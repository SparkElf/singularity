// SiYuan - Refactor your thinking
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

package model

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	stdsql "database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/88250/lute/ast"
	"github.com/siyuan-note/dataparser"
	"github.com/siyuan-note/siyuan/kernel/conf"
	"github.com/siyuan-note/siyuan/kernel/filesys"
	"github.com/siyuan-note/siyuan/kernel/sql"
	"github.com/siyuan-note/siyuan/kernel/treenode"
	"github.com/siyuan-note/siyuan/kernel/util"
)

const (
	EnterpriseBackupFormatVersion = 1
	EnterpriseBackupMaximumBytes  = 8 * 1024 * 1024 * 1024
	EnterpriseBackupMaximumFiles  = 100_000
)

var ErrEnterpriseBackupInvalid = errors.New("enterprise backup is invalid")

type EnterpriseBackupEntry struct {
	Path      string `json:"path"`
	SHA256    string `json:"sha256,omitempty"`
	SizeBytes int64  `json:"sizeBytes"`
	Type      string `json:"type"`
}

type EnterpriseBackupManifest struct {
	CreatedAt      time.Time                `json:"createdAt"`
	Entries        []*EnterpriseBackupEntry `json:"entries"`
	FileCount      int64                    `json:"fileCount"`
	FormatVersion  int                      `json:"formatVersion"`
	KernelVersion  string                   `json:"kernelVersion"`
	SourceSpaceID  string                   `json:"sourceSpaceId"`
	TotalSizeBytes int64                    `json:"totalSizeBytes"`
}

type EnterpriseBackupArchive struct {
	ArchivePath string
	Manifest    *EnterpriseBackupManifest
	SHA256      string
	SizeBytes   int64
}

type EnterpriseBackupLimits struct {
	MaximumBytes int64
	MaximumFiles int64
}

type EnterpriseRestoreLimits struct {
	MaximumArchiveBytes int64
	MaximumEntryBytes   int64
	MaximumFiles        int64
	MaximumTotalBytes   int64
}

// CreateEnterpriseBackupArchive 在事务排空后生成有界、可校验且可取消的企业空间归档。
func CreateEnterpriseBackupArchive(
	ctx context.Context,
	sourceSpaceID string,
	limits EnterpriseBackupLimits,
) (*EnterpriseBackupArchive, error) {
	if err := ctx.Err(); err != nil {
		return nil, fmt.Errorf("create enterprise backup archive: %w", err)
	}
	if strings.TrimSpace(sourceSpaceID) == "" {
		return nil, fmt.Errorf("%w: source space is empty", ErrEnterpriseBackupInvalid)
	}
	if err := validateEnterpriseBackupLimits(limits); err != nil {
		return nil, err
	}
	backupRoot := filepath.Join(util.TempDir, "enterprise-backups")
	if err := os.MkdirAll(backupRoot, 0700); err != nil {
		return nil, fmt.Errorf("create enterprise backup directory: %w", err)
	}
	file, err := os.CreateTemp(backupRoot, "backup-*.zip.partial")
	if err != nil {
		return nil, fmt.Errorf("create enterprise backup archive: %w", err)
	}
	partialPath := file.Name()
	finalPath := strings.TrimSuffix(partialPath, ".partial")
	closed := false
	defer func() {
		if !closed {
			_ = file.Close()
		}
		_ = os.Remove(partialPath)
	}()

	lockSync()
	defer unlockSync()
	if err = ctx.Err(); err != nil {
		return nil, fmt.Errorf("create enterprise backup archive: %w", err)
	}
	drain := transactionAdmission.close("")
	defer drain.release()
	drain.wait()
	if err = ctx.Err(); err != nil {
		return nil, fmt.Errorf("create enterprise backup archive: %w", err)
	}
	queueOwner := sql.AcquireExclusiveQueueAdmission(nil)
	defer queueOwner.Release()
	if err = queueOwner.FlushQueue(); err != nil {
		return nil, fmt.Errorf("flush accepted work before enterprise backup: %w", err)
	}

	if err = ctx.Err(); err != nil {
		return nil, fmt.Errorf("create enterprise backup archive: %w", err)
	}
	manifest, err := buildEnterpriseBackupManifest(ctx, sourceSpaceID, limits)
	if err != nil {
		return nil, err
	}
	archiveWriter := &enterpriseBackupArchiveWriter{
		maximumBytes: limits.MaximumBytes,
		writer:       file,
	}
	writer := zip.NewWriter(archiveWriter)
	if err = writeEnterpriseBackupArchive(ctx, writer, manifest, limits); err != nil {
		_ = writer.Close()
		return nil, err
	}
	if err = writer.Close(); err != nil {
		return nil, fmt.Errorf("close enterprise backup archive: %w", err)
	}
	if err = file.Sync(); err != nil {
		return nil, fmt.Errorf("sync enterprise backup archive: %w", err)
	}
	if err = file.Close(); err != nil {
		return nil, fmt.Errorf("close enterprise backup file: %w", err)
	}
	closed = true
	if err = ctx.Err(); err != nil {
		return nil, fmt.Errorf("create enterprise backup archive: %w", err)
	}
	if err = os.Rename(partialPath, finalPath); err != nil {
		return nil, fmt.Errorf("publish enterprise backup archive: %w", err)
	}
	digest, size, err := enterpriseFileDigestContext(ctx, finalPath)
	if err != nil {
		_ = os.Remove(finalPath)
		return nil, err
	}
	if size > limits.MaximumBytes {
		_ = os.Remove(finalPath)
		return nil, fmt.Errorf("%w: backup archive exceeds byte limit", ErrEnterpriseBackupInvalid)
	}
	return &EnterpriseBackupArchive{
		ArchivePath: finalPath,
		Manifest:    manifest,
		SHA256:      digest,
		SizeBytes:   size,
	}, nil
}

// ValidateEnterpriseBackupArchive 校验归档摘要、manifest、条目数量和内容完整性，不写入工作区。
func ValidateEnterpriseBackupArchive(
	archivePath, expectedSHA256 string,
	limits EnterpriseRestoreLimits,
) (*EnterpriseBackupManifest, error) {
	archive, manifest, _, err := openEnterpriseBackupArchive(archivePath, expectedSHA256, limits)
	if archive != nil {
		_ = archive.Close()
	}
	return manifest, err
}

// ExtractEnterpriseBackupArchive 将已校验归档解包到隔离目录，并完成SQLite、.sy和引用一致性检查。
func ExtractEnterpriseBackupArchive(
	archivePath, destinationRoot, expectedSHA256 string,
	limits EnterpriseRestoreLimits,
) (manifest *EnterpriseBackupManifest, err error) {
	destinationRoot, err = filepath.Abs(destinationRoot)
	if err != nil {
		return nil, fmt.Errorf("resolve enterprise restore destination: %w", err)
	}
	workspaceRoot, err := filepath.Abs(util.WorkspaceDir)
	if err != nil {
		return nil, fmt.Errorf("resolve current workspace: %w", err)
	}
	if destinationRoot == workspaceRoot || strings.HasPrefix(destinationRoot+string(os.PathSeparator), workspaceRoot+string(os.PathSeparator)) {
		return nil, fmt.Errorf("%w: restore destination is the current workspace", ErrEnterpriseBackupInvalid)
	}
	if _, statErr := os.Lstat(destinationRoot); !os.IsNotExist(statErr) {
		return nil, fmt.Errorf("%w: restore destination already exists", ErrEnterpriseBackupInvalid)
	}
	archive, manifest, entries, err := openEnterpriseBackupArchive(archivePath, expectedSHA256, limits)
	if err != nil {
		return nil, err
	}
	defer archive.Close()
	if err = os.MkdirAll(destinationRoot, 0700); err != nil {
		return nil, fmt.Errorf("create enterprise restore destination: %w", err)
	}
	defer func() {
		if err != nil {
			_ = os.RemoveAll(destinationRoot)
		}
	}()
	if err = os.Mkdir(filepath.Join(destinationRoot, "data"), 0700); err != nil {
		return nil, fmt.Errorf("create enterprise restore data directory: %w", err)
	}
	expectedEntries := enterpriseBackupEntriesByPath(manifest)
	for _, entry := range entries {
		if entry.Name == "manifest.json" {
			continue
		}
		relative := strings.TrimPrefix(entry.Name, "data/")
		target := filepath.Join(destinationRoot, "data", filepath.FromSlash(relative))
		if entry.FileInfo().IsDir() {
			if err = os.MkdirAll(target, 0700); err != nil {
				return nil, fmt.Errorf("create enterprise restore directory: %w", err)
			}
			continue
		}
		if err = os.MkdirAll(filepath.Dir(target), 0700); err != nil {
			return nil, fmt.Errorf("create enterprise restore parent: %w", err)
		}
		expected := expectedEntries[entry.Name]
		if expected == nil || expected.Type != "file" {
			return nil, fmt.Errorf("%w: restore manifest entry is missing", ErrEnterpriseBackupInvalid)
		}
		if err = extractEnterpriseBackupFile(entry, target, expected); err != nil {
			return nil, err
		}
	}
	if err = ValidateEnterpriseRestoredWorkspace(destinationRoot, limits); err != nil {
		return nil, err
	}
	return manifest, nil
}

// ValidateEnterpriseRestoredWorkspace 校验解包后的文件结构；加密 .sy 只验信封，不尝试按 JSON 解密。
// ValidateEnterpriseRestoredWorkspace 检查恢复目录的文件边界、笔记本信封、块结构和引用目标。
func ValidateEnterpriseRestoredWorkspace(
	workspaceRoot string,
	limits EnterpriseRestoreLimits,
) error {
	workspaceRoot, err := filepath.Abs(workspaceRoot)
	if err != nil {
		return fmt.Errorf("%w: resolve restored workspace: %v", ErrEnterpriseBackupInvalid, err)
	}
	dataRoot := filepath.Join(workspaceRoot, "data")
	dataInfo, err := os.Lstat(dataRoot)
	if err != nil || dataInfo.Mode()&fs.ModeSymlink != 0 || !dataInfo.IsDir() {
		return fmt.Errorf("%w: restored data directory is invalid", ErrEnterpriseBackupInvalid)
	}
	if limits.MaximumEntryBytes < 1 {
		return fmt.Errorf("%w: restore entry limit is invalid", ErrEnterpriseBackupInvalid)
	}

	encryptedBoxes, err := restoredEncryptedBoxes(dataRoot)
	if err != nil {
		return err
	}
	blockIDs := make(map[string]string)
	var references []string
	luteEngine := util.NewLute()
	err = filepath.WalkDir(dataRoot, func(filePath string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return fmt.Errorf("%w: walk restored data: %v", ErrEnterpriseBackupInvalid, walkErr)
		}
		if entry.Type()&fs.ModeSymlink != 0 {
			return fmt.Errorf("%w: restored data contains a symbolic link", ErrEnterpriseBackupInvalid)
		}
		if entry.IsDir() || !entry.Type().IsRegular() || !strings.HasSuffix(entry.Name(), ".sy") {
			return nil
		}
		relative, relativeErr := filepath.Rel(dataRoot, filePath)
		if relativeErr != nil {
			return fmt.Errorf("%w: resolve restored document path: %v", ErrEnterpriseBackupInvalid, relativeErr)
		}
		relative = filepath.ToSlash(relative)
		parts := strings.Split(relative, "/")
		if len(parts) < 2 {
			return fmt.Errorf("%w: restored document is outside a notebook", ErrEnterpriseBackupInvalid)
		}
		boxID := parts[0]
		if !ast.IsNodeIDPattern(boxID) {
			return fmt.Errorf("%w: restored notebook ID is invalid", ErrEnterpriseBackupInvalid)
		}
		if _, syErr := filesys.SyObjectBase(strings.Join(parts[1:], "/")); syErr != nil {
			return fmt.Errorf("%w: restored .sy filename is invalid: %v", ErrEnterpriseBackupInvalid, syErr)
		}
		info, infoErr := entry.Info()
		if infoErr != nil || info.Size() > limits.MaximumEntryBytes {
			return fmt.Errorf("%w: restored .sy file is too large or unreadable", ErrEnterpriseBackupInvalid)
		}
		data, readErr := os.ReadFile(filePath)
		if readErr != nil {
			return fmt.Errorf("%w: read restored .sy file: %v", ErrEnterpriseBackupInvalid, readErr)
		}
		if encryptedBoxes[boxID] {
			if _, nonceErr := util.EncryptionNonce(data); nonceErr != nil {
				return fmt.Errorf("%w: encrypted .sy envelope is invalid", ErrEnterpriseBackupInvalid)
			}
			return nil
		}
		tree, parseErr := dataparser.ParseJSONWithoutFix(data, luteEngine.ParseOptions)
		if parseErr != nil || tree == nil || tree.Root == nil {
			return fmt.Errorf("%w: restored .sy JSON is invalid", ErrEnterpriseBackupInvalid)
		}
		if specErr := treenode.CheckSpec(tree); errors.Is(specErr, treenode.ErrSpecTooNew) {
			return fmt.Errorf("%w: restored .sy spec is too new", ErrEnterpriseBackupInvalid)
		}
		stem := strings.TrimSuffix(path.Base(relative), ".sy")
		if tree.Root.ID != stem {
			return fmt.Errorf("%w: restored .sy root ID does not match filename", ErrEnterpriseBackupInvalid)
		}
		ast.Walk(tree.Root, func(node *ast.Node, entering bool) ast.WalkStatus {
			if !entering {
				return ast.WalkContinue
			}
			if node.IsBlock() && node.ID != "" {
				if previous, exists := blockIDs[node.ID]; exists {
					parseErr = fmt.Errorf("duplicate block ID [%s] in [%s] and [%s]", node.ID, previous, filePath)
					return ast.WalkStop
				}
				blockIDs[node.ID] = filePath
			}
			if treenode.IsBlockRef(node) {
				defID, _, _ := treenode.GetBlockRef(node)
				if defID == "" && node.Type == ast.NodeTextMark {
					return ast.WalkContinue
				}
				if !ast.IsNodeIDPattern(defID) {
					parseErr = fmt.Errorf("invalid block reference ID [%s]", defID)
					return ast.WalkStop
				}
				references = append(references, defID)
			} else if treenode.IsEmbedBlockRef(node) {
				defID := treenode.GetEmbedBlockRef(node)
				if !ast.IsNodeIDPattern(defID) {
					parseErr = fmt.Errorf("invalid embed reference ID [%s]", defID)
					return ast.WalkStop
				}
				references = append(references, defID)
			}
			return ast.WalkContinue
		})
		if parseErr != nil {
			return fmt.Errorf("%w: restored .sy structure is invalid: %v", ErrEnterpriseBackupInvalid, parseErr)
		}
		return nil
	})
	if err != nil {
		return err
	}
	for _, reference := range references {
		if _, exists := blockIDs[reference]; !exists {
			return fmt.Errorf("%w: restored reference target [%s] is missing", ErrEnterpriseBackupInvalid, reference)
		}
	}
	if err = validateEnterpriseRestoredSQLite(workspaceRoot); err != nil {
		return err
	}
	return nil
}

func restoredEncryptedBoxes(dataRoot string) (map[string]bool, error) {
	encrypted := make(map[string]bool)
	entries, err := os.ReadDir(dataRoot)
	if err != nil {
		return nil, fmt.Errorf("%w: list restored notebooks: %v", ErrEnterpriseBackupInvalid, err)
	}
	for _, entry := range entries {
		if !entry.IsDir() || !ast.IsNodeIDPattern(entry.Name()) {
			continue
		}
		confPath := filepath.Join(dataRoot, entry.Name(), ".siyuan", "conf.json")
		confInfo, statErr := os.Lstat(confPath)
		if os.IsNotExist(statErr) {
			continue
		}
		if statErr != nil || confInfo.Mode()&fs.ModeSymlink != 0 || !confInfo.Mode().IsRegular() {
			return nil, fmt.Errorf("%w: restored notebook configuration is invalid", ErrEnterpriseBackupInvalid)
		}
		confData, readErr := os.ReadFile(confPath)
		if readErr != nil {
			return nil, fmt.Errorf("%w: read restored notebook configuration: %v", ErrEnterpriseBackupInvalid, readErr)
		}
		boxConf := &conf.BoxConf{}
		if unmarshalErr := json.Unmarshal(confData, boxConf); unmarshalErr != nil {
			return nil, fmt.Errorf("%w: parse restored notebook configuration: %v", ErrEnterpriseBackupInvalid, unmarshalErr)
		}
		if boxConf.Encrypted {
			encrypted[entry.Name()] = true
		}
	}
	return encrypted, nil
}

func validateEnterpriseRestoredSQLite(workspaceRoot string) error {
	tempRoot := filepath.Join(workspaceRoot, "temp")
	entries, err := os.ReadDir(tempRoot)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("%w: list restored SQLite directory: %v", ErrEnterpriseBackupInvalid, err)
	}
	for _, entry := range entries {
		if !enterpriseSQLiteFilename(entry.Name()) {
			continue
		}
		info, infoErr := entry.Info()
		if infoErr != nil || entry.Type()&fs.ModeSymlink != 0 || !info.Mode().IsRegular() {
			return fmt.Errorf("%w: restored SQLite file type is invalid", ErrEnterpriseBackupInvalid)
		}
		filePath := filepath.Join(tempRoot, entry.Name())
		if strings.HasPrefix(entry.Name(), "siyuan-encrypted-") {
			if info.Size() == 0 {
				return fmt.Errorf("%w: encrypted SQLite file is empty", ErrEnterpriseBackupInvalid)
			}
			continue
		}
		if err = validateEnterpriseSQLiteFile(filePath); err != nil {
			return err
		}
	}
	return nil
}

func enterpriseSQLiteFilename(name string) bool {
	return name == "siyuan.db" || name == "history.db" || name == "asset_content.db" || name == "blocktree.db" ||
		(strings.HasPrefix(name, "siyuan-encrypted-") && strings.HasSuffix(name, ".db"))
}

func validateEnterpriseSQLiteFile(filePath string) error {
	databaseURL := &url.URL{Scheme: "file", Path: filePath}
	databaseURL.RawQuery = url.Values{"mode": {"ro"}}.Encode()
	database, err := stdsql.Open("sqlite3_extended", databaseURL.String())
	if err != nil {
		return fmt.Errorf("%w: open restored SQLite file: %v", ErrEnterpriseBackupInvalid, err)
	}
	defer database.Close()
	if err = database.Ping(); err != nil {
		return fmt.Errorf("%w: restored SQLite file is unreadable", ErrEnterpriseBackupInvalid)
	}
	var integrity string
	if err = database.QueryRow("PRAGMA integrity_check").Scan(&integrity); err != nil || integrity != "ok" {
		return fmt.Errorf("%w: restored SQLite integrity check failed", ErrEnterpriseBackupInvalid)
	}
	var refsTable, blocksTable int
	if err = database.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'refs'").Scan(&refsTable); err != nil {
		return fmt.Errorf("%w: inspect restored SQLite reference table: %v", ErrEnterpriseBackupInvalid, err)
	}
	if err = database.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'blocks'").Scan(&blocksTable); err != nil {
		return fmt.Errorf("%w: inspect restored SQLite block table: %v", ErrEnterpriseBackupInvalid, err)
	}
	if refsTable == 1 && blocksTable == 1 {
		var orphanRefs int
		if err = database.QueryRow(`
			SELECT COUNT(*)
			FROM refs AS refs
			LEFT JOIN blocks AS blocks
				  ON blocks.id = refs.def_block_id
			WHERE blocks.id IS NULL
		`).Scan(&orphanRefs); err != nil {
			return fmt.Errorf("%w: inspect restored SQLite references: %v", ErrEnterpriseBackupInvalid, err)
		}
		if orphanRefs != 0 {
			return fmt.Errorf("%w: restored SQLite contains orphan references", ErrEnterpriseBackupInvalid)
		}
	}
	return nil
}

func validateEnterpriseBackupLimits(limits EnterpriseBackupLimits) error {
	if limits.MaximumBytes < 1 || limits.MaximumBytes > EnterpriseBackupMaximumBytes ||
		limits.MaximumFiles < 1 || limits.MaximumFiles > EnterpriseBackupMaximumFiles {
		return fmt.Errorf("%w: backup limits are invalid", ErrEnterpriseBackupInvalid)
	}
	return nil
}

func buildEnterpriseBackupManifest(
	ctx context.Context,
	sourceSpaceID string,
	limits EnterpriseBackupLimits,
) (*EnterpriseBackupManifest, error) {
	if err := validateEnterpriseBackupLimits(limits); err != nil {
		return nil, err
	}
	manifest := &EnterpriseBackupManifest{
		CreatedAt:     time.Now().UTC(),
		Entries:       []*EnterpriseBackupEntry{},
		FormatVersion: EnterpriseBackupFormatVersion,
		KernelVersion: util.Ver,
		SourceSpaceID: sourceSpaceID,
	}
	err := filepath.WalkDir(util.DataDir, func(filePath string, entry fs.DirEntry, walkErr error) error {
		if contextErr := ctx.Err(); contextErr != nil {
			return contextErr
		}
		if walkErr != nil {
			return walkErr
		}
		if entry.Type()&fs.ModeSymlink != 0 {
			return fmt.Errorf("%w: backup contains a symbolic link", ErrEnterpriseBackupInvalid)
		}
		relative, relativeErr := filepath.Rel(util.DataDir, filePath)
		if relativeErr != nil {
			return relativeErr
		}
		if relative == "." {
			return nil
		}
		archivePath := "data/" + filepath.ToSlash(relative)
		info, infoErr := entry.Info()
		if infoErr != nil {
			return infoErr
		}
		if info.IsDir() {
			manifest.Entries = append(manifest.Entries, &EnterpriseBackupEntry{Path: archivePath + "/", Type: "directory"})
			return nil
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("%w: backup contains a non-regular file", ErrEnterpriseBackupInvalid)
		}
		remainingBytes := limits.MaximumBytes - manifest.TotalSizeBytes
		if info.Size() > remainingBytes ||
			manifest.FileCount >= limits.MaximumFiles ||
			remainingBytes < 0 {
			return fmt.Errorf("%w: backup source exceeds limits", ErrEnterpriseBackupInvalid)
		}
		digest, size, digestErr := enterpriseFileDigestContextLimited(ctx, filePath, remainingBytes)
		if digestErr != nil {
			return digestErr
		}
		manifest.Entries = append(manifest.Entries, &EnterpriseBackupEntry{
			Path: archivePath, SHA256: digest, SizeBytes: size, Type: "file",
		})
		manifest.FileCount++
		manifest.TotalSizeBytes += size
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("build enterprise backup manifest: %w", err)
	}
	sort.Slice(manifest.Entries, func(i, j int) bool { return manifest.Entries[i].Path < manifest.Entries[j].Path })
	return manifest, nil
}

func writeEnterpriseBackupArchive(
	ctx context.Context,
	writer *zip.Writer,
	manifest *EnterpriseBackupManifest,
	limits EnterpriseBackupLimits,
) error {
	if err := validateEnterpriseBackupLimits(limits); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("write enterprise backup archive: %w", err)
	}
	manifestHeader := &zip.FileHeader{Name: "manifest.json", Method: zip.Deflate}
	manifestHeader.SetMode(0600)
	manifestWriter, err := writer.CreateHeader(manifestHeader)
	if err != nil {
		return fmt.Errorf("create enterprise backup manifest entry: %w", err)
	}
	encoder := json.NewEncoder(manifestWriter)
	encoder.SetEscapeHTML(false)
	if err = encoder.Encode(manifest); err != nil {
		return fmt.Errorf("write enterprise backup manifest: %w", err)
	}
	var fileCount, totalSize int64
	for _, entry := range manifest.Entries {
		if err = ctx.Err(); err != nil {
			return fmt.Errorf("write enterprise backup archive: %w", err)
		}
		header := &zip.FileHeader{Name: entry.Path, Method: zip.Deflate}
		if entry.Type == "directory" {
			header.SetMode(0700 | fs.ModeDir)
			if _, err = writer.CreateHeader(header); err != nil {
				return fmt.Errorf("create enterprise backup directory entry: %w", err)
			}
			continue
		}
		if entry.Type != "file" || entry.SizeBytes < 0 || entry.SizeBytes > limits.MaximumBytes ||
			fileCount >= limits.MaximumFiles || totalSize > limits.MaximumBytes-entry.SizeBytes {
			return fmt.Errorf("%w: backup manifest exceeds limits", ErrEnterpriseBackupInvalid)
		}
		fileCount++
		totalSize += entry.SizeBytes
		header.SetMode(0600)
		entryWriter, createErr := writer.CreateHeader(header)
		if createErr != nil {
			return fmt.Errorf("create enterprise backup file entry: %w", createErr)
		}
		sourcePath := filepath.Join(util.DataDir, filepath.FromSlash(strings.TrimPrefix(entry.Path, "data/")))
		if err = copyEnterpriseBackupFile(ctx, sourcePath, entryWriter, entry); err != nil {
			return err
		}
	}
	return nil
}

func copyEnterpriseBackupFile(ctx context.Context, sourcePath string, destination io.Writer, expected *EnterpriseBackupEntry) error {
	file, err := os.Open(sourcePath)
	if err != nil {
		return fmt.Errorf("open enterprise backup source: %w", err)
	}
	defer file.Close()
	digest := sha256.New()
	size, err := io.Copy(
		io.MultiWriter(destination, digest),
		io.LimitReader(enterpriseContextReader{ctx: ctx, reader: file}, expected.SizeBytes+1),
	)
	if err != nil {
		return fmt.Errorf("copy enterprise backup source: %w", err)
	}
	if size != expected.SizeBytes || hex.EncodeToString(digest.Sum(nil)) != expected.SHA256 {
		return fmt.Errorf("%w: source changed during backup", ErrEnterpriseBackupInvalid)
	}
	return nil
}

func openEnterpriseBackupArchive(
	archivePath, expectedSHA256 string,
	limits EnterpriseRestoreLimits,
) (*zip.ReadCloser, *EnterpriseBackupManifest, []*zip.File, error) {
	if limits.MaximumArchiveBytes < 1 || limits.MaximumEntryBytes < 1 || limits.MaximumFiles < 1 || limits.MaximumTotalBytes < 1 {
		return nil, nil, nil, fmt.Errorf("%w: restore limits are invalid", ErrEnterpriseBackupInvalid)
	}
	info, err := os.Lstat(archivePath)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() > limits.MaximumArchiveBytes {
		return nil, nil, nil, fmt.Errorf("%w: archive file is invalid", ErrEnterpriseBackupInvalid)
	}
	digest, _, err := enterpriseFileDigest(archivePath)
	if err != nil || digest != expectedSHA256 {
		return nil, nil, nil, fmt.Errorf("%w: archive digest mismatch", ErrEnterpriseBackupInvalid)
	}
	archive, err := zip.OpenReader(archivePath)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("%w: open archive: %v", ErrEnterpriseBackupInvalid, err)
	}
	closeWithError := func(validationErr error) (*zip.ReadCloser, *EnterpriseBackupManifest, []*zip.File, error) {
		_ = archive.Close()
		return nil, nil, nil, validationErr
	}

	seen := map[string]struct{}{}
	var manifestFile *zip.File
	for _, entry := range archive.File {
		if _, exists := seen[entry.Name]; exists {
			return closeWithError(fmt.Errorf("%w: duplicate archive path", ErrEnterpriseBackupInvalid))
		}
		seen[entry.Name] = struct{}{}
		if entry.Name == "manifest.json" {
			mode := entry.Mode()
			if mode&fs.ModeSymlink != 0 || !mode.IsRegular() {
				return closeWithError(fmt.Errorf("%w: manifest entry type is invalid", ErrEnterpriseBackupInvalid))
			}
			manifestFile = entry
			continue
		}
		if !validEnterpriseBackupPath(entry.Name) {
			return closeWithError(fmt.Errorf("%w: archive path is invalid", ErrEnterpriseBackupInvalid))
		}
		mode := entry.Mode()
		if mode&fs.ModeSymlink != 0 || (!mode.IsRegular() && !mode.IsDir()) {
			return closeWithError(fmt.Errorf("%w: archive entry type is invalid", ErrEnterpriseBackupInvalid))
		}
		if mode.IsRegular() && entry.UncompressedSize64 > uint64(limits.MaximumEntryBytes) {
			return closeWithError(fmt.Errorf("%w: archive entry is too large", ErrEnterpriseBackupInvalid))
		}
	}
	if manifestFile == nil || manifestFile.UncompressedSize64 > 4*1024*1024 {
		return closeWithError(fmt.Errorf("%w: archive manifest is missing", ErrEnterpriseBackupInvalid))
	}
	manifest, err := decodeEnterpriseBackupManifest(manifestFile)
	if err != nil {
		return closeWithError(err)
	}
	if err = validateEnterpriseBackupEntries(archive.File, manifest, limits); err != nil {
		return closeWithError(err)
	}
	return archive, manifest, archive.File, nil
}

func decodeEnterpriseBackupManifest(entry *zip.File) (*EnterpriseBackupManifest, error) {
	reader, err := entry.Open()
	if err != nil {
		return nil, fmt.Errorf("%w: open manifest", ErrEnterpriseBackupInvalid)
	}
	defer reader.Close()
	decoder := json.NewDecoder(io.LimitReader(reader, 4*1024*1024+1))
	decoder.DisallowUnknownFields()
	manifest := &EnterpriseBackupManifest{}
	if err = decoder.Decode(manifest); err != nil {
		return nil, fmt.Errorf("%w: decode manifest", ErrEnterpriseBackupInvalid)
	}
	var trailing json.RawMessage
	if decoder.Decode(&trailing) != io.EOF {
		return nil, fmt.Errorf("%w: manifest has trailing data", ErrEnterpriseBackupInvalid)
	}
	if manifest.FormatVersion != EnterpriseBackupFormatVersion || strings.TrimSpace(manifest.KernelVersion) == "" || manifest.SourceSpaceID == "" || manifest.CreatedAt.IsZero() {
		return nil, fmt.Errorf("%w: manifest version is incompatible", ErrEnterpriseBackupInvalid)
	}
	return manifest, nil
}

func validateEnterpriseBackupEntries(
	archiveEntries []*zip.File,
	manifest *EnterpriseBackupManifest,
	limits EnterpriseRestoreLimits,
) error {
	expected := enterpriseBackupEntriesByPath(manifest)
	if len(expected) != len(manifest.Entries) {
		return fmt.Errorf("%w: manifest contains duplicate paths", ErrEnterpriseBackupInvalid)
	}
	var fileCount, totalSize int64
	for _, entry := range archiveEntries {
		if entry.Name == "manifest.json" {
			continue
		}
		manifestEntry := expected[entry.Name]
		if manifestEntry == nil {
			return fmt.Errorf("%w: archive entry is not in manifest", ErrEnterpriseBackupInvalid)
		}
		if entry.FileInfo().IsDir() {
			if manifestEntry.Type != "directory" || manifestEntry.SizeBytes != 0 || manifestEntry.SHA256 != "" {
				return fmt.Errorf("%w: directory manifest is invalid", ErrEnterpriseBackupInvalid)
			}
			continue
		}
		if manifestEntry.Type != "file" || manifestEntry.SizeBytes < 0 || manifestEntry.SizeBytes > limits.MaximumEntryBytes {
			return fmt.Errorf("%w: file manifest is invalid", ErrEnterpriseBackupInvalid)
		}
		if entry.UncompressedSize64 != uint64(manifestEntry.SizeBytes) {
			return fmt.Errorf("%w: archive entry size mismatch", ErrEnterpriseBackupInvalid)
		}
		reader, err := entry.Open()
		if err != nil {
			return fmt.Errorf("%w: open archive entry", ErrEnterpriseBackupInvalid)
		}
		digest := sha256.New()
		size, copyErr := io.Copy(digest, io.LimitReader(reader, limits.MaximumEntryBytes+1))
		closeErr := reader.Close()
		if copyErr != nil || closeErr != nil || size != manifestEntry.SizeBytes || hex.EncodeToString(digest.Sum(nil)) != manifestEntry.SHA256 {
			return fmt.Errorf("%w: archive entry digest mismatch", ErrEnterpriseBackupInvalid)
		}
		fileCount++
		totalSize += size
		if fileCount > limits.MaximumFiles || totalSize > limits.MaximumTotalBytes {
			return fmt.Errorf("%w: expanded archive exceeds limits", ErrEnterpriseBackupInvalid)
		}
	}
	if len(expected) != len(archiveEntries)-1 || fileCount != manifest.FileCount || totalSize != manifest.TotalSizeBytes {
		return fmt.Errorf("%w: manifest totals do not match archive", ErrEnterpriseBackupInvalid)
	}
	return nil
}

func validEnterpriseBackupPath(name string) bool {
	if strings.Contains(name, "\\") || !strings.HasPrefix(name, "data/") || path.IsAbs(name) {
		return false
	}
	trimmed := strings.TrimSuffix(name, "/")
	if trimmed == "data" || path.Clean(trimmed) != trimmed {
		return false
	}
	for _, segment := range strings.Split(trimmed, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return false
		}
	}
	return true
}

func enterpriseBackupEntriesByPath(manifest *EnterpriseBackupManifest) map[string]*EnterpriseBackupEntry {
	entries := make(map[string]*EnterpriseBackupEntry, len(manifest.Entries))
	for _, entry := range manifest.Entries {
		if entry != nil {
			entries[entry.Path] = entry
		}
	}
	return entries
}

func extractEnterpriseBackupFile(entry *zip.File, target string, expected *EnterpriseBackupEntry) error {
	source, err := entry.Open()
	if err != nil {
		return fmt.Errorf("%w: open restore entry", ErrEnterpriseBackupInvalid)
	}
	defer source.Close()
	destination, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return fmt.Errorf("create enterprise restore file: %w", err)
	}
	digest := sha256.New()
	size, copyErr := io.Copy(io.MultiWriter(destination, digest), source)
	syncErr := destination.Sync()
	closeErr := destination.Close()
	if copyErr != nil || syncErr != nil || closeErr != nil || size != expected.SizeBytes || hex.EncodeToString(digest.Sum(nil)) != expected.SHA256 {
		return fmt.Errorf("%w: extracted file digest mismatch", ErrEnterpriseBackupInvalid)
	}
	return nil
}

func enterpriseFileDigest(filePath string) (string, int64, error) {
	return enterpriseFileDigestContext(context.Background(), filePath)
}

func enterpriseFileDigestContext(ctx context.Context, filePath string) (string, int64, error) {
	return enterpriseFileDigestContextLimited(ctx, filePath, int64(^uint64(0)>>1))
}

func enterpriseFileDigestContextLimited(ctx context.Context, filePath string, maximumBytes int64) (string, int64, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return "", 0, fmt.Errorf("open enterprise file for digest: %w", err)
	}
	defer file.Close()
	digest := sha256.New()
	reader := io.Reader(enterpriseContextReader{ctx: ctx, reader: file})
	const maximumInt64 = int64(^uint64(0) >> 1)
	if maximumBytes < maximumInt64 {
		reader = io.LimitReader(reader, maximumBytes+1)
	}
	size, err := io.Copy(
		digest,
		reader,
	)
	if err != nil {
		return "", 0, fmt.Errorf("digest enterprise file: %w", err)
	}
	if size > maximumBytes {
		return "", 0, fmt.Errorf("%w: enterprise file exceeds byte limit", ErrEnterpriseBackupInvalid)
	}
	return hex.EncodeToString(digest.Sum(nil)), size, nil
}

type enterpriseBackupArchiveWriter struct {
	maximumBytes int64
	writtenBytes int64
	writer       io.Writer
}

func (w *enterpriseBackupArchiveWriter) Write(buffer []byte) (int, error) {
	if int64(len(buffer)) > w.maximumBytes-w.writtenBytes {
		return 0, fmt.Errorf("%w: backup archive exceeds byte limit", ErrEnterpriseBackupInvalid)
	}
	written, err := w.writer.Write(buffer)
	w.writtenBytes += int64(written)
	return written, err
}

type enterpriseContextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r enterpriseContextReader) Read(buffer []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(buffer)
}
