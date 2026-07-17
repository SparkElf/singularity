package tools

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/siyuan-note/siyuan/kernel/conf"
	"github.com/siyuan-note/siyuan/kernel/model"
	"github.com/siyuan-note/siyuan/kernel/util"
)

func TestExportMarkdownUsesExplicitNotebookIdentity(t *testing.T) {
	previousConf := model.Conf
	model.Conf = model.NewAppConf()
	model.Conf.Export = conf.NewExport()
	t.Cleanup(func() { model.Conf = previousConf })
	const notebook = "20990101120000-mcpboxx"

	result, err := exportMd(map[string]any{
		"id":       "20990101120100-mcpdocx",
		"notebook": notebook,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.IsError || len(result.Content) != 1 || !strings.Contains(result.Content[0].Text, notebook) {
		t.Fatalf("explicit notebook export result = %#v, want notebook-scoped error", result)
	}
}

func TestExportDocumentActionsRejectExplicitInvalidNotebookWithoutGlobalFallback(t *testing.T) {
	previousDataDir := util.DataDir
	previousConf := model.Conf
	util.DataDir = t.TempDir()
	model.Conf = model.NewAppConf()
	model.Conf.FileTree = conf.NewFileTree()
	t.Cleanup(func() {
		model.Conf = previousConf
		util.DataDir = previousDataDir
	})

	invalidNotebooks := []struct {
		name  string
		value any
		want  string
	}{
		{name: "non-string", value: 1, want: model.ErrInvalidID.Error()},
		{name: "null", value: nil, want: model.ErrInvalidID.Error()},
		{name: "empty", value: "", want: model.ErrInvalidID.Error()},
		{name: "malformed", value: "invalid", want: model.ErrInvalidID.Error()},
		{name: "not-found", value: "20990717130300-missing", want: model.ErrBoxNotFound.Error()},
	}
	for _, action := range []string{"md", "html", "preview", "docx", "sy", "md-zip"} {
		for _, invalidNotebook := range invalidNotebooks {
			t.Run(action+"/"+invalidNotebook.name, func(t *testing.T) {
				result, err := ExportTool.Handler(CallContext{}, map[string]any{
					"action": action, "id": "20990717130301-document", "notebook": invalidNotebook.value,
				})
				if err != nil {
					t.Fatalf("%s export returned protocol error: %v", action, err)
				}
				if !result.IsError || len(result.Content) != 1 || !strings.Contains(result.Content[0].Text, invalidNotebook.want) {
					t.Fatalf("%s export result = %#v, want error containing %q", action, result, invalidNotebook.want)
				}
			})
		}
	}
}

func TestExportDocumentActionsAllowOmittedNotebook(t *testing.T) {
	for _, action := range []string{"md", "html", "preview", "docx", "sy", "md-zip"} {
		t.Run(action, func(t *testing.T) {
			result, err := ExportTool.Handler(CallContext{}, map[string]any{"action": action})
			if err != nil {
				t.Fatalf("%s export returned protocol error: %v", action, err)
			}
			if !result.IsError || len(result.Content) != 1 || result.Content[0].Text != "id is required" {
				t.Fatalf("%s export result = %#v, want dispatch past omitted optional notebook", action, result)
			}
		})
	}
}

func TestFinishMCPExportFileWithoutOutputReturnsAbsolutePhysicalPath(t *testing.T) {
	previousTempDir := util.TempDir
	util.TempDir = t.TempDir()
	t.Cleanup(func() { util.TempDir = previousTempDir })
	source := filepath.Join(util.TempDir, "export", "report.zip")
	if err := os.MkdirAll(filepath.Dir(source), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(source, []byte("completed export"), 0600); err != nil {
		t.Fatal(err)
	}

	result, err := finishMCPExportFile("/export/report.zip", "", "report")
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(util.TempDir, "export", "report.zip")
	if result.IsError || len(result.Content) != 1 || !strings.Contains(result.Content[0].Text, want) || !filepath.IsAbs(want) {
		t.Fatalf("MCP export result = %#v, want absolute physical path %q", result, want)
	}
}

func TestFinishMCPExportFilePublishesRequestedOutput(t *testing.T) {
	previousTempDir := util.TempDir
	previousWorkspaceDir := util.WorkspaceDir
	root := t.TempDir()
	util.WorkspaceDir = root
	util.TempDir = filepath.Join(root, "temp")
	t.Cleanup(func() {
		util.WorkspaceDir = previousWorkspaceDir
		util.TempDir = previousTempDir
	})
	source := filepath.Join(util.TempDir, "export", "source.zip")
	if err := os.MkdirAll(filepath.Dir(source), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(source, []byte("completed export"), 0600); err != nil {
		t.Fatal(err)
	}
	destination := filepath.Join(root, "downloads", "report.zip")
	if err := os.MkdirAll(filepath.Dir(destination), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(destination, []byte("previous export"), 0600); err != nil {
		t.Fatal(err)
	}

	result, err := finishMCPExportFile("/export/source.zip", destination, "report")
	if err != nil {
		t.Fatal(err)
	}
	if result.IsError || len(result.Content) != 1 || !strings.Contains(result.Content[0].Text, destination) {
		t.Fatalf("MCP export result = %#v, want destination %q", result, destination)
	}
	content, err := os.ReadFile(destination)
	if err != nil || string(content) != "completed export" {
		t.Fatalf("published MCP export = %q, %v", content, err)
	}
}

func TestManagedMCPExportWithoutOutputConsumesAndCleansCapability(t *testing.T) {
	previousTempDir := util.TempDir
	util.TempDir = t.TempDir()
	t.Cleanup(func() { util.TempDir = previousTempDir })
	const boxID = "20990101120000-mcpboxx"
	artifact := filepath.Join(util.TempDir, "export", boxID, "resources", "report.zip")
	if err := os.MkdirAll(filepath.Dir(artifact), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(artifact, []byte("managed plaintext"), 0600); err != nil {
		t.Fatal(err)
	}
	managedPath, err := model.RegisterManagedEncryptedExport(boxID, "resources", artifact, "report.zip")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { model.RevokeManagedEncryptedExportsForBox(boxID) })

	result, err := finishMCPExportFile("/export/"+managedPath, "", "report")
	if err != nil {
		t.Fatal(err)
	}
	if !result.IsError || len(result.Content) != 1 || !strings.Contains(result.Content[0].Text, "output is required") {
		t.Fatalf("managed MCP export result = %#v, want explicit output error", result)
	}
	if _, err = os.Stat(artifact); !os.IsNotExist(err) {
		t.Fatalf("managed MCP export without output left plaintext artifact: %v", err)
	}
}

func TestManagedMCPExportInvalidOutputConsumesAndCleansCapability(t *testing.T) {
	previousTempDir := util.TempDir
	util.TempDir = t.TempDir()
	t.Cleanup(func() { util.TempDir = previousTempDir })
	const boxID = "20990101120000-mcpboxx"
	artifact := filepath.Join(util.TempDir, "export", boxID, "resources", "report.zip")
	if err := os.MkdirAll(filepath.Dir(artifact), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(artifact, []byte("managed plaintext"), 0600); err != nil {
		t.Fatal(err)
	}
	managedPath, err := model.RegisterManagedEncryptedExport(boxID, "resources", artifact, "report.zip")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { model.RevokeManagedEncryptedExportsForBox(boxID) })

	invalidOutput := filepath.Join(util.TempDir, "export", "rejected.zip")
	result, err := finishMCPExportFile("/export/"+managedPath, invalidOutput, "report")
	if err != nil {
		t.Fatal(err)
	}
	if !result.IsError || len(result.Content) != 1 {
		t.Fatalf("managed MCP invalid-output result = %#v, want error", result)
	}
	if _, err = os.Stat(artifact); !os.IsNotExist(err) {
		t.Fatalf("managed MCP invalid output left plaintext artifact: %v", err)
	}
	if claim, claimErr := model.ClaimManagedEncryptedExport(managedPath); claim != nil || !errors.Is(claimErr, model.ErrManagedEncryptedExportUnavailable) {
		t.Fatalf("managed MCP invalid output left capability claimable: claim=%#v err=%v", claim, claimErr)
	}
}
