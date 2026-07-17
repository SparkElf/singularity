// SiYuan - Refactor your thinking
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

package mcp

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/88250/lute/ast"
	"github.com/gin-gonic/gin"
	kernelapi "github.com/siyuan-note/siyuan/kernel/api"
	"github.com/siyuan-note/siyuan/kernel/cache"
	kernelconf "github.com/siyuan-note/siyuan/kernel/conf"
	"github.com/siyuan-note/siyuan/kernel/filesys"
	"github.com/siyuan-note/siyuan/kernel/mcp/tools"
	"github.com/siyuan-note/siyuan/kernel/model"
	kernelsql "github.com/siyuan-note/siyuan/kernel/sql"
	"github.com/siyuan-note/siyuan/kernel/treenode"
	"github.com/siyuan-note/siyuan/kernel/util"
)

const (
	mcpResponseTestTimeout  = 5 * time.Second
	mcpResponseTestPassword = "mcp-response-contract-password"
)

type mcpRepoResponseFixture struct {
	boxID      string
	rootID     string
	fileID     string
	leftIndex  string
	rightIndex string
}

type blockingMCPResponseWriter struct {
	*httptest.ResponseRecorder
	writeStarted chan struct{}
	writeRelease chan struct{}
	startedOnce  sync.Once
	releaseOnce  sync.Once
}

func (writer *blockingMCPResponseWriter) Write(data []byte) (int, error) {
	writer.startedOnce.Do(func() { close(writer.writeStarted) })
	select {
	case <-writer.writeRelease:
		return writer.ResponseRecorder.Write(data)
	case <-time.After(mcpResponseTestTimeout):
		return 0, errors.New("MCP response writer release timed out")
	}
}

func (writer *blockingMCPResponseWriter) release() {
	writer.releaseOnce.Do(func() { close(writer.writeRelease) })
}

func TestMCPEncryptedExportBlocksLockUntilJSONCompletes(t *testing.T) {
	boxID, rootID := setupMCPEncryptedExport(t)
	previousMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(previousMode) })

	router := gin.New()
	router.Use(kernelapi.ContentResponseLifecycle)
	Serve(router)
	payload, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "tools/call",
		"params": map[string]any{
			"name": "export",
			"arguments": map[string]any{
				"action":   "md",
				"id":       rootID,
				"notebook": boxID,
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/mcp", bytes.NewReader(payload))
	request.RemoteAddr = "127.0.0.1:1234"
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Token mcp-response-test")
	request.Header.Set("MCP-Protocol-Version", ProtocolV20260728)
	request.Header.Set("Mcp-Method", "tools/call")
	writer := &blockingMCPResponseWriter{
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
	waitMCPSignal(t, writer.writeStarted, "MCP response did not reach JSON serialization")

	lockDone := make(chan error, 1)
	writeBlocked := observeMCPBoxResponseWriteBlocked(t, boxID)
	go func() { lockDone <- model.LockBox(boxID) }()
	waitMCPSignal(t, writeBlocked, "LockBox was not blocked by the MCP response gate")

	writer.release()
	waitMCPSignal(t, requestDone, "MCP request did not complete")
	select {
	case err = <-lockDone:
		if err != nil {
			t.Fatalf("LockBox after MCP JSON completed: %v", err)
		}
	case <-time.After(mcpResponseTestTimeout):
		t.Fatal("LockBox did not complete after MCP JSON")
	}

	var response JsonRpcResponse
	if err = json.Unmarshal(writer.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode MCP response: %v", err)
	}
	encodedResult, err := json.Marshal(response.Result)
	if err != nil {
		t.Fatal(err)
	}
	var result tools.CallToolResult
	if err = json.Unmarshal(encodedResult, &result); err != nil {
		t.Fatalf("decode MCP tool result: %v", err)
	}
	if result.IsError || len(result.Content) != 1 || !strings.Contains(result.Content[0].Text, "MCP plaintext response contract") {
		t.Fatalf("MCP export result = %#v, want decrypted document", result)
	}
}

func TestMCPEncryptedDocumentAndHistoryResponsesHoldGateUntilJSONCompletes(t *testing.T) {
	tests := []struct {
		name      string
		tool      string
		arguments func(t *testing.T, boxID, rootID string) map[string]any
		wantText  string
	}{
		{
			name: "document list selected notebook",
			tool: "document",
			arguments: func(_ *testing.T, boxID, _ string) map[string]any {
				return map[string]any{"action": "list", "notebook": boxID}
			},
			wantText: "Documents in",
		},
		{
			name: "history list selected notebook",
			tool: "history",
			arguments: func(_ *testing.T, boxID, _ string) map[string]any {
				return map[string]any{"action": "list", "notebook": boxID}
			},
			wantText: "no history found",
		},
		{
			name: "history search all notebooks",
			tool: "history",
			arguments: func(_ *testing.T, _, _ string) map[string]any {
				return map[string]any{"action": "search", "query": "missing-contract"}
			},
			wantText: "no history found",
		},
		{
			name: "history get selected notebook",
			tool: "history",
			arguments: func(t *testing.T, boxID, rootID string) map[string]any {
				return map[string]any{"action": "get", "notebook": boxID, "path": writeMCPHistoryFixture(t, boxID, rootID)}
			},
			wantText: "MCP plaintext response contract",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			boxID, rootID := setupMCPEncryptedExport(t)
			request := newMCPToolCallRequest(t, test.tool, test.arguments(t, boxID, rootID))
			router := gin.New()
			router.Use(kernelapi.ContentResponseLifecycle)
			Serve(router)
			writer := &blockingMCPResponseWriter{
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
			waitMCPSignal(t, writer.writeStarted, "MCP content response did not reach JSON serialization")

			lockDone := make(chan error, 1)
			writeBlocked := observeMCPBoxResponseWriteBlocked(t, boxID)
			go func() { lockDone <- model.LockBox(boxID) }()
			waitMCPSignal(t, writeBlocked, "LockBox was not blocked by the MCP content response")

			writer.release()
			waitMCPSignal(t, requestDone, "MCP content request did not complete")
			select {
			case err := <-lockDone:
				if err != nil {
					t.Fatalf("LockBox after MCP content response: %v", err)
				}
			case <-time.After(mcpResponseTestTimeout):
				t.Fatal("LockBox did not complete after MCP content response")
			}

			result := decodeMCPToolResult(t, writer.Body.Bytes())
			if result.IsError || len(result.Content) != 1 || !strings.Contains(result.Content[0].Text, test.wantText) {
				t.Fatalf("MCP %s result = %#v, want successful text containing %q", test.tool, result, test.wantText)
			}
		})
	}
}

func TestMCPManagedBinaryExportPreflightLeavesResponseGateToClaim(t *testing.T) {
	for _, action := range []string{"sy", "md-zip"} {
		t.Run(action, func(t *testing.T) {
			boxID, rootID := setupMCPEncryptedExport(t)
			req := &JsonRpcRequest{
				JsonRpc: "2.0",
				ID:      float64(1),
				Method:  "tools/call",
				Params: map[string]any{
					"name": "export",
					"arguments": map[string]any{
						"action": action, "id": rootID, "notebook": boxID,
					},
				},
			}
			prepared := make(chan struct{})
			release := make(chan struct{})
			var releaseOnce sync.Once
			releaseHandler := func() { releaseOnce.Do(func() { close(release) }) }
			t.Cleanup(releaseHandler)
			router := gin.New()
			router.Use(kernelapi.ContentResponseLifecycle)
			router.POST("/preflight", func(context *gin.Context) {
				if !prepareContentResponse(context, req) {
					return
				}
				close(prepared)
				<-release
				context.Status(http.StatusNoContent)
			})
			requestDone := make(chan struct{})
			go func() {
				router.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/preflight", nil))
				close(requestDone)
			}()
			waitMCPSignal(t, prepared, "managed export preflight did not complete")

			lockDone := make(chan error, 1)
			go func() { lockDone <- model.LockBox(boxID) }()
			select {
			case err := <-lockDone:
				if err != nil {
					t.Fatalf("LockBox while managed export preflight was paused: %v", err)
				}
			case <-time.After(mcpResponseTestTimeout):
				releaseHandler()
				waitMCPSignal(t, requestDone, "managed export preflight did not release after timeout")
				t.Fatal("managed export preflight retained an outer response gate")
			}
			releaseHandler()
			waitMCPSignal(t, requestDone, "managed export preflight request did not finish")
		})
	}
}

func TestMCPEncryptedRepoResponsesHoldGateUntilJSONCompletes(t *testing.T) {
	fixture := setupMCPEncryptedRepoResponse(t)
	router := gin.New()
	router.Use(kernelapi.ContentResponseLifecycle)
	Serve(router)
	tests := []struct {
		name      string
		arguments map[string]any
		wantText  string
	}{
		{
			name:      "open snapshot",
			arguments: map[string]any{"action": "file_open", "id": fixture.fileID},
			wantText:  "MCP repository response v2",
		},
		{
			name: "diff snapshots",
			arguments: map[string]any{
				"action": "diff", "left": fixture.leftIndex, "right": fixture.rightIndex,
			},
			wantText: "MCP Response Contract",
		},
		{
			name:      "search snapshots",
			arguments: map[string]any{"action": "search", "keyword": fixture.rootID, "page": float64(1)},
			wantText:  "MCP Response Contract",
		},
		{
			name:      "export snapshot",
			arguments: map[string]any{"action": "file_export", "id": fixture.fileID},
			wantText:  "/export/managed/",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			defer func() {
				if model.IsBoxUnlocked(fixture.boxID) {
					return
				}
				boxCrypt := (&model.Box{ID: fixture.boxID}).GetConf().BoxCrypt
				if err := model.UnlockBox(fixture.boxID, mcpResponseTestPassword, boxCrypt); err != nil {
					t.Errorf("unlock MCP repository response notebook: %v", err)
				}
			}()

			request := newMCPToolCallRequest(t, "repo", test.arguments)
			writer := &blockingMCPResponseWriter{
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
			waitMCPSignal(t, writer.writeStarted, "MCP repository response did not reach JSON serialization")

			lockDone := make(chan error, 1)
			writeBlocked := observeMCPBoxResponseWriteBlocked(t, fixture.boxID)
			go func() { lockDone <- model.LockBox(fixture.boxID) }()
			waitMCPSignal(t, writeBlocked, "LockBox was not blocked by the MCP repository response gate")

			writer.release()
			waitMCPSignal(t, requestDone, "MCP repository request did not complete")
			select {
			case err := <-lockDone:
				if err != nil {
					t.Fatalf("LockBox after MCP repository response: %v", err)
				}
			case <-time.After(mcpResponseTestTimeout):
				t.Fatal("LockBox did not complete after MCP repository JSON")
			}

			result := decodeMCPToolResult(t, writer.Body.Bytes())
			if result.IsError || len(result.Content) != 1 || !strings.Contains(result.Content[0].Text, test.wantText) {
				t.Fatalf("MCP repository result = %#v, want successful text containing %q", result, test.wantText)
			}
		})
	}
}

func setupMCPEncryptedRepoResponse(t *testing.T) mcpRepoResponseFixture {
	t.Helper()
	boxID, rootID := setupMCPEncryptedExport(t)
	previousRepoDir := util.RepoDir
	util.RepoDir = filepath.Join(util.WorkspaceDir, "repo")
	t.Cleanup(func() { util.RepoDir = previousRepoDir })
	model.Conf.Repo = kernelconf.NewRepo()
	model.Conf.Repo.Key = bytes.Repeat([]byte{0x5a}, 32)

	rightIndex, err := model.IndexRepo("MCP encrypted repository response v1")
	if err != nil {
		t.Fatalf("index first MCP repository snapshot: %v", err)
	}
	treePath := "/" + rootID + ".sy"
	tree, err := filesys.LoadTree(boxID, treePath, util.NewLute())
	if err != nil {
		t.Fatalf("load MCP repository response tree: %v", err)
	}
	paragraph := tree.Root.FirstChild
	if paragraph == nil || paragraph.FirstChild == nil {
		t.Fatal("MCP repository response tree has no paragraph text")
	}
	paragraph.FirstChild.Tokens = []byte("MCP repository response v2")
	if _, err = filesys.WriteTree(tree); err != nil {
		t.Fatalf("write updated MCP repository response tree: %v", err)
	}
	updated := time.Now().Add(2 * time.Second)
	if err = os.Chtimes(filepath.Join(util.DataDir, boxID, rootID+".sy"), updated, updated); err != nil {
		t.Fatalf("set MCP repository response tree timestamp: %v", err)
	}
	cache.RemoveTreeDataInBox(rootID, boxID)
	leftIndex, err := model.IndexRepo("MCP encrypted repository response v2")
	if err != nil {
		t.Fatalf("index second MCP repository snapshot: %v", err)
	}
	if leftIndex == rightIndex {
		t.Fatal("MCP repository response fixture did not create distinct snapshots")
	}

	files, _, _, err := model.SearchRepoFile(rootID, 1)
	if err != nil {
		t.Fatalf("find MCP repository response file: %v", err)
	}
	for _, file := range files {
		if strings.HasPrefix(strings.TrimPrefix(file.Path, "/"), boxID+"/") {
			if file.Notebook != boxID {
				t.Fatalf("encrypted repository search notebook = %q, want %q", file.Notebook, boxID)
			}
			if file.HPath != file.Path {
				t.Fatalf("encrypted repository search hpath = %q, want store-local snapshot path %q", file.HPath, file.Path)
			}
			return mcpRepoResponseFixture{
				boxID: boxID, rootID: rootID, fileID: file.FileID, leftIndex: leftIndex, rightIndex: rightIndex,
			}
		}
	}
	t.Fatal("MCP repository response fixture has no encrypted snapshot file")
	return mcpRepoResponseFixture{}
}

func setupMCPEncryptedExport(t *testing.T) (boxID, rootID string) {
	t.Helper()
	originalWorkspaceDir := util.WorkspaceDir
	originalHistoryDir := util.HistoryDir
	originalDataDir := util.DataDir
	originalTempDir := util.TempDir
	originalQueueDir := util.QueueDir
	originalConfDir := util.ConfDir
	originalDBPath := util.DBPath
	originalHistoryDBPath := util.HistoryDBPath
	originalAssetContentDBPath := util.AssetContentDBPath
	originalBlockTreeDBPath := util.BlockTreeDBPath
	originalConf := model.Conf
	originalIsExiting := util.IsExiting.Load()
	originalReadOnly := util.ReadOnly
	originalTimeLang, hadOriginalTimeLang := util.TimeLangs["mcp-response-test"]

	tempRoot := t.TempDir()
	util.WorkspaceDir = tempRoot
	util.HistoryDir = filepath.Join(tempRoot, "history")
	util.DataDir = filepath.Join(tempRoot, "data")
	util.TempDir = filepath.Join(tempRoot, "temp")
	util.QueueDir = filepath.Join(util.TempDir, "queue")
	util.ConfDir = filepath.Join(tempRoot, "conf")
	util.DBPath = filepath.Join(util.TempDir, util.DBName)
	util.HistoryDBPath = filepath.Join(util.TempDir, "history.db")
	util.AssetContentDBPath = filepath.Join(util.TempDir, "asset_content.db")
	util.BlockTreeDBPath = filepath.Join(util.TempDir, "blocktree.db")
	for _, dir := range []string{util.HistoryDir, util.DataDir, util.TempDir, util.QueueDir, util.ConfDir} {
		if err := os.MkdirAll(dir, 0755); err != nil {
			t.Fatalf("create MCP response test directory %s: %v", dir, err)
		}
	}
	util.IsExiting.Store(false)
	util.ReadOnly = false
	model.Conf = model.NewAppConf()
	model.Conf.System = kernelconf.NewSystem()
	model.Conf.Sync = kernelconf.NewSync()
	model.Conf.FileTree = kernelconf.NewFileTree()
	model.Conf.Editor = kernelconf.NewEditor()
	model.Conf.Export = kernelconf.NewExport()
	model.Conf.Search = kernelconf.NewSearch()
	model.Conf.NotebookCrypto = kernelconf.NewNotebookCrypto()
	model.Conf.Api = kernelconf.NewAPI()
	model.Conf.Api.Token = "mcp-response-test"
	model.Conf.Lang = "mcp-response-test"
	util.TimeLangs[model.Conf.Lang] = map[string]any{
		"now": "now", "1s": "1 second", "xs": "%d seconds", "1m": "1 minute", "xm": "%d minutes",
		"xh": "%d minutes", "1h": "1 hour", "1d": "1 day", "xd": "%d days", "1w": "1 week",
		"xw": "%d weeks", "1M": "1 month", "xM": "%d months", "1y": "1 year", "2y": "2 years",
		"xy": "%d years", "max": "a long time", "albl": "ago", "blbl": "from now",
	}
	cache.ClearTreeCache()
	if err := kernelsql.ClearQueue(); err != nil {
		t.Fatalf("clear MCP response queue: %v", err)
	}
	if err := kernelsql.InitDatabase(true); err != nil {
		t.Fatalf("initialize MCP response content database: %v", err)
	}
	kernelsql.InitHistoryDatabase(true)
	kernelsql.InitAssetContentDatabase(true)
	t.Cleanup(func() {
		if boxID != "" {
			_ = model.LockBox(boxID)
		}
		if err := kernelsql.ClearQueue(); err != nil {
			t.Errorf("clear MCP response queue during cleanup: %v", err)
		}
		kernelsql.CloseDatabase()
		cache.ClearTreeCache()
		if hadOriginalTimeLang {
			util.TimeLangs["mcp-response-test"] = originalTimeLang
		} else {
			delete(util.TimeLangs, "mcp-response-test")
		}
		model.Conf = originalConf
		util.ReadOnly = originalReadOnly
		util.IsExiting.Store(originalIsExiting)
		util.BlockTreeDBPath = originalBlockTreeDBPath
		util.AssetContentDBPath = originalAssetContentDBPath
		util.HistoryDBPath = originalHistoryDBPath
		util.DBPath = originalDBPath
		util.ConfDir = originalConfDir
		util.QueueDir = originalQueueDir
		util.TempDir = originalTempDir
		util.DataDir = originalDataDir
		util.HistoryDir = originalHistoryDir
		util.WorkspaceDir = originalWorkspaceDir
	})

	if err := model.EnableEncryptedNotebook(mcpResponseTestPassword); err != nil {
		t.Fatalf("enable encrypted notebooks: %v", err)
	}
	var err error
	boxID, err = model.CreateEncryptedBox("MCP Response Contract", mcpResponseTestPassword)
	if err != nil {
		t.Fatalf("create encrypted notebook: %v", err)
	}
	if _, err = model.Mount(boxID); err != nil {
		t.Fatalf("open encrypted MCP response notebook: %v", err)
	}
	rootID = "20990717120000-mcpresp"
	treePath := "/" + rootID + ".sy"
	tree := treenode.NewTree(boxID, treePath, "/MCP Response Contract", "MCP Response Contract")
	tree.Root.FirstChild.Unlink()
	tree.ID = rootID
	tree.Root.ID = rootID
	tree.Root.Box = boxID
	tree.Root.Path = treePath
	tree.Root.SetIALAttr("id", rootID)
	tree.Root.SetIALAttr("updated", rootID[:14])
	paragraphID := "20990717120001-mcpresp"
	paragraph := &ast.Node{Type: ast.NodeParagraph, ID: paragraphID, Box: boxID, Path: treePath}
	paragraph.SetIALAttr("id", paragraphID)
	paragraph.SetIALAttr("updated", paragraphID[:14])
	paragraph.AppendChild(&ast.Node{Type: ast.NodeText, Tokens: []byte("MCP plaintext response contract")})
	tree.Root.AppendChild(paragraph)
	if _, err = filesys.WriteTree(tree); err != nil {
		t.Fatalf("write encrypted MCP response tree: %v", err)
	}
	if err = treenode.UpsertBlockTree(tree); err != nil {
		t.Fatalf("index encrypted MCP response tree: %v", err)
	}
	cache.RemoveTreeDataInBox(rootID, boxID)
	return boxID, rootID
}

func newMCPToolCallRequest(t *testing.T, tool string, arguments map[string]any) *http.Request {
	t.Helper()
	payload, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "tools/call",
		"params":  map[string]any{"name": tool, "arguments": arguments},
	})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/mcp", bytes.NewReader(payload))
	request.RemoteAddr = "127.0.0.1:1234"
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Token mcp-response-test")
	request.Header.Set("MCP-Protocol-Version", ProtocolV20260728)
	request.Header.Set("Mcp-Method", "tools/call")
	return request
}

func decodeMCPToolResult(t *testing.T, payload []byte) tools.CallToolResult {
	t.Helper()
	var response JsonRpcResponse
	if err := json.Unmarshal(payload, &response); err != nil {
		t.Fatalf("decode MCP response: %v", err)
	}
	encodedResult, err := json.Marshal(response.Result)
	if err != nil {
		t.Fatal(err)
	}
	var result tools.CallToolResult
	if err = json.Unmarshal(encodedResult, &result); err != nil {
		t.Fatalf("decode MCP tool result: %v", err)
	}
	return result
}

func writeMCPHistoryFixture(t *testing.T, boxID, rootID string) string {
	t.Helper()
	source := filepath.Join(util.DataDir, boxID, rootID+".sy")
	ciphertext, err := os.ReadFile(source)
	if err != nil {
		t.Fatalf("read encrypted MCP document for history: %v", err)
	}
	historyFile := filepath.Join(util.HistoryDir, "2099-07-17-120000-update", boxID, rootID+".sy")
	if err = os.MkdirAll(filepath.Dir(historyFile), 0755); err != nil {
		t.Fatalf("create MCP history fixture directory: %v", err)
	}
	if err = os.WriteFile(historyFile, ciphertext, 0600); err != nil {
		t.Fatalf("write MCP history fixture: %v", err)
	}
	requestPath, err := filepath.Rel(util.WorkspaceDir, historyFile)
	if err != nil {
		t.Fatalf("resolve MCP history request path: %v", err)
	}
	return filepath.ToSlash(requestPath)
}

func waitMCPSignal(t *testing.T, signal <-chan struct{}, failure string) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(mcpResponseTestTimeout):
		t.Fatal(failure)
	}
}

func observeMCPBoxResponseWriteBlocked(t *testing.T, boxID string) <-chan struct{} {
	t.Helper()
	blocked := make(chan struct{})
	var once sync.Once
	restore := model.SetBoxResponseWriteBlockedObserverForTest(func(blockedBoxID string) {
		if blockedBoxID == boxID {
			once.Do(func() { close(blocked) })
		}
	})
	t.Cleanup(restore)
	return blocked
}
