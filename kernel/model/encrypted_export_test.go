package model

import (
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/siyuan-note/siyuan/kernel/conf"
	"github.com/siyuan-note/siyuan/kernel/util"
)

func TestManagedEncryptedExportRevocation(t *testing.T) {
	previousTempDir := util.TempDir
	util.TempDir = t.TempDir()
	t.Cleanup(func() { util.TempDir = previousTempDir })

	boxID := "20260711211244-abcdefg"
	artifact := filepath.Join(util.TempDir, "export", boxID, "resources", "export.zip")
	if err := os.MkdirAll(filepath.Dir(artifact), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(artifact, []byte("plaintext"), 0600); err != nil {
		t.Fatal(err)
	}

	relativePath, err := RegisterManagedEncryptedExport(boxID, "resources", artifact, "export.zip")
	if err != nil {
		t.Fatalf("register managed export: %v", err)
	}
	t.Cleanup(func() { RevokeManagedEncryptedExportsForBox(boxID) })

	RevokeManagedEncryptedExportsForBox(boxID)
	if _, err = ClaimManagedEncryptedExport(relativePath); !errors.Is(err, ErrManagedEncryptedExportUnavailable) {
		t.Fatal("revoked managed export remained downloadable")
	}
	if _, err = os.Stat(artifact); !os.IsNotExist(err) {
		t.Fatalf("revoked managed export artifact remains: %v", err)
	}
}

func TestManagedEncryptedExportRejectsCrossKindArtifact(t *testing.T) {
	previousTempDir := util.TempDir
	util.TempDir = t.TempDir()
	t.Cleanup(func() { util.TempDir = previousTempDir })

	boxID := "20260711211244-abcdefg"
	artifact := filepath.Join(util.TempDir, "export", boxID, "markdown", "export.zip")
	if err := os.MkdirAll(filepath.Dir(artifact), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(artifact, []byte("markdown"), 0600); err != nil {
		t.Fatal(err)
	}

	if _, err := RegisterManagedEncryptedExport(boxID, "resources", artifact, "export.zip"); err == nil {
		t.Fatal("artifact from another export kind was registered")
	}
	content, err := os.ReadFile(artifact)
	if err != nil || string(content) != "markdown" {
		t.Fatalf("rejected cross-kind artifact changed: content=%q err=%v", content, err)
	}
}

func TestManagedEncryptedExportRejectsUnsafeDisplayFileName(t *testing.T) {
	previousTempDir := util.TempDir
	util.TempDir = t.TempDir()
	t.Cleanup(func() { util.TempDir = previousTempDir })

	boxID := "20260711211244-abcdefg"
	artifact := filepath.Join(util.TempDir, "export", boxID, "resources", "physical.zip")
	if err := os.MkdirAll(filepath.Dir(artifact), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(artifact, []byte("plaintext"), 0600); err != nil {
		t.Fatal(err)
	}

	if _, err := RegisterManagedEncryptedExport(boxID, "resources", artifact, "../download.zip"); err == nil {
		t.Fatal("unsafe managed export display file name was registered")
	}
	assertManagedExportFileContent(t, artifact, "plaintext")
}

func TestManagedEncryptedExportClaimRejectsReplacedRoot(t *testing.T) {
	previousTempDir := util.TempDir
	util.TempDir = t.TempDir()
	t.Cleanup(func() { util.TempDir = previousTempDir })

	boxID := "20260711211244-abcdefg"
	root := filepath.Join(util.TempDir, "export", boxID, "resources")
	artifact := filepath.Join(root, "export.zip")
	if err := os.MkdirAll(root, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(artifact, []byte("registered"), 0600); err != nil {
		t.Fatal(err)
	}
	managedPath, err := RegisterManagedEncryptedExport(boxID, "resources", artifact, "export.zip")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { RevokeManagedEncryptedExportsForBox(boxID) })

	originalRoot := root + "-registered"
	if err = os.Rename(root, originalRoot); err != nil {
		t.Fatal(err)
	}
	if err = os.MkdirAll(root, 0755); err != nil {
		t.Fatal(err)
	}
	replacement := filepath.Join(root, filepath.Base(artifact))
	if err = os.WriteFile(replacement, []byte("replacement"), 0600); err != nil {
		t.Fatal(err)
	}

	if _, err = ClaimManagedEncryptedExport(managedPath); !errors.Is(err, ErrManagedEncryptedExportArtifact) {
		t.Fatalf("claim after root replacement error = %v, want artifact identity failure", err)
	}
	assertManagedExportFileContent(t, replacement, "replacement")
	assertManagedExportFileContent(t, filepath.Join(originalRoot, filepath.Base(artifact)), "registered")
}

func TestManagedEncryptedExportRevokeDoesNotDeleteReplacedRoot(t *testing.T) {
	previousTempDir := util.TempDir
	util.TempDir = t.TempDir()
	t.Cleanup(func() { util.TempDir = previousTempDir })

	boxID := "20260711211244-abcdefg"
	root := filepath.Join(util.TempDir, "export", boxID, "resources")
	artifact := filepath.Join(root, "export.zip")
	if err := os.MkdirAll(root, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(artifact, []byte("registered"), 0600); err != nil {
		t.Fatal(err)
	}
	managedPath, err := RegisterManagedEncryptedExport(boxID, "resources", artifact, "export.zip")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { RevokeManagedEncryptedExportsForBox(boxID) })

	originalRoot := root + "-registered"
	if err = os.Rename(root, originalRoot); err != nil {
		t.Fatal(err)
	}
	if err = os.MkdirAll(root, 0755); err != nil {
		t.Fatal(err)
	}
	replacement := filepath.Join(root, filepath.Base(artifact))
	if err = os.WriteFile(replacement, []byte("replacement"), 0600); err != nil {
		t.Fatal(err)
	}

	RevokeManagedEncryptedExportsForBox(boxID)
	if _, err = ClaimManagedEncryptedExport(managedPath); !errors.Is(err, ErrManagedEncryptedExportUnavailable) {
		t.Fatalf("revoked token error = %v, want unavailable", err)
	}
	assertManagedExportFileContent(t, replacement, "replacement")
	assertManagedExportFileContent(t, filepath.Join(originalRoot, filepath.Base(artifact)), "registered")
}

func TestManagedEncryptedExportClaimRejectsReplacedArtifact(t *testing.T) {
	previousTempDir := util.TempDir
	util.TempDir = t.TempDir()
	t.Cleanup(func() { util.TempDir = previousTempDir })

	boxID := "20260711211244-abcdefg"
	root := filepath.Join(util.TempDir, "export", boxID, "resources")
	artifact := filepath.Join(root, "export.zip")
	if err := os.MkdirAll(root, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(artifact, []byte("registered"), 0600); err != nil {
		t.Fatal(err)
	}
	managedPath, err := RegisterManagedEncryptedExport(boxID, "resources", artifact, "export.zip")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { RevokeManagedEncryptedExportsForBox(boxID) })
	if err = os.Rename(artifact, artifact+".registered"); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(artifact, []byte("replacement"), 0600); err != nil {
		t.Fatal(err)
	}

	if _, err = ClaimManagedEncryptedExport(managedPath); !errors.Is(err, ErrManagedEncryptedExportArtifact) {
		t.Fatalf("claim after artifact replacement error = %v, want artifact identity failure", err)
	}
	assertManagedExportFileContent(t, artifact, "replacement")
}

func TestManagedEncryptedExportTTLRemovesArtifactWithoutRegistryTraffic(t *testing.T) {
	previousTempDir := util.TempDir
	previousTTL := encryptedExportTTL
	previousNow := encryptedExportNow
	util.TempDir = t.TempDir()
	now := time.Date(2026, 7, 17, 9, 0, 0, 0, time.UTC)
	encryptedExportNow = func() time.Time { return now }
	encryptedExportTTL = time.Hour
	t.Cleanup(func() {
		encryptedExportNow = previousNow
		encryptedExportTTL = previousTTL
		util.TempDir = previousTempDir
	})

	boxID := "20260711211244-abcdefg"
	artifact := filepath.Join(util.TempDir, "export", boxID, "resources", "export.zip")
	if err := os.MkdirAll(filepath.Dir(artifact), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(artifact, []byte("plaintext"), 0600); err != nil {
		t.Fatal(err)
	}
	managedPath, err := RegisterManagedEncryptedExport(boxID, "resources", artifact, "export.zip")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { RevokeManagedEncryptedExportsForBox(boxID) })

	token, valid := managedEncryptedExportToken(managedPath)
	if !valid {
		t.Fatalf("registered managed export path is invalid: %s", managedPath)
	}
	managedEncryptedExports.Lock()
	job := managedEncryptedExports.jobs[token]
	if job == nil {
		managedEncryptedExports.Unlock()
		t.Fatal("registered managed export job is missing")
	}
	expiresAt := job.expiresAt
	stopManagedEncryptedExportTimerLocked(job)
	managedEncryptedExports.Unlock()
	now = expiresAt
	expireManagedEncryptedExport(token, job, expiresAt)
	if _, statErr := os.Stat(artifact); !os.IsNotExist(statErr) {
		t.Fatalf("expired managed export artifact remains: %v", statErr)
	}
	if _, err = ClaimManagedEncryptedExport(managedPath); !errors.Is(err, ErrManagedEncryptedExportUnavailable) {
		t.Fatalf("expired managed export error = %v, want unavailable", err)
	}
}

func TestManagedEncryptedExportClaimRevalidatesAfterLockBox(t *testing.T) {
	previousTempDir := util.TempDir
	util.TempDir = t.TempDir()
	t.Cleanup(func() { util.TempDir = previousTempDir })
	boxID, _ := setupEncryptedAssetStoreTest(t)

	artifact := filepath.Join(util.TempDir, "export", boxID, "resources", "physical.zip")
	if err := os.MkdirAll(filepath.Dir(artifact), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(artifact, []byte("plaintext"), 0600); err != nil {
		t.Fatal(err)
	}
	managedPath, err := RegisterManagedEncryptedExport(boxID, "resources", artifact, "download.zip")
	if err != nil {
		t.Fatal(err)
	}

	snapshotReached := make(chan struct{})
	resumeSnapshot := make(chan struct{})
	var resumeOnce sync.Once
	previousHook := managedEncryptedExportAfterSnapshotHook
	managedEncryptedExportAfterSnapshotHook = func(candidateBoxID string) {
		if candidateBoxID != boxID {
			return
		}
		close(snapshotReached)
		<-resumeSnapshot
	}
	t.Cleanup(func() {
		resumeOnce.Do(func() { close(resumeSnapshot) })
		managedEncryptedExportAfterSnapshotHook = previousHook
	})

	type claimResult struct {
		claim *ManagedEncryptedExportClaim
		err   error
	}
	claimDone := make(chan claimResult, 1)
	go func() {
		claim, claimErr := ClaimManagedEncryptedExport(managedPath)
		claimDone <- claimResult{claim: claim, err: claimErr}
	}()
	select {
	case <-snapshotReached:
	case <-time.After(5 * time.Second):
		t.Fatal("managed export claim did not reach the pre-response-lock snapshot")
	}

	lockDone := make(chan error, 1)
	go func() { lockDone <- LockBox(boxID) }()
	select {
	case lockErr := <-lockDone:
		if lockErr != nil {
			t.Fatalf("LockBox while claim awaited response lock: %v", lockErr)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("LockBox waited for a claim that had not acquired the response lock")
	}
	if _, statErr := os.Stat(artifact); !os.IsNotExist(statErr) {
		t.Fatalf("LockBox returned before removing the unclaimed managed artifact: %v", statErr)
	}

	resumeOnce.Do(func() { close(resumeSnapshot) })
	select {
	case result := <-claimDone:
		if result.claim != nil || !errors.Is(result.err, ErrManagedEncryptedExportUnavailable) {
			t.Fatalf("claim after LockBox = %#v, %v; want nil, unavailable", result.claim, result.err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("managed export claim did not revalidate after LockBox")
	}
}

func TestExportStageTTLRemovesDirectoryWithoutRegistryTraffic(t *testing.T) {
	previousTempDir := util.TempDir
	previousTTL := encryptedExportTTL
	previousNow := encryptedExportNow
	util.TempDir = t.TempDir()
	now := time.Date(2026, 7, 17, 10, 0, 0, 0, time.UTC)
	encryptedExportNow = func() time.Time { return now }
	encryptedExportTTL = time.Hour
	t.Cleanup(func() {
		encryptedExportNow = previousNow
		encryptedExportTTL = previousTTL
		util.TempDir = previousTempDir
	})

	token, directory, err := CreateExportStage("20260716090000-boxxxxx", "html")
	if err != nil {
		t.Fatal(err)
	}
	if err = CompleteExportStage(token, "20260716090000-boxxxxx"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if claim, ok := TakeExportStage(token, "20260716090000-boxxxxx"); ok {
			_ = claim.Close()
		}
	})
	exportStages.Lock()
	job := exportStages.jobs[token]
	if job == nil {
		exportStages.Unlock()
		t.Fatal("completed export stage is missing")
	}
	expiresAt := job.expiresAt
	stopExportStageTimerLocked(job)
	exportStages.Unlock()
	now = expiresAt
	expireExportStage(token, job, expiresAt)
	if _, statErr := os.Stat(directory); !os.IsNotExist(statErr) {
		t.Fatalf("expired export stage directory remains: %v", statErr)
	}
	if _, ok := TakeExportStage(token, "20260716090000-boxxxxx"); ok {
		t.Fatal("expired export stage remained claimable")
	}
}

func TestExportStageTTLStartsWhenBuildCompletes(t *testing.T) {
	previousTempDir := util.TempDir
	previousNow := encryptedExportNow
	util.TempDir = t.TempDir()
	now := time.Date(2026, 7, 16, 12, 0, 0, 0, time.UTC)
	encryptedExportNow = func() time.Time { return now }
	t.Cleanup(func() {
		encryptedExportNow = previousNow
		util.TempDir = previousTempDir
	})

	const boxID = "20260716090000-boxxxxx"
	token, directory, err := CreateExportStage(boxID, "html")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = DiscardExportStage(token, boxID) })

	now = now.Add(2 * encryptedExportTTL)
	if _, ok := TakeExportStage(token, boxID); ok {
		t.Fatal("building export stage became claimable while generation was incomplete")
	}
	if _, err = os.Stat(directory); err != nil {
		t.Fatalf("building export stage expired before completion: %v", err)
	}
	if err = CompleteExportStage(token, boxID); err != nil {
		t.Fatalf("complete long-running export stage: %v", err)
	}

	now = now.Add(encryptedExportTTL - time.Second)
	claim, ok := TakeExportStage(token, boxID)
	if !ok || claim.Directory != directory {
		t.Fatalf("recently completed export stage = %#v, %t; want %q, true", claim, ok, directory)
	}
	if err = claim.Close(); err != nil {
		t.Fatalf("close completed export stage: %v", err)
	}
}

func TestValidatePlaintextExportDestinationRejectsControlledRootsAndSymlinks(t *testing.T) {
	previousWorkspaceDir := util.WorkspaceDir
	previousDataDir := util.DataDir
	previousTempDir := util.TempDir
	previousConf := Conf
	root := t.TempDir()
	util.WorkspaceDir = root
	util.DataDir = filepath.Join(root, "data")
	util.TempDir = filepath.Join(root, "temp")
	Conf = NewAppConf()
	t.Cleanup(func() {
		Conf = previousConf
		util.TempDir = previousTempDir
		util.DataDir = previousDataDir
		util.WorkspaceDir = previousWorkspaceDir
	})

	const boxID = "20260716090000-boxxxxx"
	boxConf := conf.NewBoxConf()
	boxConf.Encrypted = true
	if err := (&Box{ID: boxID}).SaveConf(boxConf); err != nil {
		t.Fatalf("save encrypted notebook fixture: %v", err)
	}
	managedRoot := filepath.Join(util.TempDir, "export")
	if err := os.MkdirAll(managedRoot, 0755); err != nil {
		t.Fatal(err)
	}

	normal := filepath.Join(root, "downloads", "report.zip")
	resolved, err := ValidatePlaintextExportDestination(normal)
	if err != nil || resolved != normal {
		t.Fatalf("normal export destination = %q, %v; want %q", resolved, err, normal)
	}

	rawRoot := filepath.Join(util.DataDir, boxID)
	for _, dir := range []string{rawRoot, managedRoot} {
		if err = os.MkdirAll(dir, 0755); err != nil {
			t.Fatal(err)
		}
	}
	rawLink := filepath.Join(root, "encrypted-link")
	managedLink := filepath.Join(root, "managed-link")
	if err = os.Symlink(rawRoot, rawLink); err != nil {
		t.Skipf("symbolic links unavailable: %v", err)
	}
	if err = os.Symlink(managedRoot, managedLink); err != nil {
		t.Skipf("symbolic links unavailable: %v", err)
	}

	for name, destination := range map[string]string{
		"encrypted raw path":         filepath.Join(rawRoot, "report.zip"),
		"encrypted raw path symlink": filepath.Join(rawLink, "report.zip"),
		"managed export root":        filepath.Join(managedRoot, "report.zip"),
		"managed export symlink":     filepath.Join(managedLink, "report.zip"),
	} {
		t.Run(name, func(t *testing.T) {
			if accepted, validateErr := ValidatePlaintextExportDestination(destination); validateErr == nil {
				t.Fatalf("controlled destination accepted as %q", accepted)
			}
		})
	}
}

func assertManagedExportFileContent(t *testing.T, path, expected string) {
	t.Helper()
	content, err := os.ReadFile(path)
	if err != nil || string(content) != expected {
		t.Fatalf("managed export file [%s] = %q, %v; want %q", path, content, err, expected)
	}
}

func TestCopyExportResourceDirectory(t *testing.T) {
	source := filepath.Join(t.TempDir(), "assets")
	nested := filepath.Join(source, "nested")
	if err := os.MkdirAll(nested, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(nested, "resource.txt"), []byte("content"), 0600); err != nil {
		t.Fatal(err)
	}

	destination := filepath.Join(t.TempDir(), "export")
	if err := copyExportResource(&exportReadContext{}, source, destination); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(filepath.Join(destination, "nested", "resource.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "content" {
		t.Fatalf("unexpected copied content: %q", content)
	}
}

func TestUniqueExportFilePath(t *testing.T) {
	destination := filepath.Join(t.TempDir(), "resource.txt")
	if err := os.WriteFile(destination, []byte("first"), 0600); err != nil {
		t.Fatal(err)
	}
	if actual := uniqueExportFilePath(destination); actual != filepath.Join(filepath.Dir(destination), "resource (2).txt") {
		t.Fatalf("unexpected unique export path: %s", actual)
	}
}

func TestExportStageIsSingleUseAndBoundToExactNotebook(t *testing.T) {
	previousTempDir := util.TempDir
	util.TempDir = t.TempDir()
	t.Cleanup(func() { util.TempDir = previousTempDir })

	token, directory, err := CreateExportStage("20260716090000-boxxxxx", "html")
	if err != nil {
		t.Fatalf("create export stage: %v", err)
	}
	if token == "" || directory == "" {
		t.Fatal("export stage did not return a token and directory")
	}
	t.Cleanup(func() {
		if claim, ok := TakeExportStage(token, "20260716090000-boxxxxx"); ok {
			_ = claim.Close()
		}
	})
	if _, ok := TakeExportStage("../"+token, "20260716090000-boxxxxx"); ok {
		t.Fatal("path-like client input resolved an export stage")
	}
	if _, ok := TakeExportStage(token, "20260716090000-boxxxxx"); ok {
		t.Fatal("building export stage was claimable before completion")
	}
	if err = CompleteExportStage(token, "20260716090000-boxxxxx"); err != nil {
		t.Fatalf("complete export stage: %v", err)
	}
	if _, ok := TakeExportStage(token, "20260716090001-otherxx"); ok {
		t.Fatal("export stage resolved for a different declared notebook")
	}
	claim, ok := TakeExportStage(token, "20260716090000-boxxxxx")
	if !ok || claim.Directory != directory {
		t.Fatalf("export stage resolved to %#v, want directory %q", claim, directory)
	}
	if err = claim.Close(); err != nil {
		t.Fatalf("close export stage: %v", err)
	}
	if _, ok = TakeExportStage(token, "20260716090000-boxxxxx"); ok {
		t.Fatal("consumed export stage resolved a second time")
	}
}

func TestExpiredExportEntriesArePrunedOnRegistryUse(t *testing.T) {
	previousTempDir := util.TempDir
	previousNow := encryptedExportNow
	util.TempDir = t.TempDir()
	now := time.Date(2026, 7, 16, 12, 0, 0, 0, time.UTC)
	encryptedExportNow = func() time.Time { return now }
	t.Cleanup(func() {
		encryptedExportNow = previousNow
		util.TempDir = previousTempDir
	})

	oldToken, oldStage, err := CreateExportStage("20260716090000-boxxxxx", "html")
	if err != nil {
		t.Fatalf("create old export stage: %v", err)
	}
	t.Cleanup(func() {
		if claim, ok := TakeExportStage(oldToken, "20260716090000-boxxxxx"); ok {
			_ = claim.Close()
		}
	})
	if err = CompleteExportStage(oldToken, "20260716090000-boxxxxx"); err != nil {
		t.Fatalf("complete old export stage: %v", err)
	}
	boxID := "20260716090000-boxxxxx"
	artifactRoot := filepath.Join(util.TempDir, "export", boxID, "html")
	if err = os.MkdirAll(artifactRoot, 0755); err != nil {
		t.Fatalf("create managed artifact root: %v", err)
	}
	oldArtifact := filepath.Join(artifactRoot, "old.zip")
	if err = os.WriteFile(oldArtifact, []byte("old"), 0600); err != nil {
		t.Fatalf("write old managed artifact: %v", err)
	}
	oldManagedPath, err := RegisterManagedEncryptedExport(boxID, "html", oldArtifact, "old.zip")
	if err != nil {
		t.Fatalf("register old managed artifact: %v", err)
	}
	t.Cleanup(func() { RevokeManagedEncryptedExportsForBox(boxID) })

	now = now.Add(encryptedExportTTL + time.Second)
	newToken, newStage, err := CreateExportStage("20260716090000-boxxxxx", "html")
	if err != nil {
		t.Fatalf("create new export stage: %v", err)
	}
	t.Cleanup(func() {
		if claim, ok := TakeExportStage(newToken, "20260716090000-boxxxxx"); ok {
			_ = claim.Close()
		}
	})
	if err = CompleteExportStage(newToken, "20260716090000-boxxxxx"); err != nil {
		t.Fatalf("complete new export stage: %v", err)
	}
	newArtifact := filepath.Join(artifactRoot, "new.zip")
	if err = os.WriteFile(newArtifact, []byte("new"), 0600); err != nil {
		t.Fatalf("write new managed artifact: %v", err)
	}
	newManagedPath, err := RegisterManagedEncryptedExport(boxID, "html", newArtifact, "new.zip")
	if err != nil {
		t.Fatalf("register new managed artifact: %v", err)
	}
	t.Cleanup(func() {
		RevokeManagedEncryptedExportsForBox(boxID)
		_ = os.Remove(newArtifact)
	})

	if _, ok := TakeExportStage(oldToken, "20260716090000-boxxxxx"); ok {
		t.Fatal("expired export stage remained registered")
	}
	if _, err = os.Stat(oldStage); !os.IsNotExist(err) {
		t.Fatalf("expired export stage was not removed: %v", err)
	}
	if _, claimErr := ClaimManagedEncryptedExport(oldManagedPath); !errors.Is(claimErr, ErrManagedEncryptedExportUnavailable) {
		t.Fatal("expired managed artifact remained registered")
	}
	if _, err = os.Stat(oldArtifact); !os.IsNotExist(err) {
		t.Fatalf("expired managed artifact was not removed: %v", err)
	}
	stageClaim, ok := TakeExportStage(newToken, "20260716090000-boxxxxx")
	if !ok || stageClaim.Directory != newStage {
		t.Fatalf("current export stage = %#v, %t; want %q, true", stageClaim, ok, newStage)
	}
	if closeErr := stageClaim.Close(); closeErr != nil {
		t.Fatalf("close current export stage: %v", closeErr)
	}
	claim, claimErr := ClaimManagedEncryptedExport(newManagedPath)
	if claimErr != nil {
		t.Fatalf("claim current managed artifact: %v", claimErr)
	}
	if closeErr := claim.Close(); closeErr != nil {
		t.Fatalf("close current managed artifact claim: %v", closeErr)
	}
}

func TestExportStageRevocationDoesNotDeleteReplacementDirectory(t *testing.T) {
	previousTempDir := util.TempDir
	util.TempDir = t.TempDir()
	t.Cleanup(func() { util.TempDir = previousTempDir })
	boxID := "20260716090000-boxxxxx"

	token, directory, err := CreateExportStage(boxID, "html")
	if err != nil {
		t.Fatal(err)
	}
	original := directory + "-registered"
	if err = os.Rename(directory, original); err != nil {
		t.Fatal(err)
	}
	if err = os.MkdirAll(directory, 0755); err != nil {
		t.Fatal(err)
	}
	replacement := filepath.Join(directory, "replacement.txt")
	if err = os.WriteFile(replacement, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}

	RevokeManagedEncryptedExportsForBox(boxID)
	assertManagedExportFileContent(t, replacement, "keep")
	if _, err = os.Stat(original); err != nil {
		t.Fatalf("registered stage directory changed: %v", err)
	}
	if _, ok := TakeExportStage(token, boxID); ok {
		t.Fatal("revoked replacement stage remained claimable")
	}
}
