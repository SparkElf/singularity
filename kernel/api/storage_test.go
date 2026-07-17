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
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/siyuan-note/siyuan/kernel/model"
)

func TestRecentDocUpdatesRequireExplicitNotebookIdentity(t *testing.T) {
	previousMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(previousMode) })

	router := gin.New()
	router.Use(func(c *gin.Context) {
		c.Set(model.RoleContextKey, model.RoleAdministrator)
	})
	router.POST("/open", updateRecentDocOpenTime)
	router.POST("/view", updateRecentDocViewTime)
	router.POST("/close", updateRecentDocCloseTime)
	router.POST("/batch", batchUpdateRecentDocCloseTime)

	const rootID = "20260716000000-recentx"
	for _, test := range []struct {
		name string
		path string
		body map[string]any
	}{
		{name: "open", path: "/open", body: map[string]any{"rootID": rootID}},
		{name: "view", path: "/view", body: map[string]any{"rootID": rootID}},
		{name: "close", path: "/close", body: map[string]any{"rootID": rootID}},
		{name: "legacy batch root IDs", path: "/batch", body: map[string]any{"rootIDs": []string{rootID}}},
		{name: "batch entry", path: "/batch", body: map[string]any{"docs": []map[string]any{{"rootID": rootID}}}},
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

			var result struct {
				Code int    `json:"code"`
				Msg  string `json:"msg"`
			}
			if err = json.Unmarshal(response.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			if result.Code == 0 || result.Msg == "" {
				t.Fatalf("result = %+v, want explicit missing notebook identity error", result)
			}
		})
	}
}
