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
	"net/http"
	"strconv"
	"unicode/utf8"

	"github.com/88250/gulu"
	"github.com/gin-gonic/gin"
	"github.com/siyuan-note/siyuan/kernel/model"
	"github.com/siyuan-note/siyuan/kernel/util"
)

func refreshBacklink(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}

	id := arg["id"].(string)
	boxID, err := encryptedNotebookFromArg(arg)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	if boxID != "" {
		model.RefreshBacklinkInBox(id, boxID)
	} else {
		model.RefreshBacklink(id)
	}
	model.FlushTxQueue()
}

func getBackmentionDoc(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}

	defID := arg["defID"].(string)
	refTreeID := arg["refTreeID"].(string)
	keyword := arg["keyword"].(string)
	boxID, err := encryptedNotebookForResponse(c, arg)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	containChildren := model.Conf.Editor.BacklinkContainChildren
	if val, ok := arg["containChildren"]; ok {
		containChildren = val.(bool)
	}
	highlight := true
	if val, ok := arg["highlight"]; ok {
		highlight = val.(bool)
	}
	var backlinks []*model.Backlink
	var keywords []string
	if boxID != "" {
		backlinks, keywords = model.GetBackmentionDocInBox(defID, refTreeID, keyword, containChildren, highlight, boxID)
	} else {
		backlinks, keywords = model.GetBackmentionDoc(defID, refTreeID, keyword, containChildren, highlight)
	}
	ret.Data = map[string]any{
		"backmentions": backlinks,
		"keywords":     keywords,
	}
}

func getBacklinkDoc(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}

	defID := arg["defID"].(string)
	refTreeID := arg["refTreeID"].(string)
	keyword := arg["keyword"].(string)
	boxID, err := encryptedNotebookForResponse(c, arg)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	containChildren := model.Conf.Editor.BacklinkContainChildren
	if val, ok := arg["containChildren"]; ok {
		containChildren = val.(bool)
	}
	highlight := true
	if val, ok := arg["highlight"]; ok {
		highlight = val.(bool)
	}
	var backlinks []*model.Backlink
	var keywords []string
	if boxID != "" {
		backlinks, keywords = model.GetBacklinkDocInBox(defID, refTreeID, keyword, containChildren, highlight, boxID)
	} else {
		backlinks, keywords = model.GetBacklinkDoc(defID, refTreeID, keyword, containChildren, highlight)
	}
	ret.Data = map[string]any{
		"backlinks": backlinks,
		"keywords":  keywords,
	}
}

func getBacklink2(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}

	if nil == arg["id"] {
		return
	}

	id := arg["id"].(string)
	keyword := arg["k"].(string)
	mentionKeyword := arg["mk"].(string)
	sortArg := arg["sort"]
	sort := util.SortModeUpdatedDESC
	if nil != sortArg {
		sort, _ = strconv.Atoi(sortArg.(string))
	}
	mentionSortArg := arg["mSort"]
	mentionSort := util.SortModeUpdatedDESC
	if nil != mentionSortArg {
		mentionSort, _ = strconv.Atoi(mentionSortArg.(string))
	}
	containChildren := model.Conf.Editor.BacklinkContainChildren
	if val, ok := arg["containChildren"]; ok {
		containChildren = val.(bool)
	}
	var backlinks, backmentions []*model.Path
	var linkRefsCount, mentionsCount int
	var boxID string
	documentScope, enterprise, identityOK := enterpriseDiscoveryDocumentScopeFromRequest(c, arg, "id")
	if enterprise {
		if !identityOK {
			ret.Code = -1
			ret.Msg = "document identity is unavailable"
			return
		}
		if utf8.RuneCountInString(keyword) > enterpriseDiscoveryQueryMaxRunes || utf8.RuneCountInString(mentionKeyword) > enterpriseDiscoveryQueryMaxRunes {
			ret.Code = -1
			ret.Msg = "discovery query is too long"
			return
		}
		contentBoxID := enterpriseDiscoveryBoxID(documentScope.NotebookID)
		_, backlinks, backmentions, linkRefsCount, mentionsCount = model.GetBacklink2InBox(documentScope.DocumentID, keyword, mentionKeyword, sort, mentionSort, containChildren, contentBoxID)
		boxID = documentScope.NotebookID
	} else {
		var err error
		boxID, err = encryptedNotebookForResponse(c, arg)
		if err != nil {
			ret.Code = -1
			ret.Msg = err.Error()
			return
		}
		if boxID != "" {
			boxID, backlinks, backmentions, linkRefsCount, mentionsCount = model.GetBacklink2InBox(id, keyword, mentionKeyword, sort, mentionSort, containChildren, boxID)
		} else {
			boxID, backlinks, backmentions, linkRefsCount, mentionsCount = model.GetBacklink2(id, keyword, mentionKeyword, sort, mentionSort, containChildren)
		}
	}
	if model.IsReadOnlyRoleContext(c) {
		publishAccess := model.GetPublishAccess()
		backlinks = model.FilterPathsByPublishAccess(c, publishAccess, backlinks)
		backmentions = model.FilterPathsByPublishAccess(c, publishAccess, backmentions)
	}
	if enterprise {
		ret.Data = map[string]any{
			"backlinks":    enterpriseDiscoveryBacklinkProjections(backlinks),
			"backmentions": enterpriseDiscoveryBacklinkProjections(backmentions),
		}
		return
	}
	ret.Data = map[string]any{
		"backlinks":     backlinks,
		"linkRefsCount": linkRefsCount,
		"backmentions":  backmentions,
		"mentionsCount": mentionsCount,
		"k":             keyword,
		"mk":            mentionKeyword,
		"box":           boxID,
	}
}

func getBacklink(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}

	if nil == arg["id"] {
		return
	}

	id := arg["id"].(string)
	keyword := arg["k"].(string)
	mentionKeyword := arg["mk"].(string)
	beforeLen := 12
	if nil != arg["beforeLen"] {
		beforeLen = int(arg["beforeLen"].(float64))
	}
	containChildren := model.Conf.Editor.BacklinkContainChildren
	if val, ok := arg["containChildren"]; ok {
		containChildren = val.(bool)
	}
	boxID, err := encryptedNotebookForResponse(c, arg)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	var backlinks, backmentions []*model.Path
	var linkRefsCount, mentionsCount int
	if boxID != "" {
		boxID, backlinks, backmentions, linkRefsCount, mentionsCount = model.GetBacklinkInBox(id, keyword, mentionKeyword, beforeLen, containChildren, boxID)
	} else {
		boxID, backlinks, backmentions, linkRefsCount, mentionsCount = model.GetBacklink(id, keyword, mentionKeyword, beforeLen, containChildren)
	}
	if model.IsReadOnlyRoleContext(c) {
		publishAccess := model.GetPublishAccess()
		backlinks = model.FilterPathsByPublishAccess(c, publishAccess, backlinks)
		backmentions = model.FilterPathsByPublishAccess(c, publishAccess, backmentions)
	}
	ret.Data = map[string]any{
		"backlinks":     backlinks,
		"linkRefsCount": linkRefsCount,
		"backmentions":  backmentions,
		"mentionsCount": mentionsCount,
		"k":             keyword,
		"mk":            mentionKeyword,
		"box":           boxID,
	}
	util.RandomSleep(200, 500)
}
