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
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/88250/lute/ast"
	"github.com/88250/lute/parse"
	"github.com/siyuan-note/siyuan/kernel/av"
	"github.com/siyuan-note/siyuan/kernel/cache"
	"github.com/siyuan-note/siyuan/kernel/conf"
	"github.com/siyuan-note/siyuan/kernel/filesys"
	kernelsql "github.com/siyuan-note/siyuan/kernel/sql"
	"github.com/siyuan-note/siyuan/kernel/treenode"
	"github.com/siyuan-note/siyuan/kernel/util"
)

func TestTransactionJSONCarriesNotebookIdentity(t *testing.T) {
	const notebook = "20260716000000-jsonbox"
	data, err := json.Marshal(&Transaction{Notebook: notebook})
	if err != nil {
		t.Fatalf("marshal transaction: %v", err)
	}
	var payload struct {
		Notebook string `json:"notebook"`
	}
	if err = json.Unmarshal(data, &payload); err != nil {
		t.Fatalf("unmarshal transaction payload: %v", err)
	}
	if payload.Notebook != notebook {
		t.Fatalf("transaction notebook = %q, want %q", payload.Notebook, notebook)
	}
}

func TestTransactionJSONCarriesExplicitContentTargets(t *testing.T) {
	const (
		notebookID = "20260716000000-targetbox"
		documentID = "20260716000001-targetdoc"
	)
	data, err := json.Marshal(&Transaction{
		Notebook: notebookID,
		ContentTargets: []TransactionContentTarget{{
			NotebookID: notebookID,
			DocumentID: documentID,
		}},
	})
	if err != nil {
		t.Fatalf("marshal transaction content target: %v", err)
	}
	var payload struct {
		Notebook       string                     `json:"notebook"`
		ContentTargets []TransactionContentTarget `json:"contentTargets"`
	}
	if err = json.Unmarshal(data, &payload); err != nil {
		t.Fatalf("unmarshal transaction content target: %v", err)
	}
	if payload.Notebook != notebookID || len(payload.ContentTargets) != 1 ||
		payload.ContentTargets[0].NotebookID != notebookID || payload.ContentTargets[0].DocumentID != documentID {
		t.Fatalf("transaction content target payload = %#v, want explicit notebook/document identity", payload)
	}
}

func TestPopulateContentTargetsUsesRequestAndLoadedTreeIdentities(t *testing.T) {
	const (
		requestNotebook = "20990716000000-requestbox"
		requestDocument = "20990716000001-requestdoc"
		treeNotebook    = "20990716000002-treebox"
		treeDocument    = "20990716000003-treedoc"
	)
	tx := &Transaction{
		trees: map[string]*parse.Tree{
			treeDocument: &parse.Tree{ID: treeDocument, Box: treeNotebook},
		},
	}
	tx.PopulateContentTargets(requestNotebook, requestDocument)
	if !reflect.DeepEqual(tx.ContentTargets, []TransactionContentTarget{
		{NotebookID: requestNotebook, DocumentID: requestDocument},
		{NotebookID: treeNotebook, DocumentID: treeDocument},
	}) {
		t.Fatalf("content targets = %#v, want request and loaded-tree identities", tx.ContentTargets)
	}
}

func TestTransactionNotebookForBoxUsesCanonicalContentStoreIdentity(t *testing.T) {
	originalDataDir := util.DataDir
	util.DataDir = t.TempDir()
	t.Cleanup(func() { util.DataDir = originalDataDir })

	const encryptedBox = "20990717150000-dailytx"
	boxConf := conf.NewBoxConf()
	boxConf.Encrypted = true
	if err := (&Box{ID: encryptedBox}).SaveConf(boxConf); err != nil {
		t.Fatalf("save encrypted daily-note notebook config: %v", err)
	}

	if got := TransactionNotebookForBox("20990717150001-ordinary"); got != "" {
		t.Fatalf("ordinary daily-note transaction notebook = %q, want global content store", got)
	}
	if got := TransactionNotebookForBox(encryptedBox); got != encryptedBox {
		t.Fatalf("encrypted daily-note transaction notebook = %q, want %q", got, encryptedBox)
	}
}

func TestUndoEntryPreservesTransactionNotebook(t *testing.T) {
	const (
		notebook = "20260716000000-undobox"
		rootID   = "20260716000000-undoroot"
	)
	log := newUndoLog(4)
	tx := &Transaction{
		Notebook:       notebook,
		UndoOperations: []*Operation{{Action: "delete", ID: rootID}},
		trees:          map[string]*parse.Tree{rootID: nil},
		fromAPI:        true,
	}
	log.Record(tx)
	entry := log.Peek(notebook, rootID)
	if entry == nil {
		t.Fatal("committed API transaction was not recorded in undo history")
	}
	if entry.Notebook() != notebook {
		t.Fatalf("undo notebook = %q, want %q", entry.Notebook(), notebook)
	}
}

func TestEncryptedTransactionRejectsAttributeViewActionsBeforeDispatch(t *testing.T) {
	const notebook = "20260716000000-avreject"
	originalDataDir := util.DataDir
	originalConf := Conf
	util.DataDir = t.TempDir()
	Conf = NewAppConf()
	t.Cleanup(func() {
		Conf = originalConf
		util.DataDir = originalDataDir
	})
	boxConf := conf.NewBoxConf()
	boxConf.Encrypted = true
	if err := os.MkdirAll(filepath.Join(util.DataDir, notebook), 0755); err != nil {
		t.Fatalf("create encrypted notebook fixture: %v", err)
	}
	if err := (&Box{ID: notebook}).SaveConf(boxConf); err != nil {
		t.Fatalf("save encrypted notebook fixture: %v", err)
	}
	for _, action := range []string{
		"setAttrViewName",
		"insertAttrViewBlock",
		"updateAttrViewCell",
		"updateAttrViewColRelation",
		"changeAttrViewLayout",
		"syncAttrViewTableColWidth",
	} {
		t.Run(action, func(t *testing.T) {
			err := PerformTxSync(&Transaction{
				Notebook:     notebook,
				DoOperations: []*Operation{{Action: action}},
			})
			if err == nil {
				t.Fatal("encrypted attribute view transaction was accepted")
			}
			txErr, ok := err.(*TxErr)
			if !ok || txErr.Code() != TxErrCodePushMsg {
				t.Fatalf("error = %T %v, want a transaction contract error", err, err)
			}
			if !strings.Contains(err.Error(), notebook) || !strings.Contains(err.Error(), action) {
				t.Fatalf("error %q does not identify notebook %q and action %q", err, notebook, action)
			}
		})
	}
}

func TestAttributeViewRelationRefreshPersistsBeforeTransactionWorkReturns(t *testing.T) {
	const avID = "20260716000000-avsyncx"
	originalDataDir := util.DataDir
	util.DataDir = t.TempDir()
	t.Cleanup(func() {
		cache.RemoveAVDataInBox(avID, "")
		util.DataDir = originalDataDir
	})

	attrView := &av.AttributeView{
		Spec:              av.CurrentSpec,
		ID:                avID,
		ViewID:            "20260716000002-avsyncx",
		Views:             []*av.View{{ID: "20260716000002-avsyncx", PageSize: av.ViewDefaultPageSize}},
		RenderedViewables: map[string]av.Viewable{},
	}
	if err := av.SaveAttributeView(attrView); err != nil {
		t.Fatalf("save attribute view fixture: %v", err)
	}
	attrView.Views[0].PageSize = 0
	data, err := json.Marshal(attrView)
	if err != nil {
		t.Fatalf("marshal unnormalized attribute view fixture: %v", err)
	}
	avPath, _ := av.FindAttributeViewPath(avID)
	if err = os.WriteFile(avPath, data, 0644); err != nil {
		t.Fatalf("write unnormalized attribute view fixture: %v", err)
	}
	cache.RemoveAVDataInBox(avID, "")

	node := &ast.Node{Type: ast.NodeParagraph, ID: "20260716000001-avsyncx"}
	node.SetIALAttr(av.NodeAttrNameAvs, avID)
	if err = upsertAvBlockRel(node, &Transaction{}); err != nil {
		t.Fatalf("refresh attribute view relation: %v", err)
	}

	cache.RemoveAVDataInBox(avID, "")
	persisted, err := av.ParseAttributeView(avID)
	if err != nil {
		t.Fatalf("parse refreshed attribute view: %v", err)
	}
	if persisted.Views[0].PageSize != av.ViewDefaultPageSize {
		t.Fatalf("attribute view page size = %d, want normalized value %d before transaction work returns", persisted.Views[0].PageSize, av.ViewDefaultPageSize)
	}
}

func TestTransactionAdmissionDrainWaitsAndBlocksNewWork(t *testing.T) {
	const notebook = "20260716000000-drainxx"
	admission := newTransactionAdmission()
	initialTurn := admission.admit(notebook, nil)

	drain := admission.close(notebook)
	waitDone := make(chan struct{})
	newAdmissionDone := make(chan struct{})
	newAdmissionBlocked := make(chan struct{})
	releaseBlockedCallback := make(chan struct{})
	completionDone := make(chan struct{})
	var newTurn *transactionTurn
	var completeInitialOnce, completeNewAdmissionOnce, releaseBlockedOnce, releaseDrainOnce sync.Once
	completeInitial := func() { completeInitialOnce.Do(initialTurn.complete) }
	completeNewAdmission := func() {
		completeNewAdmissionOnce.Do(func() { newTurn.complete() })
	}
	releaseBlocked := func() { releaseBlockedOnce.Do(func() { close(releaseBlockedCallback) }) }
	releaseDrain := func() { releaseDrainOnce.Do(drain.release) }
	waitLaunched := false
	newAdmissionLaunched := false
	completionLaunched := false
	t.Cleanup(func() {
		releaseBlocked()
		completeInitial()
		releaseDrain()
		if completionLaunched {
			<-completionDone
		}
		if waitLaunched {
			<-waitDone
		}
		if newAdmissionLaunched {
			<-newAdmissionDone
			completeNewAdmission()
		}
	})

	admission.mu.Lock()
	pendingBeforeDrain := admission.pending[notebook]
	totalBeforeDrain := admission.total
	admission.mu.Unlock()
	if pendingBeforeDrain != 1 || totalBeforeDrain != 1 {
		t.Fatalf("pending transactions = %d total=%d, want one accepted transaction", pendingBeforeDrain, totalBeforeDrain)
	}

	waitLaunched = true
	go func() {
		drain.wait()
		close(waitDone)
	}()

	newAdmissionLaunched = true
	go func() {
		newTurn = admission.admit(notebook, func() {
			close(newAdmissionBlocked)
			<-releaseBlockedCallback
		})
		close(newAdmissionDone)
	}()
	select {
	case <-newAdmissionBlocked:
	case <-time.After(time.Second):
		t.Fatal("new transaction admission did not observe the closed gate")
	}
	admission.mu.Lock()
	closedWhileBlocked := admission.closed
	pendingWhileBlocked := admission.pending[notebook]
	totalWhileBlocked := admission.total
	admission.mu.Unlock()
	if !closedWhileBlocked || pendingWhileBlocked != 1 || totalWhileBlocked != 1 {
		t.Fatalf("blocked admission changed gate state: closed=%t pending=%d total=%d", closedWhileBlocked, pendingWhileBlocked, totalWhileBlocked)
	}

	completionLaunched = true
	go func() {
		completeInitial()
		close(completionDone)
	}()
	select {
	case <-completionDone:
	case <-time.After(time.Second):
		t.Fatal("blocked admission callback prevented an accepted transaction from completing")
	}
	select {
	case <-waitDone:
	case <-time.After(time.Second):
		t.Fatal("drain did not observe accepted transaction completion")
	}
	admission.mu.Lock()
	pendingAfterDrain := admission.pending[notebook]
	totalAfterDrain := admission.total
	closedAfterDrain := admission.closed
	admission.mu.Unlock()
	if pendingAfterDrain != 0 || totalAfterDrain != 0 {
		t.Fatalf("pending transactions after drain wait = %d total=%d, want none", pendingAfterDrain, totalAfterDrain)
	}
	if !closedAfterDrain {
		t.Fatal("transaction admission reopened before drain release")
	}

	releaseBlocked()
	releaseDrain()
	select {
	case <-newAdmissionDone:
	case <-time.After(time.Second):
		t.Fatal("transaction admission did not reopen after drain release")
	}
	admission.mu.Lock()
	pendingAfterReopen := admission.pending[notebook]
	totalAfterReopen := admission.total
	admission.mu.Unlock()
	if pendingAfterReopen != 1 || totalAfterReopen != 1 {
		t.Fatalf("pending transactions after reopening = %d total=%d, want newly admitted transaction", pendingAfterReopen, totalAfterReopen)
	}
	completeNewAdmission()
}

func TestEarlierAsyncTransactionAdmissionCannotBeOvertakenByUndoReplay(t *testing.T) {
	fixture := setupDerivedContentStoreFixture(t)
	previousUndoLog := GlobalUndoLog
	GlobalUndoLog = newUndoLog(64)
	t.Cleanup(func() { GlobalUndoLog = previousUndoLog })

	seed := &Transaction{
		Notebook: fixture.boxA,
		DoOperations: []*Operation{{
			Action: "setAttrs", ID: fixture.defID, Data: `{"title":"Edited"}`,
		}},
		UndoOperations: []*Operation{{
			Action: "setAttrs", ID: fixture.defID, Data: `{"title":"Definition A"}`,
		}},
		fromAPI: true,
	}
	if err := PerformTxSync(seed); err != nil {
		t.Fatalf("seed undo history: %v", err)
	}

	ordinary := &Transaction{
		Notebook: fixture.boxA,
		DoOperations: []*Operation{{
			Action: "setAttrs", ID: fixture.defID, Data: `{"title":"Concurrent"}`,
		}},
		UndoOperations: []*Operation{{
			Action: "setAttrs", ID: fixture.defID, Data: `{"title":"Edited"}`,
		}},
		fromAPI: true,
	}
	ordinaryAdmitted := make(chan struct{})
	replayAdmitted := make(chan struct{})
	releaseOrdinary := make(chan struct{})
	ordinaryDone := make(chan error, 1)
	replayDone := make(chan struct {
		result *UndoReplayResult
		err    error
	}, 1)
	ordinaryExited := make(chan struct{})
	replayExited := make(chan struct{})
	replayLaunched := false
	var ordinaryAdmittedOnce, replayAdmittedOnce, releaseOnce sync.Once
	previousAdmissionHook := transactionAfterAdmissionHook
	transactionAfterAdmissionHook = func(tx *Transaction) {
		switch {
		case tx == ordinary:
			ordinaryAdmittedOnce.Do(func() { close(ordinaryAdmitted) })
			<-releaseOrdinary
		case tx != nil && tx.isReplay:
			replayAdmittedOnce.Do(func() { close(replayAdmitted) })
		}
	}
	t.Cleanup(func() {
		releaseOnce.Do(func() { close(releaseOrdinary) })
		<-ordinaryExited
		if replayLaunched {
			<-replayExited
		}
		transactionAfterAdmissionHook = previousAdmissionHook
	})

	go func() {
		defer close(ordinaryExited)
		transactions := []*Transaction{ordinary}
		PerformTransactions(&transactions)
		ordinaryDone <- ordinary.WaitForCommit()
	}()
	waitTransactionSignal(t, ordinaryAdmitted, "ordinary transaction was not admitted")

	replayLaunched = true
	go func() {
		defer close(replayExited)
		result, err := PerformUndoSync(fixture.boxA, fixture.defID)
		replayDone <- struct {
			result *UndoReplayResult
			err    error
		}{result: result, err: err}
	}()
	waitTransactionSignal(t, replayAdmitted, "undo replay was not admitted behind the ordinary transaction")
	select {
	case <-ordinaryDone:
		t.Fatal("ordinary transaction completed while its admission hook was blocked")
	default:
	}
	select {
	case replay := <-replayDone:
		t.Fatalf("undo replay crossed the earlier ordinary admission: result=%#v err=%v", replay.result, replay.err)
	default:
	}

	releaseOnce.Do(func() { close(releaseOrdinary) })
	if err := waitTransactionError(t, ordinaryDone, "ordinary transaction did not complete after admission turn release"); err != nil {
		t.Fatalf("ordinary transaction failed: %v", err)
	}
	var replay struct {
		result *UndoReplayResult
		err    error
	}
	select {
	case replay = <-replayDone:
	case <-time.After(5 * time.Second):
		t.Fatal("undo replay did not complete after the earlier ordinary transaction")
	}
	if replay.err != nil || replay.result == nil || replay.result.Transaction == nil {
		t.Fatalf("undo replay result = %#v, %v", replay.result, replay.err)
	}

	loaded, err := loadTreeByBlockIDInBox(fixture.defID, fixture.boxA)
	if err != nil {
		t.Fatalf("load tree after ordered transaction/replay: %v", err)
	}
	if title := loaded.Root.IALAttr("title"); title != "Edited" {
		t.Fatalf("title after ordered transaction/replay = %q, want Edited", title)
	}
}

func TestUndoRedoReplaySerializesStackTransitionWithOrdinaryTransaction(t *testing.T) {
	for _, test := range []struct {
		name            string
		undo            bool
		replayTitle     string
		normalUndoTitle string
	}{
		{name: "undo", undo: true, replayTitle: "Definition A", normalUndoTitle: "Definition A"},
		{name: "redo", replayTitle: "Edited", normalUndoTitle: "Edited"},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := setupDerivedContentStoreFixture(t)
			previousUndoLog := GlobalUndoLog
			GlobalUndoLog = newUndoLog(64)

			seed := &Transaction{
				Notebook: fixture.boxA,
				DoOperations: []*Operation{{
					Action: "setAttrs", ID: fixture.defID, Data: `{"title":"Edited"}`,
				}},
				UndoOperations: []*Operation{{
					Action: "setAttrs", ID: fixture.defID, Data: `{"title":"Definition A"}`,
				}},
				fromAPI: true,
			}
			if err := PerformTxSync(seed); err != nil {
				t.Fatalf("seed undo history: %v", err)
			}
			if !test.undo {
				if _, err := PerformUndoSync(fixture.boxA, fixture.defID); err != nil {
					t.Fatalf("prepare redo stack: %v", err)
				}
			}

			previousCommitHook := contentCommitBeforeEnqueueHook
			previousAdmissionHook := transactionAfterAdmissionHook
			replayAtCommit := make(chan struct{})
			releaseReplay := make(chan struct{})
			normalAdmitted := make(chan struct{})
			var replayAtCommitOnce, normalAdmittedOnce, releaseReplayOnce sync.Once
			contentCommitBeforeEnqueueHook = func(tree *parse.Tree) {
				if tree.Box == fixture.boxA && tree.ID == fixture.defID && tree.Root.IALAttr("title") == test.replayTitle {
					replayAtCommitOnce.Do(func() { close(replayAtCommit) })
					<-releaseReplay
				}
			}

			normalTx := &Transaction{
				Notebook: fixture.boxA,
				DoOperations: []*Operation{{
					Action: "setAttrs", ID: fixture.defID, Data: `{"title":"Concurrent"}`,
				}},
				UndoOperations: []*Operation{{
					Action: "setAttrs", ID: fixture.defID, Data: `{"title":"` + test.normalUndoTitle + `"}`,
				}},
				fromAPI: true,
			}
			transactionAfterAdmissionHook = func(tx *Transaction) {
				if tx == normalTx {
					normalAdmittedOnce.Do(func() { close(normalAdmitted) })
				}
			}

			type replayResponse struct {
				result *UndoReplayResult
				err    error
			}
			replayDone := make(chan replayResponse, 1)
			replayExited := make(chan struct{})
			normalDone := make(chan error, 1)
			normalExited := make(chan struct{})
			normalLaunched := false
			release := func() { releaseReplayOnce.Do(func() { close(releaseReplay) }) }
			t.Cleanup(func() {
				release()
				<-replayExited
				if normalLaunched {
					<-normalExited
				}
				contentCommitBeforeEnqueueHook = previousCommitHook
				transactionAfterAdmissionHook = previousAdmissionHook
				GlobalUndoLog = previousUndoLog
			})

			go func() {
				defer close(replayExited)
				var result *UndoReplayResult
				var err error
				if test.undo {
					result, err = PerformUndoSync(fixture.boxA, fixture.defID)
				} else {
					result, err = PerformRedoSync(fixture.boxA, fixture.defID)
				}
				replayDone <- replayResponse{result: result, err: err}
			}()
			waitTransactionSignal(t, replayAtCommit, test.name+" replay did not reach the durable commit boundary")

			normalLaunched = true
			go func() {
				defer close(normalExited)
				normalDone <- PerformTxSync(normalTx)
			}()
			waitTransactionSignal(t, normalAdmitted, "ordinary transaction was not admitted behind replay")
			select {
			case err := <-normalDone:
				t.Fatalf("ordinary transaction crossed the %s replay boundary: %v", test.name, err)
			default:
			}

			release()
			replayed := <-replayDone
			if replayed.err != nil || replayed.result == nil || replayed.result.Transaction == nil {
				t.Fatalf("%s replay result = %#v, %v", test.name, replayed.result, replayed.err)
			}
			if err := <-normalDone; err != nil {
				t.Fatalf("ordinary transaction after %s: %v", test.name, err)
			}

			loaded, err := loadTreeByBlockIDInBox(fixture.defID, fixture.boxA)
			if err != nil {
				t.Fatalf("load tree after serialized %s: %v", test.name, err)
			}
			if title := loaded.Root.IALAttr("title"); title != "Concurrent" {
				t.Fatalf("title after serialized %s = %q, want Concurrent", test.name, title)
			}
			if canUndo, canRedo, _ := GlobalUndoLog.State(fixture.boxA, fixture.defID); !canUndo || canRedo {
				t.Fatalf("state after serialized %s = undo:%t redo:%t, want undo only", test.name, canUndo, canRedo)
			}
		})
	}
}

func TestUndoRedoReplayFailureRestoresSelectedStack(t *testing.T) {
	const rootID = "20990717180000-replayx"
	for _, test := range []struct {
		name     string
		undo     bool
		doOps    []*Operation
		undoOps  []*Operation
		wantUndo bool
		wantRedo bool
	}{
		{
			name: "undo", undo: true,
			doOps:    []*Operation{{Action: "noop"}},
			undoOps:  []*Operation{{Action: "create", Data: "not a tree"}},
			wantUndo: true,
		},
		{
			name:     "redo",
			doOps:    []*Operation{{Action: "create", Data: "not a tree"}},
			undoOps:  []*Operation{{Action: "noop"}},
			wantRedo: true,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			previousUndoLog := GlobalUndoLog
			GlobalUndoLog = newUndoLog(8)
			t.Cleanup(func() { GlobalUndoLog = previousUndoLog })
			GlobalUndoLog.Record(&Transaction{
				DoOperations:   test.doOps,
				UndoOperations: test.undoOps,
				trees:          map[string]*parse.Tree{rootID: nil},
				fromAPI:        true,
			})
			if !test.undo {
				if _, err := PerformUndoSync("", rootID); err != nil {
					t.Fatalf("prepare redo stack: %v", err)
				}
			}

			var err error
			if test.undo {
				_, err = PerformUndoSync("", rootID)
			} else {
				_, err = PerformRedoSync("", rootID)
			}
			if err == nil {
				t.Fatalf("%s replay unexpectedly succeeded", test.name)
			}
			canUndo, canRedo, _ := GlobalUndoLog.State("", rootID)
			if canUndo != test.wantUndo || canRedo != test.wantRedo {
				t.Fatalf("state after failed %s = undo:%t redo:%t, want undo:%t redo:%t", test.name, canUndo, canRedo, test.wantUndo, test.wantRedo)
			}
		})
	}
}

func TestTransactionPanicReturnsError(t *testing.T) {
	err := PerformTxSync(&Transaction{
		DoOperations: []*Operation{{Action: "create", Data: "not a tree"}},
	})
	if err == nil || !strings.Contains(err.Error(), "transaction panic") {
		t.Fatalf("transaction panic error = %v, want an explicit failure", err)
	}
}

func TestTransactionPostCommitPanicKeepsDurableCommit(t *testing.T) {
	setupDerivedContentStoreFixture(t)
	const rootID = "20990717009999-postcmt"
	tree := treenode.NewTree("", "/"+rootID+".sy", "/Post Commit", "Post Commit")
	queuePath := filepath.Join(util.QueueDir, "index.queue")
	beforeQueue, err := readOptionalTransactionFile(queuePath)
	if err != nil {
		t.Fatalf("read durable queue before transaction: %v", err)
	}
	Conf.Sync = nil

	err = PerformTxSync(&Transaction{
		DoOperations: []*Operation{{Action: "create", Data: tree}},
	})
	if err != nil {
		t.Fatalf("durably committed transaction returned a post-commit error: %v", err)
	}
	filePath := filepath.Join(util.DataDir, strings.TrimPrefix(tree.Path, "/"))
	if _, statErr := os.Stat(filePath); statErr != nil {
		t.Fatalf("durably committed tree file is missing: %v", statErr)
	}
	if blockTree := treenode.GetBlockTreeInBox(rootID, ""); blockTree == nil {
		t.Fatal("durably committed blocktree is missing")
	}
	afterQueue, err := readOptionalTransactionFile(queuePath)
	if err != nil {
		t.Fatalf("read durable queue after transaction: %v", err)
	}
	if bytes.Equal(afterQueue, beforeQueue) || !bytes.Contains(afterQueue, []byte(rootID)) {
		t.Fatalf("durably committed queue entry is missing: before=%q after=%q", beforeQueue, afterQueue)
	}
}

func TestTransactionSecondTreeWriteFailureRestoresEarlierFiles(t *testing.T) {
	fixture := setupDerivedContentStoreFixture(t)
	first := treenode.NewTree(fixture.boxA, "/20990717010000-txfirst.sy", "/First", "First")
	second := treenode.NewTree(fixture.boxA, first.Path+"/20990717010001-txsecon.sy", "/First/Second", "Second")

	err := PerformTxSync(&Transaction{
		Notebook: fixture.boxA,
		DoOperations: []*Operation{
			{Action: "create", Data: first},
			{Action: "create", Data: second},
		},
	})
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "not a directory") {
		t.Fatalf("transaction error = %v, want a real second-tree ENOTDIR failure", err)
	}
	for _, tree := range []*parse.Tree{first, second} {
		filePath := filepath.Join(util.DataDir, tree.Box, strings.TrimPrefix(tree.Path, "/"))
		if _, statErr := os.Stat(filePath); !os.IsNotExist(statErr) {
			t.Fatalf("rejected transaction file [%s] remains: %v", tree.ID, statErr)
		}
		if blockTree := treenode.GetBlockTreeInBox(tree.ID, tree.Box); blockTree != nil {
			t.Fatalf("rejected transaction blocktree [%s] remains", tree.ID)
		}
	}
}

func TestTransactionQueuePublicationFailureRestoresFilesAndBlocktrees(t *testing.T) {
	fixture := setupDerivedContentStoreFixture(t)
	tree := treenode.NewTree(fixture.boxA, "/20990717010002-txqueue.sy", "/Queue", "Queue")
	queuePath := filepath.Join(util.QueueDir, "index.queue")
	beforeQueue, readErr := os.ReadFile(queuePath)
	if readErr != nil && !os.IsNotExist(readErr) {
		t.Fatalf("read durable queue before transaction: %v", readErr)
	}
	restoreQueueDir := blockTransactionDurableQueue(t)

	err := PerformTxSync(&Transaction{
		Notebook:     fixture.boxA,
		DoOperations: []*Operation{{Action: "create", Data: tree}},
	})
	restoreQueueDir()
	if !isTransactionDurableQueueFailure(err) {
		t.Fatalf("transaction error = %v, want a real durable queue ENOTDIR failure", err)
	}
	filePath := filepath.Join(util.DataDir, tree.Box, strings.TrimPrefix(tree.Path, "/"))
	if _, statErr := os.Stat(filePath); !os.IsNotExist(statErr) {
		t.Fatalf("rejected transaction file remains: %v", statErr)
	}
	if blockTree := treenode.GetBlockTreeInBox(tree.ID, tree.Box); blockTree != nil {
		t.Fatal("rejected transaction blocktree remains")
	}
	queueData, readErr := os.ReadFile(queuePath)
	if readErr != nil && !os.IsNotExist(readErr) {
		t.Fatalf("read durable queue after rejected transaction: %v", readErr)
	}
	if !bytes.Equal(queueData, beforeQueue) {
		t.Fatalf("rejected transaction changed durable queue data: before=%q after=%q", beforeQueue, queueData)
	}
}

func TestEncryptedPerformTxSyncCommitsOnlyDeclaredStore(t *testing.T) {
	fixture := setupDerivedContentStoreFixture(t)
	for _, tree := range fixture.defTrees {
		if err := kernelsql.UpsertTreeQueue(tree); err != nil {
			t.Fatalf("queue encrypted transaction fixture [%s]: %v", tree.Box, err)
		}
	}
	if err := kernelsql.FlushQueue(); err != nil {
		t.Fatalf("flush encrypted transaction fixtures: %v", err)
	}
	targetTree := fixture.defTrees[fixture.boxA]
	otherTree := fixture.defTrees[fixture.boxB]
	otherPath := transactionTreeFilePath(otherTree)
	otherBefore, err := os.ReadFile(otherPath)
	if err != nil {
		t.Fatalf("read colliding other-store tree before transaction: %v", err)
	}
	otherSQLBefore := kernelsql.GetBlockInBox(fixture.defID, fixture.boxB)

	err = PerformTxSync(&Transaction{
		Notebook: fixture.boxA,
		DoOperations: []*Operation{{
			Action: "setAttrs",
			ID:     fixture.defID,
			Data:   `{"title":"Updated Target"}`,
		}},
	})
	if err != nil {
		t.Fatalf("perform encrypted transaction: %v", err)
	}
	targetAfter, err := filesys.LoadTree(fixture.boxA, targetTree.Path, util.NewLute())
	if err != nil {
		t.Fatalf("load committed target tree: %v", err)
	}
	if targetAfter.Root.IALAttr("title") != "Updated Target" {
		t.Fatalf("target title = %q, want Updated Target", targetAfter.Root.IALAttr("title"))
	}
	otherAfter, err := os.ReadFile(otherPath)
	if err != nil {
		t.Fatalf("read colliding other-store tree after transaction: %v", err)
	}
	if !bytes.Equal(otherAfter, otherBefore) {
		t.Fatal("encrypted transaction rewrote the colliding tree in another notebook")
	}
	queueData, err := readOptionalTransactionFile(filepath.Join(util.QueueDir, "index.queue"))
	if err != nil {
		t.Fatalf("read encrypted transaction durable queue: %v", err)
	}
	if !bytes.Contains(queueData, []byte(`"box":"`+fixture.boxA+`"`)) || bytes.Contains(queueData, []byte(`"box":"`+fixture.boxB+`"`)) {
		t.Fatalf("encrypted transaction queue crossed stores: %s", queueData)
	}
	if err = kernelsql.FlushQueue(); err != nil {
		t.Fatalf("flush committed encrypted transaction: %v", err)
	}
	targetSQL := kernelsql.GetBlockInBox(fixture.defID, fixture.boxA)
	if targetSQL == nil || targetSQL.Box != fixture.boxA || !strings.Contains(targetSQL.IAL, "Updated Target") {
		t.Fatalf("target SQL row after encrypted transaction = %#v", targetSQL)
	}
	if !reflect.DeepEqual(kernelsql.GetBlockInBox(fixture.defID, fixture.boxB), otherSQLBefore) {
		t.Fatal("encrypted transaction changed the colliding SQL row in another notebook")
	}
}

func TestLockBoxWaitsForAcceptedPerformTxSyncDurableCommit(t *testing.T) {
	fixture := setupDerivedContentStoreFixture(t)
	const rootID = "20990717010400-txdrain"
	tree := treenode.NewTree(fixture.boxA, "/"+rootID+".sy", "/Transaction Drain", "Transaction Drain")

	previousBeforeHook := contentCommitBeforeEnqueueHook
	previousAfterHook := contentCommitAfterEnqueueHook
	previousAdmissionHook := lockBoxAfterTransactionAdmissionCloseHook
	previousDrainHook := lockBoxAfterSQLDrainHook
	beforeEnqueue := make(chan struct{})
	allowEnqueue := make(chan struct{})
	enqueueDurable := make(chan struct{})
	allowTransactionReturn := make(chan struct{})
	lockAdmissionClosed := make(chan struct{})
	drainAcquired := make(chan struct{})
	transactionExited := make(chan struct{})
	lockExited := make(chan struct{})
	lockLaunched := false
	var beforeOnce, afterOnce, admissionOnce, drainOnce, allowEnqueueOnce, allowReturnOnce sync.Once
	releaseEnqueue := func() { allowEnqueueOnce.Do(func() { close(allowEnqueue) }) }
	releaseTransactionReturn := func() { allowReturnOnce.Do(func() { close(allowTransactionReturn) }) }
	contentCommitBeforeEnqueueHook = func(candidate *parse.Tree) {
		if candidate.Box == fixture.boxA && candidate.ID == rootID {
			beforeOnce.Do(func() { close(beforeEnqueue) })
			<-allowEnqueue
		}
	}
	contentCommitAfterEnqueueHook = func(candidate *parse.Tree) {
		if candidate.Box == fixture.boxA && candidate.ID == rootID {
			afterOnce.Do(func() { close(enqueueDurable) })
			<-allowTransactionReturn
		}
	}
	lockBoxAfterTransactionAdmissionCloseHook = func(candidateBoxID string) {
		if candidateBoxID == fixture.boxA {
			admissionOnce.Do(func() { close(lockAdmissionClosed) })
		}
	}
	lockBoxAfterSQLDrainHook = func(candidateBoxID string) {
		if candidateBoxID == fixture.boxA {
			drainOnce.Do(func() { close(drainAcquired) })
		}
	}
	t.Cleanup(func() {
		releaseEnqueue()
		releaseTransactionReturn()
		<-transactionExited
		if lockLaunched {
			<-lockExited
		}
		contentCommitBeforeEnqueueHook = previousBeforeHook
		contentCommitAfterEnqueueHook = previousAfterHook
		lockBoxAfterTransactionAdmissionCloseHook = previousAdmissionHook
		lockBoxAfterSQLDrainHook = previousDrainHook
	})

	transactionDone := make(chan error, 1)
	go func() {
		defer close(transactionExited)
		transactionDone <- PerformTxSync(&Transaction{
			Notebook:     fixture.boxA,
			DoOperations: []*Operation{{Action: "create", Data: tree}},
		})
	}()
	waitTransactionSignal(t, beforeEnqueue, "encrypted transaction did not reach durable enqueue")

	lockDone := make(chan error, 1)
	lockLaunched = true
	go func() {
		defer close(lockExited)
		lockDone <- LockBox(fixture.boxA)
	}()
	waitTransactionSignal(t, lockAdmissionClosed, "LockBox did not close transaction admission")
	select {
	case err := <-lockDone:
		t.Fatalf("LockBox completed while the accepted transaction was before enqueue: %v", err)
	default:
	}

	releaseEnqueue()
	waitTransactionSignal(t, enqueueDurable, "encrypted transaction did not publish its durable queue entry")
	select {
	case err := <-lockDone:
		t.Fatalf("LockBox completed before the accepted transaction released its commit token: %v", err)
	default:
	}
	releaseTransactionReturn()
	if err := waitTransactionError(t, transactionDone, "accepted encrypted transaction did not complete"); err != nil {
		t.Fatalf("accepted encrypted transaction failed: %v", err)
	}
	waitTransactionSignal(t, drainAcquired, "LockBox did not acquire SQL drain after transaction completion")
	if err := waitTransactionError(t, lockDone, "LockBox did not complete after accepted transaction"); err != nil {
		t.Fatalf("LockBox after accepted encrypted transaction: %v", err)
	}
	if IsBoxUnlocked(fixture.boxA) {
		t.Fatal("encrypted notebook remained unlocked after drained LockBox")
	}
}

func TestTransactionInsertQueueFailureRestoresAttributeViewState(t *testing.T) {
	setupDerivedContentStoreFixture(t)
	const (
		avID             = "20990717010100-avstate"
		insertedBlockID  = "20990717010101-avinsrt"
		existingMirrorID = "20990717010102-avbase1"
		rootID           = "20990717010103-avrootx"
	)
	attrView := av.NewAttributeView(avID)
	if err := av.SaveAttributeView(attrView); err != nil {
		t.Fatalf("save attribute view fixture: %v", err)
	}
	if _, err := av.UpsertBlockRel(avID, existingMirrorID); err != nil {
		t.Fatalf("seed attribute view mirror: %v", err)
	}
	attrView.Views[0].PageSize = 0
	unnormalizedAV, err := json.Marshal(attrView)
	if err != nil {
		t.Fatalf("marshal unnormalized attribute view fixture: %v", err)
	}

	avPath, _ := av.FindAttributeViewPathInBox(avID, "")
	if err = os.WriteFile(avPath, unnormalizedAV, 0644); err != nil {
		t.Fatalf("write unnormalized attribute view fixture: %v", err)
	}
	cache.RemoveAVDataInBox(avID, "")
	beforeAV, err := os.ReadFile(avPath)
	if err != nil {
		t.Fatalf("read attribute view before transaction: %v", err)
	}
	beforeMirror, err := av.GetBlockRelsInBoxStrict("")
	if err != nil {
		t.Fatalf("read attribute view mirror before transaction: %v", err)
	}
	tree := writeDerivedDefinitionTree(t, "", rootID, "Transaction AV Insert")
	treePath := filepath.Join(util.DataDir, tree.Box, strings.TrimPrefix(tree.Path, "/"))
	beforeTree, err := os.ReadFile(treePath)
	if err != nil {
		t.Fatalf("read tree before transaction: %v", err)
	}
	queuePath := filepath.Join(util.QueueDir, "index.queue")
	beforeQueue, err := readOptionalTransactionFile(queuePath)
	if err != nil {
		t.Fatalf("read durable queue before transaction: %v", err)
	}

	restoreQueueDir := blockTransactionDurableQueue(t)
	insertDOM := `<div class="av" data-node-id="` + insertedBlockID + `" data-av-id="` + avID + `" data-type="NodeAttributeView" data-av-type="table"></div>`
	err = PerformTxSync(&Transaction{
		DoOperations: []*Operation{{
			Action:   "insert",
			ParentID: tree.ID,
			Data:     insertDOM,
		}},
	})
	restoreQueueDir()
	if !isTransactionDurableQueueFailure(err) {
		t.Fatalf("transaction error = %v, want a real durable queue ENOTDIR failure", err)
	}

	afterTree, readErr := os.ReadFile(treePath)
	if readErr != nil {
		t.Fatalf("read tree after rejected transaction: %v", readErr)
	}
	if !bytes.Equal(afterTree, beforeTree) {
		t.Fatal("rejected attribute view insert changed the tree file")
	}
	if blockTree := treenode.GetBlockTreeInBox(insertedBlockID, ""); blockTree != nil {
		t.Fatalf("rejected attribute view insert left a blocktree: %#v", blockTree)
	}
	afterAV, readErr := os.ReadFile(avPath)
	if readErr != nil {
		t.Fatalf("read attribute view after rejected transaction: %v", readErr)
	}
	if !bytes.Equal(afterAV, beforeAV) {
		t.Fatal("rejected attribute view insert changed the definition bytes")
	}
	afterMirror, mirrorErr := av.GetBlockRelsInBoxStrict("")
	if mirrorErr != nil {
		t.Fatalf("read attribute view mirror after rejected transaction: %v", mirrorErr)
	}
	if !reflect.DeepEqual(afterMirror, beforeMirror) {
		t.Fatalf("rejected attribute view insert changed mirror state: before=%#v after=%#v", beforeMirror, afterMirror)
	}
	afterQueue, readErr := readOptionalTransactionFile(queuePath)
	if readErr != nil {
		t.Fatalf("read durable queue after rejected transaction: %v", readErr)
	}
	if !bytes.Equal(afterQueue, beforeQueue) {
		t.Fatalf("rejected attribute view insert changed durable queue data: before=%q after=%q", beforeQueue, afterQueue)
	}
}

func TestTransactionDeleteQueueFailureRestoresAttributeViewState(t *testing.T) {
	setupDerivedContentStoreFixture(t)
	const (
		avID         = "20990717010200-avstate"
		boundBlockID = "20990717010201-avbound"
		firstAVID    = "20990717010202-avnode1"
		secondAVID   = "20990717010203-avnode2"
		rootID       = "20990717010205-avrootx"
	)
	attrView := av.NewAttributeView(avID)
	blockValues := attrView.GetBlockKeyValues()
	blockValues.Values = []*av.Value{{
		ID:      "20990717010204-avvalue",
		KeyID:   blockValues.Key.ID,
		BlockID: boundBlockID,
		Type:    av.KeyTypeBlock,
		Block:   &av.ValueBlock{ID: boundBlockID, Content: "Bound block"},
	}}
	if err := av.SaveAttributeView(attrView); err != nil {
		t.Fatalf("save attribute view fixture: %v", err)
	}

	tree := writeDerivedDefinitionTree(t, "", rootID, "Transaction AV Delete")
	container := &ast.Node{Type: ast.NodeBlockquote, ID: boundBlockID, Box: tree.Box, Path: tree.Path}
	container.SetIALAttr("id", boundBlockID)
	container.SetIALAttr("updated", util.TimeFromID(boundBlockID))
	container.SetIALAttr(av.NodeAttrNameAvs, avID)
	firstAV := newTransactionAttributeViewNode(firstAVID, avID, tree)
	secondAV := newTransactionAttributeViewNode(secondAVID, avID, tree)
	container.AppendChild(firstAV)
	tree.Root.AppendChild(container)
	tree.Root.AppendChild(secondAV)
	if _, err := filesys.WriteTree(tree); err != nil {
		t.Fatalf("write attribute view tree fixture: %v", err)
	}
	if err := treenode.UpsertBlockTree(tree); err != nil {
		t.Fatalf("index attribute view tree fixture: %v", err)
	}
	if err := av.BatchUpsertBlockRel([]*ast.Node{firstAV, secondAV}); err != nil {
		t.Fatalf("seed attribute view mirror: %v", err)
	}

	avPath, _ := av.FindAttributeViewPathInBox(avID, "")
	beforeAV, err := os.ReadFile(avPath)
	if err != nil {
		t.Fatalf("read attribute view before transaction: %v", err)
	}
	beforeMirror, err := av.GetBlockRelsInBoxStrict("")
	if err != nil {
		t.Fatalf("read attribute view mirror before transaction: %v", err)
	}
	treePath := filepath.Join(util.DataDir, tree.Box, strings.TrimPrefix(tree.Path, "/"))
	beforeTree, err := os.ReadFile(treePath)
	if err != nil {
		t.Fatalf("read tree before transaction: %v", err)
	}
	queuePath := filepath.Join(util.QueueDir, "index.queue")
	beforeQueue, err := readOptionalTransactionFile(queuePath)
	if err != nil {
		t.Fatalf("read durable queue before transaction: %v", err)
	}

	restoreQueueDir := blockTransactionDurableQueue(t)
	err = PerformTxSync(&Transaction{
		DoOperations: []*Operation{{Action: "delete", ID: boundBlockID}},
	})
	restoreQueueDir()
	if !isTransactionDurableQueueFailure(err) {
		t.Fatalf("transaction error = %v, want a real durable queue ENOTDIR failure", err)
	}

	afterTree, readErr := os.ReadFile(treePath)
	if readErr != nil {
		t.Fatalf("read tree after rejected transaction: %v", readErr)
	}
	if !bytes.Equal(afterTree, beforeTree) {
		t.Fatal("rejected attribute view delete changed the tree file")
	}
	for _, blockID := range []string{boundBlockID, firstAVID, secondAVID} {
		if blockTree := treenode.GetBlockTreeInBox(blockID, ""); blockTree == nil {
			t.Fatalf("rejected attribute view delete removed blocktree [%s]", blockID)
		}
	}
	afterAV, readErr := os.ReadFile(avPath)
	if readErr != nil {
		t.Fatalf("read attribute view after rejected transaction: %v", readErr)
	}
	if !bytes.Equal(afterAV, beforeAV) {
		t.Fatal("rejected attribute view delete changed the definition bytes")
	}
	afterMirror, mirrorErr := av.GetBlockRelsInBoxStrict("")
	if mirrorErr != nil {
		t.Fatalf("read attribute view mirror after rejected transaction: %v", mirrorErr)
	}
	if !reflect.DeepEqual(afterMirror, beforeMirror) {
		t.Fatalf("rejected attribute view delete changed mirror state: before=%#v after=%#v", beforeMirror, afterMirror)
	}
	afterQueue, readErr := readOptionalTransactionFile(queuePath)
	if readErr != nil {
		t.Fatalf("read durable queue after rejected transaction: %v", readErr)
	}
	if !bytes.Equal(afterQueue, beforeQueue) {
		t.Fatalf("rejected attribute view delete changed durable queue data: before=%q after=%q", beforeQueue, afterQueue)
	}
}

func TestTransactionQueueFailureRestoresAttributeViewRelationsAndAllowsRetry(t *testing.T) {
	setupDerivedContentStoreFixture(t)
	const (
		existingSourceID = "20990717010300-avrelsx"
		sourceID         = "20990717010301-avrelsx"
		destinationID    = "20990717010302-avrelsx"
		relationKeyID    = "20990717010303-avrelsx"
		rootID           = "20990717010304-avrootx"
	)

	existingSource := av.NewAttributeView(existingSourceID)
	source := av.NewAttributeView(sourceID)
	source.KeyValues = append(source.KeyValues, &av.KeyValues{
		Key: av.NewKey(relationKeyID, "Destination", "", av.KeyTypeRelation),
	})
	destination := av.NewAttributeView(destinationID)
	for _, attrView := range []*av.AttributeView{existingSource, source, destination} {
		if err := av.SaveAttributeView(attrView); err != nil {
			t.Fatalf("save attribute view [%s]: %v", attrView.ID, err)
		}
	}
	if err := av.UpsertAvBackRel(existingSourceID, destinationID); err != nil {
		t.Fatalf("seed attribute view relation: %v", err)
	}
	wantBefore := []string{existingSourceID}
	if got := av.GetSrcAvIDsInBox(destinationID, ""); !reflect.DeepEqual(got, wantBefore) {
		t.Fatalf("initial attribute view relations = %#v, want %#v", got, wantBefore)
	}

	newTransaction := func() *Transaction {
		return &Transaction{DoOperations: []*Operation{
			{
				Action: "updateAttrViewColRelation",
				AvID:   sourceID,
				ID:     destinationID,
				KeyID:  relationKeyID,
				Format: "Destination",
			},
			{
				Action: "create",
				Data:   treenode.NewTree("", "/"+rootID+".sy", "/Relation Retry", "Relation Retry"),
			},
		}}
	}

	restoreQueueDir := blockTransactionDurableQueue(t)
	err := PerformTxSync(newTransaction())
	restoreQueueDir()
	if !isTransactionDurableQueueFailure(err) {
		t.Fatalf("transaction error = %v, want a real durable queue ENOTDIR failure", err)
	}
	if got := av.GetSrcAvIDsInBox(destinationID, ""); !reflect.DeepEqual(got, wantBefore) {
		t.Fatalf("rejected transaction changed attribute view relations: got %#v, want %#v", got, wantBefore)
	}
	restoredSource, parseErr := av.ParseAttributeView(sourceID)
	if parseErr != nil {
		t.Fatalf("parse restored source attribute view: %v", parseErr)
	}
	restoredKey, _ := restoredSource.GetKey(relationKeyID)
	if restoredKey == nil || restoredKey.Relation != nil {
		t.Fatalf("rejected transaction retained source relation: %#v", restoredKey)
	}

	if err = PerformTxSync(newTransaction()); err != nil {
		t.Fatalf("retry transaction failed: %v", err)
	}
	wantAfter := []string{existingSourceID, sourceID}
	if got := av.GetSrcAvIDsInBox(destinationID, ""); !reflect.DeepEqual(got, wantAfter) {
		t.Fatalf("retried attribute view relations = %#v, want %#v", got, wantAfter)
	}
}

func blockTransactionDurableQueue(t *testing.T) func() {
	t.Helper()
	originalQueueDir := util.QueueDir
	blockedPath := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(blockedPath, []byte("blocked"), 0644); err != nil {
		t.Fatalf("create durable queue failure boundary: %v", err)
	}
	util.QueueDir = blockedPath
	restore := func() { util.QueueDir = originalQueueDir }
	t.Cleanup(restore)
	return restore
}

func readOptionalTransactionFile(path string) ([]byte, error) {
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	return data, err
}

func isTransactionDurableQueueFailure(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "index queue") && strings.Contains(message, "not a directory")
}

func waitTransactionSignal(t *testing.T, signal <-chan struct{}, failure string) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(5 * time.Second):
		t.Fatal(failure)
	}
}

func waitTransactionError(t *testing.T, result <-chan error, failure string) error {
	t.Helper()
	select {
	case err := <-result:
		return err
	case <-time.After(5 * time.Second):
		t.Fatal(failure)
		return nil
	}
}

func newTransactionAttributeViewNode(id, avID string, tree *parse.Tree) *ast.Node {
	node := &ast.Node{
		Type:              ast.NodeAttributeView,
		ID:                id,
		Box:               tree.Box,
		Path:              tree.Path,
		AttributeViewID:   avID,
		AttributeViewType: "table",
	}
	node.SetIALAttr("id", id)
	node.SetIALAttr("updated", util.TimeFromID(id))
	return node
}
