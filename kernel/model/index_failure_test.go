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
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/88250/lute/ast"
	"github.com/88250/lute/parse"
	"github.com/siyuan-note/siyuan/kernel/av"
	"github.com/siyuan-note/siyuan/kernel/cache"
	"github.com/siyuan-note/siyuan/kernel/conf"
	"github.com/siyuan-note/siyuan/kernel/filesys"
	"github.com/siyuan-note/siyuan/kernel/sql"
	"github.com/siyuan-note/siyuan/kernel/treenode"
	"github.com/siyuan-note/siyuan/kernel/util"
)

func TestFullReindexRejectsCorruptNotebookMembershipBeforeReset(t *testing.T) {
	setupIndexFailureEnvironment(t)

	const boxID = "20990717010000-corrupt"
	confPath := filepath.Join(util.DataDir, boxID, ".siyuan", "conf.json")
	if err := os.MkdirAll(filepath.Dir(confPath), 0755); err != nil {
		t.Fatalf("create notebook configuration directory: %v", err)
	}
	corrupt := []byte("{not-json")
	if err := os.WriteFile(confPath, corrupt, 0644); err != nil {
		t.Fatalf("write corrupt notebook configuration: %v", err)
	}

	databaseSentinel := []byte("database-must-not-reset")
	if err := os.WriteFile(util.DBPath, databaseSentinel, 0644); err != nil {
		t.Fatalf("write database reset sentinel: %v", err)
	}

	if err := FullReindexDirect(); err == nil {
		t.Fatal("full reindex accepted incomplete notebook membership")
	}
	gotConf, err := os.ReadFile(confPath)
	if err != nil {
		t.Fatalf("read notebook configuration after rejected rebuild: %v", err)
	}
	if !bytes.Equal(gotConf, corrupt) {
		t.Fatalf("strict notebook enumeration changed corrupt configuration: %q", gotConf)
	}
	gotDatabase, err := os.ReadFile(util.DBPath)
	if err != nil {
		t.Fatalf("read database reset sentinel after rejected rebuild: %v", err)
	}
	if !bytes.Equal(gotDatabase, databaseSentinel) {
		t.Fatalf("full reindex reset database before membership validation: %q", gotDatabase)
	}
}

func TestFullReindexQueueClearFailurePreservesDatabase(t *testing.T) {
	setupIndexFailureEnvironment(t)

	databaseSentinel := []byte("database-must-survive-queue-failure")
	if err := os.WriteFile(util.DBPath, databaseSentinel, 0644); err != nil {
		t.Fatalf("write database reset sentinel: %v", err)
	}
	blockDurableIndexQueue(t)

	if err := FullReindexDirect(); err == nil {
		t.Fatal("full reindex accepted a queue clear failure")
	}
	gotDatabase, err := os.ReadFile(util.DBPath)
	if err != nil {
		t.Fatalf("read database reset sentinel after rejected rebuild: %v", err)
	}
	if !bytes.Equal(gotDatabase, databaseSentinel) {
		t.Fatalf("full reindex reset database after queue preflight failure: %q", gotDatabase)
	}
}

func TestDuplicateBlockRepairCompensatesUndurableCommit(t *testing.T) {
	setupIndexFailureEnvironment(t)

	const (
		boxID       = "20990717010005-repairx"
		firstRootID = "20990717010006-repairx"
		duplicateID = "20990717010007-repairx"
		rootID      = "20990717010008-repairx"
	)
	saveIndexFailureBox(t, boxID, false)
	firstTree := treenode.NewTree(boxID, "/"+firstRootID+".sy", "/First Repair", "First Repair")
	firstTree.Root.FirstChild.ID = duplicateID
	firstTree.Root.FirstChild.Box = boxID
	firstTree.Root.FirstChild.Path = firstTree.Path
	firstTree.Root.FirstChild.SetIALAttr("id", duplicateID)
	tree := treenode.NewTree(boxID, "/"+rootID+".sy", "/Repair", "Repair")
	tree.Root.FirstChild.ID = duplicateID
	tree.Root.FirstChild.Box = boxID
	tree.Root.FirstChild.Path = tree.Path
	tree.Root.FirstChild.SetIALAttr("id", duplicateID)
	for _, candidate := range []*parse.Tree{firstTree, tree} {
		if _, err := filesys.WriteTree(candidate); err != nil {
			t.Fatalf("write duplicate-block repair fixture %s: %v", candidate.ID, err)
		}
	}
	duplicateCount := 0
	for _, candidate := range []*parse.Tree{firstTree, tree} {
		loadedFixture, err := filesys.LoadTree(boxID, candidate.Path, util.NewLute())
		if err != nil {
			t.Fatalf("load duplicate-block repair fixture %s: %v", candidate.ID, err)
		}
		ast.Walk(loadedFixture.Root, func(node *ast.Node, entering bool) ast.WalkStatus {
			if entering && node.IsBlock() && node.ID == duplicateID {
				duplicateCount++
			}
			return ast.WalkContinue
		})
	}
	if duplicateCount != 2 {
		t.Fatalf("duplicate-block repair fixture has %d copies of %s, want 2", duplicateCount, duplicateID)
	}
	for _, candidate := range []*parse.Tree{firstTree, tree} {
		if err := treenode.UpsertBlockTree(candidate); err != nil {
			t.Fatalf("index duplicate-block repair fixture %s: %v", candidate.ID, err)
		}
	}
	firstAbsPath := filepath.Join(util.DataDir, boxID, firstRootID+".sy")
	beforeFirstFile, err := os.ReadFile(firstAbsPath)
	if err != nil {
		t.Fatalf("read first duplicate-block fixture: %v", err)
	}
	absPath := filepath.Join(util.DataDir, boxID, rootID+".sy")
	beforeFile, err := os.ReadFile(absPath)
	if err != nil {
		t.Fatalf("read duplicate-block fixture: %v", err)
	}
	beforeRows := treenode.GetBlockTreesByRootIDInBox(rootID, boxID)

	originalQueueDir := util.QueueDir
	blockedQueuePath := filepath.Join(t.TempDir(), "not-a-directory")
	if err = os.WriteFile(blockedQueuePath, []byte("blocked"), 0644); err != nil {
		t.Fatalf("create durable queue failure boundary: %v", err)
	}
	util.QueueDir = blockedQueuePath
	t.Cleanup(func() { util.QueueDir = originalQueueDir })
	resetDuplicateBlocksOnFileSys()
	util.QueueDir = originalQueueDir

	afterFailure, err := os.ReadFile(absPath)
	if err != nil {
		t.Fatalf("read duplicate-block fixture after rejected repair: %v", err)
	}
	if !bytes.Equal(afterFailure, beforeFile) {
		t.Fatal("undurable duplicate-block repair changed the tree file")
	}
	afterFailureFirst, err := os.ReadFile(firstAbsPath)
	if err != nil {
		t.Fatalf("read first duplicate-block fixture after rejected repair: %v", err)
	}
	if !bytes.Equal(afterFailureFirst, beforeFirstFile) {
		t.Fatal("undurable duplicate-block repair changed the retained first tree")
	}
	afterFailureRows := treenode.GetBlockTreesByRootIDInBox(rootID, boxID)
	if len(afterFailureRows) != len(beforeRows) {
		t.Fatalf("undurable duplicate-block repair changed blocktree rows from %d to %d", len(beforeRows), len(afterFailureRows))
	}

	resetDuplicateBlocksOnFileSys()
	afterSuccess, err := os.ReadFile(absPath)
	if err != nil {
		t.Fatalf("read duplicate-block fixture after committed repair: %v", err)
	}
	if bytes.Equal(afterSuccess, beforeFile) {
		t.Fatal("durable duplicate-block repair did not update the tree file")
	}
	afterSuccessFirst, err := os.ReadFile(firstAbsPath)
	if err != nil {
		t.Fatalf("read first duplicate-block fixture after committed repair: %v", err)
	}
	if !bytes.Equal(afterSuccessFirst, beforeFirstFile) {
		t.Fatal("durable duplicate-block repair changed the retained first tree")
	}
	cache.RemoveTreeDataInBox(rootID, boxID)
	repaired, err := filesys.LoadTree(boxID, tree.Path, util.NewLute())
	if err != nil {
		t.Fatalf("load committed duplicate-block repair: %v", err)
	}
	seen := map[string]bool{}
	ast.Walk(repaired.Root, func(node *ast.Node, entering bool) ast.WalkStatus {
		if entering && node.IsBlock() {
			if seen[node.ID] {
				t.Fatalf("committed duplicate-block repair retained duplicate ID %s", node.ID)
			}
			seen[node.ID] = true
		}
		return ast.WalkContinue
	})

	queueData, err := os.ReadFile(filepath.Join(util.QueueDir, "index.queue"))
	if err != nil {
		t.Fatalf("read committed duplicate-block repair queue: %v", err)
	}
	var found bool
	for _, line := range bytes.Split(bytes.TrimSpace(queueData), []byte("\n")) {
		var entry struct {
			Action string `json:"action"`
			Box    string `json:"box"`
			Path   string `json:"path"`
		}
		if err = json.Unmarshal(line, &entry); err != nil {
			t.Fatalf("decode duplicate-block repair queue entry: %v", err)
		}
		if entry.Action == "upsert" && entry.Box == boxID && entry.Path == tree.Path {
			found = true
		}
	}
	if !found {
		t.Fatalf("committed duplicate-block repair queue has no upsert for [%s/%s]", boxID, tree.Path)
	}
}

func TestRepeatedFullReindexDoesNotDuplicateEncryptedStoreRows(t *testing.T) {
	setupIndexFailureEnvironment(t)

	const boxID = "20990717010010-encrypt"
	const rootID = "20990717010011-encrypt"
	boxConf := conf.NewBoxConf()
	boxConf.Name = boxID
	boxConf.Encrypted = true
	boxConf.Closed = false
	if err := (&Box{ID: boxID}).SaveConf(boxConf); err != nil {
		t.Fatalf("save encrypted notebook configuration: %v", err)
	}
	dek, err := util.GenerateDEK()
	if err != nil {
		t.Fatalf("generate encrypted notebook key: %v", err)
	}
	if err = sql.OpenEncryptedDB(boxID, dek); err != nil {
		t.Fatalf("open encrypted content database: %v", err)
	}
	if err = treenode.OpenEncryptedBlockTreeDB(boxID, dek); err != nil {
		t.Fatalf("open encrypted blocktree database: %v", err)
	}
	sql.InitHistoryDatabase(true)
	sql.InitAssetContentDatabase(true)
	cachedDEKsLock.Lock()
	cachedDEKs[boxID] = append([]byte(nil), dek...)
	cachedDEKsLock.Unlock()
	clear(dek)
	t.Cleanup(func() {
		sql.CloseEncryptedDB(boxID)
		sql.CloseDatabase()
		treenode.CloseEncryptedBlockTreeDB(boxID)
		cachedDEKsLock.Lock()
		if cached := cachedDEKs[boxID]; cached != nil {
			clear(cached)
		}
		delete(cachedDEKs, boxID)
		cachedDEKsLock.Unlock()
	})
	writeIndexFailureTree(t, boxID, rootID, "Encrypted")

	counts := func() (blocks, blocktrees int) {
		t.Helper()
		database := sql.GetEncryptedDB(boxID)
		if database == nil {
			t.Fatal("encrypted content database is not open")
		}
		if err := database.QueryRow("SELECT COUNT(*) FROM blocks WHERE box = ?", boxID).Scan(&blocks); err != nil {
			t.Fatalf("count encrypted content rows: %v", err)
		}
		blocktrees = len(treenode.GetBlockTreesByBoxID(boxID))
		return
	}

	if err = FullReindexDirect(); err != nil {
		t.Fatalf("first full reindex: %v", err)
	}
	firstBlocks, firstBlocktrees := counts()
	if firstBlocks == 0 || firstBlocktrees == 0 {
		t.Fatalf("first full reindex produced blocks=%d blocktrees=%d", firstBlocks, firstBlocktrees)
	}
	if err = FullReindexDirect(); err != nil {
		t.Fatalf("second full reindex: %v", err)
	}
	secondBlocks, secondBlocktrees := counts()
	if secondBlocks != firstBlocks || secondBlocktrees != firstBlocktrees {
		t.Fatalf("repeated full reindex changed encrypted counts from blocks=%d blocktrees=%d to blocks=%d blocktrees=%d", firstBlocks, firstBlocktrees, secondBlocks, secondBlocktrees)
	}
}

func TestEncryptedFullReindexFailureRestoresDatabaseBlocktreeAndMirror(t *testing.T) {
	setupIndexFailureEnvironment(t)

	const (
		boxID           = "20990717010020-restore"
		rootID          = "20990717010021-restore"
		avID            = "20990717010022-restore"
		mirrorBlockID   = "20990717010023-restore"
		writerRootID    = "20990717010024-writerx"
		previousTitle   = "Previous encrypted index"
		replacementName = "Replacement encrypted index"
		writerTitle     = "Concurrent encrypted writer"
	)
	boxConf := conf.NewBoxConf()
	boxConf.Name = boxID
	boxConf.Encrypted = true
	boxConf.Closed = false
	if err := (&Box{ID: boxID}).SaveConf(boxConf); err != nil {
		t.Fatalf("save encrypted notebook configuration: %v", err)
	}
	dek, err := util.GenerateDEK()
	if err != nil {
		t.Fatalf("generate encrypted notebook key: %v", err)
	}
	if err = sql.OpenEncryptedDB(boxID, dek); err != nil {
		t.Fatalf("open encrypted content database: %v", err)
	}
	if err = treenode.OpenEncryptedBlockTreeDB(boxID, dek); err != nil {
		t.Fatalf("open encrypted blocktree database: %v", err)
	}
	cachedDEKsLock.Lock()
	cachedDEKs[boxID] = append([]byte(nil), dek...)
	cachedDEKsLock.Unlock()
	clear(dek)
	if err = sql.InitDatabase(true); err != nil {
		t.Fatalf("initialize ordinary content database: %v", err)
	}
	sql.InitHistoryDatabase(true)
	sql.InitAssetContentDatabase(true)
	originalBeforeHook := contentCommitBeforeEnqueueHook
	originalAfterHook := contentCommitAfterEnqueueHook
	t.Cleanup(func() {
		contentCommitBeforeEnqueueHook = originalBeforeHook
		contentCommitAfterEnqueueHook = originalAfterHook
		sql.CloseEncryptedDB(boxID)
		sql.CloseDatabase()
		treenode.CloseEncryptedBlockTreeDB(boxID)
		cachedDEKsLock.Lock()
		if cached := cachedDEKs[boxID]; cached != nil {
			clear(cached)
		}
		delete(cachedDEKs, boxID)
		cachedDEKsLock.Unlock()
	})

	previous := writeIndexFailureTree(t, boxID, rootID, previousTitle)
	if err = treenode.UpsertBlockTree(previous); err != nil {
		t.Fatalf("persist previous encrypted blocktree: %v", err)
	}
	if err = sql.IndexTreeQueue(previous); err != nil {
		t.Fatalf("enqueue previous encrypted content index: %v", err)
	}
	if err = sql.FlushQueue(); err != nil {
		t.Fatalf("flush previous encrypted content index: %v", err)
	}
	attrView := &av.AttributeView{Spec: av.CurrentSpec, ID: avID, RenderedViewables: map[string]av.Viewable{}}
	if err = av.SaveAttributeViewInBox(attrView, boxID); err != nil {
		t.Fatalf("save encrypted attribute view definition: %v", err)
	}
	if err = av.ReplaceBlockRelsInBox([]*ast.Node{{
		Type:            ast.NodeAttributeView,
		ID:              mirrorBlockID,
		AttributeViewID: avID,
	}}, boxID); err != nil {
		t.Fatalf("persist previous encrypted mirror: %v", err)
	}
	replacement := treenode.NewTree(boxID, previous.Path, "/"+replacementName, replacementName)
	replacement.ID = rootID
	replacement.Root.ID = rootID
	replacement.Root.Box = boxID
	replacement.Root.Path = previous.Path
	replacement.Root.SetIALAttr("id", rootID)
	replacement.Root.SetIALAttr("title", replacementName)
	if _, err = filesys.WriteTree(replacement); err != nil {
		t.Fatalf("write replacement encrypted tree: %v", err)
	}
	writerTree := treenode.NewTree(boxID, "/"+writerRootID+".sy", "/"+writerTitle, writerTitle)

	var dropOnce sync.Once
	var dropErr error
	rebuildQueued := make(chan struct{})
	allowFlushFailure := make(chan struct{})
	writerSawRestoredDatabase := make(chan error, 1)
	contentCommitBeforeEnqueueHook = func(tree *parse.Tree) {
		if tree.Box != boxID || tree.ID != writerRootID {
			return
		}
		var restoredTitle string
		queryErr := sql.GetEncryptedDB(boxID).QueryRow("SELECT hpath FROM blocks WHERE id = ?", rootID).Scan(&restoredTitle)
		if queryErr == nil && restoredTitle != previous.HPath {
			queryErr = fmt.Errorf("restored encrypted hpath = %q, want %q", restoredTitle, previous.HPath)
		}
		writerSawRestoredDatabase <- queryErr
	}
	contentCommitAfterEnqueueHook = func(tree *parse.Tree) {
		if tree.Box != boxID || tree.ID != rootID {
			return
		}
		dropOnce.Do(func() {
			close(rebuildQueued)
			<-allowFlushFailure
			_, dropErr = sql.GetEncryptedDB(boxID).Exec("DROP TABLE blocks")
		})
	}
	rebuildDone := make(chan error, 1)
	go func() {
		rebuildDone <- FullReindexDirect()
	}()
	select {
	case <-rebuildQueued:
	case <-time.After(5 * time.Second):
		t.Fatal("encrypted rebuild did not reach its durable batch boundary")
	}

	writerStarted := make(chan struct{})
	writerDone := make(chan error, 1)
	go func() {
		close(writerStarted)
		writerDone <- indexWriteTreeUpsertQueue(writerTree)
	}()
	<-writerStarted
	close(allowFlushFailure)
	select {
	case err = <-rebuildDone:
	case <-time.After(10 * time.Second):
		t.Fatal("failed encrypted rebuild did not finish restoring its snapshot")
	}
	if dropErr != nil {
		t.Fatalf("create encrypted flush failure boundary: %v", dropErr)
	}
	if err == nil {
		t.Fatal("encrypted full reindex succeeded after its SQL table disappeared")
	}
	select {
	case observationErr := <-writerSawRestoredDatabase:
		if observationErr != nil {
			t.Fatalf("concurrent writer crossed admission before database restore: %v", observationErr)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("concurrent writer did not continue after encrypted rebuild restore")
	}
	select {
	case writerErr := <-writerDone:
		if writerErr != nil {
			t.Fatalf("commit concurrent encrypted writer after rebuild restore: %v", writerErr)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("concurrent encrypted writer did not complete after admission reopened")
	}

	var restoredTitle string
	if queryErr := sql.GetEncryptedDB(boxID).QueryRow("SELECT hpath FROM blocks WHERE id = ?", rootID).Scan(&restoredTitle); queryErr != nil {
		t.Fatalf("query restored encrypted content index: %v", queryErr)
	}
	if restoredTitle != previous.HPath {
		t.Fatalf("restored encrypted hpath = %q, want %q", restoredTitle, previous.HPath)
	}
	restoredBlocktree := treenode.GetBlockTreeInBox(rootID, boxID)
	if restoredBlocktree == nil || restoredBlocktree.HPath != previous.HPath || restoredBlocktree.Path != previous.Path {
		t.Fatalf("restored encrypted blocktree = %#v", restoredBlocktree)
	}
	restoredMirror, mirrorErr := av.GetBlockRelsInBoxStrict(boxID)
	if mirrorErr != nil {
		t.Fatalf("read restored encrypted mirror: %v", mirrorErr)
	}
	if got := restoredMirror[avID]; len(got) != 1 || got[0] != mirrorBlockID {
		t.Fatalf("restored encrypted mirror relation = %#v, want [%s]", got, mirrorBlockID)
	}

	queueData, readErr := os.ReadFile(filepath.Join(util.QueueDir, "index.queue"))
	if readErr != nil {
		t.Fatalf("read durable queue after rejected encrypted rebuild: %v", readErr)
	}
	var foundWriter bool
	for _, line := range bytes.Split(bytes.TrimSpace(queueData), []byte("\n")) {
		if len(line) == 0 {
			continue
		}
		var entry struct {
			Action string `json:"action"`
			ID     string `json:"id"`
			Box    string `json:"box"`
			Batch  string `json:"batch"`
		}
		if unmarshalErr := json.Unmarshal(line, &entry); unmarshalErr != nil {
			t.Fatalf("decode durable queue after rejected encrypted rebuild: %v", unmarshalErr)
		}
		if entry.Batch != "" {
			t.Fatalf("rejected encrypted rebuild entry remains durable: %#v", entry)
		}
		if entry.Action == "upsert" && entry.Box == boxID && entry.ID == writerRootID {
			foundWriter = true
		} else if entry.Box == boxID {
			t.Fatalf("rejected encrypted rebuild operation remains durable: %#v", entry)
		}
	}
	if !foundWriter {
		t.Fatalf("concurrent encrypted writer is missing from durable queue: %s", queueData)
	}
	loadedWriter, loadErr := filesys.LoadTree(boxID, writerTree.Path, util.NewLute())
	if loadErr != nil || loadedWriter.ID != writerRootID || loadedWriter.HPath != writerTree.HPath {
		t.Fatalf("concurrent writer file after rebuild restore = %#v, err=%v", loadedWriter, loadErr)
	}
	writerBlocktree := treenode.GetBlockTreeInBox(writerRootID, boxID)
	if writerBlocktree == nil || writerBlocktree.Path != writerTree.Path || writerBlocktree.HPath != writerTree.HPath {
		t.Fatalf("concurrent writer blocktree after rebuild restore = %#v", writerBlocktree)
	}
	if err = sql.FlushQueue(); err != nil {
		t.Fatalf("flush concurrent encrypted writer preserved by rebuild rollback: %v", err)
	}
	writerBlock := sql.GetBlockInBox(writerRootID, boxID)
	if writerBlock == nil || writerBlock.Box != boxID || writerBlock.HPath != writerTree.HPath {
		t.Fatalf("concurrent encrypted writer SQL row after flush = %#v", writerBlock)
	}

	contentCommitBeforeEnqueueHook = originalBeforeHook
	contentCommitAfterEnqueueHook = originalAfterHook
	if err = FullReindexDirect(); err != nil {
		t.Fatalf("retry encrypted full reindex after restored writer: %v", err)
	}
	writerBlock = sql.GetBlockInBox(writerRootID, boxID)
	if writerBlock == nil || writerBlock.Box != boxID || writerBlock.HPath != writerTree.HPath {
		t.Fatalf("concurrent encrypted writer after successful rebuild retry = %#v", writerBlock)
	}
}

func TestUnmountDurableQueueFailurePreservesOpenNotebookAndBlocktree(t *testing.T) {
	setupIndexFailureEnvironment(t)

	const boxID = "20990717010100-unmount"
	const rootID = "20990717010101-unmount"
	saveIndexFailureBox(t, boxID, false)
	tree := treenode.NewTree(boxID, "/"+rootID+".sy", "/Unmount", "Unmount")
	if err := treenode.UpsertBlockTree(tree); err != nil {
		t.Fatalf("index test blocktree: %v", err)
	}
	if treenode.GetBlockTreeInBox(rootID, boxID) == nil {
		t.Fatal("test blocktree was not indexed")
	}
	blockDurableIndexQueue(t)

	if err := Unmount(boxID); err == nil {
		t.Fatal("unmount succeeded without a durable unindex queue entry")
	}
	if got := (&Box{ID: boxID}).GetConf().Closed; got {
		t.Fatal("failed unmount left notebook closed")
	}
	if treenode.GetBlockTreeInBox(rootID, boxID) == nil {
		t.Fatal("failed unmount removed the existing blocktree")
	}
}

func TestUnmountBlocktreeFailureRestoresOpenNotebook(t *testing.T) {
	setupIndexFailureEnvironment(t)

	const boxID = "20990717010110-unmount"
	const rootID = "20990717010111-unmount"
	saveIndexFailureBox(t, boxID, false)
	tree := treenode.NewTree(boxID, "/"+rootID+".sy", "/Unmount", "Unmount")
	if err := treenode.UpsertBlockTree(tree); err != nil {
		t.Fatalf("index test blocktree: %v", err)
	}
	treenode.CloseDatabase()

	if err := Unmount(boxID); err == nil {
		t.Fatal("unmount succeeded after blocktree deletion failed")
	}
	queueData, readErr := os.ReadFile(filepath.Join(util.QueueDir, "index.queue"))
	if readErr != nil && !os.IsNotExist(readErr) {
		t.Fatalf("read durable queue after blocktree failure: %v", readErr)
	}
	if len(bytes.TrimSpace(queueData)) != 0 {
		t.Fatalf("blocktree failure published a durable notebook deletion: %s", queueData)
	}
	if got := (&Box{ID: boxID}).GetConf().Closed; got {
		t.Fatal("failed unmount left notebook closed")
	}
	treenode.InitBlockTree(false)
	if treenode.GetBlockTreeInBox(rootID, boxID) == nil {
		t.Fatal("failed unmount removed the existing blocktree")
	}
}

func TestMountDurableQueueFailureRestoresClosedNotebook(t *testing.T) {
	setupIndexFailureEnvironment(t)

	const boxID = "20990717010200-mountxx"
	const rootID = "20990717010201-mountxx"
	saveIndexFailureBox(t, boxID, true)
	writeIndexFailureTree(t, boxID, rootID, "Mount")
	blockDurableIndexQueue(t)

	alreadyMounted, err := Mount(boxID)
	if err == nil {
		t.Fatal("mount succeeded without a durable index queue entry")
	}
	if alreadyMounted {
		t.Fatal("failed mount reported an already mounted notebook")
	}
	if got := (&Box{ID: boxID}).GetConf().Closed; !got {
		t.Fatal("failed mount did not restore the closed notebook state")
	}
}

func TestInitBoxesDurableQueueFailureDoesNotPublishIndexSuccess(t *testing.T) {
	setupIndexFailureEnvironment(t)

	const boxID = "20990717010300-initbox"
	const rootID = "20990717010301-initbox"
	saveIndexFailureBox(t, boxID, false)
	writeIndexFailureTree(t, boxID, rootID, "Initialize")
	wantHistory := time.Unix(123, 0)
	boxLatestHistoryTime[boxID] = wantHistory
	blockDurableIndexQueue(t)

	if err := InitBoxes(); err == nil {
		t.Fatal("notebook initialization succeeded without a durable index queue entry")
	}
	if got := boxLatestHistoryTime[boxID]; !got.Equal(wantHistory) {
		t.Fatalf("failed notebook initialization updated history time to %s", got)
	}
	if tree := treenode.GetBlockTreeInBox(rootID, boxID); tree != nil {
		t.Fatalf("failed notebook initialization published a blocktree: %#v", tree)
	}
}

func TestBoxIndexBlocktreeFailureDoesNotPublishIndexSuccess(t *testing.T) {
	setupIndexFailureEnvironment(t)

	const boxID = "20990717010400-blockdb"
	const rootID = "20990717010401-blockdb"
	saveIndexFailureBox(t, boxID, false)
	writeIndexFailureTree(t, boxID, rootID, "Blocktree")
	wantHistory := time.Unix(456, 0)
	boxLatestHistoryTime[boxID] = wantHistory
	treenode.CloseDatabase()

	if err := (&Box{ID: boxID, Name: boxID}).Index(); err == nil {
		t.Fatal("notebook index succeeded without blocktree persistence")
	}
	if got := boxLatestHistoryTime[boxID]; !got.Equal(wantHistory) {
		t.Fatalf("blocktree index failure updated history time to %s", got)
	}
}

func TestBoxIndexMirrorFailureDoesNotPublishIndexSuccess(t *testing.T) {
	setupIndexFailureEnvironment(t)

	const boxID = "20990717010500-mirrorx"
	const rootID = "20990717010501-mirrorx"
	saveIndexFailureBox(t, boxID, false)
	writeIndexFailureTree(t, boxID, rootID, "Mirror")
	wantHistory := time.Unix(789, 0)
	boxLatestHistoryTime[boxID] = wantHistory
	mirrorDir := filepath.Join(util.DataDir, "storage", "av")
	if err := os.MkdirAll(filepath.Dir(mirrorDir), 0755); err != nil {
		t.Fatalf("create attribute view mirror parent: %v", err)
	}
	writeBoundary := []byte("not-a-directory")
	if err := os.WriteFile(mirrorDir, writeBoundary, 0644); err != nil {
		t.Fatalf("create attribute view mirror write boundary: %v", err)
	}

	err := (&Box{ID: boxID, Name: boxID}).Index()
	if err == nil {
		t.Fatal("notebook index succeeded without persisting the attribute view mirror")
	}
	if got := boxLatestHistoryTime[boxID]; !got.Equal(wantHistory) {
		t.Fatalf("attribute view mirror failure updated history time to %s", got)
	}
	gotBoundary, readErr := os.ReadFile(mirrorDir)
	if readErr != nil {
		t.Fatalf("read attribute view mirror boundary after rejected index: %v", readErr)
	}
	if !bytes.Equal(gotBoundary, writeBoundary) {
		t.Fatalf("rejected notebook index changed mirror write boundary: %q", gotBoundary)
	}
}

func TestBoxIndexRejectsClosedNotebook(t *testing.T) {
	setupIndexFailureEnvironment(t)

	const boxID = "20990717010600-closedx"
	const rootID = "20990717010601-closedx"
	saveIndexFailureBox(t, boxID, true)
	writeIndexFailureTree(t, boxID, rootID, "Closed")
	wantHistory := time.Unix(987, 0)
	boxLatestHistoryTime[boxID] = wantHistory

	err := (&Box{ID: boxID, Name: boxID}).Index()
	if !errors.Is(err, ErrBoxUnindexed) {
		t.Fatalf("closed notebook index error = %v, want ErrBoxUnindexed", err)
	}
	if got := boxLatestHistoryTime[boxID]; !got.Equal(wantHistory) {
		t.Fatalf("closed notebook index updated history time to %s", got)
	}
	if tree := treenode.GetBlockTreeInBox(rootID, boxID); tree != nil {
		t.Fatalf("closed notebook was indexed: %#v", tree)
	}
}

func TestIndexDirectoryWalkErrorsAreReturned(t *testing.T) {
	setupIndexFailureEnvironment(t)

	tests := []struct {
		name string
		run  func([]string) error
	}{
		{name: "upsert", run: UpsertIndexes},
		{name: "remove", run: RemoveIndexes},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if err := test.run([]string{"missing/"}); err == nil {
				t.Fatal("missing index directory was accepted")
			}
		})
	}
}

func setupIndexFailureEnvironment(t *testing.T) {
	t.Helper()

	originalDataDir := util.DataDir
	originalTempDir := util.TempDir
	originalQueueDir := util.QueueDir
	originalConfDir := util.ConfDir
	originalHistoryDir := util.HistoryDir
	originalDBPath := util.DBPath
	originalHistoryDBPath := util.HistoryDBPath
	originalAssetContentDBPath := util.AssetContentDBPath
	originalBlockTreeDBPath := util.BlockTreeDBPath
	originalConf := Conf
	originalHistoryTimes := boxLatestHistoryTime
	originalIsExiting := util.IsExiting.Load()
	originalTimeLang, hadOriginalTimeLang := util.TimeLangs["index-failure-test"]

	tempRoot := t.TempDir()
	util.DataDir = filepath.Join(tempRoot, "data")
	util.TempDir = filepath.Join(tempRoot, "temp")
	util.QueueDir = filepath.Join(util.TempDir, "queue")
	util.ConfDir = filepath.Join(tempRoot, "conf")
	util.HistoryDir = filepath.Join(tempRoot, "history")
	util.DBPath = filepath.Join(util.TempDir, util.DBName)
	util.HistoryDBPath = filepath.Join(util.TempDir, "history.db")
	util.AssetContentDBPath = filepath.Join(util.TempDir, "asset_content.db")
	util.BlockTreeDBPath = filepath.Join(util.TempDir, "blocktree.db")
	for _, dir := range []string{util.DataDir, util.TempDir, util.QueueDir, util.ConfDir, util.HistoryDir} {
		if err := os.MkdirAll(dir, 0755); err != nil {
			t.Fatalf("create test directory %s: %v", dir, err)
		}
	}
	Conf = NewAppConf()
	Conf.System = conf.NewSystem()
	Conf.Editor = conf.NewEditor()
	Conf.FileTree = conf.NewFileTree()
	Conf.Search = conf.NewSearch()
	Conf.Lang = "index-failure-test"
	util.TimeLangs[Conf.Lang] = map[string]any{
		"now": "now", "1s": "1 second", "xs": "%d seconds", "1m": "1 minute",
		"xh": "%d minutes", "1h": "1 hour", "1d": "1 day", "xd": "%d days",
		"1w": "1 week", "xw": "%d weeks", "1M": "1 month", "xM": "%d months",
		"1y": "1 year", "2y": "2 years", "xy": "%d years", "max": "a long time",
		"albl": "ago", "blbl": "from now",
	}
	boxLatestHistoryTime = map[string]time.Time{}
	util.IsExiting.Store(false)
	cache.ClearTreeCache()
	cache.ClearDocsIAL()
	cache.ClearBlocksIAL()
	cache.ClearAVCache()
	if err := sql.ClearQueue(); err != nil {
		t.Fatalf("clear index failure queue: %v", err)
	}
	treenode.CloseDatabase()
	treenode.InitBlockTree(true)

	t.Cleanup(func() {
		if err := sql.ClearQueue(); err != nil {
			t.Errorf("clear index failure queue during cleanup: %v", err)
		}
		treenode.CloseDatabase()
		cache.ClearTreeCache()
		cache.ClearDocsIAL()
		cache.ClearBlocksIAL()
		cache.ClearAVCache()
		if hadOriginalTimeLang {
			util.TimeLangs["index-failure-test"] = originalTimeLang
		} else {
			delete(util.TimeLangs, "index-failure-test")
		}
		util.IsExiting.Store(originalIsExiting)
		boxLatestHistoryTime = originalHistoryTimes
		Conf = originalConf
		util.BlockTreeDBPath = originalBlockTreeDBPath
		util.AssetContentDBPath = originalAssetContentDBPath
		util.HistoryDBPath = originalHistoryDBPath
		util.DBPath = originalDBPath
		util.HistoryDir = originalHistoryDir
		util.ConfDir = originalConfDir
		util.QueueDir = originalQueueDir
		util.TempDir = originalTempDir
		util.DataDir = originalDataDir
	})
}

func saveIndexFailureBox(t *testing.T, boxID string, closed bool) {
	t.Helper()
	boxConf := conf.NewBoxConf()
	boxConf.Name = boxID
	boxConf.Closed = closed
	if err := (&Box{ID: boxID}).SaveConf(boxConf); err != nil {
		t.Fatalf("save notebook configuration: %v", err)
	}
}

func writeIndexFailureTree(t *testing.T, boxID, rootID, title string) *parse.Tree {
	t.Helper()
	tree := treenode.NewTree(boxID, "/"+rootID+".sy", "/"+title, title)
	if _, err := filesys.WriteTree(tree); err != nil {
		t.Fatalf("write notebook tree: %v", err)
	}
	return tree
}

func blockDurableIndexQueue(t *testing.T) {
	t.Helper()
	originalQueueDir := util.QueueDir
	blockedPath := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(blockedPath, []byte("blocked"), 0644); err != nil {
		t.Fatalf("create durable queue failure boundary: %v", err)
	}
	util.QueueDir = blockedPath
	t.Cleanup(func() {
		util.QueueDir = originalQueueDir
	})
}
