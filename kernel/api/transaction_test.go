// SiYuan - Refactor your thinking
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/88250/lute/ast"
	"github.com/gin-gonic/gin"
	kernelconf "github.com/siyuan-note/siyuan/kernel/conf"
	"github.com/siyuan-note/siyuan/kernel/model"
	"github.com/siyuan-note/siyuan/kernel/treenode"
	"github.com/siyuan-note/siyuan/kernel/util"
)

func TestValidateTransactionNotebookUsesOneContentStoreIdentity(t *testing.T) {
	ordinaryID, encryptedID, missingID := setupNotebookArgTest(t)

	for _, test := range []struct {
		name         string
		transaction  *model.Transaction
		wantNotebook string
		wantError    bool
	}{
		{name: "missing transaction", transaction: nil, wantError: true},
		{name: "global content store", transaction: &model.Transaction{}},
		{name: "encrypted content store", transaction: &model.Transaction{Notebook: encryptedID}, wantNotebook: encryptedID},
		{name: "ordinary notebook canonicalizes to the global content store", transaction: &model.Transaction{Notebook: ordinaryID}},
		{name: "invalid notebook", transaction: &model.Transaction{Notebook: "../../etc/passwd"}, wantError: true},
		{name: "missing notebook", transaction: &model.Transaction{Notebook: missingID}, wantError: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			err := validateTransactionNotebook(test.transaction)
			if test.wantError && err == nil {
				t.Fatal("validation succeeded, want error")
			}
			if !test.wantError && err != nil {
				t.Fatalf("validation failed: %v", err)
			}
			if !test.wantError && test.transaction.Notebook != test.wantNotebook {
				t.Fatalf("canonical notebook = %q, want %q", test.transaction.Notebook, test.wantNotebook)
			}
		})
	}
}

func TestPerformTransactionsRejectsMixedStoresBeforeCommitAndAcceptsOneStore(t *testing.T) {
	boxIDs := setupEncryptedResponseTest(t, 2)
	ordinaryIDs := []string{"20990717170002-normal1", "20990717170003-normal2"}
	for _, boxID := range ordinaryIDs {
		boxConf := kernelconf.NewBoxConf()
		boxConf.Name = boxID
		if err := (&model.Box{ID: boxID}).SaveConf(boxConf); err != nil {
			t.Fatalf("create ordinary notebook fixture %s: %v", boxID, err)
		}
	}
	util.SetBooted()
	const (
		rootID        = "20990717170000-txbatch"
		firstBlockID  = "20990717170001-txbatch"
		secondBlockID = "20990717170004-txbatch"
	)
	treePath := "/" + rootID + ".sy"
	tree := treenode.NewTree(boxIDs[0], treePath, "/Batch", "Batch")
	tree.Root.FirstChild.ID = firstBlockID
	tree.Root.FirstChild.SetIALAttr("id", firstBlockID)
	tree.Root.FirstChild.SetIALAttr("updated", firstBlockID[:14])
	tree.Root.FirstChild.AppendChild(&ast.Node{Type: ast.NodeText, Tokens: []byte("before")})
	secondBlock := &ast.Node{Type: ast.NodeParagraph, ID: secondBlockID, Box: boxIDs[0], Path: treePath}
	secondBlock.SetIALAttr("id", secondBlockID)
	secondBlock.SetIALAttr("updated", secondBlockID[:14])
	secondBlock.AppendChild(&ast.Node{Type: ast.NodeText, Tokens: []byte("second")})
	tree.Root.AppendChild(secondBlock)
	if err := model.PerformTxSync(&model.Transaction{
		Notebook:     boxIDs[0],
		DoOperations: []*model.Operation{{Action: "create", Data: tree}},
	}); err != nil {
		t.Fatalf("create transaction batch fixture: %v", err)
	}

	previousMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(previousMode) })
	router := gin.New()
	router.Use(ContentResponseLifecycle)
	router.POST("/api/transactions", performTransactions)
	post := func(notebooks []string, update bool) (result struct {
		Code int `json:"code"`
		Data []struct {
			Notebook string `json:"notebook"`
		} `json:"data"`
	}) {
		t.Helper()
		firstOperations := []map[string]any{}
		secondOperations := []map[string]any{}
		if update {
			firstOperations = append(firstOperations, map[string]any{"action": "setAttrs", "id": firstBlockID, "data": `{"custom-batch":"first"}`})
			secondOperations = append(secondOperations, map[string]any{"action": "setAttrs", "id": secondBlockID, "data": `{"custom-batch":"second"}`})
		}
		body, err := json.Marshal(map[string]any{
			"reqId": 1,
			"transactions": []map[string]any{
				{
					"notebook":     notebooks[0],
					"doOperations": firstOperations,
				},
				{"notebook": notebooks[1], "doOperations": secondOperations},
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		request := httptest.NewRequest(http.MethodPost, "/api/transactions", bytes.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		if err = json.Unmarshal(response.Body.Bytes(), &result); err != nil {
			t.Fatalf("decode transaction batch response: %v", err)
		}
		return
	}
	readBatchAttrs := func() (string, string) {
		t.Helper()
		loaded, err := model.LoadTreeByBlockIDInBox(rootID, boxIDs[0])
		if err != nil {
			t.Fatalf("load transaction batch fixture: %v", err)
		}
		first := treenode.GetNodeInTree(loaded, firstBlockID)
		second := treenode.GetNodeInTree(loaded, secondBlockID)
		if first == nil || second == nil {
			t.Fatalf("transaction batch fixture blocks are missing: first=%#v second=%#v", first, second)
		}
		return first.IALAttr("custom-batch"), second.IALAttr("custom-batch")
	}

	for _, notebooks := range [][]string{{boxIDs[0], ""}, {boxIDs[0], boxIDs[1]}} {
		result := post(notebooks, true)
		if result.Code == 0 {
			t.Fatalf("mixed transaction notebooks %q were accepted", notebooks)
		}
		if first, second := readBatchAttrs(); first != "" || second != "" {
			t.Fatalf("mixed transaction batch committed before rejection: first=%q second=%q", first, second)
		}
	}

	result := post([]string{boxIDs[0], boxIDs[0]}, true)
	if result.Code != 0 || len(result.Data) != 2 || result.Data[0].Notebook != boxIDs[0] || result.Data[1].Notebook != boxIDs[0] {
		t.Fatalf("same-store transaction response = %#v", result)
	}
	if first, second := readBatchAttrs(); first != "first" || second != "second" {
		t.Fatalf("same-store transaction batch writes = first:%q second:%q, want both committed", first, second)
	}

	result = post(ordinaryIDs, false)
	if result.Code != 0 || len(result.Data) != 2 || result.Data[0].Notebook != "" || result.Data[1].Notebook != "" {
		t.Fatalf("ordinary same-store transaction response = %#v", result)
	}
}

func TestPerformTransactionsHoldsEncryptedResponseGateUntilJSONCompletes(t *testing.T) {
	boxIDs := setupEncryptedResponseTest(t, 1)
	util.SetBooted()
	previousMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(previousMode) })

	router := gin.New()
	router.Use(ContentResponseLifecycle)
	router.POST("/api/transactions", performTransactions)
	body, err := json.Marshal(map[string]any{
		"reqId": 1,
		"transactions": []map[string]any{
			{"notebook": boxIDs[0], "doOperations": []any{}, "undoOperations": []any{}},
			{"notebook": boxIDs[0], "doOperations": []any{}, "undoOperations": []any{}},
			{"notebook": boxIDs[0], "doOperations": []any{}, "undoOperations": []any{}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/transactions", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	writer := &blockingResponseWriter{
		ResponseRecorder: httptest.NewRecorder(),
		writeStarted:     make(chan struct{}),
		writeRelease:     make(chan struct{}),
	}
	t.Cleanup(writer.release)

	requestDone := make(chan struct{})
	go func() {
		router.ServeHTTP(writer, request)
		close(requestDone)
	}()
	waitResponseTestSignal(t, writer.writeStarted, "transaction response did not reach JSON serialization")

	lockDone := make(chan error, 1)
	writeBlocked := observeBoxResponseWriteBlocked(t, boxIDs[0])
	go func() { lockDone <- model.LockBox(boxIDs[0]) }()
	waitResponseTestSignal(t, writeBlocked, "LockBox was not blocked by the transaction response gate")

	writer.release()
	waitResponseTestSignal(t, requestDone, "transaction response did not complete")
	if err = waitResponseTestError(t, lockDone, "LockBox did not complete after the transaction JSON body"); err != nil {
		t.Fatalf("LockBox after transaction JSON completed: %v", err)
	}
	var result struct {
		Code int `json:"code"`
		Data []struct {
			Notebook string `json:"notebook"`
		} `json:"data"`
	}
	if err = json.Unmarshal(writer.Body.Bytes(), &result); err != nil {
		t.Fatalf("decode transaction response: %v", err)
	}
	if result.Code != 0 || len(result.Data) != 3 || result.Data[1].Notebook != boxIDs[0] {
		t.Fatalf("transaction response = %#v, want all validated notebook identities", result)
	}
}

func TestEncryptedTransactionHandlersRejectAfterLockBoxWinsResponseGate(t *testing.T) {
	for _, test := range []struct {
		name    string
		path    string
		handler gin.HandlerFunc
		body    func(string) map[string]any
	}{
		{
			name: "transactions", path: "/api/transactions", handler: performTransactions,
			body: func(notebook string) map[string]any {
				return map[string]any{"reqId": 1, "transactions": []map[string]any{{"notebook": notebook, "doOperations": []any{}}}}
			},
		},
		{name: "undo state", path: "/api/transactions/undoState", handler: undoState, body: transactionReplayBody},
		{name: "undo", path: "/api/transactions/undo", handler: performUndo, body: transactionReplayBody},
		{name: "redo", path: "/api/transactions/redo", handler: performRedo, body: transactionReplayBody},
	} {
		t.Run(test.name, func(t *testing.T) {
			boxID := setupEncryptedResponseTest(t, 1)[0]
			util.SetBooted()
			previousMode := gin.Mode()
			gin.SetMode(gin.TestMode)
			t.Cleanup(func() { gin.SetMode(previousMode) })
			router := gin.New()
			router.Use(ContentResponseLifecycle)
			router.POST(test.path, test.handler)

			beforeRegistration := make(chan struct{})
			allowRegistration := make(chan struct{})
			var beforeOnce, allowOnce, releaseReaderOnce sync.Once
			previousHook := transactionBeforeResponseRegistrationHook
			transactionBeforeResponseRegistrationHook = func(notebook string) {
				if notebook == boxID {
					beforeOnce.Do(func() { close(beforeRegistration) })
					<-allowRegistration
				}
			}

			model.HoldBoxResponseReadLock(boxID)
			readerHeld := true
			releaseReader := func() {
				releaseReaderOnce.Do(func() {
					if readerHeld {
						readerHeld = false
						model.ReleaseBoxResponseReadLock(boxID)
					}
				})
			}
			allow := func() { allowOnce.Do(func() { close(allowRegistration) }) }
			lockDone := make(chan error, 1)
			lockExited := make(chan struct{})
			requestExited := make(chan struct{})
			lockLaunched := false
			requestLaunched := false
			t.Cleanup(func() {
				allow()
				releaseReader()
				if requestLaunched {
					<-requestExited
				}
				if lockLaunched {
					<-lockExited
				}
				transactionBeforeResponseRegistrationHook = previousHook
			})

			writeBlocked := observeBoxResponseWriteBlocked(t, boxID)
			lockLaunched = true
			go func() {
				defer close(lockExited)
				lockDone <- model.LockBox(boxID)
			}()
			waitResponseTestSignal(t, writeBlocked, "LockBox writer did not queue behind the initial response reader")

			body, err := json.Marshal(test.body(boxID))
			if err != nil {
				t.Fatal(err)
			}
			request := httptest.NewRequest(http.MethodPost, test.path, bytes.NewReader(body))
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			requestLaunched = true
			go func() {
				defer close(requestExited)
				router.ServeHTTP(response, request)
			}()
			waitResponseTestSignal(t, beforeRegistration, "request did not validate the encrypted notebook before response registration")
			allow()
			releaseReader()
			if err = waitResponseTestError(t, lockDone, "LockBox did not finish after the initial reader released"); err != nil {
				t.Fatalf("LockBox: %v", err)
			}
			waitResponseTestSignal(t, requestExited, "request did not resume after LockBox completed")

			var result struct {
				Code int    `json:"code"`
				Msg  string `json:"msg"`
			}
			if err = json.Unmarshal(response.Body.Bytes(), &result); err != nil {
				t.Fatalf("decode response: %v", err)
			}
			if result.Code == 0 || !strings.Contains(result.Msg, "locked") {
				t.Fatalf("response after LockBox won = %#v, want locked failure", result)
			}
		})
	}
}

func TestPerformTransactionsReturnsCommitFailureWithoutApplyingWrite(t *testing.T) {
	boxID := setupEncryptedResponseTest(t, 1)[0]
	util.SetBooted()
	const (
		rootID  = "20990717190000-txfailx"
		blockID = "20990717190001-txfailx"
	)
	tree := treenode.NewTree(boxID, "/"+rootID+".sy", "/Commit Failure", "Commit Failure")
	tree.Root.FirstChild.ID = blockID
	tree.Root.FirstChild.SetIALAttr("id", blockID)
	tree.Root.FirstChild.SetIALAttr("updated", blockID[:14])
	if err := model.PerformTxSync(&model.Transaction{
		Notebook: boxID, DoOperations: []*model.Operation{{Action: "create", Data: tree}},
	}); err != nil {
		t.Fatalf("create commit failure fixture: %v", err)
	}

	previousMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(previousMode) })
	router := gin.New()
	router.Use(ContentResponseLifecycle)
	router.POST("/api/transactions", performTransactions)
	body, err := json.Marshal(map[string]any{
		"reqId": 1,
		"transactions": []map[string]any{{
			"notebook": boxID,
			"doOperations": []map[string]any{{
				"action": "setAttrs", "id": blockID, "data": `{"custom-commit":"applied"}`,
			}},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}

	originalQueueDir := util.QueueDir
	blockedQueueDir := filepath.Join(t.TempDir(), "not-a-directory")
	if err = os.WriteFile(blockedQueueDir, []byte("blocked"), 0644); err != nil {
		t.Fatalf("create durable queue failure boundary: %v", err)
	}
	util.QueueDir = blockedQueueDir
	t.Cleanup(func() { util.QueueDir = originalQueueDir })
	request := httptest.NewRequest(http.MethodPost, "/api/transactions", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	util.QueueDir = originalQueueDir

	var result struct {
		Code int    `json:"code"`
		Msg  string `json:"msg"`
	}
	if err = json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatalf("decode failed transaction response: %v", err)
	}
	if result.Code == 0 || !strings.Contains(result.Msg, "transaction failed") {
		t.Fatalf("failed transaction response = %#v", result)
	}
	loaded, err := model.LoadTreeByBlockIDInBox(rootID, boxID)
	if err != nil {
		t.Fatalf("load rolled back transaction tree: %v", err)
	}
	if node := treenode.GetNodeInTree(loaded, blockID); node == nil || node.IALAttr("custom-commit") != "" {
		t.Fatalf("failed HTTP transaction changed block: %#v", node)
	}
}

func TestEncryptedHTTPUndoRedoStateIsolatesCollidingOrdinaryStore(t *testing.T) {
	encryptedID := setupEncryptedResponseTest(t, 1)[0]
	util.SetBooted()
	const (
		ordinaryID = "20990717200000-normalx"
		rootID     = "20990717200001-undorot"
		blockID    = "20990717200002-undoblk"
	)
	ordinaryConf := kernelconf.NewBoxConf()
	ordinaryConf.Name = ordinaryID
	if err := (&model.Box{ID: ordinaryID}).SaveConf(ordinaryConf); err != nil {
		t.Fatalf("create ordinary notebook fixture: %v", err)
	}
	model.GlobalUndoLog.Clear("", rootID)
	t.Cleanup(func() { model.GlobalUndoLog.Clear("", rootID) })

	for _, fixture := range []struct {
		boxID    string
		notebook string
		title    string
	}{
		{boxID: ordinaryID, title: "Ordinary"},
		{boxID: encryptedID, notebook: encryptedID, title: "Encrypted"},
	} {
		tree := treenode.NewTree(fixture.boxID, "/"+rootID+".sy", "/"+fixture.title, fixture.title)
		tree.Root.FirstChild.ID = blockID
		tree.Root.FirstChild.SetIALAttr("id", blockID)
		tree.Root.FirstChild.SetIALAttr("updated", blockID[:14])
		tree.Root.FirstChild.SetIALAttr("custom-undo", "before")
		if err := model.PerformTxSync(&model.Transaction{
			Notebook: fixture.notebook, DoOperations: []*model.Operation{{Action: "create", Data: tree}},
		}); err != nil {
			t.Fatalf("create %s undo fixture: %v", fixture.title, err)
		}
	}

	previousMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(previousMode) })
	router := gin.New()
	router.Use(ContentResponseLifecycle)
	router.POST("/api/transactions", performTransactions)
	router.POST("/api/transactions/undoState", undoState)
	router.POST("/api/transactions/undo", performUndo)
	router.POST("/api/transactions/redo", performRedo)
	post := func(path string, body map[string]any, result any) {
		t.Helper()
		data, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		request := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(data))
		request.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		if err = json.Unmarshal(response.Body.Bytes(), result); err != nil {
			t.Fatalf("decode %s response: %v", path, err)
		}
	}
	type stateResponse struct {
		Code int `json:"code"`
		Data struct {
			CanUndo bool `json:"canUndo"`
			CanRedo bool `json:"canRedo"`
			Failed  bool `json:"failed"`
		} `json:"data"`
	}

	for _, notebook := range []string{ordinaryID, encryptedID} {
		var result struct {
			Code int             `json:"code"`
			Data json.RawMessage `json:"data"`
		}
		post("/api/transactions", map[string]any{
			"reqId": 1,
			"transactions": []map[string]any{{
				"notebook": notebook,
				"doOperations": []map[string]any{{
					"action": "setAttrs", "id": blockID, "data": `{"custom-undo":"after"}`,
				}},
				"undoOperations": []map[string]any{{
					"action": "setAttrs", "id": blockID, "data": `{"custom-undo":"before"}`,
				}},
			}},
		}, &result)
		if result.Code != 0 {
			t.Fatalf("record %s undo transaction = %#v", notebook, result)
		}
	}
	readAttr := func(notebook string) string {
		t.Helper()
		loaded, err := model.LoadTreeByBlockIDInBox(rootID, notebook)
		if err != nil {
			t.Fatalf("load %q undo tree: %v", notebook, err)
		}
		node := treenode.GetNodeInTree(loaded, blockID)
		if node == nil {
			t.Fatalf("load %q undo block", notebook)
		}
		return node.IALAttr("custom-undo")
	}
	state := func(notebook string) stateResponse {
		t.Helper()
		var result stateResponse
		post("/api/transactions/undoState", map[string]any{"notebook": notebook, "rootID": rootID}, &result)
		return result
	}
	if ordinary, encrypted := readAttr(""), readAttr(encryptedID); ordinary != "after" || encrypted != "after" {
		t.Fatalf("recorded attrs = ordinary:%q encrypted:%q", ordinary, encrypted)
	}
	for _, notebook := range []string{ordinaryID, encryptedID} {
		result := state(notebook)
		if result.Code != 0 || !result.Data.CanUndo || result.Data.CanRedo {
			t.Fatalf("initial %s undo state = %#v", notebook, result)
		}
	}

	var replay stateResponse
	post("/api/transactions/undo", map[string]any{"notebook": encryptedID, "rootID": rootID}, &replay)
	if replay.Code != 0 || replay.Data.Failed || !replay.Data.CanRedo {
		t.Fatalf("encrypted undo response = %#v", replay)
	}
	if ordinary, encrypted := readAttr(""), readAttr(encryptedID); ordinary != "after" || encrypted != "before" {
		t.Fatalf("attrs after encrypted undo = ordinary:%q encrypted:%q", ordinary, encrypted)
	}
	if ordinaryState := state(ordinaryID); !ordinaryState.Data.CanUndo || ordinaryState.Data.CanRedo {
		t.Fatalf("encrypted undo changed ordinary state: %#v", ordinaryState)
	}

	post("/api/transactions/redo", map[string]any{"notebook": encryptedID, "rootID": rootID}, &replay)
	if replay.Code != 0 || replay.Data.Failed || !replay.Data.CanUndo || replay.Data.CanRedo {
		t.Fatalf("encrypted redo response = %#v", replay)
	}
	if ordinary, encrypted := readAttr(""), readAttr(encryptedID); ordinary != "after" || encrypted != "after" {
		t.Fatalf("attrs after encrypted redo = ordinary:%q encrypted:%q", ordinary, encrypted)
	}
}

func transactionReplayBody(notebook string) map[string]any {
	return map[string]any{"notebook": notebook, "rootID": "20990717190002-replayx"}
}
