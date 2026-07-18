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
	"testing"

	"github.com/88250/lute/ast"
	"github.com/gin-gonic/gin"
	kernelconf "github.com/siyuan-note/siyuan/kernel/conf"
	"github.com/siyuan-note/siyuan/kernel/filesys"
	"github.com/siyuan-note/siyuan/kernel/model"
	kernelsql "github.com/siyuan-note/siyuan/kernel/sql"
	"github.com/siyuan-note/siyuan/kernel/treenode"
	"github.com/siyuan-note/siyuan/kernel/util"
)

func setupNotebookArgTest(t *testing.T) (ordinaryID, encryptedID, missingID string) {
	t.Helper()
	previousConf := model.Conf
	previousDataDir := util.DataDir
	util.DataDir = t.TempDir()
	model.Conf = model.NewAppConf()
	model.Conf.FileTree = kernelconf.NewFileTree()
	t.Cleanup(func() {
		model.Conf = previousConf
		util.DataDir = previousDataDir
	})

	ordinaryID = "20990101120000-normal1"
	encryptedID = "20990101120000-encrypt"
	missingID = "20990101120000-missing"
	for id, encrypted := range map[string]bool{ordinaryID: false, encryptedID: true} {
		confDir := filepath.Join(util.DataDir, id, ".siyuan")
		if err := os.MkdirAll(confDir, 0755); err != nil {
			t.Fatal(err)
		}
		data, err := json.Marshal(map[string]any{"name": id, "encrypted": encrypted})
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(filepath.Join(confDir, "conf.json"), data, 0644); err != nil {
			t.Fatal(err)
		}
	}
	return
}

// TestEncryptedNotebookFromArgDistinguishesMissingAndInvalid 验证未提供或合法普通 notebook 进入普通分支，显式无效值被拒绝。
func TestEncryptedNotebookFromArgDistinguishesMissingAndInvalid(t *testing.T) {
	ordinaryID, encryptedID, missingID := setupNotebookArgTest(t)

	if got, err := encryptedNotebookFromArg(map[string]any{}); err != nil || got != "" {
		t.Fatalf("missing notebook = %q, %v; want empty without error", got, err)
	}
	if got, err := encryptedNotebookFromArg(map[string]any{"notebook": ordinaryID}); err != nil || got != "" {
		t.Fatalf("ordinary notebook = %q, %v; want global route without error", got, err)
	}
	if got, err := encryptedNotebookFromArg(map[string]any{"notebook": encryptedID}); err != nil || got != encryptedID {
		t.Fatalf("encrypted notebook = %q, %v; want encrypted route", got, err)
	}
	if got, err := encryptedNotebookFromArg(map[string]any{"notebook": missingID}); !errors.Is(err, model.ErrBoxNotFound) || got != "" {
		t.Fatalf("missing notebook id = %q, %v; want ErrBoxNotFound", got, err)
	}

	invalid := []struct {
		name  string
		value any
	}{
		{name: "empty", value: ""},
		{name: "null", value: nil},
		{name: "wrong type", value: 1},
		{name: "invalid id", value: "not-a-notebook-id"},
		{name: "path", value: "../../etc/passwd"},
	}
	for _, test := range invalid {
		t.Run(test.name, func(t *testing.T) {
			if got, err := encryptedNotebookFromArg(map[string]any{"notebook": test.value}); !errors.Is(err, model.ErrInvalidID) || got != "" {
				t.Fatalf("explicit invalid notebook = %q, %v; want ErrInvalidID", got, err)
			}
		})
	}
}

// TestHeadingHandlersRequireExplicitNotebook 验证标题辅助接口不会在缺少内容库身份时按块 ID 猜测笔记本。
func TestHeadingHandlersRequireExplicitNotebook(t *testing.T) {
	setupNotebookArgTest(t)
	previousMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(previousMode) })

	router := gin.New()
	router.Use(ContentResponseLifecycle)
	router.POST("/api/block/getHeadingChildrenIDs", getHeadingChildrenIDs)
	router.POST("/api/block/getHeadingChildrenDOM", getHeadingChildrenDOM)
	router.POST("/api/block/getHeadingDeleteTransaction", getHeadingDeleteTransaction)
	router.POST("/api/block/getHeadingInsertTransaction", getHeadingInsertTransaction)
	router.POST("/api/block/getHeadingLevelTransaction", getHeadingLevelTransaction)

	for _, endpoint := range []string{
		"/api/block/getHeadingChildrenIDs",
		"/api/block/getHeadingChildrenDOM",
		"/api/block/getHeadingDeleteTransaction",
		"/api/block/getHeadingInsertTransaction",
		"/api/block/getHeadingLevelTransaction",
	} {
		t.Run(endpoint, func(t *testing.T) {
			body, err := json.Marshal(map[string]any{
				"id":    "20990101120000-block01",
				"level": 2,
			})
			if err != nil {
				t.Fatal(err)
			}
			request := httptest.NewRequest(http.MethodPost, endpoint, bytes.NewReader(body))
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
			if result.Code != -1 || !strings.Contains(result.Msg, model.ErrInvalidID.Error()) {
				t.Fatalf("result = %+v, want explicit missing-notebook error", result)
			}
		})
	}
}

func TestCheckBlocksExistRequiresExplicitNotebook(t *testing.T) {
	setupNotebookArgTest(t)
	previousMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(previousMode) })

	router := gin.New()
	router.Use(ContentResponseLifecycle)
	router.POST("/api/block/checkBlocksExist", checkBlocksExist)
	body, err := json.Marshal(map[string]any{
		"ids": []string{"20990101120000-block01"},
	})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/block/checkBlocksExist", bytes.NewReader(body))
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
	if result.Code != -1 || !strings.Contains(result.Msg, model.ErrInvalidID.Error()) {
		t.Fatalf("result = %+v, want explicit missing-notebook error", result)
	}
}

// TestFoldQueriesRejectInvalidNotebook 验证折叠状态与展开父级查询都通过真实 HTTP handler 返回明确错误。
func TestFoldQueriesRejectInvalidNotebook(t *testing.T) {
	_, encryptedID, missingID := setupNotebookArgTest(t)
	previousMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(previousMode) })

	router := gin.New()
	router.Use(ContentResponseLifecycle)
	router.POST("/api/block/checkBlockFold", checkBlockFold)
	router.POST("/api/block/getUnfoldedParentID", getUnfoldedParentID)
	for _, endpoint := range []string{"/api/block/checkBlockFold", "/api/block/getUnfoldedParentID"} {
		for _, test := range []struct {
			name     string
			notebook string
		}{
			{name: "invalid id", notebook: "../../etc/passwd"},
			{name: "not found", notebook: missingID},
			{name: "encrypted locked", notebook: encryptedID},
		} {
			t.Run(endpoint+"/"+test.name, func(t *testing.T) {
				body, err := json.Marshal(map[string]any{
					"id":       "20990101120000-block01",
					"notebook": test.notebook,
				})
				if err != nil {
					t.Fatal(err)
				}
				request := httptest.NewRequest(http.MethodPost, endpoint, bytes.NewReader(body))
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
}

func TestBlockMutationHandlersRejectInvalidDeclaredNotebook(t *testing.T) {
	setupNotebookArgTest(t)
	previousMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(previousMode) })

	router := gin.New()
	router.Use(ContentResponseLifecycle)
	handlers := map[string]gin.HandlerFunc{
		"updateTaskListItemMarker":      updateTaskListItemMarker,
		"batchUpdateTaskListItemMarker": batchUpdateTaskListItemMarker,
		"moveOutlineHeading":            moveOutlineHeading,
		"unfoldBlock":                   unfoldBlock,
		"foldBlock":                     foldBlock,
		"moveBlock":                     moveBlock,
		"appendBlock":                   appendBlock,
		"batchAppendBlock":              batchAppendBlock,
		"prependBlock":                  prependBlock,
		"batchPrependBlock":             batchPrependBlock,
		"insertBlock":                   insertBlock,
		"updateBlock":                   updateBlock,
		"batchInsertBlock":              batchInsertBlock,
		"batchUpdateBlock":              batchUpdateBlock,
		"deleteBlock":                   deleteBlock,
	}
	for name, handler := range handlers {
		router.POST("/api/block/"+name, handler)
	}

	body, err := json.Marshal(map[string]any{"notebook": "../../etc/passwd"})
	if err != nil {
		t.Fatal(err)
	}
	for name := range handlers {
		t.Run(name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/api/block/"+name, bytes.NewReader(body))
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
			if result.Code != -1 || !strings.Contains(result.Msg, model.ErrInvalidID.Error()) {
				t.Fatalf("result = %+v, want invalid declared-notebook error", result)
			}
		})
	}
}

func TestMoveBlockMutatesAndReturnsOnlyDeclaredContentStore(t *testing.T) {
	boxIDs := setupEncryptedResponseTest(t, 2)
	const (
		rootID    = "20990717160000-moveapi"
		currentID = "20990717160001-current"
		targetID  = "20990717160002-targetx"
	)
	for index, boxID := range boxIDs {
		treePath := "/" + rootID + ".sy"
		tree := treenode.NewTree(boxID, treePath, "/Move HTTP", "Move HTTP")
		tree.Root.FirstChild.Unlink()
		tree.ID = rootID
		tree.Root.ID = rootID
		tree.Root.Box = boxID
		tree.Root.Path = treePath
		tree.Root.SetIALAttr("id", rootID)
		for _, id := range []string{currentID, targetID} {
			paragraph := &ast.Node{Type: ast.NodeParagraph, ID: id, Box: boxID, Path: treePath}
			paragraph.SetIALAttr("id", id)
			paragraph.SetIALAttr("updated", id[:14])
			paragraph.AppendChild(&ast.Node{Type: ast.NodeText, Tokens: []byte(boxID)})
			tree.Root.AppendChild(paragraph)
		}
		tree.Root.SetIALAttr("title", "Move HTTP "+string(rune('A'+index)))
		if _, err := filesys.WriteTree(tree); err != nil {
			t.Fatalf("write move fixture for notebook %s: %v", boxID, err)
		}
		if err := treenode.UpsertBlockTree(tree); err != nil {
			t.Fatalf("index move blocktree for notebook %s: %v", boxID, err)
		}
		if err := kernelsql.UpsertTreeQueue(tree); err != nil {
			t.Fatalf("queue move content index for notebook %s: %v", boxID, err)
		}
	}
	if err := kernelsql.FlushQueue(); err != nil {
		t.Fatalf("flush move content fixtures: %v", err)
	}
	otherBefore, err := os.ReadFile(filepath.Join(util.DataDir, boxIDs[1], rootID+".sy"))
	if err != nil {
		t.Fatalf("read other-store fixture before move: %v", err)
	}

	previousMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(previousMode) })
	router := gin.New()
	router.Use(ContentResponseLifecycle)
	router.POST("/api/block/moveBlock", moveBlock)
	body, err := json.Marshal(map[string]any{
		"id":         currentID,
		"previousID": targetID,
		"notebook":   boxIDs[0],
	})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/block/moveBlock", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("HTTP status = %d, want 200", response.Code)
	}
	var result struct {
		Code int `json:"code"`
		Data []struct {
			Notebook     string `json:"notebook"`
			DoOperations []struct {
				Action string `json:"action"`
				ID     string `json:"id"`
			} `json:"doOperations"`
		} `json:"data"`
	}
	if err = json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatalf("decode move response: %v", err)
	}
	if result.Code != 0 || len(result.Data) != 1 || result.Data[0].Notebook != boxIDs[0] ||
		len(result.Data[0].DoOperations) != 1 || result.Data[0].DoOperations[0].Action != "move" || result.Data[0].DoOperations[0].ID != currentID {
		t.Fatalf("move response = %#v, want one transaction for notebook %s", result, boxIDs[0])
	}

	targetTree, err := filesys.LoadTree(boxIDs[0], "/"+rootID+".sy", util.NewLute())
	if err != nil {
		t.Fatalf("load moved target tree: %v", err)
	}
	targetNode := treenode.GetNodeInTree(targetTree, targetID)
	if targetNode == nil || targetNode.Next == nil || targetNode.Next.ID != currentID {
		t.Fatalf("declared store did not move %s after %s", currentID, targetID)
	}
	otherAfter, err := os.ReadFile(filepath.Join(util.DataDir, boxIDs[1], rootID+".sy"))
	if err != nil {
		t.Fatalf("read other-store fixture after move: %v", err)
	}
	if !bytes.Equal(otherAfter, otherBefore) {
		t.Fatal("move transaction rewrote the colliding tree in another content store")
	}
	otherTree, err := filesys.LoadTree(boxIDs[1], "/"+rootID+".sy", util.NewLute())
	if err != nil {
		t.Fatalf("load other-store tree after move: %v", err)
	}
	currentNode := treenode.GetNodeInTree(otherTree, currentID)
	if currentNode == nil || currentNode.Next == nil || currentNode.Next.ID != targetID {
		t.Fatal("move transaction changed the colliding order in another content store")
	}
}
