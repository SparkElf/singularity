// SiYuan - Refactor your thinking
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

package api

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
	"github.com/88250/lute/render"
	"github.com/gin-gonic/gin"
	"github.com/siyuan-note/siyuan/kernel/cache"
	kernelconf "github.com/siyuan-note/siyuan/kernel/conf"
	"github.com/siyuan-note/siyuan/kernel/model"
	kernelsql "github.com/siyuan-note/siyuan/kernel/sql"
	"github.com/siyuan-note/siyuan/kernel/treenode"
	"github.com/siyuan-note/siyuan/kernel/util"
)

const responseTestTimeout = 5 * time.Second

type encryptedBoxCreateResult struct {
	id  string
	err error
}

type blockingResponseWriter struct {
	*httptest.ResponseRecorder
	writeStarted chan struct{}
	writeRelease chan struct{}
	startedOnce  sync.Once
	releaseOnce  sync.Once
}

func (writer *blockingResponseWriter) Write(data []byte) (int, error) {
	writer.startedOnce.Do(func() { close(writer.writeStarted) })
	select {
	case <-writer.writeRelease:
		return writer.ResponseRecorder.Write(data)
	case <-time.After(responseTestTimeout):
		return 0, errors.New("response writer release timed out")
	}
}

func (writer *blockingResponseWriter) release() {
	writer.releaseOnce.Do(func() { close(writer.writeRelease) })
}

func TestEncryptedExportResponseBlocksLockUntilJSONCompletes(t *testing.T) {
	boxIDs := setupEncryptedResponseTest(t, 1)
	encryptedID := boxIDs[0]
	const (
		rootID    = "20990716090000-respons"
		headingID = "20990716090001-respons"
		childID   = "20990716090002-respons"
	)
	treePath := "/" + rootID + ".sy"
	tree := treenode.NewTree(encryptedID, treePath, "/Response Contract", "Response Contract")
	tree.Root.FirstChild.Unlink()
	tree.Root.ID = rootID
	tree.ID = rootID
	tree.Root.SetIALAttr("id", rootID)
	heading := &ast.Node{Type: ast.NodeHeading, ID: headingID, Box: encryptedID, Path: treePath, HeadingLevel: 2}
	heading.SetIALAttr("id", headingID)
	heading.SetIALAttr("updated", headingID[:14])
	heading.AppendChild(&ast.Node{Type: ast.NodeText, Tokens: []byte("Encrypted response")})
	child := &ast.Node{Type: ast.NodeParagraph, ID: childID, Box: encryptedID, Path: treePath}
	child.SetIALAttr("id", childID)
	child.SetIALAttr("updated", childID[:14])
	child.AppendChild(&ast.Node{Type: ast.NodeText, Tokens: []byte("Plaintext response contract")})
	tree.Root.AppendChild(heading)
	tree.Root.AppendChild(child)
	tree.Root.Spec = "1"
	luteEngine := util.NewLute()
	plain := render.NewJSONRenderer(tree, luteEngine.RenderOptions, luteEngine.ParseOptions).Render()
	dek, err := model.GetDEK(encryptedID)
	if err != nil {
		t.Fatalf("get encrypted response fixture key: %v", err)
	}
	ciphertext, err := model.EncryptFile(encryptedID, treePath, dek, plain)
	clear(dek)
	if err != nil {
		t.Fatalf("encrypt response fixture tree: %v", err)
	}
	filePath := filepath.Join(util.DataDir, encryptedID, treePath)
	if err = os.MkdirAll(filepath.Dir(filePath), 0755); err != nil {
		t.Fatalf("create response fixture directory: %v", err)
	}
	if err = os.WriteFile(filePath, ciphertext, 0644); err != nil {
		t.Fatalf("write response fixture tree: %v", err)
	}
	if err = treenode.UpsertBlockTree(tree); err != nil {
		t.Fatalf("index encrypted response fixture tree: %v", err)
	}
	cache.RemoveTreeDataInBox(rootID, encryptedID)

	previousMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(previousMode) })

	router := gin.New()
	router.Use(ContentResponseLifecycle)
	router.POST("/api/export/exportMdContent", exportMdContent)

	body, err := json.Marshal(map[string]any{
		"id":                 rootID,
		"notebook":           encryptedID,
		"refMode":            3,
		"embedMode":          1,
		"yfm":                false,
		"fillCSSVar":         false,
		"adjustHeadingLevel": false,
	})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/export/exportMdContent", bytes.NewReader(body))
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
	waitResponseTestSignal(t, writer.writeStarted, "encrypted response did not reach JSON serialization")

	lockDone := make(chan error, 1)
	writeBlocked := observeBoxResponseWriteBlocked(t, encryptedID)
	go func() {
		lockDone <- model.LockBox(encryptedID)
	}()
	waitResponseTestSignal(t, writeBlocked, "LockBox was not blocked by the encrypted response gate")

	writer.release()
	waitResponseTestSignal(t, requestDone, "encrypted response did not complete")
	if err = waitResponseTestError(t, lockDone, "LockBox did not complete after the JSON body"); err != nil {
		t.Fatalf("LockBox after the JSON body completed: %v", err)
	}
	var result struct {
		Code int `json:"code"`
		Data struct {
			Content string `json:"content"`
		} `json:"data"`
	}
	if err = json.Unmarshal(writer.Body.Bytes(), &result); err != nil {
		t.Fatalf("decode encrypted response: %v", err)
	}
	if result.Code != 0 || !strings.Contains(result.Data.Content, "Plaintext response contract") {
		t.Fatalf("encrypted export response = %#v, want decrypted document content", result)
	}
}

func TestRecentDocsHoldEveryEncryptedResponseGateUntilJSONCompletes(t *testing.T) {
	boxIDs := setupEncryptedResponseTest(t, 2)
	secondEncryptedID := boxIDs[1]

	previousMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(previousMode) })

	router := gin.New()
	router.Use(ContentResponseLifecycle)
	router.POST("/api/storage/getRecentDocs", getRecentDocs)
	request := httptest.NewRequest(http.MethodPost, "/api/storage/getRecentDocs", nil)
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
	waitResponseTestSignal(t, writer.writeStarted, "recent-document response did not reach JSON serialization")

	lockDone := make(chan error, 1)
	writeBlocked := observeBoxResponseWriteBlocked(t, secondEncryptedID)
	go func() {
		lockDone <- model.LockBox(secondEncryptedID)
	}()
	waitResponseTestSignal(t, writeBlocked, "LockBox was not blocked by the recent-document response gate")

	createDone := make(chan encryptedBoxCreateResult, 1)
	controlBlocked := observeNotebookCryptoBlocked(t)
	go func() {
		id, err := model.CreateEncryptedBox("Membership Contract", "response-contract-password")
		createDone <- encryptedBoxCreateResult{id: id, err: err}
	}()
	waitResponseTestSignal(t, controlBlocked, "encrypted notebook creation was not blocked by the membership control gate")

	writer.release()
	waitResponseTestSignal(t, requestDone, "recent-document response did not complete")
	if err := waitResponseTestError(t, lockDone, "LockBox did not complete after the recent-document JSON body"); err != nil {
		t.Fatalf("LockBox after the recent-document JSON body completed: %v", err)
	}
	created := waitResponseTestCreate(t, createDone)
	if created.err != nil {
		t.Fatalf("create encrypted notebook after response membership release: %v", created.err)
	}
	t.Cleanup(func() { _ = model.LockBox(created.id) })
}

func TestEncryptedHistoryResponseBlocksLockUntilJSONCompletes(t *testing.T) {
	boxIDs := setupEncryptedResponseTest(t, 1)
	encryptedID := boxIDs[0]
	historyPath := writeEncryptedHistoryResponseFixture(t, encryptedID)

	previousMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(previousMode) })

	router := gin.New()
	router.Use(ContentResponseLifecycle)
	router.POST("/api/history/getDocHistoryContent", getDocHistoryContent)
	body, err := json.Marshal(map[string]any{
		"historyPath": historyPath,
		"notebook":    encryptedID,
	})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/history/getDocHistoryContent", bytes.NewReader(body))
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
	waitResponseTestSignal(t, writer.writeStarted, "encrypted history response did not reach JSON serialization")

	lockDone := make(chan error, 1)
	writeBlocked := observeBoxResponseWriteBlocked(t, encryptedID)
	go func() {
		lockDone <- model.LockBox(encryptedID)
	}()
	waitResponseTestSignal(t, writeBlocked, "LockBox was not blocked by the encrypted history response gate")

	writer.release()
	waitResponseTestSignal(t, requestDone, "encrypted history response did not complete")
	if err = waitResponseTestError(t, lockDone, "LockBox did not complete after the history JSON body"); err != nil {
		t.Fatalf("LockBox after the history JSON body completed: %v", err)
	}
	var result struct {
		Code int `json:"code"`
		Data struct {
			Content string `json:"content"`
		} `json:"data"`
	}
	if err = json.Unmarshal(writer.Body.Bytes(), &result); err != nil {
		t.Fatalf("decode encrypted history response: %v", err)
	}
	if result.Code != 0 || !strings.Contains(result.Data.Content, "Encrypted history response") {
		t.Fatalf("encrypted history response = %#v, want decrypted history content", result)
	}
}

func TestHistoryContentRequiresValidMatchingNotebookIdentity(t *testing.T) {
	boxIDs := setupEncryptedResponseTest(t, 2)
	historyPath := writeEncryptedHistoryResponseFixture(t, boxIDs[0])

	previousMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(previousMode) })
	router := gin.New()
	router.Use(ContentResponseLifecycle)
	router.POST("/api/history/getDocHistoryContent", getDocHistoryContent)

	tests := []struct {
		name       string
		notebook   any
		include    bool
		wantErrMsg string
	}{
		{name: "missing", include: false, wantErrMsg: model.ErrInvalidID.Error()},
		{name: "invalid", notebook: "invalid", include: true, wantErrMsg: model.ErrInvalidID.Error()},
		{name: "different historical owner", notebook: "20990716090009-missing", include: true, wantErrMsg: "does not belong to notebook"},
		{name: "mismatched", notebook: boxIDs[1], include: true, wantErrMsg: "does not belong to notebook"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			payload := map[string]any{"historyPath": historyPath}
			if test.include {
				payload["notebook"] = test.notebook
			}
			body, err := json.Marshal(payload)
			if err != nil {
				t.Fatal(err)
			}
			request := httptest.NewRequest(http.MethodPost, "/api/history/getDocHistoryContent", bytes.NewReader(body))
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

func TestNotebookControlHandlersAllowResponseIndexRepair(t *testing.T) {
	tests := []struct {
		name    string
		path    string
		handler gin.HandlerFunc
		removed bool
	}{
		{name: "close", path: "/api/notebook/closeNotebook", handler: closeNotebook},
		{name: "remove", path: "/api/notebook/removeNotebook", handler: removeNotebook, removed: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			boxID := setupEncryptedResponseTest(t, 1)[0]
			previousMode := gin.Mode()
			gin.SetMode(gin.TestMode)
			t.Cleanup(func() { gin.SetMode(previousMode) })

			responseRegistered := make(chan struct{})
			repairAllowed := make(chan struct{})
			var releaseRepair sync.Once
			releaseResponseRepair := func() { releaseRepair.Do(func() { close(repairAllowed) }) }
			t.Cleanup(releaseResponseRepair)
			repairResult := make(chan error, 1)
			confPath := filepath.Join(util.DataDir, boxID, ".siyuan", "conf.json")

			router := gin.New()
			router.Use(ContentResponseLifecycle)
			router.POST("/response-index-repair", func(c *gin.Context) {
				if err := RegisterEncryptedResponse(c, boxID); err != nil {
					repairResult <- err
					c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
					return
				}
				close(responseRegistered)
				<-repairAllowed
				_, err := model.ListNotebooks()
				if err == nil {
					_, err = os.Stat(confPath)
				}
				repairResult <- err
				c.JSON(http.StatusOK, gin.H{"repaired": err == nil})
			})
			router.POST(test.path, test.handler)

			responseRecorder := httptest.NewRecorder()
			responseDone := make(chan struct{})
			go func() {
				router.ServeHTTP(responseRecorder, httptest.NewRequest(http.MethodPost, "/response-index-repair", nil))
				close(responseDone)
			}()
			waitResponseTestSignal(t, responseRegistered, "response did not acquire its notebook gate")
			if err := os.Remove(confPath); err != nil {
				t.Fatalf("remove notebook configuration before repair: %v", err)
			}

			writeBlocked := observeBoxResponseWriteBlocked(t, boxID)
			controlBody, err := json.Marshal(map[string]string{"notebook": boxID})
			if err != nil {
				t.Fatal(err)
			}
			controlRequest := httptest.NewRequest(http.MethodPost, test.path, bytes.NewReader(controlBody))
			controlRequest.Header.Set("Content-Type", "application/json")
			controlRecorder := httptest.NewRecorder()
			controlDone := make(chan struct{})
			go func() {
				router.ServeHTTP(controlRecorder, controlRequest)
				close(controlDone)
			}()
			waitResponseTestSignal(t, writeBlocked, "notebook control request was not blocked by the response read gate")

			releaseResponseRepair()
			waitResponseTestSignal(t, responseDone, "response-side configuration repair was blocked by notebook control")
			if err = <-repairResult; err != nil {
				t.Fatalf("repair notebook configuration and index while control waits: %v", err)
			}
			waitResponseTestSignal(t, controlDone, "notebook control request did not complete after response repair")

			var controlResult struct {
				Code int    `json:"code"`
				Msg  string `json:"msg"`
			}
			if err = json.Unmarshal(controlRecorder.Body.Bytes(), &controlResult); err != nil {
				t.Fatalf("decode notebook control response: %v", err)
			}
			if controlResult.Code != 0 {
				t.Fatalf("notebook control response = %#v", controlResult)
			}
			if test.removed {
				if _, err = os.Stat(filepath.Join(util.DataDir, boxID)); !os.IsNotExist(err) {
					t.Fatalf("removed notebook directory still exists: %v", err)
				}
			} else if !(&model.Box{ID: boxID}).GetConf().Closed {
				t.Fatal("closed notebook configuration remains open")
			}
		})
	}
}

func setupEncryptedResponseTest(t *testing.T, boxCount int) []string {
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
			t.Fatalf("create encrypted response test directory %s: %v", dir, err)
		}
	}
	util.IsExiting.Store(false)
	util.ReadOnly = false
	model.Conf = model.NewAppConf()
	model.Conf.Lang = "en"
	model.Conf.System = kernelconf.NewSystem()
	model.Conf.Sync = kernelconf.NewSync()
	model.Conf.FileTree = kernelconf.NewFileTree()
	model.Conf.Editor = kernelconf.NewEditor()
	model.Conf.Export = kernelconf.NewExport()
	model.Conf.Search = kernelconf.NewSearch()
	model.Conf.NotebookCrypto = kernelconf.NewNotebookCrypto()
	englishLang, hadEnglishLang := util.Langs["en"]
	if !hadEnglishLang {
		englishLang = map[int]string{}
		util.Langs["en"] = englishLang
	}
	untitledLabel, hadUntitledLabel := englishLang[16]
	if !hadUntitledLabel {
		// 测试直接替换配置，不经过 InitConf；补齐空标题规范化所需的语言合同。
		englishLang[16] = "Untitled"
	}
	_, hadEnglishTimeLang := util.TimeLangs["en"]
	if !hadEnglishTimeLang {
		// 测试直接替换配置，不经过 InitConf；补齐 HumanizeTime 所需的最小语言合同。
		util.TimeLangs["en"] = map[string]any{
			"albl": "ago", "blbl": "from now", "now": "now",
			"1s": "1 second %s", "xs": "%d seconds %s", "1m": "1 minute %s", "xm": "%d minutes %s",
			"1h": "1 hour %s", "xh": "%d hours %s", "1d": "1 day %s", "xd": "%d days %s",
			"1w": "1 week %s", "xw": "%d weeks %s", "1M": "1 month %s", "xM": "%d months %s",
			"1y": "1 year %s", "2y": "2 years %s", "xy": "%d years %s", "max": "a long while %s",
		}
	}
	cache.ClearTreeCache()
	if err := kernelsql.ClearQueue(); err != nil {
		t.Fatalf("clear encrypted response queue: %v", err)
	}
	if err := kernelsql.InitDatabase(true); err != nil {
		t.Fatalf("initialize encrypted response content database: %v", err)
	}
	kernelsql.InitHistoryDatabase(true)
	kernelsql.InitAssetContentDatabase(true)

	boxIDs := make([]string, 0, boxCount)
	t.Cleanup(func() {
		for _, boxID := range boxIDs {
			_ = model.LockBox(boxID)
		}
		if err := kernelsql.ClearQueue(); err != nil {
			t.Errorf("clear encrypted response queue during cleanup: %v", err)
		}
		kernelsql.CloseDatabase()
		cache.ClearTreeCache()
		model.Conf = originalConf
		if !hadEnglishTimeLang {
			delete(util.TimeLangs, "en")
		}
		if hadUntitledLabel {
			englishLang[16] = untitledLabel
		} else {
			delete(englishLang, 16)
		}
		if !hadEnglishLang {
			delete(util.Langs, "en")
		}
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

	const password = "response-contract-password"
	if err := model.EnableEncryptedNotebook(password); err != nil {
		t.Fatalf("enable encrypted notebook test fixture: %v", err)
	}
	for i := 0; i < boxCount; i++ {
		boxID, err := model.CreateEncryptedBox("Response Contract", password)
		if err != nil {
			t.Fatalf("create encrypted notebook test fixture %d: %v", i, err)
		}
		boxIDs = append(boxIDs, boxID)
	}
	return boxIDs
}

func writeEncryptedHistoryResponseFixture(t *testing.T, boxID string) string {
	t.Helper()
	const (
		rootID  = "20990716090003-history"
		childID = "20990716090004-history"
	)
	treePath := "/" + rootID + ".sy"
	tree := treenode.NewTree(boxID, treePath, "/History Contract", "History Contract")
	tree.Root.FirstChild.Unlink()
	tree.Root.ID = rootID
	tree.ID = rootID
	tree.Root.SetIALAttr("id", rootID)
	child := &ast.Node{Type: ast.NodeParagraph, ID: childID, Box: boxID, Path: treePath}
	child.SetIALAttr("id", childID)
	child.SetIALAttr("updated", childID[:14])
	child.AppendChild(&ast.Node{Type: ast.NodeText, Tokens: []byte("Encrypted history response")})
	tree.Root.AppendChild(child)
	tree.Root.Spec = "1"
	luteEngine := util.NewLute()
	plain := render.NewJSONRenderer(tree, luteEngine.RenderOptions, luteEngine.ParseOptions).Render()
	dek, err := model.GetDEK(boxID)
	if err != nil {
		t.Fatalf("get encrypted history fixture key: %v", err)
	}
	ciphertext, err := model.EncryptFile(boxID, treePath, dek, plain)
	clear(dek)
	if err != nil {
		t.Fatalf("encrypt history fixture: %v", err)
	}
	historyFile := filepath.Join(util.HistoryDir, "2099-07-16-090000-update", boxID, rootID+".sy")
	if err = os.MkdirAll(filepath.Dir(historyFile), 0755); err != nil {
		t.Fatalf("create history fixture directory: %v", err)
	}
	if err = os.WriteFile(historyFile, ciphertext, 0644); err != nil {
		t.Fatalf("write history fixture: %v", err)
	}
	requestPath, err := filepath.Rel(util.WorkspaceDir, historyFile)
	if err != nil {
		t.Fatalf("resolve history request path: %v", err)
	}
	return filepath.ToSlash(requestPath)
}

func waitResponseTestSignal(t *testing.T, signal <-chan struct{}, failure string) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(responseTestTimeout):
		t.Fatal(failure)
	}
}

func waitResponseTestError(t *testing.T, result <-chan error, failure string) error {
	t.Helper()
	select {
	case err := <-result:
		return err
	case <-time.After(responseTestTimeout):
		t.Fatal(failure)
		return nil
	}
}

func observeBoxResponseWriteBlocked(t *testing.T, boxID string) <-chan struct{} {
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

func observeNotebookCryptoBlocked(t *testing.T) <-chan struct{} {
	t.Helper()
	blocked := make(chan struct{})
	var once sync.Once
	restore := model.SetNotebookCryptoBlockedObserverForTest(func() {
		once.Do(func() { close(blocked) })
	})
	t.Cleanup(restore)
	return blocked
}

func waitResponseTestCreate(t *testing.T, result <-chan encryptedBoxCreateResult) encryptedBoxCreateResult {
	t.Helper()
	select {
	case created := <-result:
		return created
	case <-time.After(responseTestTimeout):
		t.Fatal("encrypted notebook creation did not finish after response membership release")
		return encryptedBoxCreateResult{}
	}
}
