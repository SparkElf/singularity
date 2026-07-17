// SiYuan - Refactor your thinking
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

package treenode

import (
	"database/sql"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/88250/lute/parse"
	_ "github.com/mattn/go-sqlite3"
)

func TestGlobalBlockTreeLookupsDoNotReadEncryptedStores(t *testing.T) {
	globalDB := newBlockTreeTestDB(t, "global.db")
	encryptedDB := newBlockTreeTestDB(t, "encrypted.db")
	installBlockTreeTestDBs(t, globalDB, "encrypted-box", encryptedDB)

	globalID := "20260716000000-global1"
	encryptedID := "20260716000000-encrypt"
	insertBlockTreeForTest(t, globalDB, globalID, "global-box")
	insertBlockTreeForTest(t, encryptedDB, encryptedID, "encrypted-box")

	if got := GetBlockTree(globalID); got == nil || got.BoxID != "global-box" {
		t.Fatalf("global lookup did not return the global block tree: %#v", got)
	}
	if got := GetBlockTree(encryptedID); got != nil {
		t.Fatalf("global lookup returned encrypted block tree: %#v", got)
	}
	if got := GetBlockTrees([]string{globalID, encryptedID}); len(got) != 1 || got[globalID] == nil {
		t.Fatalf("global batch lookup crossed content stores: %#v", got)
	}
	if ExistBlockTree(encryptedID) {
		t.Fatal("global existence lookup reported an encrypted block tree")
	}
	if got := ExistBlockTrees([]string{globalID, encryptedID}); !got[globalID] || got[encryptedID] {
		t.Fatalf("global batch existence lookup crossed content stores: %#v", got)
	}

	if got := GetBlockTreeInBox(encryptedID, ""); got != nil {
		t.Fatalf("empty box lookup returned encrypted block tree: %#v", got)
	}
	if got := GetBlockTreesInBox([]string{encryptedID}, ""); len(got) != 0 {
		t.Fatalf("empty box batch lookup returned encrypted block trees: %#v", got)
	}
	if ExistBlockTreeInBox(encryptedID, "") {
		t.Fatal("empty box existence lookup reported an encrypted block tree")
	}
	if got := ExistBlockTreesInBox([]string{encryptedID}, ""); got[encryptedID] {
		t.Fatalf("empty box batch existence lookup reported an encrypted block tree: %#v", got)
	}
	if got := RootChildIDs(encryptedID); len(got) != 0 {
		t.Fatalf("global root lookup returned encrypted document ids: %#v", got)
	}

	if got := GetBlockTreeInBox(encryptedID, "encrypted-box"); got == nil || got.BoxID != "encrypted-box" {
		t.Fatalf("explicit encrypted lookup did not return its block tree: %#v", got)
	}
	if got := GetBlockTreesInBox([]string{encryptedID}, "encrypted-box"); got[encryptedID] == nil {
		t.Fatalf("explicit encrypted batch lookup did not return its block tree: %#v", got)
	}
	if got := GetRootUpdatedInBox(""); len(got) != 1 || got[globalID] != "20260716000000" {
		t.Fatalf("global root update query crossed content stores: %#v", got)
	}
	if got := GetRootUpdatedInBox("encrypted-box"); len(got) != 1 || got[encryptedID] != "20260716000000" {
		t.Fatalf("encrypted root update query crossed content stores: %#v", got)
	}
	if !ExistBlockTreeInBox(encryptedID, "encrypted-box") {
		t.Fatal("explicit encrypted existence lookup did not find its block tree")
	}
	if got := ExistBlockTreesInBox([]string{encryptedID}, "encrypted-box"); !got[encryptedID] {
		t.Fatalf("explicit encrypted batch existence lookup did not find its block tree: %#v", got)
	}
}

func TestPlainBlockTreeInBoxLookupsStayWithinNotebook(t *testing.T) {
	database := newBlockTreeTestDB(t, "plain-in-box.db")
	installBlockTreeTestDBs(t, database, "", nil)
	const sharedID = "20260717020000-plainid"
	insertBlockTreePathForTest(t, database, sharedID, "box-a", "/a/"+sharedID+".sy")
	insertBlockTreePathForTest(t, database, sharedID, "box-b", "/b/"+sharedID+".sy")
	if _, err := database.Exec("UPDATE blocktrees SET updated = ? WHERE id = ? AND box_id = ?", "20260717020001", sharedID, "box-b"); err != nil {
		t.Fatalf("differentiate duplicate blocktree update times: %v", err)
	}

	if got := GetBlockTreeInBox(sharedID, "box-a"); got == nil || got.BoxID != "box-a" || got.Path != "/a/"+sharedID+".sy" {
		t.Fatalf("single lookup crossed notebook: %#v", got)
	}
	if got := GetBlockTreesInBox([]string{sharedID}, "box-b")[sharedID]; got == nil || got.BoxID != "box-b" || got.Path != "/b/"+sharedID+".sy" {
		t.Fatalf("batch lookup crossed notebook: %#v", got)
	}
	if !ExistBlockTreeInBox(sharedID, "box-a") || !ExistBlockTreesInBox([]string{sharedID}, "box-b")[sharedID] {
		t.Fatal("notebook-scoped existence lookup missed duplicate root")
	}
	if got := GetBlockTreesByRootIDInBox(sharedID, "box-a"); len(got) != 1 || got[0].BoxID != "box-a" {
		t.Fatalf("root lookup crossed notebook: %#v", got)
	}
	if got := GetRootUpdatedInBox("box-a"); len(got) != 1 || got[sharedID] != "20260716000000" {
		t.Fatalf("root update lookup for box-a = %#v", got)
	}
	if got := GetRootUpdatedInBox("box-b"); len(got) != 1 || got[sharedID] != "20260717020001" {
		t.Fatalf("root update lookup for box-b = %#v", got)
	}
}

func TestBlockContainerValidationUsesDeclaredContentStore(t *testing.T) {
	globalDB := newBlockTreeTestDB(t, "global-container.db")
	encryptedDB := newBlockTreeTestDB(t, "encrypted-container.db")
	const (
		encryptedBoxID = "encrypted-box"
		parentID       = "20260717021000-parent1"
		childID        = "20260717021001-child01"
	)
	installBlockTreeTestDBs(t, globalDB, encryptedBoxID, encryptedDB)

	insertBlockTreeForTest(t, globalDB, parentID, "ordinary-box")
	insertBlockTreeForTest(t, globalDB, childID, "ordinary-box")
	if _, err := globalDB.Exec("UPDATE blocktrees SET type = ? WHERE id IN (?, ?)", "p", parentID, childID); err != nil {
		t.Fatalf("configure global leaf blocks: %v", err)
	}
	insertBlockTreeForTest(t, encryptedDB, parentID, encryptedBoxID)
	insertBlockTreeForTest(t, encryptedDB, childID, encryptedBoxID)
	if _, err := encryptedDB.Exec("UPDATE blocktrees SET type = ? WHERE id IN (?, ?)", "i", parentID, childID); err != nil {
		t.Fatalf("configure encrypted list items: %v", err)
	}

	if err := CheckContainerParentInBox(parentID, encryptedBoxID); err != nil {
		t.Fatalf("encrypted container validation read the wrong content store: %v", err)
	}
	if err := CheckContainerParentInBox(parentID, ""); err == nil {
		t.Fatal("global container validation accepted the encrypted block type")
	}
	if err := CheckContainerParent(parentID); err == nil {
		t.Fatal("legacy container validation did not delegate to the global store")
	}

	if err := CheckListItemNestingInBox(parentID, childID, encryptedBoxID); err == nil {
		t.Fatal("encrypted nesting validation missed direct list-item nesting")
	}
	if err := CheckListItemNestingInBox(parentID, childID, ""); err != nil {
		t.Fatalf("global nesting validation crossed into the encrypted store: %v", err)
	}
	if err := CheckListItemNesting(parentID, childID); err != nil {
		t.Fatalf("legacy nesting validation did not delegate to the global store: %v", err)
	}
}

func TestBlockTreeRemovalAPIsStayWithinNotebook(t *testing.T) {
	database := newBlockTreeTestDB(t, "store-scoped-removal.db")
	installBlockTreeTestDBs(t, database, "", nil)
	ids := []string{
		"20260717020100-rootdel",
		"20260717020101-idsdelx",
		"20260717020102-onedelx",
		"20260717020103-pathdel",
		"20260717020104-boxdely",
	}
	for _, id := range ids {
		path := "/other/" + id + ".sy"
		if id == ids[3] {
			path = "/prefix/" + id + ".sy"
		}
		insertBlockTreePathForTest(t, database, id, "box-a", path)
		insertBlockTreePathForTest(t, database, id, "box-b", path)
	}

	if err := RemoveBlockTreesByRootID("box-a", ids[0]); err != nil {
		t.Fatalf("remove root-scoped blocktrees: %v", err)
	}
	if err := RemoveBlockTreesByIDs("box-a", []string{ids[1]}); err != nil {
		t.Fatalf("remove selected blocktree IDs: %v", err)
	}
	if err := RemoveBlockTree("box-a", ids[2]); err != nil {
		t.Fatalf("remove selected blocktree: %v", err)
	}
	if err := RemoveBlockTreesByPathPrefix("box-a", "/prefix/"); err != nil {
		t.Fatalf("remove blocktrees by path prefix: %v", err)
	}
	removed, err := RemoveBlockTreesByBoxID("box-a")
	if err != nil {
		t.Fatalf("remove notebook blocktrees: %v", err)
	}
	if len(removed) != 1 || removed[0] != ids[4] {
		t.Fatalf("remaining box-a removal IDs = %#v, want [%s]", removed, ids[4])
	}
	for _, id := range ids {
		if blockTreeExistsForTest(t, database, id, "box-a") {
			t.Fatalf("blocktree %s remains in selected notebook", id)
		}
		if !blockTreeExistsForTest(t, database, id, "box-b") {
			t.Fatalf("blocktree %s was removed from other notebook", id)
		}
	}
}

func TestBlockTreeWriteAPIsReturnPersistenceErrors(t *testing.T) {
	database := newBlockTreeTestDB(t, "closed-writes.db")
	if err := database.Close(); err != nil {
		t.Fatalf("close blocktree database: %v", err)
	}
	installBlockTreeTestDBs(t, database, "", nil)
	const id = "20260717020200-writeer"
	tests := []struct {
		name string
		run  func() error
	}{
		{name: "root", run: func() error { return RemoveBlockTreesByRootID("box-a", id) }},
		{name: "path", run: func() error { return RemoveBlockTreesByPathPrefix("box-a", "/prefix/") }},
		{name: "box", run: func() error { _, err := RemoveBlockTreesByBoxID("box-a"); return err }},
		{name: "ids", run: func() error { return RemoveBlockTreesByIDs("box-a", []string{id}) }},
		{name: "single", run: func() error { return RemoveBlockTree("box-a", id) }},
		{name: "upsert", run: func() error { return UpsertBlockTree(NewTree("box-a", "/"+id+".sy", "/Write", "Write")) }},
		{name: "clear redundant", run: func() error { return ClearRedundantBlockTrees("box-a", []string{"/" + id + ".sy"}) }},
		{name: "missing paths", run: func() error { _, err := GetNotExistPaths("box-a", []string{"/" + id + ".sy"}); return err }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if err := test.run(); err == nil {
				t.Fatal("closed blocktree database write succeeded")
			}
		})
	}
}

func TestUpsertBlockTreeIsAtomicAndStoreScoped(t *testing.T) {
	const rootID = "20260717020300-upsertx"
	t.Run("store scoped", func(t *testing.T) {
		database := newBlockTreeTestDB(t, "upsert-store.db")
		installBlockTreeTestDBs(t, database, "", nil)
		insertBlockTreePathForTest(t, database, rootID, "box-a", "/old-a/"+rootID+".sy")
		insertBlockTreePathForTest(t, database, rootID, "box-b", "/old-b/"+rootID+".sy")

		newPath := "/new-a/" + rootID + ".sy"
		if err := UpsertBlockTree(NewTree("box-a", newPath, "/New A", "New A")); err != nil {
			t.Fatalf("upsert selected notebook blocktree: %v", err)
		}
		if got := blockTreePathForTest(t, database, rootID, "box-a"); got != newPath {
			t.Fatalf("selected notebook path = %q, want %q", got, newPath)
		}
		if got := blockTreePathForTest(t, database, rootID, "box-b"); got != "/old-b/"+rootID+".sy" {
			t.Fatalf("upsert crossed notebook: %q", got)
		}
	})

	t.Run("insert failure rolls back delete", func(t *testing.T) {
		database := newBlockTreeTestDB(t, "upsert-rollback.db")
		installBlockTreeTestDBs(t, database, "", nil)
		oldPath := "/old/" + rootID + ".sy"
		insertBlockTreePathForTest(t, database, rootID, "box-a", oldPath)
		if _, err := database.Exec("CREATE TRIGGER reject_upsert_insert BEFORE INSERT ON blocktrees BEGIN SELECT RAISE(FAIL, 'insert blocked'); END"); err != nil {
			t.Fatalf("create upsert insert failure: %v", err)
		}

		if err := UpsertBlockTree(NewTree("box-a", "/new/"+rootID+".sy", "/New", "New")); err == nil {
			t.Fatal("blocktree upsert succeeded after insert failure")
		}
		if got := blockTreePathForTest(t, database, rootID, "box-a"); got != oldPath {
			t.Fatalf("failed upsert changed old path to %q", got)
		}
	})
}

func TestIndexBlockTreeReturnsPersistenceErrors(t *testing.T) {
	t.Run("database unavailable", func(t *testing.T) {
		installBlockTreeTestDBs(t, nil, "", nil)

		err := IndexBlockTree(NewTree("plain-box", "/20260717000000-dbnull.sy", "/DB nil", "DB nil"))
		if err == nil || !strings.Contains(err.Error(), "begin blocktree transaction") || !strings.Contains(err.Error(), "blocktree database is nil") {
			t.Fatalf("expected unavailable database error, got %v", err)
		}
	})

	t.Run("begin transaction", func(t *testing.T) {
		database := newBlockTreeTestDB(t, "closed.db")
		if err := database.Close(); err != nil {
			t.Fatalf("close block tree test database: %v", err)
		}
		installBlockTreeTestDBs(t, database, "", nil)

		err := IndexBlockTree(NewTree("plain-box", "/20260717000000-begin.sy", "/Begin", "Begin"))
		if err == nil || !strings.Contains(err.Error(), "begin blocktree transaction") {
			t.Fatalf("expected begin transaction error, got %v", err)
		}
	})

	t.Run("insert", func(t *testing.T) {
		database := newBlockTreeTestDB(t, "missing-table.db")
		if _, err := database.Exec("DROP TABLE blocktrees"); err != nil {
			t.Fatalf("drop block tree test table: %v", err)
		}
		installBlockTreeTestDBs(t, database, "", nil)

		err := IndexBlockTree(NewTree("plain-box", "/20260717000000-insert.sy", "/Insert", "Insert"))
		if err == nil || !strings.Contains(err.Error(), "insert blocktrees") || !strings.Contains(err.Error(), "no such table") {
			t.Fatalf("expected insert error, got %v", err)
		}
		if inUse := database.Stats().InUse; inUse != 0 {
			t.Fatalf("insert failure left %d database connections in use", inUse)
		}
	})

	t.Run("commit", func(t *testing.T) {
		database := newBlockTreeTestDB(t, "commit.db")
		for _, statement := range []string{
			"PRAGMA foreign_keys = ON",
			"DROP TABLE blocktrees",
			"CREATE TABLE boxes (id TEXT PRIMARY KEY)",
			"CREATE TABLE blocktrees (id, root_id, parent_id, box_id REFERENCES boxes(id) DEFERRABLE INITIALLY DEFERRED, path, hpath, updated, type)",
		} {
			if _, err := database.Exec(statement); err != nil {
				t.Fatalf("prepare deferred commit failure: %v", err)
			}
		}
		installBlockTreeTestDBs(t, database, "", nil)

		err := IndexBlockTree(NewTree("missing-box", "/20260717000000-commit.sy", "/Commit", "Commit"))
		if err == nil || !strings.Contains(err.Error(), "commit blocktree transaction") || !strings.Contains(err.Error(), "FOREIGN KEY constraint failed") {
			t.Fatalf("expected commit error, got %v", err)
		}
	})
}

func TestSetBlockTreePathIsAtomicAndStoreScoped(t *testing.T) {
	const rootID = "20260717010000-pathset"

	t.Run("store scoped replacement", func(t *testing.T) {
		database := newBlockTreeTestDB(t, "store-scoped.db")
		installBlockTreeTestDBs(t, database, "", nil)
		insertBlockTreePathForTest(t, database, rootID, "box-a", "/old-a/"+rootID+".sy")
		insertBlockTreePathForTest(t, database, rootID, "box-b", "/old-b/"+rootID+".sy")

		newPath := "/new-a/" + rootID + ".sy"
		if err := SetBlockTreePath(NewTree("box-a", newPath, "/New A", "New A")); err != nil {
			t.Fatalf("replace selected blocktree path: %v", err)
		}
		if got := blockTreePathForTest(t, database, rootID, "box-a"); got != newPath {
			t.Fatalf("selected store path = %q, want %q", got, newPath)
		}
		if got := blockTreePathForTest(t, database, rootID, "box-b"); got != "/old-b/"+rootID+".sy" {
			t.Fatalf("replacement crossed into other store: %q", got)
		}
	})

	t.Run("empty tree preserves old path", func(t *testing.T) {
		database := newBlockTreeTestDB(t, "empty-tree.db")
		installBlockTreeTestDBs(t, database, "", nil)
		oldPath := "/old/" + rootID + ".sy"
		insertBlockTreePathForTest(t, database, rootID, "box-a", oldPath)
		tree := NewTree("box-a", "/new/"+rootID+".sy", "/New", "New")
		tree.Root.ID = ""
		tree.Root.FirstChild.ID = ""

		if err := SetBlockTreePath(tree); err == nil || !strings.Contains(err.Error(), "no indexable blocks") {
			t.Fatalf("expected empty tree rejection, got %v", err)
		}
		if got := blockTreePathForTest(t, database, rootID, "box-a"); got != oldPath {
			t.Fatalf("empty tree changed old path to %q", got)
		}
	})

	t.Run("delete failure preserves old path", func(t *testing.T) {
		database := newBlockTreeTestDB(t, "delete-failure.db")
		installBlockTreeTestDBs(t, database, "", nil)
		oldPath := "/old/" + rootID + ".sy"
		insertBlockTreePathForTest(t, database, rootID, "box-a", oldPath)
		if _, err := database.Exec("CREATE TRIGGER reject_blocktree_delete BEFORE DELETE ON blocktrees BEGIN SELECT RAISE(FAIL, 'delete blocked'); END"); err != nil {
			t.Fatalf("create blocktree delete failure: %v", err)
		}

		err := SetBlockTreePath(NewTree("box-a", "/new/"+rootID+".sy", "/New", "New"))
		if err == nil || !strings.Contains(err.Error(), "delete previous blocktree path") {
			t.Fatalf("expected blocktree delete error, got %v", err)
		}
		if got := blockTreePathForTest(t, database, rootID, "box-a"); got != oldPath {
			t.Fatalf("delete failure changed old path to %q", got)
		}
	})

	t.Run("insert failure rolls back deleted path", func(t *testing.T) {
		database := newBlockTreeTestDB(t, "insert-failure.db")
		installBlockTreeTestDBs(t, database, "", nil)
		oldPath := "/old/" + rootID + ".sy"
		insertBlockTreePathForTest(t, database, rootID, "box-a", oldPath)
		if _, err := database.Exec("CREATE TRIGGER reject_blocktree_insert BEFORE INSERT ON blocktrees BEGIN SELECT RAISE(FAIL, 'insert blocked'); END"); err != nil {
			t.Fatalf("create blocktree insert failure: %v", err)
		}

		err := SetBlockTreePath(NewTree("box-a", "/new/"+rootID+".sy", "/New", "New"))
		if err == nil || !strings.Contains(err.Error(), "replace blocktree path") {
			t.Fatalf("expected blocktree insert error, got %v", err)
		}
		if got := blockTreePathForTest(t, database, rootID, "box-a"); got != oldPath {
			t.Fatalf("insert failure changed old path to %q", got)
		}
	})

	t.Run("commit failure rolls back deleted path", func(t *testing.T) {
		database := newBlockTreeTestDB(t, "path-commit.db")
		for _, statement := range []string{
			"PRAGMA foreign_keys = ON",
			"DROP TABLE blocktrees",
			"CREATE TABLE allowed_paths (path TEXT PRIMARY KEY)",
			"CREATE TABLE blocktrees (id, root_id, parent_id, box_id, path REFERENCES allowed_paths(path) DEFERRABLE INITIALLY DEFERRED, hpath, updated, type)",
		} {
			if _, err := database.Exec(statement); err != nil {
				t.Fatalf("prepare deferred path commit failure: %v", err)
			}
		}
		installBlockTreeTestDBs(t, database, "", nil)
		oldPath := "/old/" + rootID + ".sy"
		if _, err := database.Exec("INSERT INTO allowed_paths (path) VALUES (?)", oldPath); err != nil {
			t.Fatalf("insert allowed old path: %v", err)
		}
		insertBlockTreePathForTest(t, database, rootID, "box-a", oldPath)

		err := SetBlockTreePath(NewTree("box-a", "/new/"+rootID+".sy", "/New", "New"))
		if err == nil || !strings.Contains(err.Error(), "commit blocktree path transaction") {
			t.Fatalf("expected blocktree path commit error, got %v", err)
		}
		if got := blockTreePathForTest(t, database, rootID, "box-a"); got != oldPath {
			t.Fatalf("commit failure changed old path to %q", got)
		}
	})
}

func TestReplaceBlockTreesSnapshotRestoresAllSelectedRoots(t *testing.T) {
	const (
		boxID        = "box-a"
		otherBoxID   = "box-b"
		rootA        = "20260717030000-roota01"
		rootB        = "20260717030001-rootb02"
		unrelated    = "20260717030002-unrel03"
		oldChildA    = "20260717030003-oldcha1"
		oldChildB    = "20260717030004-oldchb2"
		newChildA    = "20260717030005-newcha3"
		newChildB    = "20260717030006-newchb4"
		otherChildA  = "20260717030007-othcha5"
		unrelatedKid = "20260717030008-unrkid6"
	)
	globalDatabase := newBlockTreeTestDB(t, "batch-restore-global.db")
	encryptedDatabase := newBlockTreeTestDB(t, "batch-restore-encrypted.db")
	installBlockTreeTestDBs(t, globalDatabase, boxID, encryptedDatabase)
	for _, tree := range []*parse.Tree{
		newBatchBlockTreeForTest(boxID, rootA, oldChildA, "old-a"),
		newBatchBlockTreeForTest(boxID, rootB, oldChildB, "old-b"),
		newBatchBlockTreeForTest(otherBoxID, rootA, otherChildA, "other-box"),
	} {
		if err := IndexBlockTree(tree); err != nil {
			t.Fatalf("seed blocktree %s/%s: %v", tree.Box, tree.ID, err)
		}
	}

	snapshot, err := ReplaceBlockTrees([]*parse.Tree{
		newBatchBlockTreeForTest(boxID, rootA, newChildA, "new-a"),
		newBatchBlockTreeForTest(boxID, rootB, newChildB, "new-b"),
	})
	if err != nil {
		t.Fatalf("replace blocktree batch: %v", err)
	}
	assertBlockTreeRootForTest(t, boxID, rootA, "/new-a/"+rootA+".sy", rootA, newChildA)
	assertBlockTreeRootForTest(t, boxID, rootB, "/new-b/"+rootB+".sy", rootB, newChildB)
	assertBlockTreeRootForTest(t, otherBoxID, rootA, "/other-box/"+rootA+".sy", rootA, otherChildA)

	if err = IndexBlockTree(newBatchBlockTreeForTest(boxID, unrelated, unrelatedKid, "after-replace")); err != nil {
		t.Fatalf("add unrelated root after replacement: %v", err)
	}
	if err = snapshot.Restore(); err != nil {
		t.Fatalf("restore replaced blocktree roots: %v", err)
	}

	assertBlockTreeRootForTest(t, boxID, rootA, "/old-a/"+rootA+".sy", rootA, oldChildA)
	assertBlockTreeRootForTest(t, boxID, rootB, "/old-b/"+rootB+".sy", rootB, oldChildB)
	assertBlockTreeRootForTest(t, boxID, unrelated, "/after-replace/"+unrelated+".sy", unrelated, unrelatedKid)
	assertBlockTreeRootForTest(t, otherBoxID, rootA, "/other-box/"+rootA+".sy", rootA, otherChildA)
}

func TestReplaceBlockTreesRollsBackWholeBatchOnLaterInsertFailure(t *testing.T) {
	database := newBlockTreeTestDB(t, "batch-rollback.db")
	installBlockTreeTestDBs(t, database, "", nil)

	const (
		boxID     = "box-a"
		rootA     = "20260717030100-roota11"
		rootB     = "20260717030101-rootb12"
		oldChildA = "20260717030102-oldca13"
		oldChildB = "20260717030103-oldcb14"
		newChildA = "20260717030104-newca15"
		newChildB = "20260717030105-newcb16"
	)
	for _, tree := range []*parse.Tree{
		newBatchBlockTreeForTest(boxID, rootA, oldChildA, "old-a"),
		newBatchBlockTreeForTest(boxID, rootB, oldChildB, "old-b"),
	} {
		if err := IndexBlockTree(tree); err != nil {
			t.Fatalf("seed blocktree %s: %v", tree.ID, err)
		}
	}
	if _, err := database.Exec("CREATE TRIGGER reject_second_batch_root BEFORE INSERT ON blocktrees WHEN NEW.root_id = '" + rootB + "' AND NEW.path LIKE '/new-%' BEGIN SELECT RAISE(FAIL, 'second root blocked'); END"); err != nil {
		t.Fatalf("create later-root failure: %v", err)
	}

	_, err := ReplaceBlockTrees([]*parse.Tree{
		newBatchBlockTreeForTest(boxID, rootA, newChildA, "new-a"),
		newBatchBlockTreeForTest(boxID, rootB, newChildB, "new-b"),
	})
	if err == nil || !strings.Contains(err.Error(), "insert blocktrees during batch replacement") {
		t.Fatalf("later-root replacement error = %v", err)
	}
	assertBlockTreeRootForTest(t, boxID, rootA, "/old-a/"+rootA+".sy", rootA, oldChildA)
	assertBlockTreeRootForTest(t, boxID, rootB, "/old-b/"+rootB+".sy", rootB, oldChildB)
}

func TestRemoveBlockTreeRootsSnapshotRestoresOnlySelectedRoots(t *testing.T) {
	database := newBlockTreeTestDB(t, "root-removal-restore.db")
	installBlockTreeTestDBs(t, database, "", nil)

	const (
		boxID          = "box-a"
		otherBoxID     = "box-b"
		rootA          = "20260717030200-roota21"
		rootB          = "20260717030201-rootb22"
		unrelated      = "20260717030202-unrel23"
		oldChildA      = "20260717030203-oldca24"
		oldChildB      = "20260717030204-oldcb25"
		unrelatedChild = "20260717030205-unrch26"
		otherChild     = "20260717030206-othch27"
		replacementKid = "20260717030207-replc28"
	)
	for _, tree := range []*parse.Tree{
		newBatchBlockTreeForTest(boxID, rootA, oldChildA, "old-a"),
		newBatchBlockTreeForTest(boxID, rootB, oldChildB, "old-b"),
		newBatchBlockTreeForTest(boxID, unrelated, unrelatedChild, "unrelated"),
		newBatchBlockTreeForTest(otherBoxID, rootA, otherChild, "other-box"),
	} {
		if err := IndexBlockTree(tree); err != nil {
			t.Fatalf("seed blocktree %s/%s: %v", tree.Box, tree.ID, err)
		}
	}

	snapshot, err := RemoveBlockTreeRoots(boxID, []string{rootA, rootB, rootA})
	if err != nil {
		t.Fatalf("remove selected blocktree roots: %v", err)
	}
	assertBlockTreeRootAbsentForTest(t, boxID, rootA)
	assertBlockTreeRootAbsentForTest(t, boxID, rootB)
	assertBlockTreeRootForTest(t, boxID, unrelated, "/unrelated/"+unrelated+".sy", unrelated, unrelatedChild)
	assertBlockTreeRootForTest(t, otherBoxID, rootA, "/other-box/"+rootA+".sy", rootA, otherChild)

	if err = IndexBlockTree(newBatchBlockTreeForTest(boxID, rootA, replacementKid, "replacement")); err != nil {
		t.Fatalf("add replacement root before compensation: %v", err)
	}
	if err = snapshot.Restore(); err != nil {
		t.Fatalf("restore removed blocktree roots: %v", err)
	}
	assertBlockTreeRootForTest(t, boxID, rootA, "/old-a/"+rootA+".sy", rootA, oldChildA)
	assertBlockTreeRootForTest(t, boxID, rootB, "/old-b/"+rootB+".sy", rootB, oldChildB)
	assertBlockTreeRootForTest(t, boxID, unrelated, "/unrelated/"+unrelated+".sy", unrelated, unrelatedChild)
	assertBlockTreeRootForTest(t, otherBoxID, rootA, "/other-box/"+rootA+".sy", rootA, otherChild)
}

func TestRemoveBlockTreeBoxSnapshotRestoresWholeNotebook(t *testing.T) {
	const (
		boxID            = "box-a"
		otherBoxID       = "box-b"
		rootA            = "20260717030300-roota31"
		rootB            = "20260717030301-rootb32"
		replacementRoot  = "20260717030302-replr33"
		oldChildA        = "20260717030303-oldca34"
		oldChildB        = "20260717030304-oldcb35"
		otherChild       = "20260717030305-othch36"
		replacementChild = "20260717030306-replc37"
	)
	globalDatabase := newBlockTreeTestDB(t, "box-removal-global.db")
	encryptedDatabase := newBlockTreeTestDB(t, "box-removal-encrypted.db")
	installBlockTreeTestDBs(t, globalDatabase, boxID, encryptedDatabase)
	for _, tree := range []*parse.Tree{
		newBatchBlockTreeForTest(boxID, rootA, oldChildA, "old-a"),
		newBatchBlockTreeForTest(boxID, rootB, oldChildB, "old-b"),
		newBatchBlockTreeForTest(otherBoxID, rootA, otherChild, "other-box"),
	} {
		if err := IndexBlockTree(tree); err != nil {
			t.Fatalf("seed blocktree %s/%s: %v", tree.Box, tree.ID, err)
		}
	}

	snapshot, err := RemoveBlockTreeBox(boxID)
	if err != nil {
		t.Fatalf("remove notebook blocktrees: %v", err)
	}
	if got := GetBlockTreesByBoxID(boxID); len(got) != 0 {
		t.Fatalf("removed notebook still has blocktrees: %#v", got)
	}
	assertBlockTreeRootForTest(t, otherBoxID, rootA, "/other-box/"+rootA+".sy", rootA, otherChild)

	if err = IndexBlockTree(newBatchBlockTreeForTest(boxID, replacementRoot, replacementChild, "replacement")); err != nil {
		t.Fatalf("add notebook replacement state: %v", err)
	}
	if err = snapshot.Restore(); err != nil {
		t.Fatalf("restore notebook blocktrees: %v", err)
	}
	assertBlockTreeRootForTest(t, boxID, rootA, "/old-a/"+rootA+".sy", rootA, oldChildA)
	assertBlockTreeRootForTest(t, boxID, rootB, "/old-b/"+rootB+".sy", rootB, oldChildB)
	assertBlockTreeRootAbsentForTest(t, boxID, replacementRoot)
	assertBlockTreeRootForTest(t, otherBoxID, rootA, "/other-box/"+rootA+".sy", rootA, otherChild)
}

func TestBlockTreeSnapshotRestoreFailurePreservesReplacementState(t *testing.T) {
	database := newBlockTreeTestDB(t, "restore-rollback.db")
	installBlockTreeTestDBs(t, database, "", nil)

	const (
		boxID           = "box-a"
		rootID          = "20260717030400-rootr41"
		oldChild        = "20260717030401-oldch42"
		replacementKid  = "20260717030402-replc43"
		oldPathFragment = "/old/"
	)
	if err := IndexBlockTree(newBatchBlockTreeForTest(boxID, rootID, oldChild, "old")); err != nil {
		t.Fatalf("seed blocktree root: %v", err)
	}
	snapshot, err := RemoveBlockTreeRoots(boxID, []string{rootID})
	if err != nil {
		t.Fatalf("remove blocktree root: %v", err)
	}
	if err = IndexBlockTree(newBatchBlockTreeForTest(boxID, rootID, replacementKid, "replacement")); err != nil {
		t.Fatalf("add replacement blocktree root: %v", err)
	}
	if _, err = database.Exec("CREATE TRIGGER reject_snapshot_restore BEFORE INSERT ON blocktrees WHEN NEW.path LIKE '" + oldPathFragment + "%' BEGIN SELECT RAISE(FAIL, 'snapshot restore blocked'); END"); err != nil {
		t.Fatalf("create snapshot restore failure: %v", err)
	}

	err = snapshot.Restore()
	if err == nil || !strings.Contains(err.Error(), "restore blocktree batch rows") {
		t.Fatalf("snapshot restore error = %v", err)
	}
	assertBlockTreeRootForTest(t, boxID, rootID, "/replacement/"+rootID+".sy", rootID, replacementKid)
}

func newBatchBlockTreeForTest(boxID, rootID, childID, pathPrefix string) *parse.Tree {
	path := "/" + pathPrefix + "/" + rootID + ".sy"
	tree := NewTree(boxID, path, "/"+pathPrefix, pathPrefix)
	tree.Root.FirstChild.ID = childID
	tree.Root.FirstChild.SetIALAttr("id", childID)
	tree.Root.FirstChild.SetIALAttr("updated", childID[:14])
	return tree
}

func assertBlockTreeRootForTest(t *testing.T, boxID, rootID, path string, wantIDs ...string) {
	t.Helper()
	rows := GetBlockTreesByRootIDInBox(rootID, boxID)
	if len(rows) != len(wantIDs) {
		t.Fatalf("blocktree root %s/%s has %d rows, want %d: %#v", boxID, rootID, len(rows), len(wantIDs), rows)
	}
	want := make(map[string]struct{}, len(wantIDs))
	for _, id := range wantIDs {
		want[id] = struct{}{}
	}
	for _, row := range rows {
		if row.BoxID != boxID || row.RootID != rootID || row.Path != path {
			t.Fatalf("blocktree root %s/%s contains unexpected row: %#v", boxID, rootID, row)
		}
		if _, ok := want[row.ID]; !ok {
			t.Fatalf("blocktree root %s/%s contains unexpected ID %q", boxID, rootID, row.ID)
		}
		delete(want, row.ID)
	}
	if len(want) != 0 {
		t.Fatalf("blocktree root %s/%s is missing IDs: %#v", boxID, rootID, want)
	}
}

func assertBlockTreeRootAbsentForTest(t *testing.T, boxID, rootID string) {
	t.Helper()
	if rows := GetBlockTreesByRootIDInBox(rootID, boxID); len(rows) != 0 {
		t.Fatalf("blocktree root %s/%s remains: %#v", boxID, rootID, rows)
	}
}

func newBlockTreeTestDB(t *testing.T, name string) *sql.DB {
	t.Helper()
	database, err := sql.Open("sqlite3", filepath.Join(t.TempDir(), name))
	if err != nil {
		t.Fatalf("open block tree test database: %v", err)
	}
	database.SetMaxOpenConns(1)
	if _, err = database.Exec("CREATE TABLE blocktrees (id, root_id, parent_id, box_id, path, hpath, updated, type)"); err != nil {
		database.Close()
		t.Fatalf("create block tree test table: %v", err)
	}
	t.Cleanup(func() {
		if err := database.Close(); err != nil {
			t.Errorf("close block tree test database: %v", err)
		}
	})
	return database
}

func installBlockTreeTestDBs(t *testing.T, globalDB *sql.DB, encryptedBoxID string, encryptedDB *sql.DB) {
	t.Helper()
	previousGlobalDB := db
	previousEncryptedDBs := encryptedBlockTreeDBs
	previousIsEncryptedBoxFn := IsEncryptedBoxFn
	db = globalDB
	encryptedBlockTreeDBs = &sync.Map{}
	IsEncryptedBoxFn = nil
	if encryptedDB != nil {
		encryptedBlockTreeDBs.Store(encryptedBoxID, encryptedDB)
	}
	t.Cleanup(func() {
		db = previousGlobalDB
		encryptedBlockTreeDBs = previousEncryptedDBs
		IsEncryptedBoxFn = previousIsEncryptedBoxFn
	})
}

func insertBlockTreeForTest(t *testing.T, database *sql.DB, id, boxID string) {
	t.Helper()
	insertBlockTreePathForTest(t, database, id, boxID, "/"+id+".sy")
}

func insertBlockTreePathForTest(t *testing.T, database *sql.DB, id, boxID, path string) {
	t.Helper()
	if _, err := database.Exec(
		"INSERT INTO blocktrees (id, root_id, parent_id, box_id, path, hpath, updated, type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		id, id, "", boxID, path, "/Test", "20260716000000", "d",
	); err != nil {
		t.Fatalf("insert block tree test row: %v", err)
	}
}

func blockTreePathForTest(t *testing.T, database *sql.DB, rootID, boxID string) string {
	t.Helper()
	var path string
	if err := database.QueryRow("SELECT path FROM blocktrees WHERE id = ? AND root_id = ? AND box_id = ?", rootID, rootID, boxID).Scan(&path); err != nil {
		t.Fatalf("query block tree path: %v", err)
	}
	return path
}

func blockTreeExistsForTest(t *testing.T, database *sql.DB, id, boxID string) bool {
	t.Helper()
	var count int
	if err := database.QueryRow("SELECT COUNT(*) FROM blocktrees WHERE id = ? AND box_id = ?", id, boxID).Scan(&count); err != nil {
		t.Fatalf("query blocktree existence: %v", err)
	}
	return count > 0
}
