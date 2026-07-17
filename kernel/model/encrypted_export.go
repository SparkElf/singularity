// SiYuan - Refactor your thinking
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

package model

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/88250/lute/ast"
	"github.com/siyuan-note/logging"
	"github.com/siyuan-note/siyuan/kernel/util"
)

const managedEncryptedExportPrefix = "managed"

var (
	ErrManagedEncryptedExportUnavailable = errors.New("managed encrypted export is unavailable")
	ErrManagedEncryptedExportArtifact    = errors.New("managed encrypted export artifact is unavailable")
)

// ValidatePlaintextExportDestination resolves the caller-selected destination
// and rejects every application-controlled or encrypted storage boundary.
func ValidatePlaintextExportDestination(destination string) (string, error) {
	if destination == "" {
		return "", errors.New("export destination is required")
	}
	absDestination, err := filepath.Abs(destination)
	if err != nil {
		return "", err
	}
	resolvedDestination := util.ResolveLongestExistingParent(absDestination)
	if util.IsSensitivePath(absDestination) || util.IsSensitivePath(resolvedDestination) {
		return "", errors.New("refuse to export to a sensitive path")
	}
	if EncryptedRawPathBoxID(absDestination) != "" {
		return "", errors.New("refuse to export plaintext into an encrypted notebook")
	}
	if util.IsPathAtOrBelowResolved(filepath.Join(util.TempDir, "export"), absDestination) {
		return "", errors.New("refuse to export into the managed export directory")
	}
	return absDestination, nil
}

var (
	encryptedExportNow = time.Now
	encryptedExportTTL = time.Hour
)

type managedEncryptedExport struct {
	boxID           string
	root            string
	rootInfo        os.FileInfo
	artifact        string
	artifactInfo    os.FileInfo
	displayFileName string
	expiresAt       time.Time
	timer           *time.Timer
}

var managedEncryptedExports = struct {
	sync.Mutex
	jobs map[string]*managedEncryptedExport
}{jobs: map[string]*managedEncryptedExport{}}

// managedEncryptedExportAfterSnapshotHook is a concurrency-test barrier after
// claim metadata lookup and before the plaintext response gates are acquired.
var managedEncryptedExportAfterSnapshotHook func(boxID string)

type exportStage struct {
	boxID         string
	directory     string
	directoryInfo os.FileInfo
	available     bool
	expiresAt     time.Time
	timer         *time.Timer
}

var exportStages = struct {
	sync.Mutex
	jobs map[string]*exportStage
}{jobs: map[string]*exportStage{}}

func newManagedEncryptedExportID() (string, error) {
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		return "", err
	}
	return hex.EncodeToString(random), nil
}

// RegisterManagedEncryptedExport validates artifact ownership and returns an
// opaque capability path. Notebook, kind, and display file name are registry
// metadata, not parts of the download token.
func RegisterManagedEncryptedExport(boxID, kind, artifact, displayFileName string) (string, error) {
	if displayFileName == "" || displayFileName == "." || displayFileName == ".." ||
		displayFileName != filepath.Base(displayFileName) || displayFileName != util.FilterFileName(displayFileName) {
		return "", fmt.Errorf("invalid managed export display file name %q", displayFileName)
	}
	rootPath, artifactPath, rootInfo, artifactInfo, err := validateManagedEncryptedExportArtifact(boxID, kind, artifact)
	if err != nil {
		return "", err
	}

	for {
		token, tokenErr := newManagedEncryptedExportID()
		if tokenErr != nil {
			return "", tokenErr
		}
		now := encryptedExportNow()
		expiresAt := now.Add(encryptedExportTTL)
		job := &managedEncryptedExport{
			boxID:           boxID,
			root:            rootPath,
			rootInfo:        rootInfo,
			artifact:        artifactPath,
			artifactInfo:    artifactInfo,
			displayFileName: displayFileName,
			expiresAt:       expiresAt,
		}

		managedEncryptedExports.Lock()
		expired := detachExpiredManagedEncryptedExportsLocked(now)
		_, exists := managedEncryptedExports.jobs[token]
		if !exists {
			managedEncryptedExports.jobs[token] = job
			scheduleManagedEncryptedExportExpiryLocked(token, job, expiresAt.Sub(now))
		}
		managedEncryptedExports.Unlock()
		cleanupManagedEncryptedExports(expired, "expired")
		if !exists {
			return path.Join(managedEncryptedExportPrefix, token), nil
		}
	}
}

func validateManagedEncryptedExportArtifact(boxID, kind, artifact string) (rootPath, artifactPath string, rootInfo, artifactInfo os.FileInfo, err error) {
	if kind == "" || kind == "." || kind == ".." || strings.ContainsAny(kind, `/\\`) {
		return "", "", nil, nil, fmt.Errorf("invalid managed export kind %q", kind)
	}
	if !ast.IsNodeIDPattern(boxID) {
		return "", "", nil, nil, fmt.Errorf("invalid managed export notebook %q", boxID)
	}

	rootPath = filepath.Join(util.TempDir, "export", boxID, kind)
	rootPath, err = filepath.Abs(rootPath)
	if err != nil {
		return "", "", nil, nil, fmt.Errorf("resolve managed export root: %w", err)
	}
	artifact, err = filepath.Abs(artifact)
	if err != nil {
		return "", "", nil, nil, fmt.Errorf("resolve managed export artifact: %w", err)
	}
	artifactPath, err = filepath.Rel(rootPath, artifact)
	if err != nil || artifactPath == "." || filepath.IsAbs(artifactPath) || artifactPath == ".." || strings.HasPrefix(artifactPath, ".."+string(os.PathSeparator)) {
		return "", "", nil, nil, errors.New("managed export artifact is outside its notebook and kind root")
	}

	root, err := os.OpenRoot(rootPath)
	if err != nil {
		return "", "", nil, nil, fmt.Errorf("open managed export root: %w", err)
	}
	defer root.Close()
	rootInfo, err = root.Stat(".")
	if err != nil || !rootInfo.IsDir() {
		return "", "", nil, nil, fmt.Errorf("validate managed export root: %w", errors.Join(err, ErrManagedEncryptedExportArtifact))
	}
	file, err := util.OpenRegularFileInRoot(root, artifactPath)
	if err != nil {
		return "", "", nil, nil, fmt.Errorf("validate managed export artifact: %w", err)
	}
	artifactInfo, err = file.Stat()
	if err != nil {
		_ = file.Close()
		return "", "", nil, nil, fmt.Errorf("stat managed export artifact: %w", err)
	}
	if err = file.Close(); err != nil {
		return "", "", nil, nil, fmt.Errorf("close managed export artifact validation handle: %w", err)
	}
	return rootPath, artifactPath, rootInfo, artifactInfo, nil
}

func scheduleManagedEncryptedExportExpiryLocked(token string, job *managedEncryptedExport, delay time.Duration) {
	if delay < 0 {
		delay = 0
	}
	expiresAt := job.expiresAt
	job.timer = time.AfterFunc(delay, func() {
		expireManagedEncryptedExport(token, job, expiresAt)
	})
}

func expireManagedEncryptedExport(token string, expected *managedEncryptedExport, expiresAt time.Time) {
	managedEncryptedExports.Lock()
	job, ok := managedEncryptedExports.jobs[token]
	if !ok || job != expected || !job.expiresAt.Equal(expiresAt) {
		managedEncryptedExports.Unlock()
		return
	}
	now := encryptedExportNow()
	if now.Before(expiresAt) {
		scheduleManagedEncryptedExportExpiryLocked(token, job, expiresAt.Sub(now))
		managedEncryptedExports.Unlock()
		return
	}
	delete(managedEncryptedExports.jobs, token)
	job.timer = nil
	managedEncryptedExports.Unlock()
	cleanupManagedEncryptedExports([]*managedEncryptedExport{job}, "expired")
}

func stopManagedEncryptedExportTimerLocked(job *managedEncryptedExport) {
	if job.timer != nil {
		job.timer.Stop()
		job.timer = nil
	}
}

func cleanupManagedEncryptedExports(jobs []*managedEncryptedExport, reason string) {
	for _, job := range jobs {
		if err := removeManagedEncryptedExportArtifact(job); err != nil {
			logging.LogWarnf("remove %s managed export for notebook [%s] failed: %s", reason, job.boxID, err)
		}
	}
}

func detachExpiredManagedEncryptedExportsLocked(now time.Time) (expired []*managedEncryptedExport) {
	for token, job := range managedEncryptedExports.jobs {
		if !now.Before(job.expiresAt) {
			delete(managedEncryptedExports.jobs, token)
			stopManagedEncryptedExportTimerLocked(job)
			expired = append(expired, job)
		}
	}
	return
}

func openManagedEncryptedExportArtifact(job *managedEncryptedExport) (root *os.Root, file *os.File, err error) {
	root, err = os.OpenRoot(job.root)
	if err != nil {
		return nil, nil, err
	}
	rootInfo, statErr := root.Stat(".")
	if statErr != nil || job.rootInfo == nil || !os.SameFile(job.rootInfo, rootInfo) {
		return nil, nil, errors.Join(statErr, ErrManagedEncryptedExportArtifact, root.Close())
	}
	file, err = util.OpenRegularFileInRoot(root, job.artifact)
	if err != nil {
		return nil, nil, errors.Join(err, root.Close())
	}
	artifactInfo, statErr := file.Stat()
	if statErr != nil || job.artifactInfo == nil || !os.SameFile(job.artifactInfo, artifactInfo) {
		return nil, nil, errors.Join(statErr, ErrManagedEncryptedExportArtifact, file.Close(), root.Close())
	}
	return root, file, nil
}

// CreateExportStage allocates an opaque server-owned directory for the
// two-step HTML export flow. Clients receive only the random job token.
func CreateExportStage(boxID, kind string) (token, directory string, err error) {
	for {
		token, err = newManagedEncryptedExportID()
		if err != nil {
			return "", "", err
		}
		root := filepath.Join(util.TempDir, "export", "staging")
		if IsEncryptedBox(boxID) {
			root = filepath.Join(util.TempDir, "export", boxID, "staging")
		}
		directory = filepath.Join(root, kind+"-"+token)
		now := encryptedExportNow()

		exportStages.Lock()
		expired := detachExpiredExportStagesLocked(now)
		if _, exists := exportStages.jobs[token]; exists {
			exportStages.Unlock()
			cleanupExportStages(expired, "expired")
			continue
		}
		if err = os.MkdirAll(directory, 0755); err != nil {
			exportStages.Unlock()
			cleanupExportStages(expired, "expired")
			return "", "", err
		}
		directoryInfo, statErr := os.Lstat(directory)
		if statErr != nil || !directoryInfo.IsDir() || directoryInfo.Mode()&os.ModeSymlink != 0 {
			exportStages.Unlock()
			cleanupExportStages(expired, "expired")
			_ = os.RemoveAll(directory)
			return "", "", errors.Join(statErr, ErrManagedEncryptedExportArtifact)
		}
		job := &exportStage{boxID: boxID, directory: directory, directoryInfo: directoryInfo}
		exportStages.jobs[token] = job
		exportStages.Unlock()
		cleanupExportStages(expired, "expired")
		return token, directory, nil
	}
}

// CompleteExportStage publishes a fully generated stage and starts its client
// claim TTL at that transition.
func CompleteExportStage(token, boxID string) error {
	exportStages.Lock()
	expired := detachExpiredExportStagesLocked(encryptedExportNow())
	job, found := exportStages.jobs[token]
	if !found || job.boxID != boxID || job.available {
		exportStages.Unlock()
		cleanupExportStages(expired, "expired")
		return ErrManagedEncryptedExportUnavailable
	}
	exportStages.Unlock()
	cleanupExportStages(expired, "expired")

	if err := validateExportStageDirectory(job); err != nil {
		return errors.Join(err, DiscardExportStage(token, boxID))
	}

	now := encryptedExportNow()
	exportStages.Lock()
	expired = detachExpiredExportStagesLocked(now)
	current, currentOK := exportStages.jobs[token]
	if !currentOK || current != job || current.available {
		exportStages.Unlock()
		cleanupExportStages(expired, "expired")
		return ErrManagedEncryptedExportUnavailable
	}
	job.available = true
	job.expiresAt = now.Add(encryptedExportTTL)
	scheduleExportStageExpiryLocked(token, job, encryptedExportTTL)
	exportStages.Unlock()
	cleanupExportStages(expired, "expired")
	return nil
}

// DiscardExportStage consumes either a building or available stage and removes
// the exact directory identity allocated for it.
func DiscardExportStage(token, boxID string) error {
	exportStages.Lock()
	expired := detachExpiredExportStagesLocked(encryptedExportNow())
	job, found := exportStages.jobs[token]
	if !found || job.boxID != boxID {
		exportStages.Unlock()
		cleanupExportStages(expired, "expired")
		return ErrManagedEncryptedExportUnavailable
	}
	delete(exportStages.jobs, token)
	stopExportStageTimerLocked(job)
	exportStages.Unlock()
	cleanupExportStages(expired, "expired")
	return removeExportStageDirectory(job)
}

type ExportStageClaim struct {
	Directory string
	job       *exportStage
}

// TakeExportStage resolves and consumes an HTML export job. The declared
// notebook must exactly match the notebook that created the stage.
func TakeExportStage(token, boxID string) (claim *ExportStageClaim, ok bool) {
	exportStages.Lock()
	expired := detachExpiredExportStagesLocked(encryptedExportNow())
	job, found := exportStages.jobs[token]
	if !found || job.boxID != boxID || !job.available {
		exportStages.Unlock()
		cleanupExportStages(expired, "expired")
		return nil, false
	}
	delete(exportStages.jobs, token)
	stopExportStageTimerLocked(job)
	exportStages.Unlock()
	cleanupExportStages(expired, "expired")
	if err := validateExportStageDirectory(job); err != nil {
		logging.LogWarnf("validate claimed export stage for notebook [%s] failed: %s", job.boxID, err)
		return nil, false
	}
	return &ExportStageClaim{Directory: job.directory, job: job}, true
}

func (claim *ExportStageClaim) Close() error {
	if claim == nil || claim.job == nil {
		return nil
	}
	job := claim.job
	claim.job = nil
	return removeExportStageDirectory(job)
}

func scheduleExportStageExpiryLocked(token string, job *exportStage, delay time.Duration) {
	if delay < 0 {
		delay = 0
	}
	expiresAt := job.expiresAt
	job.timer = time.AfterFunc(delay, func() {
		expireExportStage(token, job, expiresAt)
	})
}

func expireExportStage(token string, expected *exportStage, expiresAt time.Time) {
	exportStages.Lock()
	job, ok := exportStages.jobs[token]
	if !ok || job != expected || !job.expiresAt.Equal(expiresAt) {
		exportStages.Unlock()
		return
	}
	now := encryptedExportNow()
	if now.Before(expiresAt) {
		scheduleExportStageExpiryLocked(token, job, expiresAt.Sub(now))
		exportStages.Unlock()
		return
	}
	delete(exportStages.jobs, token)
	job.timer = nil
	exportStages.Unlock()
	cleanupExportStages([]*exportStage{job}, "expired")
}

func stopExportStageTimerLocked(job *exportStage) {
	if job.timer != nil {
		job.timer.Stop()
		job.timer = nil
	}
}

func detachExpiredExportStagesLocked(now time.Time) (expired []*exportStage) {
	for token, job := range exportStages.jobs {
		if job.available && !now.Before(job.expiresAt) {
			delete(exportStages.jobs, token)
			stopExportStageTimerLocked(job)
			expired = append(expired, job)
		}
	}
	return
}

func cleanupExportStages(jobs []*exportStage, reason string) {
	for _, job := range jobs {
		if err := removeExportStageDirectory(job); err != nil {
			logging.LogWarnf("remove %s export stage for notebook [%s] failed: %s", reason, job.boxID, err)
		}
	}
}

func validateExportStageDirectory(job *exportStage) error {
	root, _, err := openExportStageDirectory(job)
	if err != nil {
		return err
	}
	return root.Close()
}

func removeExportStageDirectory(job *exportStage) error {
	root, name, err := openExportStageDirectory(job)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	removeErr := root.RemoveAll(name)
	return errors.Join(removeErr, root.Close())
}

func openExportStageDirectory(job *exportStage) (*os.Root, string, error) {
	if job == nil || job.directoryInfo == nil {
		return nil, "", ErrManagedEncryptedExportArtifact
	}
	parent := filepath.Dir(job.directory)
	name := filepath.Base(job.directory)
	root, err := os.OpenRoot(parent)
	if err != nil {
		return nil, "", err
	}
	currentInfo, statErr := root.Lstat(name)
	if statErr != nil || !currentInfo.IsDir() || currentInfo.Mode()&os.ModeSymlink != 0 || !os.SameFile(job.directoryInfo, currentInfo) {
		return nil, "", errors.Join(statErr, ErrManagedEncryptedExportArtifact, root.Close())
	}
	return root, name, nil
}

type ManagedEncryptedExportClaim struct {
	BoxID           string
	DisplayFileName string
	File            *os.File
	root            *os.Root
	artifact        string
	artifactInfo    os.FileInfo
	boxReadLocked   bool
	responseLocked  bool
}

// ClaimManagedEncryptedExport atomically consumes a download token and opens
// its artifact inside the exact root validated at registration time.
func ClaimManagedEncryptedExport(relativePath string) (*ManagedEncryptedExportClaim, error) {
	token, valid := managedEncryptedExportToken(relativePath)
	if !valid {
		return nil, ErrManagedEncryptedExportUnavailable
	}

	managedEncryptedExports.Lock()
	expired := detachExpiredManagedEncryptedExportsLocked(encryptedExportNow())
	job, ok := managedEncryptedExports.jobs[token]
	managedEncryptedExports.Unlock()
	cleanupManagedEncryptedExports(expired, "expired")
	if !ok {
		return nil, ErrManagedEncryptedExportUnavailable
	}

	if managedEncryptedExportAfterSnapshotHook != nil {
		managedEncryptedExportAfterSnapshotHook(job.boxID)
	}
	acquireBoxResponseReadLock(job.boxID)
	acquireBoxReadLock(job.boxID)

	managedEncryptedExports.Lock()
	expired = detachExpiredManagedEncryptedExportsLocked(encryptedExportNow())
	current, currentOK := managedEncryptedExports.jobs[token]
	if !currentOK || current != job {
		managedEncryptedExports.Unlock()
		cleanupManagedEncryptedExports(expired, "expired")
		releaseBoxReadLock(job.boxID)
		releaseBoxResponseReadLock(job.boxID)
		return nil, ErrManagedEncryptedExportUnavailable
	}
	delete(managedEncryptedExports.jobs, token)
	stopManagedEncryptedExportTimerLocked(job)
	managedEncryptedExports.Unlock()
	cleanupManagedEncryptedExports(expired, "expired")

	root, file, err := openManagedEncryptedExportArtifact(job)
	if err != nil {
		cleanupErr := removeManagedEncryptedExportArtifact(job)
		releaseBoxReadLock(job.boxID)
		releaseBoxResponseReadLock(job.boxID)
		return nil, fmt.Errorf("%w: %v", ErrManagedEncryptedExportArtifact, errors.Join(err, cleanupErr))
	}
	return &ManagedEncryptedExportClaim{
		BoxID:           job.boxID,
		DisplayFileName: job.displayFileName,
		File:            file,
		root:            root,
		artifact:        job.artifact,
		artifactInfo:    job.artifactInfo,
		boxReadLocked:   true,
		responseLocked:  true,
	}, nil
}

func (claim *ManagedEncryptedExportClaim) Close() error {
	if claim == nil {
		return nil
	}
	var closeErr, removeErr, rootCloseErr error
	var openedInfo os.FileInfo
	if claim.File != nil {
		openedInfo, closeErr = claim.File.Stat()
		if closeErr == nil && (claim.artifactInfo == nil || !os.SameFile(claim.artifactInfo, openedInfo)) {
			closeErr = ErrManagedEncryptedExportArtifact
		}
		fileCloseErr := claim.File.Close()
		closeErr = errors.Join(closeErr, fileCloseErr)
		claim.File = nil
	}
	if claim.root != nil {
		currentInfo, statErr := claim.root.Lstat(claim.artifact)
		if os.IsNotExist(statErr) {
			statErr = nil
		} else if statErr == nil && openedInfo != nil && os.SameFile(openedInfo, currentInfo) {
			removeErr = claim.root.Remove(claim.artifact)
			if os.IsNotExist(removeErr) {
				removeErr = nil
			}
		} else {
			removeErr = errors.Join(statErr, ErrManagedEncryptedExportArtifact)
		}
		rootCloseErr = claim.root.Close()
		claim.root = nil
	}
	if claim.boxReadLocked {
		releaseBoxReadLock(claim.BoxID)
		claim.boxReadLocked = false
	}
	if claim.responseLocked {
		releaseBoxResponseReadLock(claim.BoxID)
		claim.responseLocked = false
	}
	return errors.Join(closeErr, removeErr, rootCloseErr)
}

func managedEncryptedExportToken(relativePath string) (string, bool) {
	relativePath = strings.TrimPrefix(relativePath, "/")
	parts := strings.Split(relativePath, "/")
	if len(parts) != 2 || parts[0] != managedEncryptedExportPrefix || len(parts[1]) != 32 {
		return "", false
	}
	decoded, err := hex.DecodeString(parts[1])
	return parts[1], err == nil && len(decoded) == 16
}

func removeManagedEncryptedExportArtifact(job *managedEncryptedExport) error {
	root, file, err := openManagedEncryptedExportArtifact(job)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	fileCloseErr := file.Close()
	if fileCloseErr != nil {
		return errors.Join(fileCloseErr, root.Close())
	}
	currentInfo, statErr := root.Lstat(job.artifact)
	if errors.Is(statErr, os.ErrNotExist) {
		return root.Close()
	}
	if statErr != nil || !os.SameFile(job.artifactInfo, currentInfo) {
		return errors.Join(statErr, ErrManagedEncryptedExportArtifact, root.Close())
	}
	removeErr := root.Remove(job.artifact)
	if os.IsNotExist(removeErr) {
		removeErr = nil
	}
	return errors.Join(removeErr, root.Close())
}

// RevokeManagedEncryptedExportsForBox 使指定笔记本的所有导出下载链接立即失效。
func RevokeManagedEncryptedExportsForBox(boxID string) {
	managedEncryptedExports.Lock()
	var revoked []*managedEncryptedExport
	for token, job := range managedEncryptedExports.jobs {
		if job.boxID == boxID {
			delete(managedEncryptedExports.jobs, token)
			stopManagedEncryptedExportTimerLocked(job)
			revoked = append(revoked, job)
		}
	}
	managedEncryptedExports.Unlock()
	cleanupManagedEncryptedExports(revoked, "revoked")

	exportStages.Lock()
	var revokedStages []*exportStage
	for token, job := range exportStages.jobs {
		if job.boxID == boxID {
			delete(exportStages.jobs, token)
			stopExportStageTimerLocked(job)
			revokedStages = append(revokedStages, job)
		}
	}
	exportStages.Unlock()
	cleanupExportStages(revokedStages, "revoked")
}

// IsManagedEncryptedExportPath recognizes opaque managed tokens and legacy
// notebook-prefixed paths. Legacy recognition prevents old plaintext artifacts
// from falling through to ordinary static-file serving after an upgrade.
func IsManagedEncryptedExportPath(relativePath string) bool {
	relativePath = strings.ReplaceAll(relativePath, `\`, "/")
	relativePath = strings.TrimLeft(relativePath, "/")
	first, _, _ := strings.Cut(relativePath, "/")
	return first == managedEncryptedExportPrefix || ast.IsNodeIDPattern(first)
}
