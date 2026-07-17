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

package sql

import (
	stdsql "database/sql"
	"path/filepath"
	"sync"
	"testing"
)

func TestQueryRootBlockRefCountUsesOnlySelectedContentStore(t *testing.T) {
	globalDB := newRefsTestDB(t, "global.db")
	encryptedDB := newRefsTestDB(t, "encrypted.db")
	encryptedBoxID := "20990101120000-encrypt"

	previousDB := db
	previousEncryptedDBs := encryptedDBs
	previousIsEncryptedBox := IsEncryptedBoxFn
	db = globalDB
	encryptedDBs = &sync.Map{}
	encryptedDBs.Store(encryptedBoxID, encryptedDB)
	IsEncryptedBoxFn = func(boxID string) bool { return boxID == encryptedBoxID }
	t.Cleanup(func() {
		db = previousDB
		encryptedDBs = previousEncryptedDBs
		IsEncryptedBoxFn = previousIsEncryptedBox
	})

	insertRootRefCountTestRows(t, globalDB, "global-root", "global-ref-1", "global-ref-1", "global-ref-2")
	insertRootRefCountTestRows(t, encryptedDB, "encrypted-root", "encrypted-ref-1", "encrypted-ref-2")

	globalCounts := QueryRootBlockRefCount("")
	if len(globalCounts) != 1 || globalCounts["global-root"] != 2 {
		t.Fatalf("global counts crossed content stores: %#v", globalCounts)
	}
	ordinaryCounts := QueryRootBlockRefCount("20990101120000-ordinary")
	if len(ordinaryCounts) != 1 || ordinaryCounts["global-root"] != 2 {
		t.Fatalf("ordinary notebook did not use the global content store: %#v", ordinaryCounts)
	}
	encryptedCounts := QueryRootBlockRefCount(encryptedBoxID)
	if len(encryptedCounts) != 1 || encryptedCounts["encrypted-root"] != 2 {
		t.Fatalf("encrypted notebook did not use only its selected content store: %#v", encryptedCounts)
	}
}

func TestIndexMaintenanceQueriesUseOnlySelectedContentStore(t *testing.T) {
	globalDB := newIndexMaintenanceTestDB(t, "global-index.db")
	encryptedDB := newIndexMaintenanceTestDB(t, "encrypted-index.db")
	const encryptedBoxID = "20990101121000-encrypt"

	previousDB := db
	previousEncryptedDBs := encryptedDBs
	previousIsEncryptedBox := IsEncryptedBoxFn
	db = globalDB
	encryptedDBs = &sync.Map{}
	encryptedDBs.Store(encryptedBoxID, encryptedDB)
	IsEncryptedBoxFn = func(boxID string) bool { return boxID == encryptedBoxID }
	t.Cleanup(func() {
		db = previousDB
		encryptedDBs = previousEncryptedDBs
		IsEncryptedBoxFn = previousIsEncryptedBox
	})

	for _, fixture := range []struct {
		database *stdsql.DB
		rootID   string
		blockID  string
		updated  string
	}{
		{database: globalDB, rootID: "global-root", blockID: "global-duplicate", updated: "20260716010101"},
		{database: encryptedDB, rootID: "encrypted-root", blockID: "encrypted-duplicate", updated: "20260716020202"},
	} {
		for range 2 {
			if _, err := fixture.database.Exec(
				"INSERT INTO blocks (id, root_id, updated, type) VALUES (?, ?, ?, 'd')",
				fixture.blockID, fixture.rootID, fixture.updated,
			); err != nil {
				t.Fatalf("insert duplicate block row: %v", err)
			}
			if _, err := fixture.database.Exec(
				"INSERT INTO refs (def_block_id, def_block_root_id, block_id) VALUES (?, ?, ?)",
				fixture.blockID, fixture.rootID, fixture.blockID,
			); err != nil {
				t.Fatalf("insert duplicate reference row: %v", err)
			}
		}
	}

	globalUpdated, err := GetRootUpdatedInBox("")
	if err != nil || len(globalUpdated) != 1 || globalUpdated["global-root"] != "20260716010101" {
		t.Fatalf("global update map crossed content stores: %#v, error %v", globalUpdated, err)
	}
	encryptedUpdated, err := GetRootUpdatedInBox(encryptedBoxID)
	if err != nil || len(encryptedUpdated) != 1 || encryptedUpdated["encrypted-root"] != "20260716020202" {
		t.Fatalf("encrypted update map crossed content stores: %#v, error %v", encryptedUpdated, err)
	}
	if roots := GetDuplicatedRootIDsInBox("blocks", ""); len(roots) != 1 || roots[0] != "global-root" {
		t.Fatalf("global duplicate-block query crossed content stores: %#v", roots)
	}
	if roots := GetDuplicatedRootIDsInBox("blocks", encryptedBoxID); len(roots) != 1 || roots[0] != "encrypted-root" {
		t.Fatalf("encrypted duplicate-block query crossed content stores: %#v", roots)
	}
	if roots := GetRefDuplicatedDefRootIDsInBox(""); len(roots) != 1 || roots[0] != "global-root" {
		t.Fatalf("global duplicate-reference query crossed content stores: %#v", roots)
	}
	if roots := GetRefDuplicatedDefRootIDsInBox(encryptedBoxID); len(roots) != 1 || roots[0] != "encrypted-root" {
		t.Fatalf("encrypted duplicate-reference query crossed content stores: %#v", roots)
	}
}

func TestDerivedReferenceQueriesUseOnlySelectedContentStore(t *testing.T) {
	globalDB := newIndexMaintenanceTestDB(t, "global-derived.db")
	encryptedDB := newIndexMaintenanceTestDB(t, "encrypted-derived.db")
	const (
		encryptedBoxID = "20990101122000-encrypt"
		annotationID   = "shared-annotation"
		anchor         = "shared anchor"
		globalID       = "20990101122001-global1"
		encryptedID    = "20990101122002-encrypt"
	)

	previousDB := db
	previousEncryptedDBs := encryptedDBs
	previousIsEncryptedBox := IsEncryptedBoxFn
	db = globalDB
	encryptedDBs = &sync.Map{}
	encryptedDBs.Store(encryptedBoxID, encryptedDB)
	IsEncryptedBoxFn = func(boxID string) bool { return boxID == encryptedBoxID }
	t.Cleanup(func() {
		db = previousDB
		encryptedDBs = previousEncryptedDBs
		IsEncryptedBoxFn = previousIsEncryptedBox
	})

	for _, fixture := range []struct {
		database *stdsql.DB
		blockID  string
	}{
		{database: globalDB, blockID: globalID},
		{database: encryptedDB, blockID: encryptedID},
	} {
		if _, err := fixture.database.Exec(
			"INSERT INTO blocks (id, root_id, updated, type, name, alias, content) VALUES (?, ?, '', 'p', '', '', ?)",
			fixture.blockID, fixture.blockID, anchor,
		); err != nil {
			t.Fatalf("insert reference definition block: %v", err)
		}
		if _, err := fixture.database.Exec(
			"INSERT INTO refs (def_block_id, def_block_root_id, block_id, content) VALUES (?, ?, ?, ?)",
			fixture.blockID, fixture.blockID, fixture.blockID, anchor,
		); err != nil {
			t.Fatalf("insert reference definition row: %v", err)
		}
		if _, err := fixture.database.Exec(
			"INSERT INTO file_annotation_refs (annotation_id, block_id) VALUES (?, ?)",
			annotationID, fixture.blockID,
		); err != nil {
			t.Fatalf("insert file annotation reference: %v", err)
		}
	}

	if ids := QueryBlockDefIDsByRefTextInBox(anchor, ""); len(ids) != 1 || ids[0] != globalID {
		t.Fatalf("global reference-text query crossed content stores: %#v", ids)
	}
	if ids := QueryBlockDefIDsByRefTextInBox(anchor, encryptedBoxID); len(ids) != 1 || ids[0] != encryptedID {
		t.Fatalf("encrypted reference-text query crossed content stores: %#v", ids)
	}
	if ids := QueryRefIDsByAnnotationIDInBox(annotationID, ""); len(ids) != 1 || ids[0] != globalID {
		t.Fatalf("global annotation query crossed content stores: %#v", ids)
	}
	if ids := QueryRefIDsByAnnotationIDInBox(annotationID, encryptedBoxID); len(ids) != 1 || ids[0] != encryptedID {
		t.Fatalf("encrypted annotation query crossed content stores: %#v", ids)
	}
}

func TestQueryBlockHashesUsesProvidedTransactionWithoutGlobalDatabase(t *testing.T) {
	testDB := newIndexMaintenanceTestDB(t, "transaction-query.db")
	const (
		rootID  = "20990101123000-txquery"
		blockID = "20990101123001-txquery"
	)
	if _, err := testDB.Exec(
		"INSERT INTO blocks (id, root_id, hash, type) VALUES (?, ?, ?, 'p')",
		blockID, rootID, "selected-transaction-hash",
	); err != nil {
		t.Fatalf("insert transaction query fixture: %v", err)
	}

	tx, err := testDB.Begin()
	if err != nil {
		t.Fatalf("begin selected content-store transaction: %v", err)
	}
	t.Cleanup(func() { _ = tx.Rollback() })
	originalDB := db
	db = nil
	t.Cleanup(func() { db = originalDB })

	hashes := queryBlockHashes(tx, rootID)
	if len(hashes) != 1 || hashes[blockID] != "selected-transaction-hash" {
		t.Fatalf("transaction-bound hashes = %#v, want the selected transaction row", hashes)
	}
}

func newRefsTestDB(t *testing.T, name string) *stdsql.DB {
	t.Helper()
	database, err := stdsql.Open("sqlite3", filepath.Join(t.TempDir(), name))
	if err != nil {
		t.Fatalf("open ref-count test database: %v", err)
	}
	database.SetMaxOpenConns(1)
	if _, err = database.Exec(`CREATE TABLE refs (
		id, def_block_id, def_block_parent_id, def_block_root_id, def_block_path,
		block_id, root_id, box, path, content, markdown, type
	)`); err != nil {
		database.Close()
		t.Fatalf("create refs table: %v", err)
	}
	t.Cleanup(func() {
		if err := database.Close(); err != nil {
			t.Errorf("close ref-count test database: %v", err)
		}
	})
	return database
}

func newIndexMaintenanceTestDB(t *testing.T, name string) *stdsql.DB {
	t.Helper()
	database, err := stdsql.Open("sqlite3", filepath.Join(t.TempDir(), name))
	if err != nil {
		t.Fatalf("open index-maintenance test database: %v", err)
	}
	database.SetMaxOpenConns(1)
	for _, statement := range []string{
		"CREATE TABLE blocks (id, root_id, hash, updated, type, name, alias, content)",
		"CREATE TABLE refs (def_block_id, def_block_root_id, block_id, content)",
		"CREATE TABLE file_annotation_refs (annotation_id, block_id)",
	} {
		if _, err = database.Exec(statement); err != nil {
			database.Close()
			t.Fatalf("initialize index-maintenance test database: %v", err)
		}
	}
	t.Cleanup(func() {
		if err := database.Close(); err != nil {
			t.Errorf("close index-maintenance test database: %v", err)
		}
	})
	return database
}

func insertRootRefCountTestRows(t *testing.T, database *stdsql.DB, rootID string, blockIDs ...string) {
	t.Helper()
	for _, blockID := range blockIDs {
		if _, err := database.Exec("INSERT INTO refs (def_block_root_id, block_id) VALUES (?, ?)", rootID, blockID); err != nil {
			t.Fatalf("insert ref-count test row: %v", err)
		}
	}
}
