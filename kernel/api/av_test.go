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
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/siyuan-note/siyuan/kernel/av"
	"github.com/siyuan-note/siyuan/kernel/cache"
	"github.com/siyuan-note/siyuan/kernel/model"
	"github.com/siyuan-note/siyuan/kernel/util"
)

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
