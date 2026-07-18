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
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/siyuan-note/siyuan/kernel/sql"
	"github.com/siyuan-note/siyuan/kernel/util"
)

const EnterpriseBackupFormatVersion = 1

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

type EnterpriseRestoreLimits struct {
	MaximumArchiveBytes int64
	MaximumEntryBytes   int64
	MaximumFiles        int64
	MaximumTotalBytes   int64
}

func CreateEnterpriseBackupArchive(sourceSpaceID string) (*EnterpriseBackupArchive, error) {
	if strings.TrimSpace(sourceSpaceID) == "" {
		return nil, fmt.Errorf("%w: source space is empty", ErrEnterpriseBackupInvalid)
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
	drain := transactionAdmission.close("")
	defer drain.release()
	drain.wait()
	queueOwner := sql.AcquireExclusiveQueueAdmission(nil)
	defer queueOwner.Release()
	if err = queueOwner.FlushQueue(); err != nil {
		return nil, fmt.Errorf("flush accepted work before enterprise backup: %w", err)
	}

	manifest, err := buildEnterpriseBackupManifest(sourceSpaceID)
	if err != nil {
		return nil, err
	}
	writer := zip.NewWriter(file)
	if err = writeEnterpriseBackupArchive(writer, manifest); err != nil {
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
	if err = os.Rename(partialPath, finalPath); err != nil {
		return nil, fmt.Errorf("publish enterprise backup archive: %w", err)
	}
	digest, size, err := enterpriseFileDigest(finalPath)
	if err != nil {
		_ = os.Remove(finalPath)
		return nil, err
	}
	return &EnterpriseBackupArchive{
		ArchivePath: finalPath,
		Manifest:    manifest,
		SHA256:      digest,
		SizeBytes:   size,
	}, nil
}

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
	return manifest, nil
}

func buildEnterpriseBackupManifest(sourceSpaceID string) (*EnterpriseBackupManifest, error) {
	manifest := &EnterpriseBackupManifest{
		CreatedAt:     time.Now().UTC(),
		Entries:       []*EnterpriseBackupEntry{},
		FormatVersion: EnterpriseBackupFormatVersion,
		KernelVersion: util.Ver,
		SourceSpaceID: sourceSpaceID,
	}
	err := filepath.WalkDir(util.DataDir, func(filePath string, entry fs.DirEntry, walkErr error) error {
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
		digest, size, digestErr := enterpriseFileDigest(filePath)
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

func writeEnterpriseBackupArchive(writer *zip.Writer, manifest *EnterpriseBackupManifest) error {
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
	for _, entry := range manifest.Entries {
		header := &zip.FileHeader{Name: entry.Path, Method: zip.Deflate}
		if entry.Type == "directory" {
			header.SetMode(0700 | fs.ModeDir)
			if _, err = writer.CreateHeader(header); err != nil {
				return fmt.Errorf("create enterprise backup directory entry: %w", err)
			}
			continue
		}
		header.SetMode(0600)
		entryWriter, createErr := writer.CreateHeader(header)
		if createErr != nil {
			return fmt.Errorf("create enterprise backup file entry: %w", createErr)
		}
		sourcePath := filepath.Join(util.DataDir, filepath.FromSlash(strings.TrimPrefix(entry.Path, "data/")))
		if err = copyEnterpriseBackupFile(sourcePath, entryWriter, entry); err != nil {
			return err
		}
	}
	return nil
}

func copyEnterpriseBackupFile(sourcePath string, destination io.Writer, expected *EnterpriseBackupEntry) error {
	file, err := os.Open(sourcePath)
	if err != nil {
		return fmt.Errorf("open enterprise backup source: %w", err)
	}
	defer file.Close()
	digest := sha256.New()
	size, err := io.Copy(io.MultiWriter(destination, digest), file)
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
	if manifest.FormatVersion != EnterpriseBackupFormatVersion || manifest.KernelVersion != util.Ver || manifest.SourceSpaceID == "" || manifest.CreatedAt.IsZero() {
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
	file, err := os.Open(filePath)
	if err != nil {
		return "", 0, fmt.Errorf("open enterprise file for digest: %w", err)
	}
	defer file.Close()
	digest := sha256.New()
	size, err := io.Copy(digest, file)
	if err != nil {
		return "", 0, fmt.Errorf("digest enterprise file: %w", err)
	}
	return hex.EncodeToString(digest.Sum(nil)), size, nil
}
