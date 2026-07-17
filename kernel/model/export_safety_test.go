package model

import (
	archivezip "archive/zip"
	"errors"
	"io"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/88250/lute/ast"
	"github.com/88250/lute/parse"
	"github.com/siyuan-note/riff"
	"github.com/siyuan-note/siyuan/kernel/cache"
	"github.com/siyuan-note/siyuan/kernel/conf"
	"github.com/siyuan-note/siyuan/kernel/filesys"
	"github.com/siyuan-note/siyuan/kernel/treenode"
	"github.com/siyuan-note/siyuan/kernel/util"
)

func TestEncryptedExportAssetLookupDoesNotFallbackToOrdinaryStore(t *testing.T) {
	boxID, _ := setupEncryptedAssetStoreTest(t)
	relativePath := "assets/collision.txt"
	ordinaryPath := filepath.Join(util.DataDir, relativePath)
	if err := os.MkdirAll(filepath.Dir(ordinaryPath), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(ordinaryPath, []byte("ordinary"), 0644); err != nil {
		t.Fatal(err)
	}
	ordinaryAssets := map[string]string{relativePath: ordinaryPath}

	source, err := resolveExportAssetSource(relativePath, boxID, ordinaryAssets)
	if err == nil {
		t.Fatal("missing encrypted asset resolved through the ordinary asset store")
	}
	if source != "" {
		t.Fatalf("missing encrypted asset resolved to %q", source)
	}

	source, err = resolveExportAssetSource(relativePath, "", ordinaryAssets)
	if err != nil || source != ordinaryPath {
		t.Fatalf("ordinary export source = %q, %v; want %q", source, err, ordinaryPath)
	}
}

func TestExportZipClosesOnEntryFailure(t *testing.T) {
	partialPath := filepath.Join(t.TempDir(), "export.zip.partial")
	finalPath := filepath.Join(filepath.Dir(partialPath), "export.zip")
	archive, err := os.Create(partialPath)
	if err != nil {
		t.Fatal(err)
	}
	entryErr := errors.New("add entry failed")

	err = writeAndPublishExportZip(archive, partialPath, finalPath, func() error {
		return entryErr
	})
	if !errors.Is(err, entryErr) {
		t.Fatalf("archive failure = %v, want %v", err, entryErr)
	}
	if _, writeErr := archive.Write([]byte("still open")); writeErr == nil {
		t.Fatal("archive remained open after entry failure")
	}
	if _, statErr := os.Stat(finalPath); !os.IsNotExist(statErr) {
		t.Fatalf("failed archive was published: %v", statErr)
	}
	if _, statErr := os.Stat(partialPath); !os.IsNotExist(statErr) {
		t.Fatalf("failed archive partial remained: %v", statErr)
	}
}

func TestExportZipCloseFailureDoesNotPublish(t *testing.T) {
	partialPath := filepath.Join(t.TempDir(), "export.zip.partial")
	finalPath := filepath.Join(filepath.Dir(partialPath), "export.zip")
	archive, err := os.Create(partialPath)
	if err != nil {
		t.Fatal(err)
	}
	if err = archive.Close(); err != nil {
		t.Fatal(err)
	}

	err = writeAndPublishExportZip(archive, partialPath, finalPath, func() error { return nil })
	if err == nil {
		t.Fatal("archive close failure was ignored")
	}
	if _, statErr := os.Stat(finalPath); !os.IsNotExist(statErr) {
		t.Fatalf("archive with a failed Close was published: %v", statErr)
	}
	if _, statErr := os.Stat(partialPath); !os.IsNotExist(statErr) {
		t.Fatalf("failed archive partial remained: %v", statErr)
	}
}

func TestExportStagingCleanupRemovesStageAndPartial(t *testing.T) {
	root := t.TempDir()
	stagingDir := filepath.Join(root, "staging")
	partialPath := filepath.Join(root, "export.zip.partial")
	if err := os.MkdirAll(stagingDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stagingDir, "plain.sy"), []byte("plaintext"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(partialPath, []byte("partial"), 0600); err != nil {
		t.Fatal(err)
	}

	cleanupExportStaging(stagingDir, partialPath)
	if _, err := os.Stat(stagingDir); !os.IsNotExist(err) {
		t.Fatalf("export staging remained after cleanup: %v", err)
	}
	if _, err := os.Stat(partialPath); !os.IsNotExist(err) {
		t.Fatalf("export partial remained after cleanup: %v", err)
	}
}

func TestOrdinaryExportZipPathPreservesExistingArchive(t *testing.T) {
	candidate := filepath.Join(t.TempDir(), "export.zip")
	oldContent := []byte("completed archive")
	if err := os.WriteFile(candidate, oldContent, 0600); err != nil {
		t.Fatal(err)
	}

	got := uniqueExportZipPath(candidate, false)
	if got == candidate {
		t.Fatalf("ordinary export reused existing archive path %q", candidate)
	}
	content, err := os.ReadFile(candidate)
	if err != nil || string(content) != string(oldContent) {
		t.Fatalf("existing archive changed: content=%q err=%v", content, err)
	}
	if gotEncrypted := uniqueExportZipPath(candidate, true); gotEncrypted != candidate {
		t.Fatalf("encrypted random archive path changed from %q to %q", candidate, gotEncrypted)
	}
}

func TestOrdinaryResourceExportKeepsDisplayNameOutsideRandomDirectory(t *testing.T) {
	previousWorkspaceDir := util.WorkspaceDir
	previousTempDir := util.TempDir
	previousConf := Conf
	root := t.TempDir()
	util.WorkspaceDir = root
	util.TempDir = filepath.Join(root, "temp")
	Conf = NewAppConf()
	Conf.Export = conf.NewExport()
	t.Cleanup(func() {
		Conf = previousConf
		util.TempDir = previousTempDir
		util.WorkspaceDir = previousWorkspaceDir
	})
	resource := filepath.Join(root, "resource.txt")
	if err := os.WriteFile(resource, []byte("resource content"), 0600); err != nil {
		t.Fatal(err)
	}

	downloadPath, err := ExportResources([]string{"resource.txt"}, "Readable Report")
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := url.PathUnescape(strings.TrimPrefix(downloadPath, "/export/"))
	if err != nil {
		t.Fatal(err)
	}
	if path.Base(decoded) != "Readable Report.zip" || path.Dir(decoded) == "." {
		t.Fatalf("ordinary resource download path = %q, want random directory with clean basename", downloadPath)
	}
	archivePath := filepath.Join(util.TempDir, "export", filepath.FromSlash(decoded))
	archive, err := archivezip.OpenReader(archivePath)
	if err != nil {
		t.Fatalf("open ordinary resource archive: %v", err)
	}
	if err = archive.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestRepeatedEncryptedCodeBlockExportsKeepBothCapabilitiesClaimable(t *testing.T) {
	fixture := setupHeadingNotebookFixture(t)
	ensureExportTestConf()
	previousNow := encryptedExportNow
	encryptedExportNow = func() time.Time {
		return time.Date(2026, 7, 16, 12, 0, 0, 0, time.UTC)
	}
	t.Cleanup(func() { encryptedExportNow = previousNow })

	const (
		rootID  = "20990101123000-coderot"
		blockID = "20990101123001-codeblk"
	)
	treePath := "/" + rootID + ".sy"
	tree := treenode.NewTree(fixture.encryptedBox, treePath, "/Code Export", "Code Export")
	tree.Root.FirstChild.Unlink()
	tree.Root.ID = rootID
	tree.ID = rootID
	tree.Root.SetIALAttr("id", rootID)
	codeBlock := &ast.Node{Type: ast.NodeCodeBlock, ID: blockID, Box: fixture.encryptedBox, Path: treePath}
	codeBlock.SetIALAttr("id", blockID)
	codeBlock.SetIALAttr("updated", blockID[:14])
	codeBlock.AppendChild(&ast.Node{Type: ast.NodeCodeBlockCode, Tokens: []byte("same timestamp content")})
	tree.Root.AppendChild(codeBlock)
	if _, err := filesys.WriteTree(tree); err != nil {
		t.Fatalf("write encrypted code block fixture: %v", err)
	}
	if err := treenode.UpsertBlockTree(tree); err != nil {
		t.Fatalf("index encrypted code block fixture: %v", err)
	}

	firstPath, err := ExportCodeBlockInBox(blockID, fixture.encryptedBox)
	if err != nil {
		t.Fatalf("first encrypted code export: %v", err)
	}
	secondPath, err := ExportCodeBlockInBox(blockID, fixture.encryptedBox)
	if err != nil {
		t.Fatalf("second encrypted code export: %v", err)
	}
	if firstPath == secondPath {
		t.Fatalf("repeated encrypted code exports reused capability %q", firstPath)
	}

	first, err := ClaimManagedEncryptedExport(strings.TrimPrefix(firstPath, "/export/"))
	if err != nil {
		t.Fatalf("claim first encrypted code export: %v", err)
	}
	second, err := ClaimManagedEncryptedExport(strings.TrimPrefix(secondPath, "/export/"))
	if err != nil {
		_ = first.Close()
		t.Fatalf("claim second encrypted code export: %v", err)
	}
	firstData, firstReadErr := io.ReadAll(first.File)
	secondData, secondReadErr := io.ReadAll(second.File)
	closeErr := errors.Join(first.Close(), second.Close())
	if err = errors.Join(firstReadErr, secondReadErr, closeErr); err != nil {
		t.Fatalf("read repeated encrypted code exports: %v", err)
	}
	if string(firstData) != "same timestamp content" || string(secondData) != "same timestamp content" {
		t.Fatalf("repeated encrypted code export content = %q, %q", firstData, secondData)
	}
}

func TestExportDataPublishesUniqueCompleteArchives(t *testing.T) {
	previousWorkspaceDir := util.WorkspaceDir
	previousWorkspaceName := util.WorkspaceName
	previousTempDir := util.TempDir
	previousConf := Conf
	root := t.TempDir()
	util.WorkspaceDir = root
	util.WorkspaceName = "DataExportContract"
	util.TempDir = filepath.Join(root, "temp")
	Conf = NewAppConf()
	t.Cleanup(func() {
		Conf = previousConf
		util.TempDir = previousTempDir
		util.WorkspaceName = previousWorkspaceName
		util.WorkspaceDir = previousWorkspaceDir
	})
	dataDir := filepath.Join(root, "data")
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, "note.txt"), []byte("durable data export"), 0600); err != nil {
		t.Fatal(err)
	}

	first, err := ExportData()
	if err != nil {
		t.Fatalf("first data export: %v", err)
	}
	second, err := ExportData()
	if err != nil {
		t.Fatalf("second data export: %v", err)
	}
	if first == second {
		t.Fatalf("two data exports reused download path %q", first)
	}
	for _, downloadPath := range []string{first, second} {
		archivePath := dataExportArchivePath(t, downloadPath)
		archive, openErr := archivezip.OpenReader(archivePath)
		if openErr != nil {
			t.Fatalf("open data export %q: %v", archivePath, openErr)
		}
		found := false
		for _, entry := range archive.File {
			if !strings.HasSuffix(entry.Name, "/note.txt") {
				continue
			}
			reader, entryErr := entry.Open()
			if entryErr != nil {
				t.Fatal(entryErr)
			}
			content, readErr := io.ReadAll(reader)
			closeErr := reader.Close()
			if readErr != nil || closeErr != nil || string(content) != "durable data export" {
				t.Fatalf("data export entry: content=%q read=%v close=%v", content, readErr, closeErr)
			}
			found = true
			break
		}
		if closeErr := archive.Close(); closeErr != nil {
			t.Fatal(closeErr)
		}
		if !found {
			t.Fatalf("data export %q omitted note.txt", archivePath)
		}
	}

	entries, err := os.ReadDir(filepath.Join(util.TempDir, "export"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("data export directory entries = %v, want two completed archives", entries)
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".zip") || strings.HasSuffix(entry.Name(), ".partial") {
			t.Fatalf("data export left unpublished artifact %q", entry.Name())
		}
		base := strings.TrimSuffix(strings.TrimPrefix(entry.Name(), "DataExportContract-"), ".zip")
		if len(base) <= 15 || base[14] != '-' {
			t.Fatalf("data export name %q has no unique suffix", entry.Name())
		}
	}
}

func TestExportDataFailureCleansStagingAndPartial(t *testing.T) {
	previousWorkspaceDir := util.WorkspaceDir
	previousConf := Conf
	util.WorkspaceDir = t.TempDir()
	Conf = NewAppConf()
	t.Cleanup(func() {
		Conf = previousConf
		util.WorkspaceDir = previousWorkspaceDir
	})
	exportFolder := filepath.Join(t.TempDir(), "failed-data-export")

	if _, err := exportData(exportFolder); err == nil {
		t.Fatal("data export without a workspace data directory unexpectedly succeeded")
	}
	for _, path := range []string{exportFolder, exportFolder + ".zip.partial", exportFolder + ".zip"} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("failed data export artifact remains at %q: %v", path, err)
		}
	}
}

func dataExportArchivePath(t *testing.T, downloadPath string) string {
	t.Helper()
	const prefix = "/export/"
	if !strings.HasPrefix(downloadPath, prefix) {
		t.Fatalf("data export path = %q, want %s prefix", downloadPath, prefix)
	}
	name, err := url.PathUnescape(strings.TrimPrefix(downloadPath, prefix))
	if err != nil {
		t.Fatal(err)
	}
	return filepath.Join(util.TempDir, "export", name)
}

func TestOrdinarySYExportFailureCleansStaleStaging(t *testing.T) {
	fixture := setupHeadingNotebookFixture(t)
	openExportTestBox(t, fixture.ordinaryBox)
	const baseFolderName = "stale-sy-export"
	stagingDir := filepath.Join(util.TempDir, "export", baseFolderName)
	partialPath := stagingDir + ".sy.zip.partial"
	writeStaleExportStage(t, stagingDir, partialPath)

	_, err := exportSYZip(fixture.ordinaryBox, "/", baseFolderName, []string{"/20990101129999-missing.sy"})
	if err == nil {
		t.Fatal("ordinary SY export unexpectedly succeeded with a missing source tree")
	}
	assertExportStageRemoved(t, stagingDir, partialPath)
}

func TestOrdinaryPandocExportFailureCleansStaleStaging(t *testing.T) {
	fixture := setupHeadingNotebookFixture(t)
	openExportTestBox(t, fixture.ordinaryBox)
	const baseFolderName = "stale-pandoc-export"
	stagingDir := filepath.Join(util.TempDir, "export", baseFolderName+".md")
	partialPath := stagingDir + ".zip.partial"
	writeStaleExportStage(t, stagingDir, partialPath)

	_, err := exportPandocConvertZip(fixture.ordinaryBox, baseFolderName,
		[]string{"/20990101129999-missing.sy"}, nil, "gfm+footnotes+hard_line_breaks", "", ".md", nil)
	if err == nil {
		t.Fatal("ordinary Pandoc export unexpectedly succeeded with a missing source tree")
	}
	assertExportStageRemoved(t, stagingDir, partialPath)
}

func TestExportRefTreesReturnsReferencedTreeLoadError(t *testing.T) {
	fixture := setupHeadingNotebookFixture(t)
	ensureExportTestConf()
	blockTree := treenode.GetBlockTreeInBox(fixture.ordinaryChildID, "")
	if blockTree == nil {
		t.Fatal("missing referenced block tree fixture")
	}
	sourcePath := filepath.Join(util.DataDir, fixture.ordinaryBox, filepath.FromSlash(strings.TrimPrefix(blockTree.Path, "/")))
	if err := os.Remove(sourcePath); err != nil {
		t.Fatalf("remove referenced source tree: %v", err)
	}
	cache.ClearTreeCache()

	sourceTree := treenode.NewTree(fixture.ordinaryBox, "/20990101129800-source.sy", "/Source", "Source")
	sourceTree.Root.AppendChild(&ast.Node{
		Type:                    ast.NodeTextMark,
		TextMarkType:            "block-ref",
		TextMarkBlockRefID:      fixture.ordinaryChildID,
		TextMarkBlockRefSubtype: "d",
	})
	ctx := &exportReadContext{declaredBoxID: fixture.ordinaryBox, options: effectiveExportConfig(nil)}
	err := exportRefTrees(ctx, sourceTree, &[]string{}, map[string]*parse.Tree{})
	if err == nil {
		t.Fatal("referenced tree load failure was swallowed")
	}
}

func TestDocSaveAsTemplateReturnsSourceLoadError(t *testing.T) {
	fixture := setupHeadingNotebookFixture(t)
	ensureExportTestConf()
	blockTree := treenode.GetBlockTreeInBox(fixture.ordinaryChildID, "")
	if blockTree == nil {
		t.Fatal("missing template block tree fixture")
	}
	sourcePath := filepath.Join(util.DataDir, fixture.ordinaryBox, filepath.FromSlash(strings.TrimPrefix(blockTree.Path, "/")))
	if err := os.Remove(sourcePath); err != nil {
		t.Fatalf("remove template source tree: %v", err)
	}
	cache.ClearTreeCache()

	if _, err := DocSaveAsTemplate(fixture.ordinaryChildID, "missing-source", false); err == nil {
		t.Fatal("template save swallowed its source tree load failure")
	}
	if _, err := DocSaveAsTemplate("20990101129998-unknown", "missing-block", false); !errors.Is(err, ErrBlockNotFound) {
		t.Fatalf("missing template block error = %v, want ErrBlockNotFound", err)
	}
}

func writeStaleExportStage(t *testing.T, stagingDir, partialPath string) {
	t.Helper()
	if err := os.MkdirAll(stagingDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stagingDir, "stale.txt"), []byte("stale"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(partialPath, []byte("partial"), 0600); err != nil {
		t.Fatal(err)
	}
}

func assertExportStageRemoved(t *testing.T, stagingDir, partialPath string) {
	t.Helper()
	if _, err := os.Stat(stagingDir); !os.IsNotExist(err) {
		t.Fatalf("export staging remained after failure: %v", err)
	}
	if _, err := os.Stat(partialPath); !os.IsNotExist(err) {
		t.Fatalf("export partial remained after failure: %v", err)
	}
}

func openExportTestBox(t *testing.T, boxID string) {
	t.Helper()
	ensureExportTestConf()
	box := &Box{ID: boxID}
	boxConf := box.GetConf()
	boxConf.Closed = false
	if err := box.SaveConf(boxConf); err != nil {
		t.Fatalf("open export test notebook: %v", err)
	}
}

func ensureExportTestConf() {
	if Conf.Export == nil {
		Conf.Export = conf.NewExport()
	}
	if Conf.Editor == nil {
		Conf.Editor = conf.NewEditor()
	}
	if Conf.Flashcard == nil {
		Conf.Flashcard = conf.NewFlashcard()
	}
}

func TestSYZipFlashcardsRouteDuplicateRootByNotebook(t *testing.T) {
	fixture := setupHeadingNotebookFixture(t)
	const (
		rootID             = "20990101122000-samroot"
		ordinaryHeadingID  = "20990101122001-ordhead"
		ordinaryBlockID    = "20990101122002-ordcard"
		encryptedHeadingID = "20990101122003-enchead"
		encryptedBlockID   = "20990101122004-enccard"
	)
	writeHeadingTreeFixture(t, fixture.ordinaryBox, rootID, ordinaryHeadingID, ordinaryBlockID, "Ordinary cards", "Ordinary card")
	writeHeadingTreeFixture(t, fixture.encryptedBox, rootID, encryptedHeadingID, encryptedBlockID, "Encrypted cards", "Encrypted card")

	flashcardConf := conf.NewFlashcard()
	deck, err := riff.LoadDeck(t.TempDir(), builtinDeckID, flashcardConf.RequestRetention, flashcardConf.MaximumInterval, flashcardConf.Weights)
	if err != nil {
		t.Fatal(err)
	}
	deck.AddCard("20990101122100-card001", ordinaryBlockID)
	deck.AddCard("20990101122101-card002", encryptedBlockID)
	previousDecks := Decks
	Decks = map[string]*riff.Deck{builtinDeckID: deck}
	t.Cleanup(func() { Decks = previousDecks })

	blockIDs := func(cards []riff.Card) map[string]bool {
		ret := map[string]bool{}
		for _, card := range cards {
			ret[card.BlockID()] = true
		}
		return ret
	}
	ordinaryCards := blockIDs(getTreeFlashcardsInBox(rootID, ""))
	encryptedCards := blockIDs(getTreeFlashcardsInBox(rootID, fixture.encryptedBox))

	if len(ordinaryCards) != 1 || !ordinaryCards[ordinaryBlockID] || ordinaryCards[encryptedBlockID] {
		t.Fatalf("ordinary .sy.zip flashcards crossed content stores: %#v", ordinaryCards)
	}
	if len(encryptedCards) != 1 || encryptedCards[ordinaryBlockID] || !encryptedCards[encryptedBlockID] {
		t.Fatalf("encrypted .sy.zip flashcards crossed content stores: %#v", encryptedCards)
	}
}
