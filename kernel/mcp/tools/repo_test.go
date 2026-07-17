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
)

func TestRepoFileRollbackRequiresDeclaredHistoricalNotebook(t *testing.T) {
	result, err := RepoTool.Handler(CallContext{}, map[string]any{
		"action": "file_rollback",
		"id":     "20990717180600-repofile",
	})
	if err != nil {
		t.Fatalf("repo file rollback returned protocol error: %v", err)
	}
	if !result.IsError || len(result.Content) != 1 || !strings.Contains(result.Content[0].Text, "notebook is required") {
		t.Fatalf("repo file rollback result = %#v, want missing notebook contract", result)
	}
}
