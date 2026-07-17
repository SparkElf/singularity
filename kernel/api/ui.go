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
	"fmt"
	"net/http"

	"github.com/88250/gulu"
	"github.com/gin-gonic/gin"
	"github.com/siyuan-note/siyuan/kernel/model"
	"github.com/siyuan-note/siyuan/kernel/util"
)

func reloadTag(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	model.ReloadTag()
}

func reloadFiletree(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	model.ReloadFiletree()
}

func reloadProtyle(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}

	if _, provided := arg["notebook"]; !provided {
		ret.Code = -1
		ret.Msg = fmt.Errorf("%w: notebook", model.ErrInvalidID).Error()
		return
	}
	notebook, err := declaredNotebookForResponse(c, arg)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	id := arg["id"].(string)
	model.ReloadProtyle(id, model.TransactionNotebookForBox(notebook))
}

func reloadAttributeView(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}

	var id string
	if !util.ParseJsonArgs(arg, ret, util.BindJsonArg("id", &id, true, true)) {
		return
	}
	notebook, err := encryptedNotebookForResponse(c, arg)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	model.ReloadAttrViewInBox(id, notebook)
}

func reloadUI(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	util.ReloadUI()
}

func reloadIcon(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	model.LoadIcons()
	util.BroadcastByType("main", "setAppearance", 0, "", model.Conf.Appearance)
}

func reloadTheme(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	model.LoadThemes()
	util.BroadcastByType("main", "setAppearance", 0, "", model.Conf.Appearance)
}
