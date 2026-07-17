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
	"testing"

	"github.com/gin-gonic/gin"
	kernelconf "github.com/siyuan-note/siyuan/kernel/conf"
	"github.com/siyuan-note/siyuan/kernel/model"
)

func TestBacklinkHandlersRejectInvalidNotebookIdentity(t *testing.T) {
	_, _, missingID := setupNotebookArgTest(t)
	model.Conf.Editor = kernelconf.NewEditor()
	previousMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(previousMode) })

	type endpoint struct {
		name    string
		path    string
		handler gin.HandlerFunc
		body    map[string]any
	}
	endpoints := []endpoint{
		{name: "refresh", path: "/api/ref/refreshBacklink", handler: refreshBacklink, body: map[string]any{"id": "20990101120000-block01"}},
		{name: "backmention document", path: "/api/ref/getBackmentionDoc", handler: getBackmentionDoc, body: map[string]any{"defID": "20990101120000-block01", "refTreeID": "20990101120000-block02", "keyword": ""}},
		{name: "backlink document", path: "/api/ref/getBacklinkDoc", handler: getBacklinkDoc, body: map[string]any{"defID": "20990101120000-block01", "refTreeID": "20990101120000-block02", "keyword": ""}},
		{name: "backlink sorted", path: "/api/ref/getBacklink2", handler: getBacklink2, body: map[string]any{"id": "20990101120000-block01", "k": "", "mk": ""}},
		{name: "backlink", path: "/api/ref/getBacklink", handler: getBacklink, body: map[string]any{"id": "20990101120000-block01", "k": "", "mk": ""}},
	}
	invalidNotebooks := []struct {
		name  string
		value any
	}{
		{name: "invalid id", value: "../../etc/passwd"},
		{name: "not found", value: missingID},
	}

	for _, target := range endpoints {
		for _, notebook := range invalidNotebooks {
			t.Run(target.name+"/"+notebook.name, func(t *testing.T) {
				body := make(map[string]any, len(target.body)+1)
				for key, value := range target.body {
					body[key] = value
				}
				body["notebook"] = notebook.value
				payload, err := json.Marshal(body)
				if err != nil {
					t.Fatal(err)
				}

				router := gin.New()
				router.Use(ContentResponseLifecycle)
				router.POST(target.path, target.handler)
				request := httptest.NewRequest(http.MethodPost, target.path, bytes.NewReader(payload))
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
