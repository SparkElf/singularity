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

type imageOCRHTTPResult struct {
	Code int `json:"code"`
	Data struct {
		Text string `json:"text"`
	} `json:"data"`
	Msg string `json:"msg"`
}

func TestImageOCRHandlersUseResolvedCanonicalAssetKey(t *testing.T) {
	setupEncryptedResponseTest(t, 0)
	const (
		assetKey = "assets/ocr-contract.png"
		alias    = "assets/nested/../ocr-contract.png"
	)
	assetPath := filepath.Join(util.DataDir, filepath.FromSlash(assetKey))
	if err := os.MkdirAll(filepath.Dir(assetPath), 0755); err != nil {
		t.Fatalf("create OCR asset directory: %v", err)
	}
	if err := os.WriteFile(assetPath, []byte("not-an-image"), 0600); err != nil {
		t.Fatalf("create OCR asset: %v", err)
	}
	util.SetAssetText(assetKey, "before")
	t.Cleanup(func() {
		util.RemoveAssetText(assetKey)
		util.RemoveAssetText(alias)
	})

	router := imageOCRTestRouter(t)
	getResult := serveImageOCRRequest(t, router, "/api/asset/getImageOCRText", map[string]any{
		"path": alias,
	})
	if getResult.Code != 0 || getResult.Data.Text != "before" {
		t.Fatalf("get OCR response = %#v, want canonical text", getResult)
	}

	setResult := serveImageOCRRequest(t, router, "/api/asset/setImageOCRText", map[string]any{
		"path": alias,
		"text": "after",
	})
	if setResult.Code != 0 {
		t.Fatalf("set OCR response = %#v, want success", setResult)
	}
	if text := util.GetAssetText(assetKey); text != "after" {
		t.Fatalf("canonical OCR text = %q, want %q", text, "after")
	}
	if text := util.GetAssetText(alias); text != "after" {
		t.Fatalf("alias OCR text = %q, want canonical text", text)
	}
}

func TestImageOCRHandlersRejectUnresolvedAssetPath(t *testing.T) {
	setupEncryptedResponseTest(t, 0)
	const invalidPath = "assets/../outside.png"
	t.Cleanup(func() { util.RemoveAssetText(invalidPath) })
	router := imageOCRTestRouter(t)

	for _, request := range []struct {
		path    string
		payload map[string]any
	}{
		{path: "/api/asset/getImageOCRText", payload: map[string]any{"path": invalidPath}},
		{path: "/api/asset/setImageOCRText", payload: map[string]any{"path": invalidPath, "text": "unsafe"}},
		{path: "/api/asset/ocr", payload: map[string]any{"path": invalidPath}},
	} {
		t.Run(request.path, func(t *testing.T) {
			result := serveImageOCRRequest(t, router, request.path, request.payload)
			if result.Code == 0 || !strings.Contains(result.Msg, "is not an asset path") {
				t.Fatalf("OCR response = %#v, want asset path validation error", result)
			}
		})
	}
	if text := util.GetAssetText(invalidPath); text != "" {
		t.Fatalf("invalid OCR key was persisted with text %q", text)
	}
}

func TestImageOCRHandlerRejectsNotebookPathMismatch(t *testing.T) {
	boxIDs := setupEncryptedResponseTest(t, 2)
	router := imageOCRTestRouter(t)
	result := serveImageOCRRequest(t, router, "/api/asset/ocr", map[string]any{
		"notebook": boxIDs[0],
		"path":     "assets/cross-notebook.png?box=" + boxIDs[1],
	})
	if result.Code == 0 || !strings.Contains(result.Msg, "box mismatch") {
		t.Fatalf("OCR response = %#v, want notebook path mismatch", result)
	}
}

func TestImageOCRHandlersRejectOrdinaryNotebookFallback(t *testing.T) {
	setupEncryptedResponseTest(t, 0)
	declaredBoxID, err := model.CreateBox("Declared OCR Notebook")
	if err != nil {
		t.Fatalf("create declared OCR notebook: %v", err)
	}
	otherBoxID, err := model.CreateBox("Other OCR Notebook")
	if err != nil {
		t.Fatalf("create other OCR notebook: %v", err)
	}
	const assetPath = "assets/cross-notebook-ocr.png"
	otherAssetPath := filepath.Join(util.DataDir, otherBoxID, filepath.FromSlash(assetPath))
	if err = os.MkdirAll(filepath.Dir(otherAssetPath), 0755); err != nil {
		t.Fatalf("create other notebook asset directory: %v", err)
	}
	if err = os.WriteFile(otherAssetPath, []byte("not-an-image"), 0600); err != nil {
		t.Fatalf("create other notebook asset: %v", err)
	}
	util.SetAssetText(assetPath, "other notebook OCR")
	t.Cleanup(func() { util.RemoveAssetText(assetPath) })

	router := imageOCRTestRouter(t)
	for _, request := range []struct {
		path    string
		payload map[string]any
	}{
		{path: "/api/asset/getImageOCRText", payload: map[string]any{"notebook": declaredBoxID, "path": assetPath}},
		{path: "/api/asset/setImageOCRText", payload: map[string]any{"notebook": declaredBoxID, "path": assetPath, "text": "unsafe"}},
		{path: "/api/asset/ocr", payload: map[string]any{"notebook": declaredBoxID, "path": assetPath}},
	} {
		t.Run(request.path, func(t *testing.T) {
			result := serveImageOCRRequest(t, router, request.path, request.payload)
			if result.Code == 0 || !strings.Contains(result.Msg, "declared notebook") {
				t.Fatalf("cross-notebook OCR response = %#v, want ownership rejection", result)
			}
		})
	}
	if text := util.GetAssetText(assetPath); text != "other notebook OCR" {
		t.Fatalf("cross-notebook OCR text was mutated: %q", text)
	}
}

func TestImageOCRHandlersRejectEncryptedAssetMutation(t *testing.T) {
	boxIDs := setupEncryptedResponseTest(t, 1)
	boxID := boxIDs[0]
	assetsDir := filepath.Join(util.DataDir, boxID, "assets")
	if err := os.MkdirAll(assetsDir, 0755); err != nil {
		t.Fatalf("create encrypted OCR asset directory: %v", err)
	}
	diskName, err := model.StoreAssetForBox(boxID, assetsDir, "encrypted-ocr.png", []byte("not-an-image"))
	if err != nil {
		t.Fatalf("store encrypted OCR asset: %v", err)
	}
	relativePath := "assets/" + diskName
	requestPath := relativePath + "?box=" + boxID
	assetKey := filepath.ToSlash(filepath.Join(boxID, relativePath))
	t.Cleanup(func() {
		util.RemoveAssetText(assetKey)
		util.RemoveAssetText(requestPath)
	})

	router := imageOCRTestRouter(t)
	getResult := serveImageOCRRequest(t, router, "/api/asset/getImageOCRText", map[string]any{
		"notebook": boxID,
		"path":     requestPath,
	})
	if getResult.Code != 0 || getResult.Data.Text != "" {
		t.Fatalf("encrypted OCR read response = %#v, want empty text", getResult)
	}

	for _, request := range []struct {
		path    string
		payload map[string]any
	}{
		{
			path: "/api/asset/setImageOCRText",
			payload: map[string]any{
				"notebook": boxID,
				"path":     requestPath,
				"text":     "must-not-persist",
			},
		},
		{
			path: "/api/asset/ocr",
			payload: map[string]any{
				"notebook": boxID,
				"path":     requestPath,
			},
		},
	} {
		t.Run(request.path, func(t *testing.T) {
			result := serveImageOCRRequest(t, router, request.path, request.payload)
			if result.Code == 0 || !strings.Contains(result.Msg, "not supported") {
				t.Fatalf("encrypted OCR mutation response = %#v, want explicit rejection", result)
			}
		})
	}
	if text := util.GetAssetText(assetKey); text != "" {
		t.Fatalf("encrypted OCR text persisted under canonical key: %q", text)
	}
	if text := util.GetAssetText(requestPath); text != "" {
		t.Fatalf("encrypted OCR text persisted under request key: %q", text)
	}
}

func imageOCRTestRouter(t *testing.T) *gin.Engine {
	t.Helper()
	previousMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(previousMode) })
	router := gin.New()
	router.Use(ContentResponseLifecycle)
	router.POST("/api/asset/getImageOCRText", getImageOCRText)
	router.POST("/api/asset/setImageOCRText", setImageOCRText)
	router.POST("/api/asset/ocr", ocr)
	return router
}

func serveImageOCRRequest(
	t *testing.T,
	router *gin.Engine,
	path string,
	payload map[string]any,
) imageOCRHTTPResult {
	t.Helper()
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("encode OCR request: %v", err)
	}
	request := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	var result imageOCRHTTPResult
	if err = json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatalf("decode OCR response: %v", err)
	}
	return result
}
