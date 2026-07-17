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
	"time"

	"github.com/88250/lute/ast"
	"github.com/88250/lute/render"
	"github.com/gin-gonic/gin"
	"github.com/siyuan-note/siyuan/kernel/conf"
	"github.com/siyuan-note/siyuan/kernel/model"
	"github.com/siyuan-note/siyuan/kernel/treenode"
	"github.com/siyuan-note/siyuan/kernel/util"
)

func TestHistoryHTTPGetReadsDeletedOrdinaryOwnerAndRejectsMismatchedOwner(t *testing.T) {
	previousWorkspaceDir := util.WorkspaceDir
	previousDataDir := util.DataDir
	previousHistoryDir := util.HistoryDir
	previousConf := model.Conf
	workspace := t.TempDir()
	util.WorkspaceDir = workspace
	util.DataDir = filepath.Join(workspace, "data")
	util.HistoryDir = filepath.Join(workspace, "history")
	model.Conf = model.NewAppConf()
	model.Conf.Editor = conf.NewEditor()
	model.Conf.Export = conf.NewExport()
	model.Conf.FileTree = conf.NewFileTree()
	if err := os.MkdirAll(util.DataDir, 0755); err != nil {
		t.Fatalf("create deleted history data directory: %v", err)
	}
	t.Cleanup(func() {
		model.Conf = previousConf
		util.HistoryDir = previousHistoryDir
		util.DataDir = previousDataDir
		util.WorkspaceDir = previousWorkspaceDir
	})

	const (
		deletedNotebook = "20990717181000-deleted"
		otherNotebook   = "20990717181001-deleted"
		rootID          = "20990717181002-history"
		bodyText        = "deleted ordinary history remains readable"
	)
	if model.Conf.GetBox(deletedNotebook) != nil {
		t.Fatal("deleted history owner unexpectedly exists in current notebook configuration")
	}
	historyFile := filepath.Join(util.HistoryDir, "2099-07-17-181000-update", deletedNotebook, rootID+".sy")
	if err := os.MkdirAll(filepath.Dir(historyFile), 0755); err != nil {
		t.Fatalf("create deleted notebook history directory: %v", err)
	}
	tree := treenode.NewTree(deletedNotebook, "/"+rootID+".sy", "/Deleted history", "Deleted history")
	tree.Root.FirstChild.AppendChild(&ast.Node{Type: ast.NodeText, Tokens: []byte(bodyText)})
	luteEngine := util.NewLute()
	data := render.NewJSONRenderer(tree, luteEngine.RenderOptions, luteEngine.ParseOptions).Render()
	if err := os.WriteFile(historyFile, data, 0644); err != nil {
		t.Fatalf("write deleted notebook history document: %v", err)
	}
	historyPath, err := filepath.Rel(util.WorkspaceDir, historyFile)
	if err != nil {
		t.Fatalf("resolve deleted notebook history request path: %v", err)
	}

	previousMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(previousMode) })
	router := gin.New()
	router.Use(ContentResponseLifecycle)
	router.POST("/api/history/getDocHistoryContent", getDocHistoryContent)

	requestHistory := func(notebook string) (result struct {
		Code int    `json:"code"`
		Msg  string `json:"msg"`
		Data struct {
			RootID  string `json:"rootID"`
			Content string `json:"content"`
		} `json:"data"`
	}) {
		payload, marshalErr := json.Marshal(map[string]any{"notebook": notebook, "historyPath": filepath.ToSlash(historyPath)})
		if marshalErr != nil {
			t.Fatal(marshalErr)
		}
		request := httptest.NewRequest(http.MethodPost, "/api/history/getDocHistoryContent", bytes.NewReader(payload))
		request.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		if unmarshalErr := json.Unmarshal(response.Body.Bytes(), &result); unmarshalErr != nil {
			t.Fatalf("decode history content response: %v", unmarshalErr)
		}
		return
	}

	result := requestHistory(deletedNotebook)
	if result.Code != 0 || result.Data.RootID != rootID || !strings.Contains(result.Data.Content, bodyText) {
		t.Fatalf("deleted owner history response = %#v, want readable document %s", result, rootID)
	}
	mismatch := requestHistory(otherNotebook)
	if mismatch.Code == 0 || !strings.Contains(mismatch.Msg, "does not belong to notebook") || mismatch.Data.Content != "" {
		t.Fatalf("mismatched history owner response = %#v, want strict owner rejection", mismatch)
	}
}

func TestHistoryRollbackAllowsDeletedOrdinaryOwnerIdentity(t *testing.T) {
	previousWorkspaceDir := util.WorkspaceDir
	previousHistoryDir := util.HistoryDir
	previousConf := model.Conf
	util.WorkspaceDir = t.TempDir()
	util.HistoryDir = filepath.Join(util.WorkspaceDir, "history")
	model.Conf = model.NewAppConf()
	t.Cleanup(func() {
		model.Conf = previousConf
		util.HistoryDir = previousHistoryDir
		util.WorkspaceDir = previousWorkspaceDir
	})

	previousMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(previousMode) })
	router := gin.New()
	router.Use(ContentResponseLifecycle)
	router.POST("/api/history/rollbackDocHistory", rollbackDocHistory)
	body, err := json.Marshal(map[string]any{
		"historyPath": "history/2099-07-17-update/20990717180800-deleted/20990717180801-history.sy",
		"notebook":    "20990717180800-deleted",
	})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/history/rollbackDocHistory", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)

	var result struct {
		Code int    `json:"code"`
		Msg  string `json:"msg"`
	}
	if err = json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatalf("decode rollback response: %v", err)
	}
	if result.Code == 0 || !strings.Contains(result.Msg, "not exist") || strings.Contains(result.Msg, model.ErrBoxNotFound.Error()) {
		t.Fatalf("rollback response = %#v, want deleted ordinary owner to reach history metadata validation", result)
	}
}

func TestHistoryHTTPRejectsInvalidNotebookWithoutData(t *testing.T) {
	previousDataDir := util.DataDir
	previousConf := model.Conf
	util.DataDir = t.TempDir()
	model.Conf = model.NewAppConf()
	model.Conf.FileTree = conf.NewFileTree()
	t.Cleanup(func() {
		model.Conf = previousConf
		util.DataDir = previousDataDir
	})

	previousMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(previousMode) })

	endpoints := []struct {
		name    string
		path    string
		handler gin.HandlerFunc
	}{
		{name: "search", path: "/api/history/searchHistory", handler: searchHistory},
		{name: "items", path: "/api/history/getHistoryItems", handler: getHistoryItems},
	}
	invalidNotebooks := []struct {
		name  string
		value any
		want  string
	}{
		{name: "non-string", value: 1, want: model.ErrInvalidID.Error()},
		{name: "null", value: nil, want: model.ErrInvalidID.Error()},
		{name: "empty", value: "", want: model.ErrInvalidID.Error()},
		{name: "malformed", value: "invalid", want: model.ErrInvalidID.Error()},
		{name: "not-found", value: "20990717130100-missing", want: model.ErrBoxNotFound.Error()},
	}
	for _, endpoint := range endpoints {
		for _, invalidNotebook := range invalidNotebooks {
			t.Run(endpoint.name+"/"+invalidNotebook.name, func(t *testing.T) {
				router := gin.New()
				router.POST(endpoint.path, endpoint.handler)
				payload := map[string]any{"notebook": invalidNotebook.value}
				if endpoint.name == "items" {
					payload["created"] = "1"
				}
				body, err := json.Marshal(payload)
				if err != nil {
					t.Fatal(err)
				}
				request := httptest.NewRequest(http.MethodPost, endpoint.path, bytes.NewReader(body))
				request.Header.Set("Content-Type", "application/json")
				response := httptest.NewRecorder()
				router.ServeHTTP(response, request)

				var result struct {
					Code int             `json:"code"`
					Msg  string          `json:"msg"`
					Data json.RawMessage `json:"data"`
				}
				if err = json.Unmarshal(response.Body.Bytes(), &result); err != nil {
					t.Fatalf("decode history response: %v", err)
				}
				if result.Code == 0 || !strings.Contains(result.Msg, invalidNotebook.want) {
					t.Fatalf("history response = %#v, want error containing %q", result, invalidNotebook.want)
				}
				if len(result.Data) != 0 && string(result.Data) != "null" {
					t.Fatalf("history response exposed data after invalid notebook: %s", result.Data)
				}
			})
		}
	}
}

func TestHistoryHTTPRegistersSelectedOrAllNotebookResponseGates(t *testing.T) {
	previousMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(previousMode) })

	endpoints := []struct {
		name    string
		path    string
		handler gin.HandlerFunc
		payload map[string]any
	}{
		{name: "search", path: "/api/history/searchHistory", handler: searchHistory, payload: map[string]any{}},
		{name: "items", path: "/api/history/getHistoryItems", handler: getHistoryItems, payload: map[string]any{"created": "1"}},
	}
	for _, endpoint := range endpoints {
		for _, scope := range []struct {
			name             string
			explicitNotebook bool
			blockedBox       int
		}{
			{name: "selected notebook only", explicitNotebook: true, blockedBox: 0},
			{name: "all notebooks when omitted", blockedBox: 1},
		} {
			t.Run(endpoint.name+"/"+scope.name, func(t *testing.T) {
				boxIDs := setupEncryptedResponseTest(t, 2)
				payload := make(map[string]any, len(endpoint.payload)+1)
				for key, value := range endpoint.payload {
					payload[key] = value
				}
				if scope.explicitNotebook {
					payload["notebook"] = boxIDs[0]
				}
				body, err := json.Marshal(payload)
				if err != nil {
					t.Fatal(err)
				}

				router := gin.New()
				router.Use(ContentResponseLifecycle)
				router.POST(endpoint.path, endpoint.handler)
				request := httptest.NewRequest(http.MethodPost, endpoint.path, bytes.NewReader(body))
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
				waitResponseTestSignal(t, writer.writeStarted, "history response did not reach JSON serialization")

				blockedWrites := make(chan string, 2)
				restoreObserver := model.SetBoxResponseWriteBlockedObserverForTest(func(boxID string) {
					blockedWrites <- boxID
				})
				t.Cleanup(restoreObserver)

				blockedID := boxIDs[scope.blockedBox]
				blockedDone := make(chan error, 1)
				go func() { blockedDone <- model.LockBox(blockedID) }()
				waitHistoryResponseWriteBlocked(t, blockedWrites, blockedID)

				if scope.explicitNotebook {
					otherID := boxIDs[1]
					otherDone := make(chan error, 1)
					go func() { otherDone <- model.LockBox(otherID) }()
					if err = waitResponseTestError(t, otherDone, "unselected notebook remained blocked by selected history response"); err != nil {
						t.Fatalf("LockBox(%s) while another notebook serialized history: %v", otherID, err)
					}
				}

				writer.release()
				waitResponseTestSignal(t, requestDone, "history response did not complete")
				if err = waitResponseTestError(t, blockedDone, "LockBox did not complete after history JSON serialization"); err != nil {
					t.Fatalf("LockBox(%s) after history JSON serialization: %v", blockedID, err)
				}
				if response := writer.Result(); response.StatusCode != http.StatusOK {
					t.Fatalf("history HTTP status = %d, want %d", response.StatusCode, http.StatusOK)
				}
				var result struct {
					Code int `json:"code"`
				}
				if err = json.Unmarshal(writer.Body.Bytes(), &result); err != nil {
					t.Fatalf("decode history response: %v", err)
				}
			})
		}
	}
}

func waitHistoryResponseWriteBlocked(t *testing.T, blockedWrites <-chan string, expectedBoxID string) {
	t.Helper()
	select {
	case boxID := <-blockedWrites:
		if boxID != expectedBoxID {
			t.Fatalf("blocked response write = %s, want %s", boxID, expectedBoxID)
		}
	case <-time.After(responseTestTimeout):
		t.Fatalf("LockBox(%s) was not blocked by the response write gate", expectedBoxID)
	}
}
