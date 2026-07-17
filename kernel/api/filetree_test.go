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

	"github.com/gin-gonic/gin"
	kernelconf "github.com/siyuan-note/siyuan/kernel/conf"
	"github.com/siyuan-note/siyuan/kernel/model"
	"github.com/siyuan-note/siyuan/kernel/treenode"
	"github.com/siyuan-note/siyuan/kernel/util"
)

func TestGetHPathByIDUsesDeclaredNotebook(t *testing.T) {
	encryptedID := setupEncryptedResponseTest(t, 1)[0]
	util.SetBooted()
	const (
		ordinaryID      = "20990717210000-normal1"
		otherOrdinaryID = "20990717210001-normal2"
		rootID          = "20990717210002-hpath01"
		blockID         = "20990717210003-hpath01"
	)
	for _, boxID := range []string{ordinaryID, otherOrdinaryID} {
		boxConf := kernelconf.NewBoxConf()
		boxConf.Name = boxID
		if err := (&model.Box{ID: boxID}).SaveConf(boxConf); err != nil {
			t.Fatalf("create ordinary notebook fixture %s: %v", boxID, err)
		}
	}
	for _, fixture := range []struct {
		boxID    string
		notebook string
		title    string
	}{
		{boxID: ordinaryID, title: "Ordinary HPath"},
		{boxID: otherOrdinaryID, title: "Other Ordinary HPath"},
		{boxID: encryptedID, notebook: encryptedID, title: "Encrypted HPath"},
	} {
		tree := treenode.NewTree(fixture.boxID, "/"+rootID+".sy", "/"+fixture.title, fixture.title)
		tree.Root.FirstChild.ID = blockID
		tree.Root.FirstChild.SetIALAttr("id", blockID)
		tree.Root.FirstChild.SetIALAttr("updated", blockID[:14])
		if err := model.PerformTxSync(&model.Transaction{
			Notebook: fixture.notebook, DoOperations: []*model.Operation{{Action: "create", Data: tree}},
		}); err != nil {
			t.Fatalf("create %s fixture: %v", fixture.title, err)
		}
	}

	previousMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(previousMode) })
	router := gin.New()
	router.Use(ContentResponseLifecycle)
	router.POST("/api/filetree/getHPathByID", getHPathByID)
	post := func(notebook any, includeNotebook bool) (result struct {
		Code int    `json:"code"`
		Msg  string `json:"msg"`
		Data string `json:"data"`
	}) {
		t.Helper()
		payload := map[string]any{"id": rootID}
		if includeNotebook {
			payload["notebook"] = notebook
		}
		body, err := json.Marshal(payload)
		if err != nil {
			t.Fatal(err)
		}
		request := httptest.NewRequest(http.MethodPost, "/api/filetree/getHPathByID", bytes.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		if err = json.Unmarshal(response.Body.Bytes(), &result); err != nil {
			t.Fatalf("decode HPath response: %v", err)
		}
		return
	}

	for _, test := range []struct {
		name     string
		notebook any
		include  bool
		want     string
		wantErr  string
	}{
		{name: "ordinary", notebook: ordinaryID, include: true, want: "/Ordinary HPath"},
		{name: "other ordinary", notebook: otherOrdinaryID, include: true, want: "/Other Ordinary HPath"},
		{name: "encrypted", notebook: encryptedID, include: true, want: "/Encrypted HPath"},
		{name: "missing notebook", wantErr: model.ErrInvalidID.Error()},
		{name: "malformed notebook", notebook: "invalid", include: true, wantErr: model.ErrInvalidID.Error()},
	} {
		t.Run(test.name, func(t *testing.T) {
			result := post(test.notebook, test.include)
			if test.wantErr != "" {
				if result.Code == 0 || !strings.Contains(result.Msg, test.wantErr) {
					t.Fatalf("HPath response = %#v, want error containing %q", result, test.wantErr)
				}
				return
			}
			if result.Code != 0 || result.Data != test.want {
				t.Fatalf("HPath response = %#v, want %q", result, test.want)
			}
		})
	}
}

func TestGetHPathByIDHoldsEncryptedResponseGate(t *testing.T) {
	boxID := setupEncryptedResponseTest(t, 1)[0]
	util.SetBooted()
	const rootID = "20990717210100-hpath02"
	tree := treenode.NewTree(boxID, "/"+rootID+".sy", "/Response Gate", "Response Gate")
	if err := model.PerformTxSync(&model.Transaction{
		Notebook: boxID, DoOperations: []*model.Operation{{Action: "create", Data: tree}},
	}); err != nil {
		t.Fatalf("create response gate fixture: %v", err)
	}

	previousMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(previousMode) })
	router := gin.New()
	router.Use(ContentResponseLifecycle)
	router.POST("/api/filetree/getHPathByID", getHPathByID)
	body, err := json.Marshal(map[string]string{"id": rootID, "notebook": boxID})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/filetree/getHPathByID", bytes.NewReader(body))
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
	waitResponseTestSignal(t, writer.writeStarted, "HPath response did not reach JSON serialization")

	lockDone := make(chan error, 1)
	writeBlocked := observeBoxResponseWriteBlocked(t, boxID)
	go func() { lockDone <- model.LockBox(boxID) }()
	waitResponseTestSignal(t, writeBlocked, "LockBox was not blocked by the HPath response gate")
	writer.release()
	waitResponseTestSignal(t, requestDone, "HPath response did not complete")
	if err = waitResponseTestError(t, lockDone, "LockBox did not complete after the HPath JSON body"); err != nil {
		t.Fatalf("LockBox after HPath response: %v", err)
	}
	var result struct {
		Code int    `json:"code"`
		Data string `json:"data"`
	}
	if err = json.Unmarshal(writer.Body.Bytes(), &result); err != nil {
		t.Fatalf("decode HPath response: %v", err)
	}
	if result.Code != 0 || result.Data != "/Response Gate" {
		t.Fatalf("HPath response = %#v, want encrypted HPath", result)
	}

	lockedRequest := httptest.NewRequest(http.MethodPost, "/api/filetree/getHPathByID", bytes.NewReader(body))
	lockedRequest.Header.Set("Content-Type", "application/json")
	lockedResponse := httptest.NewRecorder()
	router.ServeHTTP(lockedResponse, lockedRequest)
	var lockedResult struct {
		Code int    `json:"code"`
		Msg  string `json:"msg"`
	}
	if err = json.Unmarshal(lockedResponse.Body.Bytes(), &lockedResult); err != nil {
		t.Fatalf("decode locked HPath response: %v", err)
	}
	if lockedResult.Code == 0 {
		t.Fatalf("locked HPath response = %#v, want failure", lockedResult)
	}
}

func TestDuplicateDocRequiresExplicitExistingNotebook(t *testing.T) {
	_, _, missingID := setupNotebookArgTest(t)
	previousMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(previousMode) })

	router := gin.New()
	router.Use(ContentResponseLifecycle)
	router.POST("/api/filetree/duplicateDoc", duplicateDoc)

	tests := []struct {
		name        string
		notebook    any
		setNotebook bool
		want        string
	}{
		{name: "missing", want: model.ErrInvalidID.Error()},
		{name: "malformed", notebook: "not-a-notebook", setNotebook: true, want: model.ErrInvalidID.Error()},
		{name: "not found", notebook: missingID, setNotebook: true, want: model.ErrBoxNotFound.Error()},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			body := map[string]any{"id": "20990717160001-docone1"}
			if test.setNotebook {
				body["notebook"] = test.notebook
			}
			data, err := json.Marshal(body)
			if err != nil {
				t.Fatal(err)
			}
			request := httptest.NewRequest(http.MethodPost, "/api/filetree/duplicateDoc", bytes.NewReader(data))
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)

			var result struct {
				Code int    `json:"code"`
				Msg  string `json:"msg"`
			}
			if err = json.Unmarshal(response.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			if response.Code != http.StatusOK || result.Code != -1 || !strings.Contains(result.Msg, test.want) {
				t.Fatalf("duplicate response = status %d, %+v; want explicit error containing %q", response.Code, result, test.want)
			}
		})
	}
}
