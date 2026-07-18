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
	"errors"
	"net/http"
	"strconv"

	"github.com/88250/lute/ast"
	"github.com/gin-gonic/gin"
	"github.com/siyuan-note/logging"
	"github.com/siyuan-note/siyuan/kernel/model"
	"github.com/siyuan-note/siyuan/kernel/serviceauth"
)

func EnterpriseListDirectoryNotebooks(c *gin.Context) {
	if len(c.Request.URL.Query()) != 0 {
		c.AbortWithStatus(http.StatusBadRequest)
		return
	}
	notebooks, err := model.ListEnterpriseDirectoryNotebooks()
	if err != nil {
		logEnterpriseDirectory(c, "notebooks-unavailable", "", "", 0, true)
		c.AbortWithStatus(http.StatusServiceUnavailable)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, map[string]any{"notebooks": notebooks})
	logEnterpriseDirectory(c, "notebooks-read", "", "", 0, false)
}

func EnterpriseListDirectoryDocuments(c *gin.Context) {
	notebookID, notebookOK := singleDirectoryQuery(c, "notebookId", true)
	parentDocumentID, parentOK := singleDirectoryQuery(c, "parentDocumentId", false)
	offsetValue, offsetOK := singleDirectoryQuery(c, "offset", true)
	if !notebookOK || !parentOK || !offsetOK || !onlyDirectoryDocumentQueries(c) {
		c.AbortWithStatus(http.StatusBadRequest)
		return
	}
	if !ast.IsNodeIDPattern(notebookID) || (parentDocumentID != "" && !ast.IsNodeIDPattern(parentDocumentID)) {
		c.AbortWithStatus(http.StatusBadRequest)
		return
	}
	offset, err := strconv.Atoi(offsetValue)
	if err != nil || offset < 0 || offset > model.EnterpriseDirectoryMaxOffset {
		c.AbortWithStatus(http.StatusBadRequest)
		return
	}

	if model.IsEncryptedBox(notebookID) {
		if err = RegisterEncryptedResponse(c, notebookID); err != nil {
			logEnterpriseDirectory(c, "response-gate-unavailable", notebookID, parentDocumentID, offset, true)
			c.AbortWithStatus(http.StatusServiceUnavailable)
			return
		}
	}
	page, err := model.ListEnterpriseDirectoryDocuments(notebookID, parentDocumentID, offset)
	if errors.Is(err, model.ErrEnterpriseDirectoryNotebookMissing) ||
		errors.Is(err, model.ErrEnterpriseDirectoryParentMissing) {
		logEnterpriseDirectory(c, "not-found", notebookID, parentDocumentID, offset, true)
		c.AbortWithStatus(http.StatusNotFound)
		return
	}
	if err != nil {
		logEnterpriseDirectory(c, "documents-unavailable", notebookID, parentDocumentID, offset, true)
		c.AbortWithStatus(http.StatusServiceUnavailable)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, page)
	logEnterpriseDirectory(c, "documents-read", notebookID, parentDocumentID, offset, false)
}

func singleDirectoryQuery(c *gin.Context, name string, required bool) (string, bool) {
	values, exists := c.Request.URL.Query()[name]
	if !exists {
		return "", !required
	}
	if len(values) != 1 || values[0] == "" {
		return "", false
	}
	return values[0], true
}

func onlyDirectoryDocumentQueries(c *gin.Context) bool {
	for name := range c.Request.URL.Query() {
		if name != "notebookId" && name != "parentDocumentId" && name != "offset" {
			return false
		}
	}
	return true
}

func logEnterpriseDirectory(c *gin.Context, outcome, notebookID, parentDocumentID string, offset int, warning bool) {
	const format = "content.directory [requestId=%s, notebookId=%s, parentDocumentId=%s, offset=%d, outcome=%s]"
	if warning {
		logging.LogWarnf(format, c.GetHeader(serviceauth.RequestIDHeader), notebookID, parentDocumentID, offset, outcome)
		return
	}
	logging.LogInfof(format, c.GetHeader(serviceauth.RequestIDHeader), notebookID, parentDocumentID, offset, outcome)
}
