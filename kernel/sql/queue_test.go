// SiYuan - Refactor your thinking
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

package sql

import (
	stdsql "database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/88250/lute/parse"
	"github.com/siyuan-note/siyuan/kernel/cache"
	"github.com/siyuan-note/siyuan/kernel/filesys"
	"github.com/siyuan-note/siyuan/kernel/treenode"
	"github.com/siyuan-note/siyuan/kernel/util"
)

func isolateQueueState(t *testing.T) string {
	t.Helper()

	originalQueueDir := util.QueueDir
	originalIndexFlock := indexFlock
	originalIndexQueueSize := indexQueueSize.Load()
	originalDeferredIndexRecoveryBoxes := deferredIndexRecoveryBoxes
	originalQueueAdmission := queueAdmission
	originalOrdinaryFlushAfterSnapshotHook := ordinaryFlushAfterSnapshotHook
	originalQueueAfterDurableCommitHook := queueAfterDurableCommitHook
	originalInitDatabaseAdmissionBlockedHook := initDatabaseAdmissionBlockedHook
	dbQueueLock.Lock()
	originalOperations := append([]*dbQueueOperation(nil), operationQueue...)
	originalFlushingTx := flushingTx
	originalIndexQueueRecoveryErr := indexQueueRecoveryErr
	originalIndexQueueRecoveryErrs := indexQueueRecoveryErrs
	operationQueue = nil
	flushingTx = false
	indexQueueRecoveryErr = nil
	indexQueueRecoveryErrs = map[string]error{}
	dbQueueLock.Unlock()

	tempDir := t.TempDir()
	util.QueueDir = filepath.Join(tempDir, "queue")
	if err := os.MkdirAll(util.QueueDir, 0755); err != nil {
		t.Fatalf("create queue directory: %v", err)
	}
	indexQueueSize.Store(0)
	deferredIndexRecoveryBoxes = &sync.Map{}
	initIndexQueue()
	queueAdmission = newQueueAdmissionGate()
	ordinaryFlushAfterSnapshotHook = nil
	queueAfterDurableCommitHook = nil
	initDatabaseAdmissionBlockedHook = nil

	t.Cleanup(func() {
		closeIndexQueue()
		util.QueueDir = originalQueueDir
		indexFlock = originalIndexFlock
		indexQueueSize.Store(originalIndexQueueSize)
		deferredIndexRecoveryBoxes = originalDeferredIndexRecoveryBoxes
		queueAdmission = originalQueueAdmission
		ordinaryFlushAfterSnapshotHook = originalOrdinaryFlushAfterSnapshotHook
		queueAfterDurableCommitHook = originalQueueAfterDurableCommitHook
		initDatabaseAdmissionBlockedHook = originalInitDatabaseAdmissionBlockedHook
		dbQueueLock.Lock()
		operationQueue = originalOperations
		flushingTx = originalFlushingTx
		indexQueueRecoveryErr = originalIndexQueueRecoveryErr
		indexQueueRecoveryErrs = originalIndexQueueRecoveryErrs
		dbQueueLock.Unlock()
	})
	return tempDir
}

func TestDeleteTreeQueueEntriesPreserveContentStoreIdentity(t *testing.T) {
	const (
		boxID  = "20260716000000-deleteq"
		rootID = "20260716000001-deleteq"
	)
	for _, operation := range []*dbQueueOperation{
		{action: "delete_id", removeTreeBox: boxID, removeTreeID: rootID},
		{action: "delete_ids", removeTreeBox: boxID, removeTreeIDs: []string{rootID}},
	} {
		t.Run(operation.action, func(t *testing.T) {
			entry := dbOpToIndexEntry(operation)
			data, err := json.Marshal(entry)
			if err != nil {
				t.Fatalf("marshal durable delete operation: %v", err)
			}
			var decoded indexEntry
			if err = json.Unmarshal(data, &decoded); err != nil {
				t.Fatalf("unmarshal durable delete operation: %v", err)
			}
			restored, restoreErr := indexEntryToOp(decoded, nil)
			if restoreErr != nil {
				t.Fatalf("restore durable delete operation: %v", restoreErr)
			}
			if restored.boxID() != boxID {
				t.Fatalf("restored delete routes to box %q, want %q", restored.boxID(), boxID)
			}
			if operation.action == "delete_id" && restored.removeTreeID != rootID {
				t.Fatalf("restored delete root = %q, want %q", restored.removeTreeID, rootID)
			}
			if operation.action == "delete_ids" && (len(restored.removeTreeIDs) != 1 || restored.removeTreeIDs[0] != rootID) {
				t.Fatalf("restored batch delete roots = %#v, want %q", restored.removeTreeIDs, rootID)
			}
		})
	}
}

func TestQueueCoalescingPreservesContentStoreIdentity(t *testing.T) {
	isolateQueueState(t)

	const (
		id        = "20260716000000-queueid"
		firstBox  = "20260716000001-boxone"
		secondBox = "20260716000002-boxtwo"
	)
	newTree := func(box string) *parse.Tree {
		return &parse.Tree{ID: id, Box: box, Path: "/" + id + ".sy"}
	}
	tests := []struct {
		name    string
		enqueue func(box string) error
	}{
		{name: "index node", enqueue: func(box string) error { return IndexNodeQueue(id, box) }},
		{name: "update block content", enqueue: func(box string) error {
			UpdateBlockContentTransientQueue(&Block{ID: id, Box: box})
			return nil
		}},
		{name: "delete refs", enqueue: func(box string) error { return DeleteRefsTreeQueue(newTree(box)) }},
		{name: "update refs", enqueue: func(box string) error { return UpdateRefsTreeQueue(newTree(box)) }},
		{name: "index tree", enqueue: func(box string) error { return IndexTreeQueue(newTree(box)) }},
		{name: "upsert tree", enqueue: func(box string) error { return UpsertTreeQueue(newTree(box)) }},
		{name: "rename tree", enqueue: func(box string) error { return RenameTreeQueue(newTree(box)) }},
		{name: "move tree", enqueue: func(box string) error { return MoveTreeQueue(newTree(box)) }},
		{name: "remove tree", enqueue: func(box string) error { return RemoveTreeQueue(box, id) }},
		{name: "remove tree path", enqueue: func(box string) error { return RemoveTreePathQueue(box, "/same/path") }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if err := ClearQueue(); err != nil {
				t.Fatalf("clear queue before identity case: %v", err)
			}
			if err := test.enqueue(firstBox); err != nil {
				t.Fatalf("enqueue first content store: %v", err)
			}
			if err := test.enqueue(secondBox); err != nil {
				t.Fatalf("enqueue second content store: %v", err)
			}

			dbQueueLock.Lock()
			ops := append([]*dbQueueOperation(nil), operationQueue...)
			dbQueueLock.Unlock()
			if len(ops) != 2 {
				t.Fatalf("queued operations = %d, want one operation per content store", len(ops))
			}
			boxes := map[string]bool{}
			for _, op := range ops {
				boxes[op.boxID()] = true
			}
			if !boxes[firstBox] || !boxes[secondBox] {
				t.Fatalf("queued content stores = %#v, want %q and %q", boxes, firstBox, secondBox)
			}
		})
	}
}

func TestQueueBatchRollbackRestoresPriorOperationAndPreservesOtherStores(t *testing.T) {
	isolateQueueState(t)

	const (
		rebuildBox = "20260717010100-rebuild"
		otherBox   = "20260717010101-otherbx"
	)
	if err := DeleteBoxQueue(rebuildBox); err != nil {
		t.Fatalf("queue operation that predates rebuild batch: %v", err)
	}
	batch := BeginQueueBatch()
	lease := batch.AcquireQueueAdmissionLease()
	if err := lease.DeleteBoxQueue(rebuildBox); err != nil {
		lease.Release()
		t.Fatalf("queue rebuild-owned replacement: %v", err)
	}
	lease.Release()
	if err := DeleteBoxQueue(otherBox); err != nil {
		t.Fatalf("queue concurrent other-store operation: %v", err)
	}
	if err := batch.Rollback(); err != nil {
		t.Fatalf("rollback rebuild queue batch: %v", err)
	}

	dbQueueLock.Lock()
	ops := append([]*dbQueueOperation(nil), operationQueue...)
	dbQueueLock.Unlock()
	if len(ops) != 2 {
		t.Fatalf("in-memory queue after batch rollback = %#v, want prior and other-store operations", ops)
	}
	seen := map[string]string{}
	for _, op := range ops {
		seen[op.boxID()] = op.batchID
	}
	if _, found := seen[rebuildBox]; !found || seen[rebuildBox] != "" {
		t.Fatalf("pre-batch rebuild operation was not restored: %#v", seen)
	}
	if _, found := seen[otherBox]; !found || seen[otherBox] != "" {
		t.Fatalf("other-store operation was not preserved: %#v", seen)
	}
	entries, _, err := loadIndexQueue()
	if err != nil {
		t.Fatalf("load durable queue after batch rollback: %v", err)
	}
	if len(entries) != 2 || entries[0].Box != rebuildBox || entries[1].Box != otherBox {
		t.Fatalf("durable queue after batch rollback = %#v, want prior rebuild then other store", entries)
	}
	for _, entry := range entries {
		if entry.Batch != "" {
			t.Fatalf("rolled-back batch generation remains durable: %#v", entries)
		}
	}
}

func TestUpdateBlockContentQueueKeepsDerivedPlaintextTransient(t *testing.T) {
	isolateQueueState(t)

	const (
		boxID   = "20260716000000-transq"
		blockID = "20260716000001-transq"
	)
	UpdateBlockContentTransientQueue(&Block{ID: blockID, Box: boxID, Content: "first plaintext"})
	UpdateBlockContentTransientQueue(&Block{ID: blockID, Box: boxID, Content: "latest plaintext"})

	entries, _, err := loadIndexQueue()
	if err != nil {
		t.Fatalf("load durable queue: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("durable queue contains transient block content: %#v", entries)
	}

	dbQueueLock.Lock()
	ops := append([]*dbQueueOperation(nil), operationQueue...)
	dbQueueLock.Unlock()
	if len(ops) != 1 || ops[0].block.Content != "latest plaintext" {
		t.Fatalf("transient queue = %#v, want one latest block-content operation", ops)
	}
}

func TestQueueAdmissionCloseCallbackDoesNotBlockReaderRelease(t *testing.T) {
	gate := newQueueAdmissionGate()
	reader := gate.acquire(nil)
	callbackStarted := make(chan struct{})
	allowCallbackReturn := make(chan struct{})
	closeDone := make(chan func(), 1)
	go func() {
		closeDone <- gate.close(func() {
			close(callbackStarted)
			<-allowCallbackReturn
		})
	}()

	select {
	case <-callbackStarted:
	case <-time.After(time.Second):
		t.Fatal("admission close callback did not start")
	}
	releaseDone := make(chan struct{})
	go func() {
		reader.Release()
		close(releaseDone)
	}()
	select {
	case <-releaseDone:
	case <-time.After(time.Second):
		t.Fatal("reader release blocked behind admission close callback")
	}

	close(allowCallbackReturn)
	select {
	case reopen := <-closeDone:
		reopen()
	case <-time.After(time.Second):
		t.Fatal("admission close did not finish after callback and reader completed")
	}
}

func TestQueueAdmissionLeaseOwnedMethodsDoNotReacquireClosedAdmission(t *testing.T) {
	isolateQueueState(t)

	const (
		boxID  = "20260717000000-leasebx"
		rootID = "20260717000001-leasert"
	)
	tree := &parse.Tree{ID: rootID, Box: boxID, Path: "/" + rootID + ".sy"}
	lease := AcquireQueueAdmissionLease()
	closeBlocked := make(chan struct{})
	closeDone := make(chan func(), 1)
	go func() {
		closeDone <- queueAdmission.close(func() { close(closeBlocked) })
	}()
	select {
	case <-closeBlocked:
	case <-time.After(time.Second):
		lease.Release()
		t.Fatal("queue admission close did not block on the held lease")
	}

	enqueueDone := make(chan error, 1)
	go func() {
		for _, enqueue := range []func() error{
			func() error { return lease.UpdateRefsTreeQueue(tree) },
			func() error { return lease.RemoveTreeQueue(boxID, rootID) },
			func() error { return lease.DeleteBoxQueue(boxID) },
			func() error { return lease.DeleteBoxRefsQueue(boxID) },
			func() error { return lease.BatchRemoveTreeQueueInBox([]string{rootID}, boxID) },
		} {
			if err := enqueue(); err != nil {
				enqueueDone <- err
				return
			}
		}
		enqueueDone <- nil
	}()

	var enqueueErr error
	select {
	case enqueueErr = <-enqueueDone:
	case <-time.After(time.Second):
		lease.Release()
		reopen := <-closeDone
		reopen()
		<-enqueueDone
		t.Fatal("lease-owned queue method reacquired closed admission")
	}
	lease.Release()
	select {
	case reopen := <-closeDone:
		reopen()
	case <-time.After(time.Second):
		t.Fatal("queue admission did not finish closing after lease release")
	}
	if enqueueErr != nil {
		t.Fatalf("queue through admission lease: %v", enqueueErr)
	}

	dbQueueLock.Lock()
	queued := len(operationQueue)
	dbQueueLock.Unlock()
	if queued != 5 {
		t.Fatalf("lease-owned operations queued = %d, want 5", queued)
	}
}

func TestExclusiveQueueAdmissionOwnerKeepsOrdinaryWritersBlockedAcrossBatchRollbackAndFlush(t *testing.T) {
	isolateQueueState(t)

	owner := AcquireExclusiveQueueAdmission(nil)
	defer owner.Release()
	batch := owner.BeginQueueBatch()
	lease := batch.AcquireQueueAdmissionLease()
	if err := lease.DeleteBoxQueue("20260717010300-ownerbx"); err != nil {
		t.Fatalf("enqueue owner batch operation: %v", err)
	}
	lease.Release()

	waiterBlocked := make(chan struct{})
	waiterDone := make(chan struct{})
	go func() {
		waiter := queueAdmission.acquire(func() { close(waiterBlocked) })
		waiter.Release()
		close(waiterDone)
	}()
	select {
	case <-waiterBlocked:
	case <-time.After(time.Second):
		t.Fatal("ordinary writer did not reach the closed admission gate")
	}

	if err := batch.Rollback(); err != nil {
		t.Fatalf("rollback owner batch while admission is closed: %v", err)
	}
	if err := owner.FlushQueue(); err != nil {
		t.Fatalf("flush owner scope while admission is closed: %v", err)
	}
	select {
	case <-waiterDone:
		t.Fatal("owner batch rollback or flush reopened ordinary admission")
	default:
	}

	owner.Release()
	select {
	case <-waiterDone:
	case <-time.After(time.Second):
		t.Fatal("ordinary writer did not continue after owner release")
	}
	entries, _, err := loadIndexQueue()
	if err != nil {
		t.Fatalf("load durable queue after owner batch rollback: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("owner batch rollback retained durable entries: %#v", entries)
	}
}

func TestRegularFlushReopensAdmissionAfterSnapshot(t *testing.T) {
	isolateQueueState(t)

	hookStarted := make(chan struct{})
	allowFlush := make(chan struct{})
	allowFlushClosed := false
	ordinaryFlushAfterSnapshotHook = func() {
		close(hookStarted)
		<-allowFlush
	}
	flushDone := make(chan error, 1)
	go func() {
		flushDone <- FlushQueue()
		close(flushDone)
	}()
	defer func() {
		if !allowFlushClosed {
			close(allowFlush)
		}
		select {
		case <-flushDone:
		case <-time.After(time.Second):
			t.Error("regular flush did not exit during cleanup")
		}
	}()

	select {
	case <-hookStarted:
	case <-time.After(time.Second):
		t.Fatal("regular flush did not reach the post-snapshot boundary")
	}
	enqueueDone := make(chan error, 1)
	go func() {
		enqueueDone <- IndexNodeQueue("20260716000000-flushq", "20260716000001-flushq")
	}()
	select {
	case err := <-enqueueDone:
		if err != nil {
			t.Fatalf("enqueue after regular flush snapshot: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("regular flush kept admission closed while captured work was pending")
	}
	close(allowFlush)
	allowFlushClosed = true
	select {
	case err := <-flushDone:
		if err != nil {
			t.Fatalf("regular flush failed: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("regular flush did not finish")
	}

	entries, _, err := loadIndexQueue()
	if err != nil {
		t.Fatalf("load post-snapshot durable suffix: %v", err)
	}
	if len(entries) != 1 || entries[0].Action != "index_node" {
		t.Fatalf("post-snapshot durable suffix = %#v, want the newly admitted operation", entries)
	}
}

func TestFlushQueueReturnsMalformedDurableQueueErrorWithoutChangingFile(t *testing.T) {
	isolateQueueState(t)

	queuePath := filepath.Join(util.QueueDir, "index.queue")
	original := []byte("{\"action\":\"delete_assets\",\"hashes\":[\"kept\"]}\n{malformed")
	if err := os.WriteFile(queuePath, original, 0644); err != nil {
		t.Fatalf("write malformed durable queue: %v", err)
	}

	if err := FlushQueue(); err == nil {
		t.Fatal("flush accepted a malformed durable queue")
	} else if !strings.Contains(err.Error(), "decode index queue") {
		t.Fatalf("flush error = %v, want durable queue decode failure", err)
	}
	after, err := os.ReadFile(queuePath)
	if err != nil {
		t.Fatalf("read durable queue after failed drain: %v", err)
	}
	if string(after) != string(original) {
		t.Fatalf("failed drain changed malformed durable queue: got %q, want %q", after, original)
	}
}

func TestRecoveryFailureBlocksNewWorkAndDrainUntilQueueIsCleared(t *testing.T) {
	isolateQueueState(t)

	queuePath := filepath.Join(util.QueueDir, "index.queue")
	original := []byte("{\"action\":\"unknown_recovery_action\",\"id\":\"20260716000000-recover\"}\n")
	if err := os.WriteFile(queuePath, original, 0644); err != nil {
		t.Fatalf("write unrestorable durable queue: %v", err)
	}
	recoverIndexQueue()

	if err := IndexNodeQueue("20260716000001-recover", ""); err == nil {
		t.Fatal("durable enqueue succeeded while queue recovery was unresolved")
	}
	if release, err := DrainQueueForBox("", nil); err == nil {
		release()
		t.Fatal("drain succeeded while queue recovery was unresolved")
	} else if release != nil {
		t.Fatal("failed recovery drain returned an admission release function")
	}
	after, err := os.ReadFile(queuePath)
	if err != nil {
		t.Fatalf("read durable queue after blocked drain: %v", err)
	}
	if string(after) != string(original) {
		t.Fatalf("blocked drain changed unrestored durable queue: got %q, want %q", after, original)
	}

	if err := ClearQueue(); err != nil {
		t.Fatalf("clear failed recovery queue: %v", err)
	}
	if err = IndexNodeQueue("20260716000001-recover", ""); err != nil {
		t.Fatalf("durable enqueue remained blocked after clearing the queue: %v", err)
	}
	entries, _, err := loadIndexQueue()
	if err != nil {
		t.Fatalf("load durable queue after clear: %v", err)
	}
	if len(entries) != 1 || entries[0].Action != "index_node" || entries[0].ID != "20260716000001-recover" {
		t.Fatalf("durable queue after clear = %#v, want only the newly admitted operation", entries)
	}
}

func makeIndexQueueUnclearable(t *testing.T) {
	t.Helper()
	queuePath := filepath.Join(util.QueueDir, "index.queue")
	if err := os.Remove(queuePath); err != nil && !os.IsNotExist(err) {
		t.Fatalf("remove index queue before failure fixture: %v", err)
	}
	if err := os.Mkdir(queuePath, 0755); err != nil {
		t.Fatalf("replace index queue with directory: %v", err)
	}
}

func TestForcedDatabaseRebuildPreservesOpenDatabaseWhenQueueClearFails(t *testing.T) {
	tempDir := isolateQueueState(t)
	originalDB := db
	originalDBPath := util.DBPath
	databasePath := filepath.Join(tempDir, "forced-rebuild.db")
	testDB, err := stdsql.Open("sqlite3", databasePath)
	if err != nil {
		t.Fatalf("open forced-rebuild sentinel database: %v", err)
	}
	db = testDB
	util.DBPath = databasePath
	t.Cleanup(func() {
		db = originalDB
		util.DBPath = originalDBPath
		testDB.Close()
	})
	for _, statement := range []string{
		"CREATE TABLE rebuild_sentinel (value TEXT)",
		"INSERT INTO rebuild_sentinel VALUES ('preserved')",
	} {
		if _, err = testDB.Exec(statement); err != nil {
			t.Fatalf("initialize forced-rebuild sentinel with %q: %v", statement, err)
		}
	}
	makeIndexQueueUnclearable(t)

	if err = InitDatabase(true); err == nil {
		t.Fatal("forced database rebuild succeeded despite queue-clear failure")
	} else if !strings.Contains(err.Error(), "clear queue before forced database rebuild") {
		t.Fatalf("forced database rebuild error = %v, want queue-clear context", err)
	}
	if db != testDB {
		t.Fatal("forced database rebuild replaced the open database after queue-clear failure")
	}
	var value string
	if err = testDB.QueryRow("SELECT value FROM rebuild_sentinel").Scan(&value); err != nil {
		t.Fatalf("query forced-rebuild sentinel after queue-clear failure: %v", err)
	}
	if value != "preserved" {
		t.Fatalf("forced-rebuild sentinel = %q, want preserved", value)
	}
}

func TestVersionDatabaseRebuildPreservesOpenDatabaseWhenQueueClearFails(t *testing.T) {
	tempDir := isolateQueueState(t)
	originalDB := db
	originalDBPath := util.DBPath
	originalBlockTreeDBPath := util.BlockTreeDBPath
	databasePath := filepath.Join(tempDir, "version-rebuild.db")
	testDB, err := stdsql.Open("sqlite3", databasePath)
	if err != nil {
		t.Fatalf("open version-rebuild sentinel database: %v", err)
	}
	db = testDB
	util.DBPath = databasePath
	util.BlockTreeDBPath = filepath.Join(tempDir, "version-rebuild-blocktree.db")
	t.Cleanup(func() {
		db = originalDB
		util.DBPath = originalDBPath
		util.BlockTreeDBPath = originalBlockTreeDBPath
		testDB.Close()
	})
	for _, statement := range []string{
		"CREATE TABLE stat (key, value)",
		"INSERT INTO stat VALUES ('siyuan_database_ver', 'outdated')",
		"CREATE TABLE rebuild_sentinel (value TEXT)",
		"INSERT INTO rebuild_sentinel VALUES ('preserved')",
	} {
		if _, err = testDB.Exec(statement); err != nil {
			t.Fatalf("initialize version-rebuild sentinel with %q: %v", statement, err)
		}
	}
	makeIndexQueueUnclearable(t)

	if err = InitDatabase(false); err == nil {
		t.Fatal("version database rebuild succeeded despite queue-clear failure")
	} else if !strings.Contains(err.Error(), "clear queue before database version rebuild") {
		t.Fatalf("version database rebuild error = %v, want queue-clear context", err)
	}
	if db != testDB {
		t.Fatal("version database rebuild replaced the open database after queue-clear failure")
	}
	var value string
	if err = testDB.QueryRow("SELECT value FROM rebuild_sentinel").Scan(&value); err != nil {
		t.Fatalf("query version-rebuild sentinel after queue-clear failure: %v", err)
	}
	if value != "preserved" {
		t.Fatalf("version-rebuild sentinel = %q, want preserved", value)
	}
}

func TestInitDatabaseWaitsForAdmittedReaderBeforeTouchingOpenDatabase(t *testing.T) {
	tempDir := isolateQueueState(t)
	originalDB := db
	originalDBPath := util.DBPath
	databasePath := filepath.Join(tempDir, "reader-protected.db")
	testDB, err := stdsql.Open("sqlite3", databasePath)
	if err != nil {
		t.Fatalf("open reader-protected database: %v", err)
	}
	db = testDB
	util.DBPath = databasePath
	t.Cleanup(func() {
		db = originalDB
		util.DBPath = originalDBPath
		testDB.Close()
	})
	for _, statement := range []string{
		"CREATE TABLE reader_sentinel (value TEXT)",
		"INSERT INTO reader_sentinel VALUES ('available')",
	} {
		if _, err = testDB.Exec(statement); err != nil {
			t.Fatalf("initialize reader-protected database with %q: %v", statement, err)
		}
	}
	makeIndexQueueUnclearable(t)

	reader := AcquireQueueAdmissionLease()
	readerReleased := false
	initBlocked := make(chan struct{})
	initDatabaseAdmissionBlockedHook = func() { close(initBlocked) }
	initDone := make(chan struct{})
	var initErr error
	go func() {
		initErr = InitDatabase(true)
		close(initDone)
	}()
	defer func() {
		if !readerReleased {
			reader.Release()
		}
		select {
		case <-initDone:
		case <-time.After(time.Second):
			t.Error("database initialization did not exit during cleanup")
		}
	}()

	select {
	case <-initBlocked:
	case <-time.After(time.Second):
		t.Fatal("database initialization did not block on the admitted reader")
	}
	var value string
	if err = testDB.QueryRow("SELECT value FROM reader_sentinel").Scan(&value); err != nil {
		t.Fatalf("query old database while admitted reader is held: %v", err)
	}
	if value != "available" {
		t.Fatalf("reader sentinel = %q, want old database to remain available", value)
	}

	reader.Release()
	readerReleased = true
	select {
	case <-initDone:
	case <-time.After(time.Second):
		t.Fatal("database initialization did not continue after admitted reader release")
	}
	if initErr == nil {
		t.Fatal("database initialization succeeded despite controlled queue-clear failure")
	}
	if !strings.Contains(initErr.Error(), "clear queue before forced database rebuild") {
		t.Fatalf("database initialization error = %v, want queue-clear context", initErr)
	}
	if db != testDB {
		t.Fatal("database initialization replaced the old database after queue-clear failure")
	}
}

func TestSuccessfulRecoveryClearsFailureAndRetainsRepairedWork(t *testing.T) {
	isolateQueueState(t)

	queuePath := filepath.Join(util.QueueDir, "index.queue")
	if err := os.WriteFile(queuePath, []byte("{\"action\":\"unknown_recovery_action\"}\n"), 0644); err != nil {
		t.Fatalf("write initial unrestorable queue: %v", err)
	}
	recoverIndexQueue()

	repaired := []byte("{\"action\":\"delete_assets\",\"hashes\":[\"recovered-hash\"]}\n")
	if err := os.WriteFile(queuePath, repaired, 0644); err != nil {
		t.Fatalf("repair durable queue fixture: %v", err)
	}
	recoverIndexQueue()
	if err := IndexNodeQueue("20260716000002-recover", ""); err != nil {
		t.Fatalf("durable enqueue remained blocked after successful recovery: %v", err)
	}

	entries, _, err := loadIndexQueue()
	if err != nil {
		t.Fatalf("load durable queue after successful recovery: %v", err)
	}
	if len(entries) != 2 || entries[0].Action != "delete_assets" || len(entries[0].Hashes) != 1 || entries[0].Hashes[0] != "recovered-hash" || entries[1].Action != "index_node" {
		t.Fatalf("durable queue after successful recovery = %#v, want recovered and newly admitted work", entries)
	}
}

func TestEncryptedRecoveryRetryClearsOnlyItsOwnDurableQueueFailure(t *testing.T) {
	fixture := setupCrossStoreQueueFixture(t)
	if err := DeleteBoxQueue(fixture.encryptedBox); err != nil {
		t.Fatalf("queue encrypted recovery fixture: %v", err)
	}
	dbQueueLock.Lock()
	operationQueue = nil
	dbQueueLock.Unlock()

	realQueueDir := util.QueueDir
	blockedParent := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(blockedParent, []byte("blocked"), 0644); err != nil {
		t.Fatalf("create real ENOTDIR recovery boundary: %v", err)
	}
	util.QueueDir = filepath.Join(blockedParent, "queue")
	recoverIndexQueue()
	firstRecovery := BeginEncryptedIndexQueueRecovery(fixture.encryptedBox)
	if err := firstRecovery.Recover(); err == nil {
		t.Fatal("explicit encrypted recovery read an index queue below a non-directory")
	}
	util.QueueDir = realQueueDir

	if err := BatchRemoveAssetsQueue([]string{"blocked-before-retry"}); err == nil {
		t.Fatal("durable enqueue ignored unresolved recovery owners")
	}
	if release, err := DrainQueueForBox(fixture.encryptedBox, nil); err == nil {
		release()
		t.Fatal("drain ignored unresolved recovery owners")
	} else if release != nil {
		t.Fatal("failed recovery drain returned an admission release function")
	}

	secondRecovery := BeginEncryptedIndexQueueRecovery(fixture.encryptedBox)
	if err := secondRecovery.Recover(); err != nil {
		t.Fatalf("retry explicit encrypted recovery after restoring queue path: %v", err)
	}
	if recoveryErr := currentIndexQueueRecoveryError(); recoveryErr == nil {
		t.Fatal("explicit recovery success cleared the unrelated startup recovery error")
	} else if strings.Contains(recoveryErr.Error(), encryptedIndexQueueRecoverySource(fixture.encryptedBox)) {
		t.Fatalf("explicit recovery success retained its own error: %v", recoveryErr)
	}
	if err := BatchRemoveAssetsQueue([]string{"still-blocked-by-startup"}); err == nil {
		t.Fatal("durable enqueue ignored the unrelated startup recovery error")
	}

	recoverIndexQueue()
	if recoveryErr := currentIndexQueueRecoveryError(); recoveryErr != nil {
		t.Fatalf("successful startup retry retained recovery errors: %v", recoveryErr)
	}
	if err := FlushQueue(); err != nil {
		t.Fatalf("flush after successful owner-scoped recovery retries: %v", err)
	}
	if err := BatchRemoveAssetsQueue([]string{"accepted-after-retry"}); err != nil {
		t.Fatalf("durable enqueue after successful owner-scoped recovery retries: %v", err)
	}
	release, err := DrainQueueForBox("", nil)
	if err != nil {
		t.Fatalf("drain after successful owner-scoped recovery retries: %v", err)
	}
	release()
}

func TestCrashRecoveryCoalescesLatestTreePathBeforeLoading(t *testing.T) {
	isolateQueueState(t)

	const (
		boxID          = "20260716000000-recovbx"
		rootID         = "20260716000001-recovrx"
		oldParentID    = "20260716000002-recovpa"
		latestParentID = "20260716000003-recovpb"
	)
	originalDataDir := util.DataDir
	util.DataDir = t.TempDir()
	t.Cleanup(func() {
		cache.RemoveTreeDataInBox(rootID, boxID)
		cache.RemoveTreeDataInBox(latestParentID, boxID)
		util.DataDir = originalDataDir
	})

	oldPath := "/" + oldParentID + "/" + rootID + ".sy"
	latestPath := "/" + latestParentID + "/" + rootID + ".sy"
	oldTree := &parse.Tree{ID: rootID, Box: boxID, Path: oldPath}
	latestParent := treenode.NewTree(boxID, "/"+latestParentID+".sy", "/Latest", "Latest")
	if _, err := filesys.WriteTree(latestParent); err != nil {
		t.Fatalf("write latest parent fixture: %v", err)
	}
	latestTree := treenode.NewTree(boxID, latestPath, "/Latest", "Latest")
	if _, err := filesys.WriteTree(latestTree); err != nil {
		t.Fatalf("write latest tree fixture: %v", err)
	}
	if err := UpsertTreeQueue(oldTree); err != nil {
		t.Fatalf("append old durable tree path: %v", err)
	}
	if err := UpsertTreeQueue(latestTree); err != nil {
		t.Fatalf("append latest durable tree path: %v", err)
	}

	dbQueueLock.Lock()
	operationQueue = nil
	dbQueueLock.Unlock()
	cache.RemoveTreeDataInBox(rootID, boxID)
	recoverIndexQueue()

	dbQueueLock.Lock()
	ops := append([]*dbQueueOperation(nil), operationQueue...)
	dbQueueLock.Unlock()
	if len(ops) != 1 {
		t.Fatalf("recovered operations = %d, want one coalesced operation", len(ops))
	}
	if ops[0].upsertTree == nil || ops[0].upsertTree.Path != latestPath {
		t.Fatalf("recovered tree path = %#v, want %q", ops[0].upsertTree, latestPath)
	}

	entries, _, err := loadIndexQueue()
	if err != nil {
		t.Fatalf("load raw durable queue after recovery: %v", err)
	}
	if len(entries) != 2 {
		t.Fatalf("raw durable queue entries = %d, want append-only old and latest records", len(entries))
	}
}

func TestDrainQueueKeepsAdmissionClosedUntilRelease(t *testing.T) {
	isolateQueueState(t)

	release, err := DrainQueueForBox("20260716000000-drainsq", nil)
	if err != nil {
		t.Fatalf("close SQL admission: %v", err)
	}
	released := false

	blocked := make(chan struct{})
	readerDone := make(chan struct{})
	go func() {
		defer close(readerDone)
		lease := queueAdmission.acquire(func() { close(blocked) })
		lease.Release()
	}()
	defer func() {
		if !released {
			release()
			released = true
		}
		select {
		case <-readerDone:
		case <-time.After(time.Second):
			t.Error("SQL admission reader did not exit during cleanup")
		}
	}()
	select {
	case <-blocked:
	case <-time.After(time.Second):
		t.Fatal("SQL admission did not observe the closed drain gate")
	}

	release()
	released = true
	select {
	case <-readerDone:
	case <-time.After(time.Second):
		t.Fatal("SQL admission did not reopen after drain release")
	}
}

func TestDrainQueueRejectsDeferredWorkForTargetBoxOnly(t *testing.T) {
	isolateQueueState(t)

	const (
		lockedBox = "20260717010300-lockedt"
		otherBox  = "20260717010301-otherdr"
		nodeID    = "20260717010302-drainop"
	)
	originalIsEncryptedBoxFn := IsEncryptedBoxFn
	IsEncryptedBoxFn = func(boxID string) bool { return boxID == lockedBox }
	t.Cleanup(func() { IsEncryptedBoxFn = originalIsEncryptedBoxFn })
	entry, err := json.Marshal(indexEntry{Action: "index_node", ID: nodeID, Box: lockedBox})
	if err != nil {
		t.Fatalf("marshal deferred target operation: %v", err)
	}
	entry = append(entry, '\n')
	if err = os.WriteFile(filepath.Join(util.QueueDir, "index.queue"), entry, 0644); err != nil {
		t.Fatalf("write deferred target operation: %v", err)
	}

	if err = FlushQueue(); err != nil {
		t.Fatalf("ordinary flush was blocked by a locked encrypted box: %v", err)
	}
	if release, drainErr := DrainQueueForBox(otherBox, nil); drainErr != nil {
		t.Fatalf("other-box drain was blocked by deferred work for %s: %v", lockedBox, drainErr)
	} else {
		release()
	}
	if release, drainErr := DrainQueueForBox(lockedBox, nil); drainErr == nil {
		release()
		t.Fatal("target-box drain accepted deferred durable work")
	} else if release != nil {
		t.Fatal("failed target-box drain returned an admission release function")
	}
	entries, _, err := loadIndexQueue()
	if err != nil {
		t.Fatalf("load durable queue after rejected target drain: %v", err)
	}
	if len(entries) != 1 || entries[0].Action != "index_node" || entries[0].Box != lockedBox || entries[0].ID != nodeID {
		t.Fatalf("durable queue after rejected target drain = %#v, want retained target operation", entries)
	}
	if recoveryErr := currentIndexQueueRecoveryError(); recoveryErr != nil {
		t.Fatalf("target drain failure became a global recovery error: %v", recoveryErr)
	}
}

func TestTreeQueueRejectsAnUndurableAppend(t *testing.T) {
	isolateQueueState(t)

	queueDir := util.QueueDir
	if err := os.RemoveAll(queueDir); err != nil {
		t.Fatalf("remove queue directory: %v", err)
	}
	if err := os.WriteFile(queueDir, []byte("not a directory"), 0644); err != nil {
		t.Fatalf("replace queue directory with a file: %v", err)
	}

	tree := &parse.Tree{
		ID:   "20260716000000-undurable",
		Box:  "20260716000001-undurable",
		Path: "/20260716000000-undurable.sy",
	}
	if err := UpsertTreeQueue(tree); err == nil {
		t.Fatal("tree queue accepted an operation whose durable append failed")
	}

	dbQueueLock.Lock()
	queued := len(operationQueue)
	dbQueueLock.Unlock()
	if queued != 0 {
		t.Fatalf("in-memory queue contains %d operations after durable append failure", queued)
	}
}

func TestFlushQueueReturnsExecFailureAndPersistsOnlyUncommittedSuffix(t *testing.T) {
	tempDir := isolateQueueState(t)

	originalDB := db
	originalIsEncryptedBoxFn := IsEncryptedBoxFn
	originalIsExiting := util.IsExiting.Load()
	IsEncryptedBoxFn = nil
	util.IsExiting.Store(false)

	testDB, err := stdsql.Open("sqlite3", filepath.Join(tempDir, "queue.db"))
	if err != nil {
		t.Fatalf("open queue database: %v", err)
	}
	testDB.SetMaxOpenConns(1)
	db = testDB
	t.Cleanup(func() {
		testDB.Close()
		db = originalDB
		IsEncryptedBoxFn = originalIsEncryptedBoxFn
		util.IsExiting.Store(originalIsExiting)
	})

	for _, statement := range []string{
		"CREATE TABLE assets (hash TEXT)",
		"CREATE TABLE queue_audit (hash TEXT NOT NULL)",
		"CREATE TABLE queue_failure (enabled INTEGER NOT NULL)",
		"INSERT INTO queue_failure VALUES (1)",
		"INSERT INTO assets VALUES ('first'), ('second'), ('third')",
		"CREATE TRIGGER audit_asset_delete AFTER DELETE ON assets BEGIN INSERT INTO queue_audit(hash) VALUES (OLD.hash); END",
		"CREATE TRIGGER fail_second_asset BEFORE DELETE ON assets WHEN OLD.hash = 'second' AND (SELECT enabled FROM queue_failure) = 1 BEGIN SELECT RAISE(ABORT, 'controlled queue failure'); END",
	} {
		if _, err = testDB.Exec(statement); err != nil {
			t.Fatalf("initialize queue database with %q: %v", statement, err)
		}
	}

	if err = BatchRemoveAssetsQueue([]string{"first"}); err != nil {
		t.Fatalf("enqueue first asset removal: %v", err)
	}
	if err = BatchRemoveAssetsQueue([]string{"second"}); err != nil {
		t.Fatalf("enqueue second asset removal: %v", err)
	}
	if err = BatchRemoveAssetsQueue([]string{"third"}); err != nil {
		t.Fatalf("enqueue third asset removal: %v", err)
	}
	flushErr := FlushQueue()
	if flushErr == nil {
		t.Fatal("queue flush succeeded despite controlled second-operation failure")
	} else if !strings.Contains(flushErr.Error(), "queue operation [delete_assets]") {
		t.Fatalf("queue flush error = %v, want delete_assets execution failure", flushErr)
	}
	if errors.Is(flushErr, stdsql.ErrTxDone) {
		t.Fatalf("queue flush error contains a duplicate-rollback ErrTxDone: %v", flushErr)
	}

	entries, _, err := loadIndexQueue()
	if err != nil {
		t.Fatalf("load durable queue after handled failure: %v", err)
	}
	if len(entries) != 2 || len(entries[0].Hashes) != 1 || entries[0].Hashes[0] != "second" || len(entries[1].Hashes) != 1 || entries[1].Hashes[0] != "third" {
		t.Fatalf("durable queue after handled failure = %#v, want second and third operations", entries)
	}
	var firstAuditCount int
	if err = testDB.QueryRow("SELECT COUNT(*) FROM queue_audit WHERE hash = 'first'").Scan(&firstAuditCount); err != nil {
		t.Fatalf("count first operation executions: %v", err)
	}
	if firstAuditCount != 1 {
		t.Fatalf("first operation executions after handled failure = %d, want 1", firstAuditCount)
	}

	// Make a replay of the committed prefix observable, then simulate restart recovery from index.queue.
	if _, err = testDB.Exec("INSERT INTO assets VALUES ('first')"); err != nil {
		t.Fatalf("restore first asset replay sentinel: %v", err)
	}
	dbQueueLock.Lock()
	operationQueue = nil
	dbQueueLock.Unlock()
	recoverIndexQueue()
	if _, err = testDB.Exec("UPDATE queue_failure SET enabled = 0"); err != nil {
		t.Fatalf("disable controlled queue failure: %v", err)
	}
	release, err := DrainQueueForBox("", nil)
	if err != nil {
		t.Fatalf("retry recovered queue suffix: %v", err)
	}
	release()

	for _, hash := range []string{"first", "second", "third"} {
		var executions int
		if err = testDB.QueryRow("SELECT COUNT(*) FROM queue_audit WHERE hash = ?", hash).Scan(&executions); err != nil {
			t.Fatalf("count %s operation executions: %v", hash, err)
		}
		if executions != 1 {
			t.Fatalf("%s operation executions after recovery = %d, want 1", hash, executions)
		}
	}
	var firstAssets int
	if err = testDB.QueryRow("SELECT COUNT(*) FROM assets WHERE hash = 'first'").Scan(&firstAssets); err != nil {
		t.Fatalf("count first replay sentinel: %v", err)
	}
	if firstAssets != 1 {
		t.Fatalf("first replay sentinel rows = %d, want committed prefix not replayed", firstAssets)
	}
	if entries, _, err = loadIndexQueue(); err != nil {
		t.Fatalf("load durable queue after successful recovery: %v", err)
	} else if len(entries) != 0 {
		t.Fatalf("durable queue after successful recovery = %#v, want empty", entries)
	}
}

func TestFlushQueueReturnsCommitFailureAndRetainsOperation(t *testing.T) {
	tempDir := isolateQueueState(t)

	originalDB := db
	originalIsEncryptedBoxFn := IsEncryptedBoxFn
	IsEncryptedBoxFn = nil
	testDB, err := stdsql.Open("sqlite3", filepath.Join(tempDir, "commit-failure.db")+"?_foreign_keys=on")
	if err != nil {
		t.Fatalf("open queue database: %v", err)
	}
	testDB.SetMaxOpenConns(1)
	db = testDB
	t.Cleanup(func() {
		testDB.Close()
		db = originalDB
		IsEncryptedBoxFn = originalIsEncryptedBoxFn
	})

	for _, statement := range []string{
		"CREATE TABLE assets (hash TEXT PRIMARY KEY)",
		"CREATE TABLE asset_children (asset_hash TEXT NOT NULL, FOREIGN KEY(asset_hash) REFERENCES assets(hash) DEFERRABLE INITIALLY DEFERRED)",
		"INSERT INTO assets(hash) VALUES ('commit-failure')",
		"INSERT INTO asset_children(asset_hash) VALUES ('commit-failure')",
	} {
		if _, err = testDB.Exec(statement); err != nil {
			t.Fatalf("initialize commit failure with %q: %v", statement, err)
		}
	}
	if err = BatchRemoveAssetsQueue([]string{"commit-failure"}); err != nil {
		t.Fatalf("enqueue asset removal: %v", err)
	}

	if flushErr := FlushQueue(); flushErr == nil {
		t.Fatal("queue flush succeeded despite deferred foreign-key commit failure")
	} else if !strings.Contains(flushErr.Error(), "commit queue operation [delete_assets]") {
		t.Fatalf("queue flush error = %v, want delete_assets commit failure", flushErr)
	}
	var assetCount int
	if err = testDB.QueryRow("SELECT COUNT(*) FROM assets WHERE hash = 'commit-failure'").Scan(&assetCount); err != nil {
		t.Fatalf("count asset after failed commit: %v", err)
	}
	if assetCount != 1 {
		t.Fatalf("asset rows after failed commit = %d, want rollback to preserve 1", assetCount)
	}
	entries, _, err := loadIndexQueue()
	if err != nil {
		t.Fatalf("load durable queue after failed commit: %v", err)
	}
	if len(entries) != 1 || entries[0].Action != "delete_assets" || len(entries[0].Hashes) != 1 || entries[0].Hashes[0] != "commit-failure" {
		t.Fatalf("durable queue after failed commit = %#v, want retained asset removal", entries)
	}

	if _, err = testDB.Exec("DELETE FROM asset_children WHERE asset_hash = 'commit-failure'"); err != nil {
		t.Fatalf("remove commit blocker: %v", err)
	}
	if err = FlushQueue(); err != nil {
		t.Fatalf("retry retained operation: %v", err)
	}
	if err = testDB.QueryRow("SELECT COUNT(*) FROM assets WHERE hash = 'commit-failure'").Scan(&assetCount); err != nil {
		t.Fatalf("count asset after retry: %v", err)
	}
	if assetCount != 0 {
		t.Fatalf("asset rows after retry = %d, want 0", assetCount)
	}
	if entries, _, err = loadIndexQueue(); err != nil {
		t.Fatalf("load durable queue after retry: %v", err)
	} else if len(entries) != 0 {
		t.Fatalf("durable queue after retry = %#v, want empty", entries)
	}
}

func setupQueueRecoveryDatabase(t *testing.T) (*stdsql.DB, string) {
	t.Helper()
	tempDir := isolateQueueState(t)
	originalDB := db
	originalDataDir := util.DataDir
	originalIsEncryptedBoxFn := IsEncryptedBoxFn
	originalIsExiting := util.IsExiting.Load()
	originalIndexIgnoreCached := IndexIgnoreCached
	originalIndexIgnore := append([]string(nil), indexIgnore...)

	util.DataDir = filepath.Join(tempDir, "data")
	IsEncryptedBoxFn = nil
	util.IsExiting.Store(false)
	IndexIgnoreCached = false
	indexIgnore = nil
	testDB, err := stdsql.Open("sqlite3", filepath.Join(tempDir, "recovery.db"))
	if err != nil {
		t.Fatalf("open queue recovery database: %v", err)
	}
	testDB.SetMaxOpenConns(1)
	db = testDB
	t.Cleanup(func() {
		testDB.Close()
		db = originalDB
		util.DataDir = originalDataDir
		IsEncryptedBoxFn = originalIsEncryptedBoxFn
		util.IsExiting.Store(originalIsExiting)
		IndexIgnoreCached = originalIndexIgnoreCached
		indexIgnore = originalIndexIgnore
	})
	createQueueIndexSchema(t, testDB, true)
	return testDB, tempDir
}

type crossStoreQueueFixture struct {
	globalDB     *stdsql.DB
	encryptedBox string
	dek          []byte
	unlocked     bool
}

func setupCrossStoreQueueFixture(t *testing.T) *crossStoreQueueFixture {
	t.Helper()
	tempDir := isolateQueueState(t)
	fixture := &crossStoreQueueFixture{
		encryptedBox: "20260717010000-encbox1",
		dek:          []byte("0123456789abcdef0123456789abcdef"),
		unlocked:     true,
	}
	originalDB := db
	originalEncryptedDBs := encryptedDBs
	originalDataDir := util.DataDir
	originalTempDir := util.TempDir
	originalIsEncryptedBoxFn := IsEncryptedBoxFn
	originalDEKProvider := filesys.DEKProvider
	originalDEKLockAcquire := filesys.DEKLockAcquire
	originalDEKLockRelease := filesys.DEKLockRelease
	originalIsExiting := util.IsExiting.Load()
	originalIndexIgnoreCached := IndexIgnoreCached
	originalIndexIgnore := append([]string(nil), indexIgnore...)

	util.DataDir = filepath.Join(tempDir, "data")
	util.TempDir = filepath.Join(tempDir, "temp")
	if err := os.MkdirAll(util.TempDir, 0755); err != nil {
		t.Fatalf("create encrypted queue temp directory: %v", err)
	}
	util.IsExiting.Store(false)
	IndexIgnoreCached = false
	indexIgnore = nil
	encryptedDBs = &sync.Map{}
	IsEncryptedBoxFn = func(boxID string) bool { return boxID == fixture.encryptedBox }
	filesys.DEKLockAcquire = nil
	filesys.DEKLockRelease = nil
	filesys.DEKProvider = func(boxID string) ([]byte, error) {
		if boxID != fixture.encryptedBox {
			return nil, nil
		}
		if !fixture.unlocked {
			return nil, errors.New("encrypted queue fixture is locked")
		}
		return append([]byte(nil), fixture.dek...), nil
	}

	var err error
	fixture.globalDB, err = stdsql.Open("sqlite3", filepath.Join(tempDir, "global.db"))
	if err != nil {
		t.Fatalf("open global queue database: %v", err)
	}
	fixture.globalDB.SetMaxOpenConns(1)
	db = fixture.globalDB
	createQueueIndexSchema(t, fixture.globalDB, true)
	if err = OpenEncryptedDB(fixture.encryptedBox, fixture.dek); err != nil {
		t.Fatalf("open encrypted queue database: %v", err)
	}

	t.Cleanup(func() {
		CloseEncryptedDB(fixture.encryptedBox)
		encryptedDBs = originalEncryptedDBs
		if err := fixture.globalDB.Close(); err != nil {
			t.Errorf("close global queue database: %v", err)
		}
		db = originalDB
		util.DataDir = originalDataDir
		util.TempDir = originalTempDir
		IsEncryptedBoxFn = originalIsEncryptedBoxFn
		filesys.DEKProvider = originalDEKProvider
		filesys.DEKLockAcquire = originalDEKLockAcquire
		filesys.DEKLockRelease = originalDEKLockRelease
		util.IsExiting.Store(originalIsExiting)
		IndexIgnoreCached = originalIndexIgnoreCached
		indexIgnore = originalIndexIgnore
	})
	return fixture
}

func TestSameIdentityAcrossGlobalAndEncryptedStoresSurvivesFlushAndDurableRecovery(t *testing.T) {
	const (
		globalBoxID = "20260717010001-global1"
		rootID      = "20260717010002-samert1"
		blockID     = "20260717010003-samebl1"
	)
	for _, mode := range []struct {
		name               string
		recoverFromDurable bool
	}{
		{name: "regular flush"},
		{name: "locked startup then durable recovery", recoverFromDurable: true},
	} {
		t.Run(mode.name, func(t *testing.T) {
			fixture := setupCrossStoreQueueFixture(t)
			path := "/" + rootID + ".sy"
			cache.RemoveTreeDataInBox(rootID, globalBoxID)
			cache.RemoveTreeDataInBox(rootID, fixture.encryptedBox)
			t.Cleanup(func() {
				cache.RemoveTreeDataInBox(rootID, globalBoxID)
				cache.RemoveTreeDataInBox(rootID, fixture.encryptedBox)
			})
			globalTree := treenode.NewTree(globalBoxID, path, "/Global", "Global")
			encryptedTree := treenode.NewTree(fixture.encryptedBox, path, "/Encrypted", "Encrypted")
			for _, tree := range []*parse.Tree{globalTree, encryptedTree} {
				tree.Root.FirstChild.ID = blockID
				tree.Root.FirstChild.SetIALAttr("id", blockID)
				tree.Root.FirstChild.SetIALAttr("updated", rootID[:14])
				if _, err := filesys.WriteTree(tree); err != nil {
					t.Fatalf("write %s tree fixture: %v", tree.Box, err)
				}
			}
			if err := UpsertTreeQueue(globalTree); err != nil {
				t.Fatalf("queue global tree: %v", err)
			}
			if err := UpsertTreeQueue(encryptedTree); err != nil {
				t.Fatalf("queue encrypted tree with the same identities: %v", err)
			}

			if mode.recoverFromDurable {
				dbQueueLock.Lock()
				operationQueue = nil
				dbQueueLock.Unlock()
				cache.RemoveTreeDataInBox(rootID, globalBoxID)
				cache.RemoveTreeDataInBox(rootID, fixture.encryptedBox)
				fixture.unlocked = false
				CloseEncryptedDB(fixture.encryptedBox)
				recoverIndexQueue()
				if recoveryErr := currentIndexQueueRecoveryError(); recoveryErr != nil {
					t.Fatalf("locked encrypted recovery blocked the global queue: %v", recoveryErr)
				}
				if err := FlushQueue(); err != nil {
					t.Fatalf("flush recoverable global work while encrypted store is locked: %v", err)
				}
				var globalRows int
				if err := fixture.globalDB.QueryRow("SELECT COUNT(*) FROM blocks WHERE box = ? AND (id = ? OR id = ?)", globalBoxID, rootID, blockID).Scan(&globalRows); err != nil {
					t.Fatalf("query recovered global identities: %v", err)
				}
				if globalRows != 2 {
					t.Fatalf("global recovered identity rows = %d, want root and child", globalRows)
				}
				entries, _, err := loadIndexQueue()
				if err != nil {
					t.Fatalf("load deferred encrypted durable queue: %v", err)
				}
				if len(entries) != 1 || entries[0].Box != fixture.encryptedBox || entries[0].ID != rootID {
					t.Fatalf("deferred encrypted durable queue = %#v, want only encrypted same-ID tree", entries)
				}

				recovery := BeginEncryptedIndexQueueRecovery(fixture.encryptedBox)
				if err = OpenEncryptedDB(fixture.encryptedBox, fixture.dek); err != nil {
					t.Fatalf("reopen encrypted queue database: %v", err)
				}
				if err = recovery.Recover(); err == nil {
					t.Fatal("deferred encrypted recovery succeeded before the DEK became readable")
				}
				if recoveryErr := currentIndexQueueRecoveryError(); recoveryErr != nil {
					t.Fatalf("box-local recovery failure blocked ordinary queue work: %v", recoveryErr)
				}
				if err = BatchRemoveAssetsQueue([]string{"ordinary-after-box-recovery-failure"}); err != nil {
					t.Fatalf("ordinary durable enqueue was blocked by box-local recovery failure: %v", err)
				}
				if err = FlushQueue(); err != nil {
					t.Fatalf("SQLCipher connection alone made deferred work recoverable before the DEK: %v", err)
				}
				fixture.unlocked = true
				if err = recovery.Recover(); err != nil {
					t.Fatalf("recover deferred encrypted queue after unlock: %v", err)
				}
			}
			if err := FlushQueue(); err != nil {
				t.Fatalf("flush %s queue: %v", mode.name, err)
			}

			for _, store := range []struct {
				name  string
				boxID string
				db    *stdsql.DB
			}{
				{name: "global", boxID: globalBoxID, db: fixture.globalDB},
				{name: "encrypted", boxID: fixture.encryptedBox, db: GetEncryptedDB(fixture.encryptedBox)},
			} {
				var count int
				if err := store.db.QueryRow("SELECT COUNT(*) FROM blocks WHERE box = ? AND (id = ? OR id = ?)", store.boxID, rootID, blockID).Scan(&count); err != nil {
					t.Fatalf("query %s same identities: %v", store.name, err)
				}
				if count != 2 {
					t.Fatalf("%s same identity rows = %d, want root and child", store.name, count)
				}
			}
			var leakedEncryptedRows int
			if err := fixture.globalDB.QueryRow("SELECT COUNT(*) FROM blocks WHERE box = ?", fixture.encryptedBox).Scan(&leakedEncryptedRows); err != nil {
				t.Fatalf("query encrypted fallback in global database: %v", err)
			}
			if leakedEncryptedRows != 0 {
				t.Fatalf("encrypted rows written to global database = %d, want 0", leakedEncryptedRows)
			}
			if entries, _, err := loadIndexQueue(); err != nil {
				t.Fatalf("load durable queue after cross-store flush: %v", err)
			} else if len(entries) != 0 {
				t.Fatalf("durable queue after cross-store flush = %#v, want empty", entries)
			}
		})
	}
}

func TestRegularFlushAndDurableRecoveryPreserveReplacementOrder(t *testing.T) {
	const (
		firstBox  = "20260717000000-order-a"
		secondBox = "20260717000001-order-b"
	)
	for _, mode := range []struct {
		name               string
		recoverFromDurable bool
	}{
		{name: "regular flush"},
		{name: "durable recovery", recoverFromDurable: true},
	} {
		t.Run(mode.name, func(t *testing.T) {
			testDB, _ := setupQueueRecoveryDatabase(t)
			for _, statement := range []string{
				"CREATE TABLE queue_order (position INTEGER PRIMARY KEY AUTOINCREMENT, box TEXT NOT NULL)",
				"CREATE TRIGGER audit_box_delete AFTER DELETE ON blocks BEGIN INSERT INTO queue_order(box) VALUES (OLD.box); END",
			} {
				if _, err := testDB.Exec(statement); err != nil {
					t.Fatalf("initialize queue order fixture with %q: %v", statement, err)
				}
			}
			for i, boxID := range []string{firstBox, secondBox} {
				rootID := []string{"20260717000002-order", "20260717000003-order"}[i]
				if _, err := testDB.Exec("INSERT INTO blocks(id, root_id, box, path) VALUES (?, ?, ?, ?)", rootID, rootID, boxID, "/"+rootID+".sy"); err != nil {
					t.Fatalf("insert queue order block for box %q: %v", boxID, err)
				}
			}

			if err := DeleteBoxQueue(firstBox); err != nil {
				t.Fatalf("queue initial first-box deletion: %v", err)
			}
			if err := DeleteBoxQueue(secondBox); err != nil {
				t.Fatalf("queue second-box deletion: %v", err)
			}
			if err := DeleteBoxQueue(firstBox); err != nil {
				t.Fatalf("queue replacement first-box deletion: %v", err)
			}
			if mode.recoverFromDurable {
				dbQueueLock.Lock()
				operationQueue = nil
				dbQueueLock.Unlock()
				recoverIndexQueue()
			}
			if err := FlushQueue(); err != nil {
				t.Fatalf("flush %s queue: %v", mode.name, err)
			}

			rows, err := testDB.Query("SELECT box FROM queue_order ORDER BY position")
			if err != nil {
				t.Fatalf("query %s execution order: %v", mode.name, err)
			}
			var order []string
			for rows.Next() {
				var boxID string
				if err = rows.Scan(&boxID); err != nil {
					rows.Close()
					t.Fatalf("scan %s execution order: %v", mode.name, err)
				}
				order = append(order, boxID)
			}
			if err = rows.Close(); err != nil {
				t.Fatalf("close %s execution-order rows: %v", mode.name, err)
			}
			if err = rows.Err(); err != nil {
				t.Fatalf("iterate %s execution order: %v", mode.name, err)
			}
			if len(order) != 2 || order[0] != secondBox || order[1] != firstBox {
				t.Fatalf("%s replacement order = %#v, want [%q %q]", mode.name, order, secondBox, firstBox)
			}
		})
	}
}

func TestDurableIndexReplayDoesNotDuplicateRows(t *testing.T) {
	testDB, _ := setupQueueRecoveryDatabase(t)

	const (
		boxID  = "20260717000004-replaybx"
		rootID = "20260717000005-replayrt"
	)
	treePath := "/" + rootID + ".sy"
	tree := treenode.NewTree(boxID, treePath, "/Replay", "Replay")
	if _, err := filesys.WriteTree(tree); err != nil {
		t.Fatalf("write replay tree: %v", err)
	}
	if err := IndexTreeQueue(tree); err != nil {
		t.Fatalf("queue durable index operation: %v", err)
	}
	queuePath := filepath.Join(util.QueueDir, "index.queue")
	durableBeforeCommit, err := os.ReadFile(queuePath)
	if err != nil {
		t.Fatalf("read durable index operation before commit: %v", err)
	}
	if err = FlushQueue(); err != nil {
		t.Fatalf("flush initial durable index operation: %v", err)
	}

	// Simulate a crash after the database commit but before the durable prefix
	// replacement reaches disk by restoring the exact pre-commit queue bytes.
	if err = os.WriteFile(queuePath, durableBeforeCommit, 0644); err != nil {
		t.Fatalf("restore committed durable index operation: %v", err)
	}
	dbQueueLock.Lock()
	operationQueue = nil
	dbQueueLock.Unlock()
	cache.RemoveTreeDataInBox(rootID, boxID)
	t.Cleanup(func() { cache.RemoveTreeDataInBox(rootID, boxID) })
	recoverIndexQueue()
	if err = FlushQueue(); err != nil {
		t.Fatalf("replay committed durable index operation: %v", err)
	}

	for _, table := range []string{"blocks", "blocks_fts"} {
		var count int
		if err = testDB.QueryRow("SELECT COUNT(*) FROM "+table+" WHERE id = ? AND root_id = ? AND box = ?", rootID, rootID, boxID).Scan(&count); err != nil {
			t.Fatalf("count replayed %s rows: %v", table, err)
		}
		if count != 1 {
			t.Fatalf("replayed %s rows = %d, want exactly 1", table, count)
		}
	}
	entries, _, err := loadIndexQueue()
	if err != nil {
		t.Fatalf("load durable queue after idempotent replay: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("durable queue after idempotent replay = %#v, want empty", entries)
	}
}

func TestCrashRecoveryKeepsLatestUpsertAfterInterleavedRootDeletion(t *testing.T) {
	testDB, _ := setupQueueRecoveryDatabase(t)

	const (
		boxID  = "20260717000000-orderbx"
		rootID = "20260717000001-orderrt"
	)
	oldPath := "/old/" + rootID + ".sy"
	latestPath := "/" + rootID + ".sy"
	latestTree := treenode.NewTree(boxID, latestPath, "/Latest", "Latest")
	if _, err := filesys.WriteTree(latestTree); err != nil {
		t.Fatalf("write latest recovery tree: %v", err)
	}
	if err := UpsertTreeQueue(&parse.Tree{ID: rootID, Box: boxID, Path: oldPath}); err != nil {
		t.Fatalf("queue old upsert: %v", err)
	}
	if err := RemoveTreeQueue(boxID, rootID); err != nil {
		t.Fatalf("queue interleaved root deletion: %v", err)
	}
	if err := UpsertTreeQueue(latestTree); err != nil {
		t.Fatalf("queue latest upsert: %v", err)
	}

	dbQueueLock.Lock()
	operationQueue = nil
	dbQueueLock.Unlock()
	cache.RemoveTreeDataInBox(rootID, boxID)
	t.Cleanup(func() { cache.RemoveTreeDataInBox(rootID, boxID) })
	recoverIndexQueue()
	if err := FlushQueue(); err != nil {
		t.Fatalf("flush recovered interleaved upsert queue: %v", err)
	}

	var count int
	if err := testDB.QueryRow("SELECT COUNT(*) FROM blocks WHERE id = ? AND root_id = ? AND path = ?", rootID, rootID, latestPath).Scan(&count); err != nil {
		t.Fatalf("query recovered root: %v", err)
	}
	if count != 1 {
		t.Fatalf("recovered latest root rows = %d, want 1", count)
	}
}

func TestCrashRecoveryKeepsFinalBoxDeletionAfterInterleavedIndex(t *testing.T) {
	testDB, _ := setupQueueRecoveryDatabase(t)

	const (
		boxID  = "20260717000002-orderbx"
		rootID = "20260717000003-orderrt"
	)
	treePath := "/" + rootID + ".sy"
	tree := treenode.NewTree(boxID, treePath, "/Indexed", "Indexed")
	if _, err := filesys.WriteTree(tree); err != nil {
		t.Fatalf("write interleaved index tree: %v", err)
	}
	if err := DeleteBoxQueue(boxID); err != nil {
		t.Fatalf("queue initial box deletion: %v", err)
	}
	if err := IndexTreeQueue(tree); err != nil {
		t.Fatalf("queue interleaved box index: %v", err)
	}
	if err := DeleteBoxQueue(boxID); err != nil {
		t.Fatalf("queue final box deletion: %v", err)
	}

	dbQueueLock.Lock()
	operationQueue = nil
	dbQueueLock.Unlock()
	cache.RemoveTreeDataInBox(rootID, boxID)
	t.Cleanup(func() { cache.RemoveTreeDataInBox(rootID, boxID) })
	recoverIndexQueue()
	if err := FlushQueue(); err != nil {
		t.Fatalf("flush recovered interleaved box queue: %v", err)
	}

	var count int
	if err := testDB.QueryRow("SELECT COUNT(*) FROM blocks WHERE box = ?", boxID).Scan(&count); err != nil {
		t.Fatalf("query recovered box rows: %v", err)
	}
	if count != 0 {
		t.Fatalf("recovered box rows = %d, want final deletion to leave 0", count)
	}
}

func createQueueIndexSchema(t *testing.T, testDB *stdsql.DB, withBlockEmbeddings bool) {
	t.Helper()
	statements := []string{
		"CREATE TABLE blocks (id, parent_id, root_id, hash, box, path, hpath, name, alias, memo, tag, content, fcontent, markdown, length, type, subtype, ial, sort, created, updated)",
		"CREATE TABLE blocks_fts (id, parent_id, root_id, hash, box, path, hpath, name, alias, memo, tag, content, fcontent, markdown, length, type, subtype, ial, sort, created, updated)",
		"CREATE TABLE spans (id, block_id, root_id, box, path, content, markdown, type, ial)",
		"CREATE TABLE assets (id, block_id, root_id, box, docpath, path, name, title, hash)",
		"CREATE TABLE attributes (id, name, value, type, block_id, root_id, box, path)",
		"CREATE TABLE refs (id, def_block_id, def_block_parent_id, def_block_root_id, def_block_path, block_id, root_id, box, path, content, markdown, type)",
		"CREATE TABLE file_annotation_refs (id, file_path, annotation_id, block_id, root_id, box, path, content, type)",
	}
	if withBlockEmbeddings {
		statements = append(statements, "CREATE TABLE block_embeddings (root_id, box, path)")
	}
	for _, statement := range statements {
		if _, err := testDB.Exec(statement); err != nil {
			t.Fatalf("initialize queue database with %q: %v", statement, err)
		}
	}
}

func TestIndexNodeLoadFailureRollsBackOnceAndKeepsDurableOperation(t *testing.T) {
	tempDir := isolateQueueState(t)
	originalDB := db
	originalDataDir := util.DataDir
	originalBlockTreeDBPath := util.BlockTreeDBPath
	originalIsEncryptedBoxFn := IsEncryptedBoxFn
	originalIsExiting := util.IsExiting.Load()
	util.DataDir = filepath.Join(tempDir, "data")
	util.BlockTreeDBPath = filepath.Join(tempDir, "blocktree.db")
	IsEncryptedBoxFn = nil
	util.IsExiting.Store(false)

	testDB, err := stdsql.Open("sqlite3", filepath.Join(tempDir, "index-node.db"))
	if err != nil {
		t.Fatalf("open index-node queue database: %v", err)
	}
	testDB.SetMaxOpenConns(1)
	db = testDB
	treenode.CloseDatabase()
	treenode.InitBlockTree(true)
	t.Cleanup(func() {
		treenode.CloseDatabase()
		if err := testDB.Close(); err != nil {
			t.Errorf("close index-node queue database: %v", err)
		}
		db = originalDB
		util.DataDir = originalDataDir
		util.BlockTreeDBPath = originalBlockTreeDBPath
		IsEncryptedBoxFn = originalIsEncryptedBoxFn
		util.IsExiting.Store(originalIsExiting)
	})
	createQueueIndexSchema(t, testDB, true)

	const (
		boxID  = "20260717010200-nodebox"
		nodeID = "20260717010201-nodeerr"
	)
	treePath := "/" + nodeID + ".sy"
	tree := treenode.NewTree(boxID, treePath, "/Missing", "Missing")
	if err = treenode.UpsertBlockTree(tree); err != nil {
		t.Fatalf("persist missing-file blocktree fixture: %v", err)
	}
	if _, err = testDB.Exec("INSERT INTO blocks(id, root_id, box, path) VALUES (?, ?, ?, ?)", nodeID, nodeID, boxID, treePath); err != nil {
		t.Fatalf("insert index-node block row: %v", err)
	}
	if _, err = testDB.Exec("INSERT INTO blocks_fts(rowid, id, root_id, box, path) VALUES (1, ?, ?, ?, ?)", nodeID, nodeID, boxID, treePath); err != nil {
		t.Fatalf("insert index-node FTS row: %v", err)
	}
	if err = IndexNodeQueue(nodeID, boxID); err != nil {
		t.Fatalf("queue index-node operation: %v", err)
	}

	flushErr := FlushQueue()
	if flushErr == nil {
		t.Fatal("index-node flush succeeded despite a missing source tree")
	}
	if !strings.Contains(flushErr.Error(), "load index node tree") {
		t.Fatalf("index-node flush error = %v, want source-tree load context", flushErr)
	}
	if errors.Is(flushErr, stdsql.ErrTxDone) {
		t.Fatalf("index-node flush attempted duplicate rollback: %v", flushErr)
	}
	entries, _, err := loadIndexQueue()
	if err != nil {
		t.Fatalf("load durable queue after index-node failure: %v", err)
	}
	if len(entries) != 1 || entries[0].Action != "index_node" || entries[0].Box != boxID || entries[0].ID != nodeID {
		t.Fatalf("durable queue after index-node failure = %#v, want retained operation", entries)
	}
}

func TestBlockEmbeddingFailureRollsBackAndKeepsDurableOperation(t *testing.T) {
	tempDir := isolateQueueState(t)

	originalDB := db
	originalIsEncryptedBoxFn := IsEncryptedBoxFn
	IsEncryptedBoxFn = nil
	testDB, err := stdsql.Open("sqlite3", filepath.Join(tempDir, "embedding-failure.db"))
	if err != nil {
		t.Fatalf("open queue database: %v", err)
	}
	testDB.SetMaxOpenConns(1)
	db = testDB
	t.Cleanup(func() {
		testDB.Close()
		db = originalDB
		IsEncryptedBoxFn = originalIsEncryptedBoxFn
	})

	createQueueIndexSchema(t, testDB, true)
	const boxID = "20260716000000-embederr"
	for _, statement := range []string{
		"INSERT INTO blocks(box) VALUES ('" + boxID + "')",
		"INSERT INTO blocks_fts(rowid, box) VALUES (1, '" + boxID + "')",
		"INSERT INTO block_embeddings(box) VALUES ('" + boxID + "')",
		"CREATE TRIGGER fail_embedding_delete BEFORE DELETE ON block_embeddings BEGIN SELECT RAISE(ABORT, 'controlled embedding failure'); END",
	} {
		if _, err = testDB.Exec(statement); err != nil {
			t.Fatalf("initialize embedding failure with %q: %v", statement, err)
		}
	}
	if err = DeleteBoxQueue(boxID); err != nil {
		t.Fatalf("enqueue notebook deletion: %v", err)
	}
	if release, drainErr := DrainQueueForBox(boxID, nil); drainErr == nil {
		release()
		t.Fatal("queue drain succeeded despite the controlled block-embedding failure")
	} else if release != nil {
		t.Fatal("failed embedding drain returned an admission release function")
	}

	for _, table := range []string{"blocks", "blocks_fts", "block_embeddings"} {
		var count int
		if err = testDB.QueryRow("SELECT COUNT(*) FROM "+table+" WHERE box = ?", boxID).Scan(&count); err != nil {
			t.Fatalf("count %s rows after rollback: %v", table, err)
		}
		if count != 1 {
			t.Fatalf("%s rows after embedding failure = %d, want rollback to preserve 1", table, count)
		}
	}
	entries, _, err := loadIndexQueue()
	if err != nil {
		t.Fatalf("load durable queue after embedding failure: %v", err)
	}
	if len(entries) != 1 || entries[0].Action != "delete_box" || entries[0].Box != boxID {
		t.Fatalf("durable queue after embedding failure = %#v, want the uncommitted notebook deletion", entries)
	}
}

func TestEncryptedQueueStoreSkipsUnsupportedBlockEmbeddings(t *testing.T) {
	tempDir := isolateQueueState(t)

	const boxID = "20260716000000-encembed"
	testDB, err := stdsql.Open("sqlite3", filepath.Join(tempDir, "encrypted-store.db"))
	if err != nil {
		t.Fatalf("open encrypted-store queue database: %v", err)
	}
	testDB.SetMaxOpenConns(1)
	encryptedDBs.Store(boxID, testDB)
	t.Cleanup(func() {
		encryptedDBs.Delete(boxID)
		testDB.Close()
	})

	createQueueIndexSchema(t, testDB, false)
	for _, table := range []string{"blocks", "blocks_fts", "spans", "assets", "attributes", "refs", "file_annotation_refs"} {
		if table == "refs" {
			_, err = testDB.Exec("INSERT INTO refs(def_block_id, box) VALUES ('20260716000001-encembed', ?)", boxID)
		} else {
			_, err = testDB.Exec("INSERT INTO "+table+"(box) VALUES (?)", boxID)
		}
		if err != nil {
			t.Fatalf("insert encrypted-store %s row: %v", table, err)
		}
	}
	if err = DeleteBoxQueue(boxID); err != nil {
		t.Fatalf("enqueue encrypted notebook deletion: %v", err)
	}
	release, err := DrainQueueForBox(boxID, nil)
	if err != nil {
		t.Fatalf("drain encrypted store without block_embeddings: %v", err)
	}
	release()

	for _, table := range []string{"blocks", "spans", "assets", "attributes", "refs", "file_annotation_refs"} {
		var count int
		if err = testDB.QueryRow("SELECT COUNT(*) FROM "+table+" WHERE box = ?", boxID).Scan(&count); err != nil {
			t.Fatalf("count encrypted-store %s rows: %v", table, err)
		}
		if count != 0 {
			t.Fatalf("encrypted-store %s rows after drain = %d, want 0", table, count)
		}
	}
	entries, _, err := loadIndexQueue()
	if err != nil {
		t.Fatalf("load durable queue after encrypted-store drain: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("durable queue after encrypted-store drain = %#v, want empty", entries)
	}
}
