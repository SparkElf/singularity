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
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

package sql

import (
	stdsql "database/sql"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// TestBlockCacheIsolatedByEncryptedBox 验证加密笔记本块不会污染全局缓存，且不同加密笔记本可安全使用相同块 ID。
func TestBlockCacheIsolatedByEncryptedBox(t *testing.T) {
	originalDisabled := cacheDisabled
	originalIsEncryptedBoxFn := IsEncryptedBoxFn
	defer func() {
		cacheDisabled = originalDisabled
		IsEncryptedBoxFn = originalIsEncryptedBoxFn
		ClearCache()
	}()

	cacheDisabled = false
	IsEncryptedBoxFn = func(boxID string) bool {
		return boxID == "encrypted-a" || boxID == "encrypted-b"
	}
	ClearCache()

	putBlockCache(&Block{ID: "shared-id", Box: "encrypted-a", Content: "secret-a"})
	putBlockCache(&Block{ID: "shared-id", Box: "encrypted-b", Content: "secret-b"})
	putBlockCache(&Block{ID: "normal-id", Box: "normal", Content: "normal"})
	blockCache.Wait()

	if block := getBlockCache("shared-id"); block != nil {
		t.Fatalf("global cache must not return encrypted block, got box %q", block.Box)
	}
	if block := getBlockCacheInBox("shared-id", "encrypted-a"); block == nil || block.Content != "secret-a" {
		t.Fatalf("encrypted-a cache miss or cross-box result: %#v", block)
	}
	if block := getBlockCacheInBox("shared-id", "encrypted-b"); block == nil || block.Content != "secret-b" {
		t.Fatalf("encrypted-b cache miss or cross-box result: %#v", block)
	}
	if block := getBlockCache("normal-id"); block == nil || block.Content != "normal" {
		t.Fatalf("normal block cache behavior changed: %#v", block)
	}

	removeBlockCache("shared-id")
	blockCache.Wait()
	if block := getBlockCacheInBox("shared-id", "encrypted-a"); block != nil {
		t.Fatalf("encrypted-a cache entry was not removed: %#v", block)
	}
	if block := getBlockCacheInBox("shared-id", "encrypted-b"); block != nil {
		t.Fatalf("encrypted-b cache entry was not removed: %#v", block)
	}
}

func TestBlockCacheInvalidationFollowsTransactionOutcome(t *testing.T) {
	for _, test := range []struct {
		name               string
		deferredConstraint bool
		commit             bool
		wantCommitError    bool
		wantCached         bool
		wantRows           int
	}{
		{name: "rollback", wantCached: true, wantRows: 1},
		{name: "commit failure", deferredConstraint: true, commit: true, wantCommitError: true, wantCached: true, wantRows: 1},
		{name: "commit success", commit: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			database, block := setupBlockCacheTransactionTest(t, test.deferredConstraint)
			putBlockCache(block)
			blockCache.Wait()

			tx, err := database.Begin()
			if err != nil {
				t.Fatalf("begin block deletion: %v", err)
			}
			if err = deleteBlocksByIDs(tx, []string{block.ID}); err != nil {
				_ = rollbackTx(tx)
				t.Fatalf("delete block in transaction: %v", err)
			}
			if test.commit {
				err = commitTx(tx)
				if test.wantCommitError && err == nil {
					t.Fatal("block deletion commit succeeded despite deferred foreign key violation")
				}
				if !test.wantCommitError && err != nil {
					t.Fatalf("commit block deletion: %v", err)
				}
			} else if err = rollbackTx(tx); err != nil {
				t.Fatalf("rollback block deletion: %v", err)
			}
			blockCache.Wait()

			cached := getBlockCache(block.ID)
			if test.wantCached && (cached == nil || cached.Content != block.Content) {
				t.Fatalf("cache after %s = %#v, want committed value", test.name, cached)
			}
			if !test.wantCached && cached != nil {
				t.Fatalf("cache after %s retained deleted block: %#v", test.name, cached)
			}
			var rows int
			if err = database.QueryRow("SELECT COUNT(*) FROM blocks WHERE id = ?", block.ID).Scan(&rows); err != nil {
				t.Fatalf("count block rows after %s: %v", test.name, err)
			}
			if rows != test.wantRows {
				t.Fatalf("block rows after %s = %d, want %d", test.name, rows, test.wantRows)
			}
		})
	}
}

func TestBlockCacheRejectsPreCommitQueryWriteback(t *testing.T) {
	database, block := setupBlockCacheTransactionTest(t, false)
	queryReady := make(chan struct{})
	allowWriteback := make(chan struct{})
	queryDone := make(chan *Block, 1)
	queryExited := make(chan struct{})
	var queryHookOnce, releaseOnce sync.Once
	releaseQuery := func() { releaseOnce.Do(func() { close(allowWriteback) }) }
	blockCacheAfterQueryHook = func(id string) {
		if id != block.ID {
			return
		}
		queryHookOnce.Do(func() {
			close(queryReady)
			<-allowWriteback
		})
	}
	go func() {
		defer close(queryExited)
		queryDone <- GetBlock(block.ID)
	}()
	t.Cleanup(func() {
		releaseQuery()
		<-queryExited
	})
	waitBlockCacheSignal(t, queryReady, "block query did not reach the cache writeback boundary")

	tx, err := database.Begin()
	if err != nil {
		t.Fatalf("begin concurrent block deletion: %v", err)
	}
	if err = deleteBlocksByIDs(tx, []string{block.ID}); err != nil {
		_ = rollbackTx(tx)
		t.Fatalf("delete block during delayed query: %v", err)
	}
	if err = commitTx(tx); err != nil {
		t.Fatalf("commit block deletion during delayed query: %v", err)
	}

	releaseQuery()
	select {
	case queried := <-queryDone:
		if queried == nil || queried.Content != block.Content {
			t.Fatalf("pre-commit query result = %#v, want its original snapshot", queried)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("pre-commit block query did not finish")
	}
	if cached := GetBlock(block.ID); cached != nil {
		t.Fatalf("pre-commit query repopulated a deleted block: %#v", cached)
	}
}

func setupBlockCacheTransactionTest(t *testing.T, deferredConstraint bool) (*stdsql.DB, *Block) {
	t.Helper()
	dsn := filepath.Join(t.TempDir(), "block-cache.db") + "?_foreign_keys=on"
	database, err := stdsql.Open("sqlite3", dsn)
	if err != nil {
		t.Fatalf("open block cache database: %v", err)
	}
	for _, statement := range []string{
		`CREATE TABLE blocks (
			id TEXT PRIMARY KEY, parent_id TEXT, root_id TEXT, hash TEXT, box TEXT,
			path TEXT, hpath TEXT, name TEXT, alias TEXT, memo TEXT, tag TEXT,
			content TEXT, fcontent TEXT, markdown TEXT, length INTEGER, type TEXT,
			subtype TEXT, ial TEXT, sort INTEGER, created TEXT, updated TEXT
		)`,
		"CREATE TABLE blocks_fts (rowid INTEGER PRIMARY KEY, content TEXT)",
	} {
		if _, err = database.Exec(statement); err != nil {
			database.Close()
			t.Fatalf("initialize block cache database with %q: %v", statement, err)
		}
	}
	if deferredConstraint {
		if _, err = database.Exec(`CREATE TABLE block_children (
			block_id TEXT NOT NULL,
			FOREIGN KEY(block_id) REFERENCES blocks(id) DEFERRABLE INITIALLY DEFERRED
		)`); err != nil {
			database.Close()
			t.Fatalf("create deferred block reference: %v", err)
		}
	}

	block := &Block{
		ID: "20990101122000-cachetx", RootID: "20990101122000-cachetx",
		Box: "20990101122001-ordinary", Path: "/cache.sy", HPath: "/Cache",
		Content: "committed content", FContent: "committed content", Markdown: "committed content",
		Type: "d", Created: "20990101122000", Updated: "20990101122000",
	}
	if _, err = database.Exec(
		"INSERT INTO blocks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		block.ID, block.ParentID, block.RootID, block.Hash, block.Box, block.Path, block.HPath,
		block.Name, block.Alias, block.Memo, block.Tag, block.Content, block.FContent, block.Markdown,
		block.Length, block.Type, block.SubType, block.IAL, block.Sort, block.Created, block.Updated,
	); err != nil {
		database.Close()
		t.Fatalf("insert block cache fixture: %v", err)
	}
	if _, err = database.Exec("INSERT INTO blocks_fts(rowid, content) SELECT rowid, content FROM blocks WHERE id = ?", block.ID); err != nil {
		database.Close()
		t.Fatalf("insert block cache FTS fixture: %v", err)
	}
	if deferredConstraint {
		if _, err = database.Exec("INSERT INTO block_children(block_id) VALUES (?)", block.ID); err != nil {
			database.Close()
			t.Fatalf("insert deferred block reference: %v", err)
		}
	}

	previousDB := db
	previousIsEncryptedBox := IsEncryptedBoxFn
	previousQueryHook := blockCacheAfterQueryHook
	blockCacheStateMu.Lock()
	previousCacheDisabled := cacheDisabled
	blockCacheStateMu.Unlock()
	db = database
	IsEncryptedBoxFn = func(string) bool { return false }
	blockCacheAfterQueryHook = nil
	enableCache()
	ClearCache()
	t.Cleanup(func() {
		ClearCache()
		blockCacheAfterQueryHook = previousQueryHook
		if previousCacheDisabled {
			disableCache()
		} else {
			enableCache()
		}
		db = previousDB
		IsEncryptedBoxFn = previousIsEncryptedBox
		database.Close()
	})
	return database, block
}

func waitBlockCacheSignal(t *testing.T, signal <-chan struct{}, failure string) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(5 * time.Second):
		t.Fatal(failure)
	}
}

func TestRefCacheUsesSelectedContentStoreAndCompositeInvalidation(t *testing.T) {
	const (
		defID          = "20990101120000-defsame"
		ordinaryBox    = "20990101120001-ordinary"
		encryptedBox   = "20990101120002-encrypted"
		ordinaryPath   = "/ordinary.sy"
		encryptedPath  = "/encrypted.sy"
		ordinaryRefID  = "20990101120003-ordinary"
		encryptedRefID = "20990101120004-encrypted"
	)
	globalDB, encryptedDB := setupRefCacheTest(t, encryptedBox)

	for _, fixture := range []struct {
		database *stdsql.DB
		refID    string
		boxID    string
		path     string
		content  string
	}{
		{database: globalDB, refID: ordinaryRefID, boxID: ordinaryBox, path: ordinaryPath, content: "ordinary"},
		{database: encryptedDB, refID: encryptedRefID, boxID: encryptedBox, path: encryptedPath, content: "encrypted"},
	} {
		insertRefCacheTestRow(t, fixture.database, fixture.refID, defID, fixture.boxID, fixture.path, fixture.content)
	}

	ordinaryRefs := GetRefsCacheByDefIDInBox(defID, ordinaryBox)
	if len(ordinaryRefs) != 1 || ordinaryRefs[0].Content != "ordinary" {
		t.Fatalf("ordinary cold cache crossed content stores: %#v", ordinaryRefs)
	}
	encryptedRefs := GetRefsCacheByDefIDInBox(defID, encryptedBox)
	if len(encryptedRefs) != 1 || encryptedRefs[0].Content != "encrypted" {
		t.Fatalf("encrypted cold cache crossed content stores: %#v", encryptedRefs)
	}

	if _, err := globalDB.Exec("DELETE FROM refs WHERE def_block_id = ?", defID); err != nil {
		t.Fatalf("remove global backing row without invalidating cache: %v", err)
	}
	tx, err := encryptedDB.Begin()
	if err != nil {
		t.Fatalf("begin encrypted ref deletion: %v", err)
	}
	if err = deleteRefsByPathTx(tx, encryptedBox, encryptedPath); err != nil {
		rollbackTx(tx)
		t.Fatalf("delete encrypted refs: %v", err)
	}
	if err = commitTx(tx); err != nil {
		t.Fatalf("commit encrypted ref deletion: %v", err)
	}

	ordinaryRefs = GetRefsCacheByDefID(defID)
	if len(ordinaryRefs) != 1 || ordinaryRefs[0].Content != "ordinary" {
		t.Fatalf("encrypted invalidation removed the global composite key: %#v", ordinaryRefs)
	}
	if encryptedRefs = GetRefsCacheByDefIDInBox(defID, encryptedBox); len(encryptedRefs) != 0 {
		t.Fatalf("encrypted composite key remained stale after deletion: %#v", encryptedRefs)
	}
}

func TestRefCacheRejectsPreCommitColdQueryWriteback(t *testing.T) {
	const (
		defID        = "20990101121000-defcold"
		ordinaryBox  = "20990101121001-ordinary"
		ordinaryRef  = "20990101121002-refcold"
		ordinaryPath = "/cold-query.sy"
	)
	globalDB, _ := setupRefCacheTest(t, "20990101121003-encrypted")
	insertRefCacheTestRow(t, globalDB, ordinaryRef, defID, ordinaryBox, ordinaryPath, "before-commit")

	queryReady := make(chan struct{})
	allowWriteback := make(chan struct{})
	queryDone := make(chan []*Ref, 1)
	queryExited := make(chan struct{})
	var queryHookOnce sync.Once
	var releaseOnce sync.Once
	releaseQuery := func() { releaseOnce.Do(func() { close(allowWriteback) }) }
	refCacheAfterQueryHook = func(key string) {
		if key != refCacheKey(defID, ordinaryBox) {
			return
		}
		queryHookOnce.Do(func() {
			close(queryReady)
			<-allowWriteback
		})
	}
	go func() {
		defer close(queryExited)
		queryDone <- GetRefsCacheByDefIDInBox(defID, ordinaryBox)
	}()
	t.Cleanup(func() {
		releaseQuery()
		<-queryExited
	})
	waitRefCacheSignal(t, queryReady, "cold query did not reach the cache writeback boundary")

	tx, err := globalDB.Begin()
	if err != nil {
		t.Fatalf("begin reference deletion: %v", err)
	}
	if err = deleteRefsByPathTx(tx, ordinaryBox, ordinaryPath); err != nil {
		rollbackTx(tx)
		t.Fatalf("delete references in transaction: %v", err)
	}
	if err = commitTx(tx); err != nil {
		t.Fatalf("commit reference deletion: %v", err)
	}

	releaseQuery()
	select {
	case refs := <-queryDone:
		if len(refs) != 1 || refs[0].Content != "before-commit" {
			t.Fatalf("pre-commit query result changed after its snapshot: %#v", refs)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("pre-commit query did not finish")
	}
	if refs := GetRefsCacheByDefIDInBox(defID, ordinaryBox); len(refs) != 0 {
		t.Fatalf("pre-commit query repopulated stale references after commit: %#v", refs)
	}
}

func setupRefCacheTest(t *testing.T, encryptedBox string) (globalDB, encryptedDB *stdsql.DB) {
	t.Helper()
	globalDB = newRefsTestDB(t, "global-refs.db")
	encryptedDB = newRefsTestDB(t, "encrypted-refs.db")
	previousDB := db
	previousEncryptedDBs := encryptedDBs
	previousIsEncryptedBox := IsEncryptedBoxFn
	previousQueryHook := refCacheAfterQueryHook
	db = globalDB
	encryptedDBs = &sync.Map{}
	encryptedDBs.Store(encryptedBox, encryptedDB)
	IsEncryptedBoxFn = func(boxID string) bool { return boxID == encryptedBox }
	refCacheAfterQueryHook = nil
	ClearCache()
	t.Cleanup(func() {
		ClearCache()
		refCacheAfterQueryHook = previousQueryHook
		db = previousDB
		encryptedDBs = previousEncryptedDBs
		IsEncryptedBoxFn = previousIsEncryptedBox
	})
	return
}

func insertRefCacheTestRow(t *testing.T, database *stdsql.DB, refID, defID, boxID, path, content string) {
	t.Helper()
	if _, err := database.Exec(
		"INSERT INTO refs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		refID, defID, "", defID, "/def.sy", refID, refID, boxID, path, content, content, "d",
	); err != nil {
		t.Fatalf("insert ref cache row: %v", err)
	}
}

func waitRefCacheSignal(t *testing.T, signal <-chan struct{}, failure string) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(5 * time.Second):
		t.Fatal(failure)
	}
}
