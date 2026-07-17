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
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/siyuan-note/siyuan/kernel/model"
	"github.com/siyuan-note/siyuan/kernel/util"
)

func TestSearchAssetRejectsInvalidEncryptedNotebookScope(t *testing.T) {
	_, encryptedID, missingID := setupNotebookArgTest(t)
	previousMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(previousMode) })

	router := gin.New()
	router.Use(ContentResponseLifecycle)
	router.POST("/api/search/searchAsset", searchAsset)
	for _, test := range []struct {
		name     string
		notebook any
	}{
		{name: "wrong type", notebook: 1},
		{name: "invalid id", notebook: "../../etc/passwd"},
		{name: "not found", notebook: missingID},
		{name: "encrypted locked", notebook: encryptedID},
	} {
		t.Run(test.name, func(t *testing.T) {
			body, err := json.Marshal(map[string]any{"k": "asset", "notebook": test.notebook})
			if err != nil {
				t.Fatal(err)
			}
			request := httptest.NewRequest(http.MethodPost, "/api/search/searchAsset", bytes.NewReader(body))
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			if response.Code != http.StatusOK {
				t.Fatalf("HTTP status = %d, want 200", response.Code)
			}
			var result struct {
				Code int    `json:"code"`
				Msg  string `json:"msg"`
			}
			if err = json.Unmarshal(response.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			if result.Code != -1 || result.Msg == "" {
				t.Fatalf("result = %+v, want Code=-1 with message", result)
			}
		})
	}
}

func TestSearchAssetHoldsEncryptedResponseGateUntilJSONCompletes(t *testing.T) {
	boxID := setupEncryptedResponseTest(t, 1)[0]
	assetsDir := filepath.Join(util.DataDir, boxID, "assets")
	if err := os.MkdirAll(assetsDir, 0755); err != nil {
		t.Fatalf("create encrypted asset directory: %v", err)
	}
	diskName, err := model.StoreAssetForBox(boxID, assetsDir, "Quarterly asset.txt", []byte("asset-content"))
	if err != nil {
		t.Fatalf("store encrypted asset fixture: %v", err)
	}

	previousMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(previousMode) })
	router := gin.New()
	router.Use(ContentResponseLifecycle)
	router.POST("/api/search/searchAsset", searchAsset)
	body, err := json.Marshal(map[string]any{"k": "Quarterly", "notebook": boxID})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/search/searchAsset", bytes.NewReader(body))
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
	waitResponseTestSignal(t, writer.writeStarted, "encrypted asset search did not reach JSON serialization")

	lockDone := make(chan error, 1)
	writeBlocked := observeBoxResponseWriteBlocked(t, boxID)
	go func() { lockDone <- model.LockBox(boxID) }()
	waitResponseTestSignal(t, writeBlocked, "LockBox was not blocked by encrypted asset search serialization")

	writer.release()
	waitResponseTestSignal(t, requestDone, "encrypted asset search response did not complete")
	if err = waitResponseTestError(t, lockDone, "LockBox did not complete after encrypted asset search serialization"); err != nil {
		t.Fatalf("LockBox after encrypted asset search response: %v", err)
	}
	var result struct {
		Code int `json:"code"`
		Data []struct {
			Path string `json:"path"`
		} `json:"data"`
	}
	if err = json.Unmarshal(writer.Body.Bytes(), &result); err != nil {
		t.Fatalf("decode encrypted asset search response: %v", err)
	}
	if result.Code != 0 || len(result.Data) != 1 || !strings.Contains(result.Data[0].Path, diskName+"?box="+boxID) {
		t.Fatalf("encrypted asset search response = %#v, want committed asset %s", result, diskName)
	}
}

func TestSearchEmbedBlockRejectsInvalidOrLockedNotebookScope(t *testing.T) {
	_, encryptedID, missingID := setupNotebookArgTest(t)
	previousMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(previousMode) })

	router := gin.New()
	router.Use(ContentResponseLifecycle)
	router.POST("/api/search/searchEmbedBlock", searchEmbedBlock)
	for _, test := range []struct {
		name     string
		notebook any
	}{
		{name: "wrong type", notebook: 1},
		{name: "invalid id", notebook: "../../etc/passwd"},
		{name: "not found", notebook: missingID},
		{name: "encrypted locked", notebook: encryptedID},
	} {
		t.Run(test.name, func(t *testing.T) {
			body, err := json.Marshal(map[string]any{
				"embedBlockID": "20990101120000-embed01",
				"stmt":         "SELECT * FROM blocks",
				"excludeIDs":   []string{},
				"notebook":     test.notebook,
			})
			if err != nil {
				t.Fatal(err)
			}
			request := httptest.NewRequest(http.MethodPost, "/api/search/searchEmbedBlock", bytes.NewReader(body))
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			if response.Code != http.StatusOK {
				t.Fatalf("HTTP status = %d, want 200", response.Code)
			}
			var result struct {
				Code int    `json:"code"`
				Msg  string `json:"msg"`
			}
			if err = json.Unmarshal(response.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			if result.Code != -1 || result.Msg == "" {
				t.Fatalf("result = %+v, want Code=-1 with message", result)
			}
		})
	}
}

func TestGetEmbedBlockFailsClosedForEncryptedNotebook(t *testing.T) {
	_, encryptedID, _ := setupNotebookArgTest(t)
	previousMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(previousMode) })

	router := gin.New()
	router.Use(ContentResponseLifecycle)
	router.POST("/api/search/getEmbedBlock", getEmbedBlock)
	body, err := json.Marshal(map[string]any{
		"embedBlockID": "20990101120000-embed01",
		"includeIDs":   []string{"20990101120000-block01"},
		"notebook":     encryptedID,
	})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/search/getEmbedBlock", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("HTTP status = %d, want 200", response.Code)
	}
	var result struct {
		Code int    `json:"code"`
		Msg  string `json:"msg"`
	}
	if err = json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Code != -1 || result.Msg == "" {
		t.Fatalf("result = %+v, want Code=-1 with message", result)
	}
}

func TestBlockSearchRejectsInvalidExplicitNotebookScope(t *testing.T) {
	_, _, missingID := setupNotebookArgTest(t)
	previousMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(previousMode) })

	router := gin.New()
	router.Use(ContentResponseLifecycle)
	router.POST("/api/search/searchRefBlock", searchRefBlock)
	router.POST("/api/search/fullTextSearchBlock", fullTextSearchBlock)

	for _, test := range []struct {
		name         string
		path         string
		body         map[string]any
		errorMessage string
	}{
		{
			name: "reference search wrong type", path: "/api/search/searchRefBlock",
			body:         map[string]any{"reqId": 1, "id": "20990101120000-block01", "rootID": "20990101120000-root001", "k": "", "beforeLen": 12, "notebook": 1},
			errorMessage: model.ErrInvalidID.Error(),
		},
		{
			name: "reference search missing notebook", path: "/api/search/searchRefBlock",
			body:         map[string]any{"reqId": 1, "id": "20990101120000-block01", "rootID": "20990101120000-root001", "k": "", "beforeLen": 12, "notebook": missingID},
			errorMessage: model.ErrBoxNotFound.Error(),
		},
		{
			name: "full text search wrong type", path: "/api/search/fullTextSearchBlock",
			body:         map[string]any{"query": "knowledge", "page": 1, "pageSize": 32, "method": 0, "notebook": 1},
			errorMessage: model.ErrInvalidID.Error(),
		},
		{
			name: "full text search missing notebook", path: "/api/search/fullTextSearchBlock",
			body:         map[string]any{"query": "knowledge", "page": 1, "pageSize": 32, "method": 0, "notebook": missingID},
			errorMessage: model.ErrBoxNotFound.Error(),
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			body, err := json.Marshal(test.body)
			if err != nil {
				t.Fatal(err)
			}
			request := httptest.NewRequest(http.MethodPost, test.path, bytes.NewReader(body))
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			if response.Code != http.StatusOK {
				t.Fatalf("HTTP status = %d, want 200", response.Code)
			}
			var result struct {
				Code int    `json:"code"`
				Msg  string `json:"msg"`
			}
			if err = json.Unmarshal(response.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			if result.Code != -1 || !strings.Contains(result.Msg, test.errorMessage) {
				t.Fatalf("result = %+v, want Code=-1 containing %q", result, test.errorMessage)
			}
		})
	}
}
