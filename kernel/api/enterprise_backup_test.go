// SiYuan - Refactor your thinking
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

package api

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/siyuan-note/siyuan/kernel/model"
)

func TestEnterpriseCreateBackupRejectsInvalidGenerationLimits(t *testing.T) {
	cases := []struct {
		maximumBytes string
		maximumFiles string
		name         string
	}{
		{name: "missing byte limit", maximumFiles: "1"},
		{name: "non-canonical byte limit", maximumBytes: "01", maximumFiles: "1"},
		{
			name:         "byte limit above hard maximum",
			maximumBytes: strconv.FormatInt(model.EnterpriseBackupMaximumBytes+1, 10),
			maximumFiles: "1",
		},
		{name: "missing file limit", maximumBytes: "1"},
		{
			name:         "file limit above hard maximum",
			maximumBytes: "1",
			maximumFiles: strconv.FormatInt(model.EnterpriseBackupMaximumFiles+1, 10),
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/internal/enterprise/backup", nil)
			if testCase.maximumBytes != "" {
				request.Header.Set(enterpriseBackupMaximumBytesHeader, testCase.maximumBytes)
			}
			if testCase.maximumFiles != "" {
				request.Header.Set(enterpriseBackupMaximumFilesHeader, testCase.maximumFiles)
			}
			response := httptest.NewRecorder()
			context, _ := gin.CreateTestContext(response)
			context.Request = request

			EnterpriseCreateBackupHandler("space-contract")(context)

			if response.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want %d", response.Code, http.StatusBadRequest)
			}
		})
	}
}
