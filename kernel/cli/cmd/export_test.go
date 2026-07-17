package cmd

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/88250/lute/ast"
	"github.com/siyuan-note/siyuan/kernel/cache"
	"github.com/siyuan-note/siyuan/kernel/conf"
	"github.com/siyuan-note/siyuan/kernel/filesys"
	"github.com/siyuan-note/siyuan/kernel/model"
	"github.com/siyuan-note/siyuan/kernel/treenode"
	"github.com/siyuan-note/siyuan/kernel/util"
)

func TestFinishExportFilePrintsAbsolutePhysicalPath(t *testing.T) {
	previousTempDir := util.TempDir
	util.TempDir = t.TempDir()
	t.Cleanup(func() { util.TempDir = previousTempDir })
	source := filepath.Join(util.TempDir, "export", "name x.zip")
	if err := os.MkdirAll(filepath.Dir(source), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(source, []byte("completed export"), 0600); err != nil {
		t.Fatal(err)
	}

	stdout := &bytes.Buffer{}
	if err := finishExportFile("/export/name%20x.zip", "", stdout); err != nil {
		t.Fatalf("finish export without output: %v", err)
	}
	want := filepath.Join(util.TempDir, "export", "name x.zip") + "\n"
	if stdout.String() != want {
		t.Fatalf("printed export path = %q, want %q", stdout.String(), want)
	}
	if !filepath.IsAbs(strings.TrimSpace(stdout.String())) {
		t.Fatalf("printed export path is not absolute: %q", stdout.String())
	}
}

func TestFinishExportFileStreamsAndReplacesExistingTarget(t *testing.T) {
	dir := t.TempDir()
	previousTempDir := util.TempDir
	previousWorkspaceDir := util.WorkspaceDir
	util.TempDir = dir
	util.WorkspaceDir = dir
	t.Cleanup(func() {
		util.WorkspaceDir = previousWorkspaceDir
		util.TempDir = previousTempDir
	})
	source := filepath.Join(dir, "export", "source.zip")
	destination := filepath.Join(dir, "destination.zip")
	content := bytes.Repeat([]byte("streamed export payload\n"), 128*1024)
	if err := os.MkdirAll(filepath.Dir(source), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(source, content, 0640); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(destination, []byte("old export"), 0600); err != nil {
		t.Fatal(err)
	}

	if err := finishExportFile("/export/source.zip", destination, io.Discard); err != nil {
		t.Fatalf("finish export: %v", err)
	}
	got, err := os.ReadFile(destination)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, content) {
		t.Fatalf("published export length = %d, want %d", len(got), len(content))
	}
	assertNoExportPartials(t, dir)
}

func TestFinishExportFileRejectsSameFile(t *testing.T) {
	previousTempDir := util.TempDir
	previousWorkspaceDir := util.WorkspaceDir
	util.TempDir = t.TempDir()
	util.WorkspaceDir = util.TempDir
	t.Cleanup(func() {
		util.WorkspaceDir = previousWorkspaceDir
		util.TempDir = previousTempDir
	})
	path := filepath.Join(util.TempDir, "export", "export.zip")
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("completed export"), 0600); err != nil {
		t.Fatal(err)
	}

	if err := finishExportFile("/export/export.zip", path, io.Discard); err == nil {
		t.Fatal("publishing an export onto itself unexpectedly succeeded")
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "completed export" {
		t.Fatalf("same-file publish changed source to %q", got)
	}
}

func TestFinishExportFileRejectsEncryptedNotebookDestination(t *testing.T) {
	previousWorkspaceDir := util.WorkspaceDir
	previousDataDir := util.DataDir
	previousTempDir := util.TempDir
	previousConf := model.Conf
	root := t.TempDir()
	util.WorkspaceDir = root
	util.DataDir = filepath.Join(root, "data")
	util.TempDir = filepath.Join(root, "temp")
	model.Conf = model.NewAppConf()
	t.Cleanup(func() {
		model.Conf = previousConf
		util.TempDir = previousTempDir
		util.DataDir = previousDataDir
		util.WorkspaceDir = previousWorkspaceDir
	})

	const boxID = "20990101120000-cliencx"
	boxConf := conf.NewBoxConf()
	boxConf.Encrypted = true
	if err := (&model.Box{ID: boxID}).SaveConf(boxConf); err != nil {
		t.Fatalf("save encrypted notebook fixture: %v", err)
	}
	destination := filepath.Join(util.DataDir, boxID, "plaintext-export.zip")
	err := finishExportFile("/export/source.zip", destination, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "encrypted notebook") {
		t.Fatalf("encrypted notebook CLI destination error = %v", err)
	}
	if _, statErr := os.Stat(destination); !os.IsNotExist(statErr) {
		t.Fatalf("rejected CLI destination exists: %v", statErr)
	}
}

func TestExportSYCommandProducesNativeSYJSON(t *testing.T) {
	const (
		boxID = "20990101120000-cliexpt"
		docID = "20990101120100-syjsonx"
	)
	originalDataDir := util.DataDir
	originalWorkspaceDir := util.WorkspaceDir
	originalTempDir := util.TempDir
	originalBlockTreeDBPath := util.BlockTreeDBPath
	originalConf := model.Conf
	tempRoot := t.TempDir()
	util.WorkspaceDir = tempRoot
	util.DataDir = filepath.Join(tempRoot, "data")
	util.TempDir = filepath.Join(tempRoot, "temp")
	util.BlockTreeDBPath = filepath.Join(util.TempDir, "blocktree.db")
	for _, dir := range []string{util.DataDir, util.TempDir} {
		if err := os.MkdirAll(dir, 0755); err != nil {
			t.Fatal(err)
		}
	}
	model.Conf = model.NewAppConf()
	model.Conf.Lang = "en"
	model.Conf.Export = conf.NewExport()
	model.Conf.FileTree = conf.NewFileTree()
	model.Conf.Flashcard = conf.NewFlashcard()
	cache.ClearTreeCache()
	t.Cleanup(func() {
		treenode.CloseDatabase()
		cache.ClearTreeCache()
		model.Conf = originalConf
		util.BlockTreeDBPath = originalBlockTreeDBPath
		util.TempDir = originalTempDir
		util.DataDir = originalDataDir
		util.WorkspaceDir = originalWorkspaceDir
	})
	treenode.InitBlockTree(true)

	boxConf := conf.NewBoxConf()
	boxConf.Name = "Native SY"
	boxConf.Closed = false
	if err := (&model.Box{ID: boxID}).SaveConf(boxConf); err != nil {
		t.Fatalf("save notebook config: %v", err)
	}
	treePath := "/" + docID + ".sy"
	tree := treenode.NewTree(boxID, treePath, "/Native SY", "Native SY")
	tree.Root.FirstChild.AppendChild(&ast.Node{Type: ast.NodeText, Tokens: []byte("native sy content")})
	if _, err := filesys.WriteTree(tree); err != nil {
		t.Fatalf("write source tree: %v", err)
	}
	if err := treenode.UpsertBlockTree(tree); err != nil {
		t.Fatalf("index source tree: %v", err)
	}

	idFlag := exportSYCmd.Flags().Lookup("id")
	outputFlag := exportSYCmd.Flags().Lookup("output")
	previousID, previousOutput := idFlag.Value.String(), outputFlag.Value.String()
	previousIDChanged, previousOutputChanged := idFlag.Changed, outputFlag.Changed
	previousDryRun := dryRun
	t.Cleanup(func() {
		_ = exportSYCmd.Flags().Set("id", previousID)
		_ = exportSYCmd.Flags().Set("output", previousOutput)
		idFlag.Changed = previousIDChanged
		outputFlag.Changed = previousOutputChanged
		dryRun = previousDryRun
	})
	output := filepath.Join(tempRoot, "native.sy.zip")
	if err := exportSYCmd.Flags().Set("id", docID); err != nil {
		t.Fatal(err)
	}
	if err := exportSYCmd.Flags().Set("output", output); err != nil {
		t.Fatal(err)
	}
	dryRun = false
	if err := exportSYCmd.RunE(exportSYCmd, nil); err != nil {
		t.Fatalf("run native SY export: %v", err)
	}

	archive, err := zip.OpenReader(output)
	if err != nil {
		t.Fatalf("open SY export: %v", err)
	}
	defer archive.Close()
	for _, entry := range archive.File {
		if filepath.Ext(entry.Name) != ".sy" {
			continue
		}
		reader, openErr := entry.Open()
		if openErr != nil {
			t.Fatal(openErr)
		}
		data, readErr := io.ReadAll(reader)
		closeErr := reader.Close()
		if readErr != nil || closeErr != nil {
			t.Fatalf("read exported SY: read=%v close=%v", readErr, closeErr)
		}
		var document struct {
			ID   string
			Spec string
			Type string
		}
		if err = json.Unmarshal(data, &document); err != nil {
			t.Fatalf("exported .sy is not JSON: %v", err)
		}
		if document.ID != docID || document.Spec == "" || document.Type != "NodeDocument" {
			t.Fatalf("exported .sy header = %#v", document)
		}
		return
	}
	t.Fatal("SY export did not contain a .sy document")
}

func assertNoExportPartials(t *testing.T, dir string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".siyuan-export-partial-") {
			t.Fatalf("export partial remained: %s", entry.Name())
		}
	}
}
