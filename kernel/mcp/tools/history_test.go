// SiYuan - Refactor your thinking
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

package tools

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/88250/lute/ast"
	"github.com/88250/lute/render"
	"github.com/siyuan-note/siyuan/kernel/conf"
	"github.com/siyuan-note/siyuan/kernel/model"
	"github.com/siyuan-note/siyuan/kernel/treenode"
	"github.com/siyuan-note/siyuan/kernel/util"
)

func TestHistoryMCPGetReadsDeletedOrdinaryOwnerAndRejectsMismatchedOwner(t *testing.T) {
	previousWorkspaceDir := util.WorkspaceDir
	previousDataDir := util.DataDir
	previousHistoryDir := util.HistoryDir
	previousConf := model.Conf
	workspace := t.TempDir()
	util.WorkspaceDir = workspace
	util.DataDir = filepath.Join(workspace, "data")
	util.HistoryDir = filepath.Join(workspace, "history")
	model.Conf = model.NewAppConf()
	model.Conf.Editor = conf.NewEditor()
	model.Conf.Export = conf.NewExport()
	model.Conf.FileTree = conf.NewFileTree()
	if err := os.MkdirAll(util.DataDir, 0755); err != nil {
		t.Fatalf("create MCP deleted history data directory: %v", err)
	}
	t.Cleanup(func() {
		model.Conf = previousConf
		util.HistoryDir = previousHistoryDir
		util.DataDir = previousDataDir
		util.WorkspaceDir = previousWorkspaceDir
	})

	const (
		deletedNotebook = "20990717181100-deleted"
		otherNotebook   = "20990717181101-deleted"
		rootID          = "20990717181102-history"
		bodyText        = "MCP reads a deleted ordinary notebook history"
	)
	historyFile := filepath.Join(util.HistoryDir, "2099-07-17-181100-update", deletedNotebook, rootID+".sy")
	if err := os.MkdirAll(filepath.Dir(historyFile), 0755); err != nil {
		t.Fatalf("create MCP deleted history directory: %v", err)
	}
	tree := treenode.NewTree(deletedNotebook, "/"+rootID+".sy", "/Deleted MCP history", "Deleted MCP history")
	tree.Root.FirstChild.AppendChild(&ast.Node{Type: ast.NodeText, Tokens: []byte(bodyText)})
	luteEngine := util.NewLute()
	data := render.NewJSONRenderer(tree, luteEngine.RenderOptions, luteEngine.ParseOptions).Render()
	if err := os.WriteFile(historyFile, data, 0644); err != nil {
		t.Fatalf("write MCP deleted history document: %v", err)
	}
	historyPath, err := filepath.Rel(util.WorkspaceDir, historyFile)
	if err != nil {
		t.Fatalf("resolve MCP deleted history path: %v", err)
	}

	result, err := HistoryTool.Handler(CallContext{}, map[string]any{
		"action": "get", "notebook": deletedNotebook, "path": filepath.ToSlash(historyPath),
	})
	if err != nil {
		t.Fatalf("MCP deleted history get returned protocol error: %v", err)
	}
	if result.IsError || len(result.Content) != 1 || !strings.Contains(result.Content[0].Text, bodyText) {
		t.Fatalf("MCP deleted history result = %#v, want readable history", result)
	}

	mismatch, err := HistoryTool.Handler(CallContext{}, map[string]any{
		"action": "get", "notebook": otherNotebook, "path": filepath.ToSlash(historyPath),
	})
	if err != nil {
		t.Fatalf("MCP mismatched history get returned protocol error: %v", err)
	}
	if !mismatch.IsError || len(mismatch.Content) != 1 || !strings.Contains(mismatch.Content[0].Text, "does not belong to notebook") {
		t.Fatalf("MCP mismatched owner result = %#v, want strict owner rejection", mismatch)
	}
}

func TestHistoryReadAndRollbackRequireNotebookIdentity(t *testing.T) {
	for _, action := range []string{"get", "rollback"} {
		t.Run(action, func(t *testing.T) {
			result, err := HistoryTool.Handler(CallContext{}, map[string]any{
				"action": action,
				"path":   "history/2099-07-16-update/notebook/document.sy",
			})
			if err != nil {
				t.Fatalf("history %s returned protocol error: %v", action, err)
			}
			if !result.IsError || len(result.Content) != 1 || !strings.Contains(result.Content[0].Text, "notebook is required") {
				t.Fatalf("history %s result = %#v, want missing notebook contract", action, result)
			}
		})
	}
}

func TestHistoricalNotebookIdentityAllowsDeletedOrdinaryOwner(t *testing.T) {
	const deletedNotebook = "20990717180500-deleted"
	notebook, err := HistoricalNotebookArg(map[string]any{"notebook": deletedNotebook}, false)
	if err != nil || notebook != deletedNotebook {
		t.Fatalf("historical notebook = %q, %v, want deleted owner %q", notebook, err, deletedNotebook)
	}
	if notebook, err = HistoricalNotebookArg(map[string]any{"notebook": ""}, true); err != nil || notebook != "" {
		t.Fatalf("workspace-global historical notebook = %q, %v, want explicit global identity", notebook, err)
	}
}

func TestHistoryActionsRejectExplicitInvalidNotebookWithoutGlobalFallback(t *testing.T) {
	previousDataDir := util.DataDir
	previousConf := model.Conf
	util.DataDir = t.TempDir()
	model.Conf = model.NewAppConf()
	model.Conf.FileTree = conf.NewFileTree()
	t.Cleanup(func() {
		model.Conf = previousConf
		util.DataDir = previousDataDir
	})

	actions := []struct {
		name string
		args map[string]any
	}{
		{name: "list", args: map[string]any{"action": "list"}},
		{name: "search", args: map[string]any{"action": "search", "query": "content"}},
		{name: "get", args: map[string]any{"action": "get", "path": "history/2099-07-16-update/notebook/document.sy"}},
	}
	invalidNotebooks := []struct {
		name  string
		value any
		want  string
	}{
		{name: "non-string", value: 1, want: model.ErrInvalidID.Error()},
		{name: "null", value: nil, want: model.ErrInvalidID.Error()},
		{name: "empty", value: "", want: model.ErrInvalidID.Error()},
		{name: "malformed", value: "invalid", want: model.ErrInvalidID.Error()},
	}
	for _, action := range actions {
		for _, invalidNotebook := range invalidNotebooks {
			t.Run(action.name+"/"+invalidNotebook.name, func(t *testing.T) {
				args := make(map[string]any, len(action.args)+1)
				for key, value := range action.args {
					args[key] = value
				}
				args["notebook"] = invalidNotebook.value
				result, err := HistoryTool.Handler(CallContext{}, args)
				if err != nil {
					t.Fatalf("%s history returned protocol error: %v", action.name, err)
				}
				if !result.IsError || len(result.Content) != 1 || !strings.Contains(result.Content[0].Text, invalidNotebook.want) {
					t.Fatalf("%s history result = %#v, want error containing %q", action.name, result, invalidNotebook.want)
				}
			})
		}
	}
	for _, action := range actions[:2] {
		t.Run(action.name+"/not-found", func(t *testing.T) {
			args := make(map[string]any, len(action.args)+1)
			for key, value := range action.args {
				args[key] = value
			}
			args["notebook"] = "20990717130200-missing"
			result, err := HistoryTool.Handler(CallContext{}, args)
			if err != nil {
				t.Fatalf("%s history returned protocol error: %v", action.name, err)
			}
			if !result.IsError || len(result.Content) != 1 || !strings.Contains(result.Content[0].Text, model.ErrBoxNotFound.Error()) {
				t.Fatalf("%s history result = %#v, want missing current notebook error", action.name, result)
			}
		})
	}
}
