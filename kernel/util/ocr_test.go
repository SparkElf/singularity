package util

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCanonicalAssetTextKey(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
		ok    bool
	}{
		{name: "global", input: "assets/image.png", want: "assets/image.png", ok: true},
		{name: "notebook local", input: "20990720010101-ocrbox1/assets/image.png", want: "20990720010101-ocrbox1/assets/image.png", ok: true},
		{name: "document local", input: "20990720010101-ocrbox1/folder/assets/image.png", want: "20990720010101-ocrbox1/folder/assets/image.png", ok: true},
		{name: "path alias", input: "assets/nested/../image.png", want: "assets/image.png", ok: true},
		{name: "render query", input: "assets/image.png?page=2#preview", want: "assets/image.png", ok: true},
		{name: "box query", input: "assets/image.png?box=20990720010101-ocrbox1", ok: false},
		{name: "outside", input: "assets/../../private.png", ok: false},
		{name: "absolute", input: "/assets/image.png", ok: false},
		{name: "not asset", input: "storage/image.png", ok: false},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, ok := CanonicalAssetTextKey(test.input)
			if ok != test.ok || got != test.want {
				t.Fatalf("CanonicalAssetTextKey(%q) = (%q, %v), want (%q, %v)", test.input, got, ok, test.want, test.ok)
			}
		})
	}
}

func TestCanonicalizeLoadedAssetTextsPrefersCanonicalSource(t *testing.T) {
	loaded := map[string]string{
		"assets/image.png":                              "canonical",
		"assets/nested/../image.png":                    "alias",
		"assets/private.png?box=20990720010101-ocrbox1": "scoped",
	}

	canonical, migrated := canonicalizeLoadedAssetTexts(loaded)
	if !migrated {
		t.Fatal("legacy OCR keys were not marked for migration")
	}
	if len(canonical) != 1 || canonical["assets/image.png"] != "canonical" {
		t.Fatalf("canonical OCR map = %#v", canonical)
	}
}

func TestResolveAssetTextKeyUsesDocumentAndBoxIdentity(t *testing.T) {
	previousDataDir := DataDir
	previousIsEncryptedBox := IsEncryptedBoxFn
	DataDir = t.TempDir()
	IsEncryptedBoxFn = func(string) bool { return false }
	t.Cleanup(func() {
		DataDir = previousDataDir
		IsEncryptedBoxFn = previousIsEncryptedBox
	})

	const (
		boxID        = "20990720010101-ocrbox1"
		otherBoxID   = "20990720010102-ocrbox2"
		documentPath = "/folder/document.sy"
	)
	paths := []string{
		filepath.Join(DataDir, boxID, "folder", "assets", "local.png"),
		filepath.Join(DataDir, boxID, "assets", "notebook.png"),
		filepath.Join(DataDir, "assets", "global.png"),
		filepath.Join(DataDir, otherBoxID, "assets", "other.png"),
	}
	for _, assetPath := range paths {
		if err := os.MkdirAll(filepath.Dir(assetPath), 0755); err != nil {
			t.Fatalf("create asset directory: %v", err)
		}
		if err := os.WriteFile(assetPath, []byte("asset"), 0600); err != nil {
			t.Fatalf("write asset: %v", err)
		}
	}

	for _, test := range []struct {
		asset string
		want  string
		ok    bool
	}{
		{asset: "assets/local.png", want: boxID + "/folder/assets/local.png", ok: true},
		{asset: "assets/notebook.png", want: boxID + "/assets/notebook.png", ok: true},
		{asset: "assets/global.png", want: "assets/global.png", ok: true},
		{asset: "assets/local.png?box=" + boxID, want: boxID + "/folder/assets/local.png", ok: true},
		{asset: "assets/global.png?box=" + boxID, ok: false},
		{asset: "assets/other.png?box=" + otherBoxID, ok: false},
	} {
		got, ok := ResolveAssetTextKey(test.asset, boxID, documentPath)
		if got != test.want || ok != test.ok {
			t.Errorf("ResolveAssetTextKey(%q) = (%q, %v), want (%q, %v)", test.asset, got, ok, test.want, test.ok)
		}
	}
}

func TestEncryptedAssetTextKeysFailClosed(t *testing.T) {
	const encryptedBoxID = "20990720010103-ocrcryp"
	assetKey := encryptedBoxID + "/assets/legacy.png"
	previousIsEncryptedBox := IsEncryptedBoxFn
	IsEncryptedBoxFn = func(boxID string) bool { return boxID == encryptedBoxID }
	assetsTextsLock.Lock()
	previousTexts := assetsTexts
	assetsTexts = map[string]string{assetKey: "legacy plaintext OCR"}
	assetsTextsLock.Unlock()
	t.Cleanup(func() {
		assetsTextsLock.Lock()
		assetsTexts = previousTexts
		assetsTextsLock.Unlock()
		IsEncryptedBoxFn = previousIsEncryptedBox
	})

	if ExistsAssetText(assetKey) || GetAssetText(assetKey) != "" {
		t.Fatal("legacy encrypted OCR text was readable")
	}
	SetAssetText(assetKey, "new plaintext OCR")
	if GetAssetText(assetKey) != "" {
		t.Fatal("encrypted OCR text was persisted")
	}
	canonical, migrated := canonicalizeLoadedAssetTexts(map[string]string{assetKey: "legacy plaintext OCR"})
	if !migrated || len(canonical) != 0 {
		t.Fatalf("encrypted OCR migration = (%#v, %v), want empty migrated map", canonical, migrated)
	}
}

func TestOCRSourceAndSnapshotStayInsideAssetRoot(t *testing.T) {
	previousDataDir := DataDir
	previousTempDir := TempDir
	previousWorkspaceDir := WorkspaceDir
	previousMaximum := TesseractMaxSize
	previousIsEncryptedBox := IsEncryptedBoxFn
	workspace := t.TempDir()
	DataDir = filepath.Join(workspace, "data")
	TempDir = filepath.Join(workspace, "temp")
	WorkspaceDir = workspace
	TesseractMaxSize = 16
	IsEncryptedBoxFn = func(string) bool { return false }
	t.Cleanup(func() {
		DataDir = previousDataDir
		TempDir = previousTempDir
		WorkspaceDir = previousWorkspaceDir
		TesseractMaxSize = previousMaximum
		IsEncryptedBoxFn = previousIsEncryptedBox
	})
	if err := os.MkdirAll(filepath.Join(DataDir, "assets"), 0755); err != nil {
		t.Fatalf("create data assets: %v", err)
	}
	if err := os.MkdirAll(TempDir, 0755); err != nil {
		t.Fatalf("create OCR temp directory: %v", err)
	}
	assetPath := filepath.Join(DataDir, "assets", "source.png")
	if err := os.WriteFile(assetPath, []byte("image"), 0600); err != nil {
		t.Fatalf("write OCR source: %v", err)
	}
	source, err := openOCRSource(assetPath)
	if err != nil {
		t.Fatalf("open OCR source: %v", err)
	}
	snapshotPath, size, cleanup, err := createOCRSnapshot(assetPath, source)
	if closeErr := source.Close(); closeErr != nil {
		t.Fatalf("close OCR source: %v", closeErr)
	}
	if err != nil || size != 5 {
		t.Fatalf("create OCR snapshot = (%q, %d, %v)", snapshotPath, size, err)
	}
	cleanup()
	if _, err = os.Stat(snapshotPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("OCR snapshot remained after cleanup: %v", err)
	}
	TesseractMaxSize = 4
	source, err = openOCRSource(assetPath)
	if err != nil {
		t.Fatalf("reopen OCR source: %v", err)
	}
	_, _, cleanup, snapshotErr := createOCRSnapshot(assetPath, source)
	if closeErr := source.Close(); closeErr != nil {
		t.Fatalf("close oversized OCR source: %v", closeErr)
	}
	cleanup()
	if snapshotErr == nil {
		t.Fatal("oversized OCR source produced a snapshot")
	}

	outsidePath := filepath.Join(workspace, "outside.png")
	if err = os.WriteFile(outsidePath, []byte("private"), 0600); err != nil {
		t.Fatalf("write outside source: %v", err)
	}
	symlinkPath := filepath.Join(DataDir, "assets", "linked.png")
	if err = os.Symlink(outsidePath, symlinkPath); err != nil {
		t.Skipf("symbolic links are unavailable: %v", err)
	}
	if linked, openErr := openOCRSource(symlinkPath); openErr == nil {
		_ = linked.Close()
		t.Fatal("OCR source followed a symbolic link")
	}
}

func TestSanitizedOCRErrorCausesRedactsWorkspacePaths(t *testing.T) {
	previousWorkspaceDir := WorkspaceDir
	WorkspaceDir = t.TempDir()
	t.Cleanup(func() { WorkspaceDir = previousWorkspaceDir })
	pathError := &os.PathError{
		Op:   "open",
		Path: filepath.Join(WorkspaceDir, "private", "asset.png"),
		Err:  os.ErrPermission,
	}
	causes := sanitizedOCRErrorCauses(errors.Join(errors.New("snapshot failed"), pathError))
	if strings.Contains(causes, WorkspaceDir) || !strings.Contains(causes, "permission denied") {
		t.Fatalf("sanitized OCR causes = %q", causes)
	}
}
