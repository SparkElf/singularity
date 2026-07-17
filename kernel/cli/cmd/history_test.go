// SiYuan - Refactor your thinking
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

package cmd

import (
	"errors"
	"strings"
	"testing"

	"github.com/siyuan-note/siyuan/kernel/model"
)

func TestHistoryGetRequiresNotebookIdentity(t *testing.T) {
	pathFlag := historyGetCmd.Flags().Lookup("path")
	notebookFlag := historyGetCmd.Flags().Lookup("notebook")
	if pathFlag == nil || notebookFlag == nil {
		t.Fatal("history get command is missing path or notebook flag")
	}
	originalPath := pathFlag.Value.String()
	originalNotebook := notebookFlag.Value.String()
	t.Cleanup(func() {
		_ = historyGetCmd.Flags().Set("path", originalPath)
		_ = historyGetCmd.Flags().Set("notebook", originalNotebook)
	})
	if err := historyGetCmd.Flags().Set("path", "history/2099-07-16-update/notebook/document.sy"); err != nil {
		t.Fatal(err)
	}
	if err := historyGetCmd.Flags().Set("notebook", ""); err != nil {
		t.Fatal(err)
	}

	err := historyGetCmd.RunE(historyGetCmd, nil)
	if err == nil || !strings.Contains(err.Error(), "--notebook is required") {
		t.Fatalf("history get error = %v, want missing notebook contract", err)
	}
}

func TestHistoryQueryRejectsInvalidNotebook(t *testing.T) {
	notebookFlag := historyListCmd.Flags().Lookup("notebook")
	if notebookFlag == nil {
		t.Fatal("history list command is missing notebook flag")
	}
	originalNotebook := notebookFlag.Value.String()
	t.Cleanup(func() { _ = historyListCmd.Flags().Set("notebook", originalNotebook) })
	if err := historyListCmd.Flags().Set("notebook", "invalid"); err != nil {
		t.Fatal(err)
	}

	if err := runHistoryQuery("", historyListCmd); !errors.Is(err, model.ErrInvalidID) {
		t.Fatalf("history query error = %v, want ErrInvalidID", err)
	}
}
