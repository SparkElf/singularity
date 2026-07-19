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
	"unicode/utf8"

	"github.com/88250/gulu"
	"github.com/gin-gonic/gin"
	"github.com/siyuan-note/siyuan/kernel/conf"
	"github.com/siyuan-note/siyuan/kernel/model"
	"github.com/siyuan-note/siyuan/kernel/util"
)

func resetGraph(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	graph := conf.NewGlobalGraph()
	model.Conf.Graph.Global = graph
	model.Conf.Save()
	ret.Data = map[string]any{
		"conf": graph,
	}
}

func resetLocalGraph(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	graph := conf.NewLocalGraph()
	model.Conf.Graph.Local = graph
	model.Conf.Save()
	ret.Data = map[string]any{
		"conf": graph,
	}
}

func getGraph(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}

	reqId := arg["reqId"]
	ret.Data = map[string]any{"reqId": reqId}

	var query string
	var confArg map[string]any
	if !util.ParseJsonArgs(arg, ret,
		util.BindJsonArg("k", &query, false, false),
		util.BindJsonArg("conf", &confArg, true, false),
	) {
		return
	}
	graphConf, err := gulu.JSON.MarshalJSON(confArg)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}

	global := conf.NewGlobalGraph()
	if err = gulu.JSON.UnmarshalJSON(graphConf, global); err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}

	if model.IsAdminRoleContext(c) && !model.IsReadOnlyRoleContext(c) {
		model.Conf.Graph.Global = global
		model.Conf.Save()
	}

	boxID, nodes, links := model.BuildGraph(query)
	if model.IsReadOnlyRoleContext(c) {
		publishAccess := model.GetPublishAccess()
		publishIgnore := model.GetInvisiblePublishAccess(publishAccess)
		nodes, links = model.FilterGraphByPublishIgnore(publishIgnore, nodes, links)
	}
	ret.Data = map[string]any{
		"nodes": nodes,
		"links": links,
		"conf":  global,
		"box":   boxID,
		"reqId": reqId,
	}
	util.RandomSleep(200, 500)
}

func getLocalGraph(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}

	reqId := arg["reqId"]
	ret.Data = map[string]any{"reqId": reqId}
	if nil == arg["id"] {
		return
	}

	var keyword, id string
	var confArg map[string]any
	if !util.ParseJsonArgs(arg, ret,
		util.BindJsonArg("k", &keyword, false, false),
		util.BindJsonArg("id", &id, true, true),
		util.BindJsonArg("conf", &confArg, true, false),
	) {
		return
	}

	graphConf, err := gulu.JSON.MarshalJSON(confArg)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}

	local := conf.NewLocalGraph()
	if err = gulu.JSON.UnmarshalJSON(graphConf, local); err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	if local.TypeFilter == nil || local.D3 == nil {
		ret.Code = -1
		ret.Msg = "graph configuration is unavailable"
		return
	}

	documentScope, enterprise, identityOK := enterpriseDiscoveryDocumentScopeFromRequest(c, arg, "id")
	if enterprise && !identityOK {
		ret.Code = -1
		ret.Msg = "document identity is unavailable"
		return
	}
	if enterprise && utf8.RuneCountInString(keyword) > enterpriseDiscoveryQueryMaxRunes {
		ret.Code = -1
		ret.Msg = "discovery query is too long"
		return
	}

	// Gateway策略将企业文档图谱声明为只读；认证后的文档面板请求不能把浏览器图谱配置
	// 持久化到Kernel。
	if !enterprise && model.IsAdminRoleContext(c) && !model.IsReadOnlyRoleContext(c) {
		model.Conf.Graph.Local = local
		model.Conf.Save()
	}

	var boxID string
	var nodes []*model.GraphNode
	var links []*model.GraphLink
	if enterprise {
		boxID, nodes, links = model.BuildTreeGraphInBoxWithConfig(
			documentScope.DocumentID,
			keyword,
			documentScope.NotebookID,
			local,
		)
	} else {
		boxID, nodes, links = model.BuildTreeGraphInBoxWithConfig(id, keyword, "", local)
	}
	if model.IsReadOnlyRoleContext(c) {
		publishAccess := model.GetPublishAccess()
		publishIgnore := model.GetInvisiblePublishAccess(publishAccess)
		nodes, links = model.FilterGraphByPublishIgnore(publishIgnore, nodes, links)
	}
	if enterprise {
		projectedNodes := enterpriseDiscoveryLocalGraphProjections(nodes)
		ret.Data = map[string]any{
			"links": enterpriseDiscoveryGraphLinkProjections(links, projectedNodes),
			"nodes": projectedNodes,
		}
		return
	}
	ret.Data = map[string]any{
		"id":    id,
		"box":   boxID,
		"nodes": nodes,
		"links": links,
		"conf":  local,
		"reqId": reqId,
	}
	util.RandomSleep(200, 500)
}
