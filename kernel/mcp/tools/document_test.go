// SiYuan - Refactor your thinking
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

package tools

import (
	"strings"
	"testing"

	"github.com/siyuan-note/siyuan/kernel/conf"
	"github.com/siyuan-note/siyuan/kernel/model"
	"github.com/siyuan-note/siyuan/kernel/util"
)

func TestDocumentNotebookActionsRequireStrictExistingIdentity(t *testing.T) {
	previousDataDir := util.DataDir
	previousConf := model.Conf
	util.DataDir = t.TempDir()
	model.Conf = model.NewAppConf()
	model.Conf.FileTree = conf.NewFileTree()
	t.Cleanup(func() {
		model.Conf = previousConf
		util.DataDir = previousDataDir
	})

	tests := []struct {
		name        string
		notebook    any
		setNotebook bool
		want        string
	}{
		{name: "missing", want: "notebook is required"},
		{name: "non-string", notebook: 1, setNotebook: true, want: model.ErrInvalidID.Error()},
		{name: "empty", notebook: "", setNotebook: true, want: model.ErrInvalidID.Error()},
		{name: "malformed", notebook: "invalid", setNotebook: true, want: model.ErrInvalidID.Error()},
		{name: "not found", notebook: "20990717144000-missing", setNotebook: true, want: model.ErrBoxNotFound.Error()},
	}
	for _, action := range []string{"list", "duplicate"} {
		for _, test := range tests {
			t.Run(action+"/"+test.name, func(t *testing.T) {
				args := map[string]any{"action": action, "id": "20990717160001-docone1"}
				if test.setNotebook {
					args["notebook"] = test.notebook
				}
				result, err := DocumentTool.Handler(CallContext{}, args)
				if err != nil {
					t.Fatalf("document %s returned protocol error: %v", action, err)
				}
				if !result.IsError || len(result.Content) != 1 || !strings.Contains(result.Content[0].Text, test.want) {
					t.Fatalf("document %s result = %#v, want error containing %q", action, result, test.want)
				}
			})
		}
	}
}
