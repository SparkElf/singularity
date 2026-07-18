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
	"strings"
	"testing"
	"time"

	"github.com/88250/lute/ast"
	"github.com/gin-gonic/gin"
	"github.com/siyuan-note/siyuan/kernel/av"
	"github.com/siyuan-note/siyuan/kernel/cache"
	"github.com/siyuan-note/siyuan/kernel/model"
	"github.com/siyuan-note/siyuan/kernel/treenode"
	"github.com/siyuan-note/siyuan/kernel/util"
)

func TestAttributeViewResponsesDeriveBoundBlockIdentityWithoutPersistingIt(t *testing.T) {
	setupEncryptedResponseTest(t, 0)
	util.SetBooted()
	previousLang := util.Lang
	previousAttrViewLangs := util.AttrViewLangs
	util.Lang = "av-identity-test"
	util.AttrViewLangs = map[string]map[string]any{
		util.Lang: {"table": "Table", "key": "Key", "select": "Select"},
	}
	t.Cleanup(func() {
		util.AttrViewLangs = previousAttrViewLangs
		util.Lang = previousLang
	})

	const (
		boxID  = "20990719010000-avbox01"
		rootA  = "20990719010001-avroot1"
		blockA = "20990719010002-avchd01"
		rootB  = "20990719010003-avroot2"
		blockB = "20990719010004-avchd02"
		avID   = "20990719010005-aviden1"
	)
	createEnterpriseDirectoryNotebook(t, boxID, "AV Identity", false)
	for _, fixture := range []struct {
		rootID  string
		blockID string
		title   string
	}{
		{rootID: rootA, blockID: blockA, title: "Alpha"},
		{rootID: rootB, blockID: blockB, title: "Beta"},
	} {
		path := "/" + fixture.rootID + ".sy"
		tree := treenode.NewTree(boxID, path, "/"+fixture.title, fixture.title)
		tree.Root.FirstChild.Unlink()
		tree.ID = fixture.rootID
		tree.Root.ID = fixture.rootID
		tree.Root.SetIALAttr("id", fixture.rootID)
		tree.Root.SetIALAttr("updated", fixture.rootID[:14])
		child := &ast.Node{Type: ast.NodeParagraph, ID: fixture.blockID, Box: boxID, Path: path}
		child.SetIALAttr("id", fixture.blockID)
		child.SetIALAttr("updated", fixture.blockID[:14])
		child.AppendChild(&ast.Node{Type: ast.NodeText, Tokens: []byte(fixture.title + " block")})
		tree.Root.AppendChild(child)
		if err := model.PerformTxSync(&model.Transaction{
			Notebook: model.TransactionNotebookForBox(boxID),
			DoOperations: []*model.Operation{{
				Action: "create",
				Data:   tree,
			}},
		}); err != nil {
			t.Fatalf("create AV identity document %s: %v", fixture.rootID, err)
		}
	}

	attrView := av.NewAttributeView(avID)
	blockKeyValues := attrView.GetBlockKeyValues()
	blockKeyValues.Values = []*av.Value{
		{
			ID:      "20990719010006-avval01",
			KeyID:   blockKeyValues.Key.ID,
			BlockID: blockA,
			Type:    av.KeyTypeBlock,
			Block: &av.ValueBlock{
				ID:         blockA,
				NotebookID: "client-supplied-notebook",
				DocumentID: "client-supplied-document",
				Content:    "Alpha block",
			},
		},
		{
			ID:      "20990719010007-avval02",
			KeyID:   blockKeyValues.Key.ID,
			BlockID: blockB,
			Type:    av.KeyTypeBlock,
			Block:   &av.ValueBlock{ID: blockB, Content: "Beta block"},
		},
	}
	relationKeyValues := attrView.KeyValues[1]
	relationKeyValues.Key.Type = av.KeyTypeRelation
	relationKeyValues.Key.Relation = &av.Relation{AvID: avID}
	relationKeyValues.Values = []*av.Value{{
		ID:      "20990719010008-avrel01",
		KeyID:   relationKeyValues.Key.ID,
		BlockID: blockA,
		Type:    av.KeyTypeRelation,
		Relation: &av.ValueRelation{
			BlockIDs: []string{blockB},
		},
	}}
	rollupKey := av.NewKey("20990719010009-avkey01", "Root", "", av.KeyTypeRollup)
	rollupKey.Rollup = &av.Rollup{
		RelationKeyID: relationKeyValues.Key.ID,
		KeyID:         blockKeyValues.Key.ID,
		Calc:          &av.RollupCalc{Operator: av.CalcOperatorNone},
	}
	attrView.KeyValues = append(attrView.KeyValues, &av.KeyValues{Key: rollupKey})
	attrView.Views[0].Table.Columns = append(attrView.Views[0].Table.Columns, &av.ViewTableColumn{
		BaseField: &av.BaseField{ID: rollupKey.ID},
	})
	if err := av.SaveAttributeView(attrView); err != nil {
		t.Fatalf("save AV identity fixture: %v", err)
	}
	avPath, _ := av.FindAttributeViewPathInBox(avID, "")
	stored, err := os.ReadFile(avPath)
	if err != nil {
		t.Fatalf("read AV identity fixture: %v", err)
	}
	var storedAttributeView struct {
		KeyValues []struct {
			Values []struct {
				Block map[string]any `json:"block"`
			} `json:"values"`
		} `json:"keyValues"`
	}
	if err = json.Unmarshal(stored, &storedAttributeView); err != nil {
		t.Fatalf("decode stored AV identity fixture: %v", err)
	}
	for _, keyValues := range storedAttributeView.KeyValues {
		for _, value := range keyValues.Values {
			if _, exists := value.Block["notebookId"]; exists {
				t.Fatalf("AV persistence contains notebookId: %#v", value.Block)
			}
			if _, exists := value.Block["documentId"]; exists {
				t.Fatalf("AV persistence contains documentId: %#v", value.Block)
			}
		}
	}

	previousMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(previousMode) })
	router := gin.New()
	router.Use(ContentResponseLifecycle)
	router.POST("/api/av/renderAttributeView", renderAttributeView)
	router.POST("/api/av/getAttributeViewPrimaryKeyValues", getAttributeViewPrimaryKeyValues)

	body, err := json.Marshal(map[string]any{
		"id":               avID,
		"notebook":         boxID,
		"createIfNotExist": false,
	})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/av/renderAttributeView", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	var rendered struct {
		Code int `json:"code"`
		Data struct {
			View struct {
				Rows []struct {
					ID    string `json:"id"`
					Cells []struct {
						Value *av.Value `json:"value"`
					} `json:"cells"`
				} `json:"rows"`
			} `json:"view"`
		} `json:"data"`
	}
	if err = json.Unmarshal(response.Body.Bytes(), &rendered); err != nil {
		t.Fatalf("decode AV identity response: %v", err)
	}
	if rendered.Code != 0 {
		t.Fatalf("AV identity response = %s", response.Body.String())
	}
	var primary, relation, rollup *av.Value
	for _, row := range rendered.Data.View.Rows {
		if row.ID != blockA {
			continue
		}
		for _, cell := range row.Cells {
			if cell.Value == nil {
				continue
			}
			switch cell.Value.Type {
			case av.KeyTypeBlock:
				primary = cell.Value
			case av.KeyTypeRelation:
				relation = cell.Value
			case av.KeyTypeRollup:
				rollup = cell.Value
			}
		}
	}
	assertIdentity := func(label string, block *av.ValueBlock, wantBlock, wantDocument string) {
		t.Helper()
		if block == nil || block.ID != wantBlock || block.NotebookID != boxID || block.DocumentID != wantDocument {
			t.Fatalf("%s identity = %#v, want block=%s notebook=%s document=%s", label, block, wantBlock, boxID, wantDocument)
		}
	}
	if primary == nil {
		t.Fatal("rendered AV response has no primary block value")
	}
	assertIdentity("primary", primary.Block, blockA, rootA)
	if relation == nil || relation.Relation == nil || len(relation.Relation.Contents) != 1 {
		t.Fatalf("relation response = %#v, want one rendered block", relation)
	}
	assertIdentity("relation", relation.Relation.Contents[0].Block, blockB, rootB)
	if rollup == nil || rollup.Rollup == nil || len(rollup.Rollup.Contents) != 1 {
		t.Fatalf("rollup response = %#v, want one rendered block", rollup)
	}
	assertIdentity("rollup", rollup.Rollup.Contents[0].Block, blockB, rootB)

	primaryBody, err := json.Marshal(map[string]any{"id": avID, "notebook": boxID})
	if err != nil {
		t.Fatal(err)
	}
	primaryRequest := httptest.NewRequest(http.MethodPost, "/api/av/getAttributeViewPrimaryKeyValues", bytes.NewReader(primaryBody))
	primaryRequest.Header.Set("Content-Type", "application/json")
	primaryResponse := httptest.NewRecorder()
	router.ServeHTTP(primaryResponse, primaryRequest)
	var primaryResult struct {
		Code int `json:"code"`
		Data struct {
			Rows struct {
				Values []*av.Value `json:"values"`
			} `json:"rows"`
		} `json:"data"`
	}
	if err = json.Unmarshal(primaryResponse.Body.Bytes(), &primaryResult); err != nil {
		t.Fatalf("decode AV primary-key response: %v", err)
	}
	if primaryResult.Code != 0 || len(primaryResult.Data.Rows.Values) != 2 {
		t.Fatalf("AV primary-key response = %s", primaryResponse.Body.String())
	}
	foundPrimary := false
	for _, value := range primaryResult.Data.Rows.Values {
		if value != nil && value.Block != nil && value.Block.ID == blockA {
			assertIdentity("primary-key list", value.Block, blockA, rootA)
			foundPrimary = true
		}
	}
	if !foundPrimary {
		t.Fatal("AV primary-key response has no Alpha block")
	}
}

func TestReloadAttributeViewCarriesEncryptedNotebookResponseScope(t *testing.T) {
	boxID := setupEncryptedResponseTest(t, 1)[0]
	previousMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(previousMode) })

	router := gin.New()
	router.Use(ContentResponseLifecycle)
	router.POST("/api/ui/reloadAttributeView", reloadAttributeView)
	body, err := json.Marshal(map[string]any{
		"id":       "20990717181400-avscope",
		"notebook": boxID,
	})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/ui/reloadAttributeView", bytes.NewReader(body))
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
	waitResponseTestSignal(t, writer.writeStarted, "attribute-view reload response did not reach JSON serialization")

	writeBlocked := observeBoxResponseWriteBlocked(t, boxID)
	lockDone := make(chan error, 1)
	go func() { lockDone <- model.LockBox(boxID) }()
	waitResponseTestSignal(t, writeBlocked, "attribute-view reload response did not retain its encrypted notebook scope")

	writer.release()
	waitResponseTestSignal(t, requestDone, "attribute-view reload response did not complete")
	select {
	case err = <-lockDone:
		if err != nil {
			t.Fatalf("LockBox after attribute-view reload response: %v", err)
		}
	case <-time.After(responseTestTimeout):
		t.Fatal("LockBox did not complete after attribute-view reload response")
	}
	var result struct {
		Code int    `json:"code"`
		Msg  string `json:"msg"`
	}
	if err = json.Unmarshal(writer.Body.Bytes(), &result); err != nil {
		t.Fatalf("decode attribute-view reload response: %v", err)
	}
	if result.Code != 0 {
		t.Fatalf("attribute-view reload response = %#v, want success", result)
	}
}

func TestRenderAttributeViewRequiresNotebookAndFailsClosedForEncryptedStore(t *testing.T) {
	boxIDs := setupEncryptedResponseTest(t, 1)
	encryptedID := boxIDs[0]
	previousLang := util.Lang
	previousAttrViewLangs := util.AttrViewLangs
	util.Lang = "av-api-test"
	util.AttrViewLangs = map[string]map[string]any{
		util.Lang: {"table": "Table", "key": "Key", "select": "Select"},
	}
	t.Cleanup(func() {
		util.AttrViewLangs = previousAttrViewLangs
		util.Lang = previousLang
	})

	const avID = "20990716090005-avscope"
	attrView := av.NewAttributeView(avID)
	view := av.NewTableView()
	attrView.ViewID = view.ID
	attrView.Views = []*av.View{view}
	if err := av.SaveAttributeView(attrView); err != nil {
		t.Fatalf("save duplicate global attribute view: %v", err)
	}
	t.Cleanup(func() { cache.RemoveAVDataInBox(avID, "") })

	previousMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(previousMode) })
	router := gin.New()
	router.Use(ContentResponseLifecycle)
	router.POST("/api/av/renderAttributeView", renderAttributeView)
	router.POST("/api/av/renderHistoryAttributeView", renderHistoryAttributeView)
	router.POST("/api/av/renderSnapshotAttributeView", renderSnapshotAttributeView)

	for _, test := range []struct {
		name       string
		path       string
		payload    map[string]any
		wantErrMsg string
	}{
		{
			name:       "missing notebook",
			path:       "/api/av/renderAttributeView",
			payload:    map[string]any{"id": avID, "createIfNotExist": false},
			wantErrMsg: model.ErrInvalidID.Error(),
		},
		{
			name: "current encrypted notebook with duplicate global id",
			path: "/api/av/renderAttributeView",
			payload: map[string]any{
				"id":               avID,
				"notebook":         encryptedID,
				"createIfNotExist": false,
			},
			wantErrMsg: model.ErrEncryptedAttributeViewUnsupported.Error(),
		},
		{
			name: "history encrypted notebook with duplicate global id",
			path: "/api/av/renderHistoryAttributeView",
			payload: map[string]any{
				"id":       avID,
				"notebook": encryptedID,
				"created":  "0",
			},
			wantErrMsg: model.ErrEncryptedAttributeViewUnsupported.Error(),
		},
		{
			name: "snapshot encrypted notebook with duplicate global id",
			path: "/api/av/renderSnapshotAttributeView",
			payload: map[string]any{
				"id":       avID,
				"notebook": encryptedID,
				"snapshot": "snapshot-id",
			},
			wantErrMsg: model.ErrEncryptedAttributeViewUnsupported.Error(),
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			body, err := json.Marshal(test.payload)
			if err != nil {
				t.Fatal(err)
			}
			request := httptest.NewRequest(http.MethodPost, test.path, bytes.NewReader(body))
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)

			var result struct {
				Code int    `json:"code"`
				Msg  string `json:"msg"`
			}
			if err = json.Unmarshal(response.Body.Bytes(), &result); err != nil {
				t.Fatalf("decode response: %v", err)
			}
			if result.Code == 0 || !strings.Contains(result.Msg, test.wantErrMsg) {
				t.Fatalf("response = %#v, want error containing %q", result, test.wantErrMsg)
			}
		})
	}
}
