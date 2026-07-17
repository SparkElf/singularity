// SiYuan - Refactor your thinking
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

package model

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/siyuan-note/siyuan/kernel/cache"
	"github.com/siyuan-note/siyuan/kernel/conf"
	"github.com/siyuan-note/siyuan/kernel/filesys"
	"github.com/siyuan-note/siyuan/kernel/sql"
	"github.com/siyuan-note/siyuan/kernel/treenode"
	"github.com/siyuan-note/siyuan/kernel/util"
)

func setupUnlockBoxContract(t *testing.T, name string) (boxID, password string, boxEncryption *conf.BoxEncryption) {
	t.Helper()
	setupIndexFailureEnvironment(t)
	Conf.Sync = conf.NewSync()
	Conf.NotebookCrypto = conf.NewNotebookCrypto()
	if err := sql.InitDatabase(true); err != nil {
		t.Fatalf("initialize content database: %v", err)
	}
	sql.InitHistoryDatabase(true)
	sql.InitAssetContentDatabase(true)

	password = "unlock-box-contract-password"
	if err := EnableEncryptedNotebook(password); err != nil {
		t.Fatalf("enable encrypted notebooks: %v", err)
	}
	var err error
	boxID, err = CreateEncryptedBox(name, password)
	if err != nil {
		t.Fatalf("create encrypted notebook: %v", err)
	}
	boxEncryption = (&Box{ID: boxID}).GetConf().BoxCrypt
	if boxEncryption == nil {
		t.Fatal("encrypted notebook has no key material")
	}
	t.Cleanup(func() {
		cachedDEKsLock.Lock()
		if dek := cachedDEKs[boxID]; dek != nil {
			zeroAndClear(dek)
			delete(cachedDEKs, boxID)
		}
		cachedDEKsLock.Unlock()
		boxLastAccess.Delete(boxID)
		treenode.RemoveEncryptedBlockTreeDBFile(boxID)
		sql.RemoveEncryptedDBFile(boxID)
		sql.CloseDatabase()
	})
	return
}

func TestUnlockBoxDerivedDatabaseOpenFailureCleansBothStores(t *testing.T) {
	boxID, password, boxEncryption := setupUnlockBoxContract(t, "Derived Store Cleanup")
	if err := LockBox(boxID); err != nil {
		t.Fatalf("lock encrypted notebook before failed reopen: %v", err)
	}
	blockedBlocktreePath := util.EncryptedBlockTreeDBPath(boxID)
	if err := os.MkdirAll(blockedBlocktreePath, 0755); err != nil {
		t.Fatalf("create real blocktree database open failure: %v", err)
	}

	if err := UnlockBox(boxID, password, boxEncryption); err == nil {
		t.Fatal("unlock succeeded with a directory at the blocktree database path")
	}
	if IsBoxUnlocked(boxID) {
		t.Fatal("derived database open failure published a DEK")
	}
	if sql.GetEncryptedDB(boxID) != nil {
		t.Fatal("derived database open failure left the content database open")
	}
	for _, openedBoxID := range treenode.GetOpenedEncryptedBoxIDs() {
		if openedBoxID == boxID {
			t.Fatal("derived database open failure left the blocktree database open")
		}
	}
	for _, derivedPath := range []string{util.EncryptedDBPath(boxID), util.EncryptedBlockTreeDBPath(boxID)} {
		if _, err := os.Stat(derivedPath); !os.IsNotExist(err) {
			t.Fatalf("derived database open failure retained %s: %v", derivedPath, err)
		}
	}
}

func TestRepeatedUnlockBoxZeroesReplacedDEK(t *testing.T) {
	boxID, password, boxEncryption := setupUnlockBoxContract(t, "Repeated Unlock")
	cachedDEKsLock.RLock()
	previous := cachedDEKs[boxID]
	cachedDEKsLock.RUnlock()
	if len(previous) == 0 {
		t.Fatal("initial unlock did not publish a DEK")
	}

	if err := UnlockBox(boxID, password, boxEncryption); err != nil {
		t.Fatalf("repeat unlock encrypted notebook: %v", err)
	}
	for i, value := range previous {
		if value != 0 {
			t.Fatalf("replaced DEK byte [%d] was not zeroed", i)
		}
	}
	cachedDEKsLock.RLock()
	replacement := cachedDEKs[boxID]
	cachedDEKsLock.RUnlock()
	if len(replacement) == 0 {
		t.Fatal("repeat unlock did not publish the replacement DEK")
	}
	var replacementHasKeyMaterial bool
	for _, value := range replacement {
		if value != 0 {
			replacementHasKeyMaterial = true
			break
		}
	}
	if !replacementHasKeyMaterial {
		t.Fatal("repeat unlock published an all-zero replacement DEK")
	}
}

func TestUnlockBoxRetriesDeferredDurableIndexQueueAfterRecoveryFailure(t *testing.T) {
	setupIndexFailureEnvironment(t)
	Conf.Sync = conf.NewSync()
	Conf.NotebookCrypto = conf.NewNotebookCrypto()
	if err := sql.InitDatabase(true); err != nil {
		t.Fatalf("initialize content database: %v", err)
	}
	sql.InitHistoryDatabase(true)
	sql.InitAssetContentDatabase(true)
	var boxID string
	t.Cleanup(func() {
		cachedDEKsLock.Lock()
		if dek := cachedDEKs[boxID]; dek != nil {
			zeroAndClear(dek)
			delete(cachedDEKs, boxID)
		}
		cachedDEKsLock.Unlock()
		sql.CloseDatabase()
	})

	const password = "deferred-recovery-password"
	if err := EnableEncryptedNotebook(password); err != nil {
		t.Fatalf("enable encrypted notebooks: %v", err)
	}
	var err error
	boxID, err = CreateEncryptedBox("Deferred Recovery", password)
	if err != nil {
		t.Fatalf("create encrypted notebook: %v", err)
	}
	boxEncryption := (&Box{ID: boxID}).GetConf().BoxCrypt
	if boxEncryption == nil {
		t.Fatal("encrypted notebook has no key material")
	}

	const rootID = "20990717150000-recover"
	tree := treenode.NewTree(boxID, "/"+rootID+".sy", "/Deferred Recovery", "Deferred Recovery")
	if _, err = filesys.WriteTree(tree); err != nil {
		t.Fatalf("write encrypted recovery tree: %v", err)
	}
	cache.RemoveTreeDataInBox(rootID, boxID)
	treeFile := filepath.Join(util.DataDir, boxID, tree.Path)
	heldTreeFile := treeFile + ".held"
	if err = os.Rename(treeFile, heldTreeFile); err != nil {
		t.Fatalf("make encrypted tree temporarily unavailable: %v", err)
	}

	sql.RemoveEncryptedDBFile(boxID)
	treenode.RemoveEncryptedBlockTreeDBFile(boxID)
	cachedDEKsLock.Lock()
	if dek := cachedDEKs[boxID]; dek != nil {
		zeroAndClear(dek)
		delete(cachedDEKs, boxID)
	}
	cachedDEKsLock.Unlock()
	boxLastAccess.Delete(boxID)

	entry, err := json.Marshal(map[string]string{
		"action": "upsert",
		"id":     rootID,
		"box":    boxID,
		"path":   tree.Path,
	})
	if err != nil {
		t.Fatalf("marshal durable recovery entry: %v", err)
	}
	entry = append(entry, '\n')
	queuePath := filepath.Join(util.QueueDir, "index.queue")
	if err = os.WriteFile(queuePath, entry, 0600); err != nil {
		t.Fatalf("write durable recovery entry: %v", err)
	}
	if err = sql.InitDatabase(false); err != nil {
		t.Fatalf("restart content database with locked encrypted work: %v", err)
	}

	if err = UnlockBox(boxID, password, boxEncryption); err == nil {
		t.Fatal("unlock succeeded while its deferred encrypted tree was unavailable")
	}
	if IsBoxUnlocked(boxID) {
		t.Fatal("failed recovery left the encrypted notebook unlocked")
	}
	if sql.GetEncryptedDB(boxID) != nil {
		t.Fatal("failed recovery left the encrypted content database open")
	}
	for _, openedBoxID := range treenode.GetOpenedEncryptedBoxIDs() {
		if openedBoxID == boxID {
			t.Fatal("failed recovery left the encrypted blocktree database open")
		}
	}
	queueData, readErr := os.ReadFile(queuePath)
	if readErr != nil {
		t.Fatalf("read durable queue after failed recovery: %v", readErr)
	}
	if !bytes.Equal(bytes.TrimSpace(queueData), bytes.TrimSpace(entry)) {
		t.Fatalf("failed recovery changed its durable entry: %s", queueData)
	}
	if err = os.Rename(heldTreeFile, treeFile); err != nil {
		t.Fatalf("restore encrypted tree for recovery retry: %v", err)
	}
	if err = UnlockBox(boxID, password, boxEncryption); err != nil {
		t.Fatalf("retry unlock and recover encrypted notebook: %v", err)
	}
	if err = sql.FlushQueue(); err != nil {
		t.Fatalf("flush recovered encrypted operation: %v", err)
	}
	database := sql.GetEncryptedDB(boxID)
	if database == nil {
		t.Fatal("encrypted database is not open after recovery")
	}
	var rows int
	if err = database.QueryRow("SELECT COUNT(*) FROM blocks WHERE box = ? AND root_id = ?", boxID, rootID).Scan(&rows); err != nil {
		t.Fatalf("query recovered encrypted document: %v", err)
	}
	if rows == 0 {
		t.Fatal("deferred encrypted document was not indexed after unlock")
	}
	queueData, readErr = os.ReadFile(queuePath)
	if readErr != nil && !os.IsNotExist(readErr) {
		t.Fatalf("read durable queue after recovery: %v", readErr)
	}
	if len(bytes.TrimSpace(queueData)) != 0 {
		t.Fatalf("durable queue remains after recovery: %s", queueData)
	}
	if err = sql.FlushQueue(); err != nil {
		t.Fatalf("flush empty queue after recovery: %v", err)
	}
}
