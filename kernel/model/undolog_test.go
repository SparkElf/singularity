// SiYuan - Refactor your thinking
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

package model

import (
	"testing"

	"github.com/88250/lute/parse"
)

func TestUndoLogSeparatesSameRootAcrossContentStores(t *testing.T) {
	const (
		encryptedNotebook = "20990717160000-undobox"
		rootID            = "20990717160001-undoroot"
		linkedRootID      = "20990717160002-undolink"
	)
	log := newUndoLog(8)
	log.Record(&Transaction{
		DoOperations:   []*Operation{{Action: "insert", ID: rootID}},
		UndoOperations: []*Operation{{Action: "delete", ID: rootID}},
		trees:          map[string]*parse.Tree{rootID: nil},
		fromAPI:        true,
	})
	log.Record(&Transaction{
		Notebook:       encryptedNotebook,
		DoOperations:   []*Operation{{Action: "move", ID: rootID}},
		UndoOperations: []*Operation{{Action: "move", ID: rootID}},
		trees: map[string]*parse.Tree{
			rootID:       nil,
			linkedRootID: nil,
		},
		fromAPI: true,
	})

	if canUndo, canRedo, _ := log.State("", rootID); !canUndo || canRedo {
		t.Fatalf("ordinary state = undo:%t redo:%t, want undo only", canUndo, canRedo)
	}
	if canUndo, canRedo, linked := log.State(encryptedNotebook, rootID); !canUndo || canRedo || len(linked) != 2 {
		t.Fatalf("encrypted state = undo:%t redo:%t linked:%v, want linked undo entry", canUndo, canRedo, linked)
	}

	entry := log.Undo(encryptedNotebook, rootID)
	if entry == nil || entry.Notebook() != encryptedNotebook {
		t.Fatalf("encrypted undo entry = %#v, want notebook %q", entry, encryptedNotebook)
	}
	log.UndoCommit(entry, encryptedNotebook, rootID)
	if canUndo, canRedo, _ := log.State(encryptedNotebook, rootID); canUndo || !canRedo {
		t.Fatalf("encrypted state after undo = undo:%t redo:%t, want redo only", canUndo, canRedo)
	}
	if canUndo, canRedo, _ := log.State(encryptedNotebook, linkedRootID); canUndo || canRedo {
		t.Fatalf("linked state after undo = undo:%t redo:%t, want empty", canUndo, canRedo)
	}
	if canUndo, canRedo, _ := log.State("", rootID); !canUndo || canRedo {
		t.Fatalf("ordinary state changed by encrypted undo = undo:%t redo:%t", canUndo, canRedo)
	}

	entry = log.Redo(encryptedNotebook, rootID)
	if entry == nil {
		t.Fatal("encrypted redo entry is missing")
	}
	log.RedoCommit(entry, encryptedNotebook, rootID)
	if canUndo, canRedo, _ := log.State(encryptedNotebook, linkedRootID); !canUndo || canRedo {
		t.Fatalf("linked state after redo = undo:%t redo:%t, want undo only", canUndo, canRedo)
	}

	log.Clear(encryptedNotebook, rootID)
	if canUndo, canRedo, _ := log.State(encryptedNotebook, rootID); canUndo || canRedo {
		t.Fatalf("cleared encrypted root state = undo:%t redo:%t, want empty", canUndo, canRedo)
	}
	if canUndo, canRedo, _ := log.State(encryptedNotebook, linkedRootID); canUndo || canRedo {
		t.Fatalf("linked encrypted root survived clear = undo:%t redo:%t", canUndo, canRedo)
	}
	if canUndo, canRedo, _ := log.State("", rootID); !canUndo || canRedo {
		t.Fatalf("ordinary state changed by encrypted clear = undo:%t redo:%t", canUndo, canRedo)
	}

	log.ClearStore("")
	if canUndo, canRedo, _ := log.State("", rootID); canUndo || canRedo {
		t.Fatalf("ordinary store survived ClearStore = undo:%t redo:%t", canUndo, canRedo)
	}
}
