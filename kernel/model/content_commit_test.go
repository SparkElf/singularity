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
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/88250/lute/parse"
	"github.com/siyuan-note/siyuan/kernel/cache"
	"github.com/siyuan-note/siyuan/kernel/conf"
	"github.com/siyuan-note/siyuan/kernel/sql"
	"github.com/siyuan-note/siyuan/kernel/treenode"
	"github.com/siyuan-note/siyuan/kernel/util"
)

func TestContentCommitBlocksLockUntilDurableEnqueue(t *testing.T) {
	const (
		boxID  = "20990716080000-commitx"
		rootID = "20990716080001-commitx"
	)
	originalDataDir := util.DataDir
	originalTempDir := util.TempDir
	originalQueueDir := util.QueueDir
	originalConfDir := util.ConfDir
	originalConf := Conf
	originalIsExiting := util.IsExiting.Load()
	originalAcceptedHook := contentCommitAcceptedHook
	originalBeforeHook := contentCommitBeforeEnqueueHook
	originalAfterHook := contentCommitAfterEnqueueHook
	originalAdmissionBlockedHook := lockBoxAdmissionBlockedHook
	originalAfterDrainHook := lockBoxAfterSQLDrainHook

	tempRoot := t.TempDir()
	util.DataDir = filepath.Join(tempRoot, "data")
	util.TempDir = filepath.Join(tempRoot, "temp")
	util.QueueDir = filepath.Join(util.TempDir, "queue")
	util.ConfDir = filepath.Join(tempRoot, "conf")
	for _, dir := range []string{util.DataDir, util.TempDir, util.QueueDir, util.ConfDir} {
		if err := os.MkdirAll(dir, 0755); err != nil {
			t.Fatalf("create test directory %s: %v", dir, err)
		}
	}
	Conf = NewAppConf()
	Conf.System = conf.NewSystem()
	Conf.Editor = conf.NewEditor()
	Conf.FileTree = conf.NewFileTree()
	Conf.Search = conf.NewSearch()
	Conf.Lang = "content-commit-test"
	util.TimeLangs[Conf.Lang] = map[string]any{
		"now": "now", "1s": "1 second", "xs": "%d seconds", "1m": "1 minute",
		"xh": "%d minutes", "1h": "1 hour", "1d": "1 day", "xd": "%d days",
		"1w": "1 week", "xw": "%d weeks", "1M": "1 month", "xM": "%d months",
		"1y": "1 year", "2y": "2 years", "xy": "%d years", "max": "a long time",
		"albl": "ago", "blbl": "from now",
	}
	util.IsExiting.Store(false)
	if err := sql.ClearQueue(); err != nil {
		t.Fatalf("clear content commit queue: %v", err)
	}
	t.Cleanup(func() {
		contentCommitAcceptedHook = originalAcceptedHook
		contentCommitBeforeEnqueueHook = originalBeforeHook
		contentCommitAfterEnqueueHook = originalAfterHook
		lockBoxAdmissionBlockedHook = originalAdmissionBlockedHook
		lockBoxAfterSQLDrainHook = originalAfterDrainHook
		if err := sql.ClearQueue(); err != nil {
			t.Errorf("clear content commit queue during cleanup: %v", err)
		}
		sql.CloseEncryptedDB(boxID)
		treenode.CloseEncryptedBlockTreeDB(boxID)
		cache.ClearTreeCache()
		cachedDEKsLock.Lock()
		if dek := cachedDEKs[boxID]; dek != nil {
			zeroAndClear(dek)
			delete(cachedDEKs, boxID)
		}
		cachedDEKsLock.Unlock()
		delete(util.TimeLangs, "content-commit-test")
		Conf = originalConf
		util.IsExiting.Store(originalIsExiting)
		util.ConfDir = originalConfDir
		util.QueueDir = originalQueueDir
		util.TempDir = originalTempDir
		util.DataDir = originalDataDir
	})

	boxConf := conf.NewBoxConf()
	boxConf.Name = "Commit Contract"
	boxConf.Encrypted = true
	boxConf.Closed = false
	if err := (&Box{ID: boxID}).SaveConf(boxConf); err != nil {
		t.Fatalf("save encrypted notebook config: %v", err)
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
	setDEKForTest(boxID, append([]byte(nil), dek...))
	zeroAndClear(dek)

	treePath := "/" + rootID + ".sy"
	tree := treenode.NewTree(boxID, treePath, "/Commit Contract", "Commit Contract")
	cache.RemoveTreeDataInBox(rootID, boxID)

	commitAccepted := make(chan struct{})
	allowContentWrite := make(chan struct{})
	commitReady := make(chan struct{})
	allowEnqueue := make(chan struct{})
	enqueueDurable := make(chan struct{})
	allowCommitRelease := make(chan struct{})
	admissionBlocked := make(chan struct{})
	drainAcquired := make(chan struct{})
	drainPhase := make(chan int32, 1)
	var commitPhase atomic.Int32
	var allowContentWriteOnce sync.Once
	var allowEnqueueOnce sync.Once
	var allowCommitReleaseOnce sync.Once
	releaseContentWrite := func() { allowContentWriteOnce.Do(func() { close(allowContentWrite) }) }
	releaseEnqueue := func() { allowEnqueueOnce.Do(func() { close(allowEnqueue) }) }
	releaseCommit := func() { allowCommitReleaseOnce.Do(func() { close(allowCommitRelease) }) }
	contentCommitAcceptedHook = func(candidateBoxID string) {
		if candidateBoxID != boxID {
			return
		}
		close(commitAccepted)
		<-allowContentWrite
	}
	contentCommitBeforeEnqueueHook = func(candidate *parse.Tree) {
		if candidate.ID != rootID || candidate.Box != boxID {
			return
		}
		commitPhase.Store(1)
		close(commitReady)
		<-allowEnqueue
	}
	contentCommitAfterEnqueueHook = func(candidate *parse.Tree) {
		if candidate.ID != rootID || candidate.Box != boxID {
			return
		}
		commitPhase.Store(2)
		close(enqueueDurable)
		<-allowCommitRelease
	}
	lockBoxAdmissionBlockedHook = func(candidateBoxID string) {
		if candidateBoxID == boxID {
			close(admissionBlocked)
		}
	}
	lockBoxAfterSQLDrainHook = func(candidateBoxID string) {
		if candidateBoxID == boxID {
			drainPhase <- commitPhase.Load()
			close(drainAcquired)
		}
	}

	writerDone := make(chan error, 1)
	writerExited := make(chan struct{})
	lockExited := make(chan struct{})
	lockLaunched := false
	go func() {
		defer close(writerExited)
		writerDone <- indexWriteTreeUpsertQueue(tree)
	}()
	t.Cleanup(func() {
		releaseContentWrite()
		releaseEnqueue()
		releaseCommit()
		select {
		case <-writerExited:
		case <-time.After(5 * time.Second):
			t.Error("content writer did not exit during cleanup")
		}
		if lockLaunched {
			select {
			case <-lockExited:
			case <-time.After(5 * time.Second):
				t.Error("LockBox did not exit during cleanup")
			}
		}
	})
	select {
	case <-commitAccepted:
	case <-time.After(5 * time.Second):
		t.Fatal("content commit did not acquire its composition token")
	}

	if _, err = os.Stat(filepath.Join(util.DataDir, boxID, treePath)); !os.IsNotExist(err) {
		t.Fatalf("tree file exists before the accepted commit is released: %v", err)
	}
	if _, ok := cache.GetTreeDataInBox(rootID, boxID); ok {
		t.Fatal("plaintext tree cache was populated before the accepted commit was released")
	}
	if treenode.GetBlockTreeInBox(rootID, boxID) != nil {
		t.Fatal("block tree was updated before the accepted commit was released")
	}

	lockDone := make(chan error, 1)
	lockLaunched = true
	go func() {
		defer close(lockExited)
		lockDone <- LockBox(boxID)
	}()
	select {
	case <-admissionBlocked:
	case <-time.After(5 * time.Second):
		t.Fatal("LockBox was not blocked by the accepted content commit's SQL admission lease")
	}

	releaseContentWrite()
	select {
	case <-commitReady:
	case <-time.After(5 * time.Second):
		t.Fatal("content commit did not reach the durable enqueue boundary")
	}
	if _, err = os.Stat(filepath.Join(util.DataDir, boxID, treePath)); err != nil {
		t.Errorf("tree file was not written before enqueue: %v", err)
	}
	if treenode.GetBlockTreeInBox(rootID, boxID) == nil {
		t.Error("block tree was not updated before enqueue")
	}
	releaseEnqueue()
	select {
	case <-enqueueDurable:
	case <-time.After(5 * time.Second):
		t.Fatal("content commit did not persist its durable queue entry")
	}
	durableData, readErr := os.ReadFile(filepath.Join(util.QueueDir, "index.queue"))
	if readErr != nil {
		t.Fatalf("read durable SQL queue before token release: %v", readErr)
	}
	var durableEntry struct {
		Action string `json:"action"`
		ID     string `json:"id"`
		Box    string `json:"box"`
	}
	if err = json.Unmarshal(bytes.TrimSpace(durableData), &durableEntry); err != nil {
		t.Fatalf("decode durable SQL queue entry: %v", err)
	}
	if durableEntry.Action != "upsert" || durableEntry.ID != rootID || durableEntry.Box != boxID {
		t.Fatalf("durable SQL queue entry = %#v, want the accepted tree in its content store", durableEntry)
	}
	commitPhase.Store(3)
	releaseCommit()
	select {
	case err = <-writerDone:
		if err != nil {
			t.Fatalf("finish accepted content commit: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("accepted content commit did not finish")
	}
	select {
	case <-drainAcquired:
	case <-time.After(5 * time.Second):
		t.Fatal("LockBox did not acquire SQL drain after the accepted commit released its token")
	}
	if phase := <-drainPhase; phase != 3 {
		t.Fatalf("LockBox acquired SQL drain during content commit phase %d, want release phase 3", phase)
	}
	select {
	case err = <-lockDone:
		if err != nil {
			t.Fatalf("LockBox after accepted content commit: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("LockBox did not finish after the accepted content commit")
	}

	if _, ok := cache.GetTreeDataInBox(rootID, boxID); ok {
		t.Fatal("plaintext tree cache was repopulated after LockBox completed")
	}
	queueData, readErr := os.ReadFile(filepath.Join(util.QueueDir, "index.queue"))
	if readErr != nil && !os.IsNotExist(readErr) {
		t.Fatalf("read durable SQL queue after LockBox: %v", readErr)
	}
	if len(bytes.TrimSpace(queueData)) != 0 {
		t.Fatalf("durable SQL queue was mutated after LockBox completed: %s", queueData)
	}
}
