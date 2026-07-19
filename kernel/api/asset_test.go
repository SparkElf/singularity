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
	if text := util.GetAssetText(alias); text != "" {
		t.Fatalf("alias OCR text = %q, want no duplicate key", text)
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
