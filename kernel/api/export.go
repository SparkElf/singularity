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
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/88250/gulu"
	"github.com/88250/lute/ast"
	"github.com/88250/lute/parse"
	"github.com/gin-gonic/gin"
	"github.com/mssola/useragent"
	"github.com/siyuan-note/filelock"
	"github.com/siyuan-note/logging"
	"github.com/siyuan-note/siyuan/kernel/model"
	"github.com/siyuan-note/siyuan/kernel/treenode"
	"github.com/siyuan-note/siyuan/kernel/util"
)

func exportCodeBlock(c *gin.Context) {
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
	boxID, scopeErr := declaredNotebookForResponse(c, arg)
	if scopeErr != nil {
		ret.Code = -1
		ret.Msg = scopeErr.Error()
		return
	}
	filePath, err := model.ExportCodeBlockInBox(id, boxID)
	if err != nil {
		ret.Code = 1
		ret.Msg = err.Error()
		ret.Data = map[string]any{"closeTimeout": 7000}
		return
	}

	ret.Data = map[string]any{
		"path": filePath,
	}
}

func exportAttributeView(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}

	var avID, blockID string
	if !util.ParseJsonArgs(arg, ret,
		util.BindJsonArg("id", &avID, true, true),
		util.BindJsonArg("blockID", &blockID, true, true),
	) {
		return
	}
	boxID, scopeErr := declaredNotebookForResponse(c, arg)
	if scopeErr != nil {
		ret.Code = -1
		ret.Msg = scopeErr.Error()
		return
	}
	zipPath, err := model.ExportAv2CSVInBox(avID, blockID, boxID)
	if err != nil {
		ret.Code = 1
		ret.Msg = err.Error()
		ret.Data = map[string]any{"closeTimeout": 7000}
		return
	}

	ret.Data = map[string]any{
		"zip": zipPath,
	}
}

func exportEPUB(c *gin.Context) {
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
	boxID, err := declaredNotebookForResponse(c, arg)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	name, zipPath, err := model.ExportPandocConvertZipInBox([]string{id}, "epub", ".epub", boxID)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	ret.Data = map[string]any{
		"name": name,
		"zip":  zipPath,
	}
}

func exportRTF(c *gin.Context) {
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
	boxID, err := declaredNotebookForResponse(c, arg)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	name, zipPath, err := model.ExportPandocConvertZipInBox([]string{id}, "rtf", ".rtf", boxID)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	ret.Data = map[string]any{
		"name": name,
		"zip":  zipPath,
	}
}

func exportODT(c *gin.Context) {
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
	boxID, err := declaredNotebookForResponse(c, arg)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	name, zipPath, err := model.ExportPandocConvertZipInBox([]string{id}, "odt", ".odt", boxID)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	ret.Data = map[string]any{
		"name": name,
		"zip":  zipPath,
	}
}

func exportMediaWiki(c *gin.Context) {
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
	boxID, err := declaredNotebookForResponse(c, arg)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	name, zipPath, err := model.ExportPandocConvertZipInBox([]string{id}, "mediawiki", ".wiki", boxID)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	ret.Data = map[string]any{
		"name": name,
		"zip":  zipPath,
	}
}

func exportOrgMode(c *gin.Context) {
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
	boxID, err := declaredNotebookForResponse(c, arg)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	name, zipPath, err := model.ExportPandocConvertZipInBox([]string{id}, "org", ".org", boxID)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	ret.Data = map[string]any{
		"name": name,
		"zip":  zipPath,
	}
}

func exportOPML(c *gin.Context) {
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
	boxID, err := declaredNotebookForResponse(c, arg)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	name, zipPath, err := model.ExportPandocConvertZipInBox([]string{id}, "opml", ".opml", boxID)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	ret.Data = map[string]any{
		"name": name,
		"zip":  zipPath,
	}
}

func exportTextile(c *gin.Context) {
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
	boxID, err := declaredNotebookForResponse(c, arg)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	name, zipPath, err := model.ExportPandocConvertZipInBox([]string{id}, "textile", ".textile", boxID)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	ret.Data = map[string]any{
		"name": name,
		"zip":  zipPath,
	}
}

func exportAsciiDoc(c *gin.Context) {
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
	boxID, err := declaredNotebookForResponse(c, arg)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	name, zipPath, err := model.ExportPandocConvertZipInBox([]string{id}, "asciidoc", ".adoc", boxID)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	ret.Data = map[string]any{
		"name": name,
		"zip":  zipPath,
	}
}

func exportReStructuredText(c *gin.Context) {
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
	boxID, err := declaredNotebookForResponse(c, arg)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	name, zipPath, err := model.ExportPandocConvertZipInBox([]string{id}, "rst", ".rst", boxID)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	ret.Data = map[string]any{
		"name": name,
		"zip":  zipPath,
	}
}

func export2Liandi(c *gin.Context) {
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
	boxID, scopeErr := declaredNotebookForResponse(c, arg)
	if scopeErr != nil {
		ret.Code = -1
		ret.Msg = scopeErr.Error()
		return
	}
	err := model.Export2LiandiInBox(id, boxID)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
}

func exportDataInFolder(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}

	var exportFolder string
	if !util.ParseJsonArgs(arg, ret, util.BindJsonArg("folder", &exportFolder, true, true)) {
		return
	}
	exportFolder, err := model.ValidatePlaintextExportDestination(exportFolder)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	name, err := model.ExportDataInFolder(exportFolder)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		ret.Data = map[string]any{"closeTimeout": 7000}
		return
	}
	ret.Data = map[string]any{
		"name": name,
	}
}

func exportData(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	zipPath, err := model.ExportData()
	if err != nil {
		ret.Code = 1
		ret.Msg = err.Error()
		ret.Data = map[string]any{"closeTimeout": 7000}
		return
	}
	ret.Data = map[string]any{
		"zip": zipPath,
	}
}

func exportResources(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}

	var name string
	if nil != arg["name"] {
		name = util.TruncateLenFileName(arg["name"].(string))
	}
	if name == "" {
		name = time.Now().Format("export-2006-01-02_15-04-05") // 生成的 *.zip 文件主文件名
	}

	if nil == arg["paths"] {
		ret.Code = 1
		ret.Data = ""
		ret.Msg = "[paths] is required"
		return
	}

	var resourcePaths []string // 文件/文件夹在工作空间中的路径
	for _, resourcePath := range arg["paths"].([]any) {
		resourcePaths = append(resourcePaths, resourcePath.(string))
	}

	zipFilePath, err := model.ExportResources(resourcePaths, name)
	if err != nil {
		ret.Code = 1
		ret.Msg = err.Error()
		ret.Data = map[string]any{"closeTimeout": 7000}
		return
	}
	ret.Data = map[string]any{
		"path": zipFilePath, // 普通导出是工作空间相对路径；加密导出是 /export/managed capability。
	}
}

func exportNotebookMd(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}

	notebook, err := requiredNotebookForResponse(c, arg)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	zipPath, err := model.ExportNotebookMarkdownWithOptions(notebook, model.ParseExportOptions(arg))
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	ret.Data = map[string]any{
		"name": path.Base(zipPath),
		"zip":  zipPath,
	}
}

func exportMds(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}

	idsArg, idsOK := arg["ids"].([]any)
	if !idsOK || len(idsArg) == 0 {
		ret.Code = -1
		ret.Msg = "ids is required"
		return
	}
	var ids []string
	for _, id := range idsArg {
		value, valueOK := id.(string)
		if !valueOK || !ast.IsNodeIDPattern(value) {
			ret.Code = -1
			ret.Msg = "invalid id"
			return
		}
		ids = append(ids, value)
	}
	boxID, err := declaredNotebookForResponse(c, arg)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	name, zipPath, err := model.ExportPandocConvertZipWithOptionsInBox(ids, "", ".md", model.ParseExportOptions(arg), boxID)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	ret.Data = map[string]any{
		"name": name,
		"zip":  zipPath,
	}
}

func exportMd(c *gin.Context) {
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
	boxID, err := declaredNotebookForResponse(c, arg)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	name, zipPath, err := model.ExportPandocConvertZipWithOptionsInBox([]string{id}, "", ".md", model.ParseExportOptions(arg), boxID)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	ret.Data = map[string]any{
		"name": name,
		"zip":  zipPath,
	}
}

func exportNotebookSY(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}

	notebook, err := requiredNotebookForResponse(c, arg)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	zipPath, err := model.ExportNotebookSY(notebook)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	ret.Data = map[string]any{
		"zip": zipPath,
	}
}

func exportSYs(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}

	idsArg, idsOK := arg["ids"].([]any)
	if !idsOK || len(idsArg) == 0 {
		ret.Code = -1
		ret.Msg = "ids is required"
		return
	}
	var ids []string
	for _, id := range idsArg {
		value, valueOK := id.(string)
		if !valueOK || !ast.IsNodeIDPattern(value) {
			ret.Code = -1
			ret.Msg = "invalid id"
			return
		}
		ids = append(ids, value)
	}
	boxID, err := declaredNotebookForResponse(c, arg)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	zipPath, err := model.ExportSYsInBox(ids, boxID)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	ret.Data = map[string]any{
		"zip": zipPath,
	}
}

func exportSY(c *gin.Context) {
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
	boxID, err := declaredNotebookForResponse(c, arg)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	zipPath, err := model.ExportSYsInBox([]string{id}, boxID)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	ret.Data = map[string]any{
		"zip": zipPath,
	}
}

func exportMdContent(c *gin.Context) {
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
	if util.InvalidIDPattern(id, ret) {
		return
	}
	boxID, scopeErr := declaredNotebookForResponse(c, arg)
	if scopeErr != nil {
		ret.Code = -1
		ret.Msg = scopeErr.Error()
		return
	}

	refMode := model.Conf.Export.BlockRefMode
	if nil != arg["refMode"] {
		refMode = int(arg["refMode"].(float64))
	}

	embedMode := model.Conf.Export.BlockEmbedMode
	if nil != arg["embedMode"] {
		embedMode = int(arg["embedMode"].(float64))
	}

	yfm := true
	if nil != arg["yfm"] {
		yfm = arg["yfm"].(bool)
	}

	var fillCSSVar, adjustHeadingLevel, imgTag bool
	if !util.ParseJsonArgs(arg, ret,
		util.BindJsonArg("fillCSSVar", &fillCSSVar, false, false),
		util.BindJsonArg("adjustHeadingLevel", &adjustHeadingLevel, false, false),
		util.BindJsonArg("imgTag", &imgTag, false, false),
	) {
		return
	}

	addTitle := model.Conf.Export.AddTitle
	if nil != arg["addTitle"] {
		if arg["addTitle"].(bool) {
			addTitle = true
		} else {
			addTitle = false
		}
	}

	hPath, content, err := model.ExportMarkdownContentInBox(id, refMode, embedMode, yfm, fillCSSVar, adjustHeadingLevel, imgTag, addTitle, boxID)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	ret.Data = map[string]any{
		"hPath":   hPath,
		"content": content,
	}
}

func exportDocx(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}

	var id, savePath string
	var removeAssets, merge bool
	if !util.ParseJsonArgs(arg, ret,
		util.BindJsonArg("id", &id, true, true),
		util.BindJsonArg("savePath", &savePath, true, true),
		util.BindJsonArg("removeAssets", &removeAssets, true, false),
		util.BindJsonArg("merge", &merge, false, false),
	) {
		return
	}
	boxID, scopeErr := declaredNotebookForResponse(c, arg)
	if scopeErr != nil {
		ret.Code = -1
		ret.Msg = scopeErr.Error()
		return
	}

	savePath, err := model.ValidatePlaintextExportDestination(savePath)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}

	fullPath, err := model.ExportDocxInBox(id, savePath, removeAssets, merge, boxID)
	if err != nil {
		ret.Code = 1
		ret.Msg = err.Error()
		ret.Data = map[string]any{"closeTimeout": 7000}
		return
	}
	ret.Data = map[string]any{
		"path": fullPath,
	}
}

func exportMdHTML(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}

	var id, savePath string
	if !util.ParseJsonArgs(arg, ret,
		util.BindJsonArg("id", &id, true, true),
		util.BindJsonArg("savePath", &savePath, false, false),
	) {
		return
	}
	boxID, scopeErr := declaredNotebookForResponse(c, arg)
	if scopeErr != nil {
		ret.Code = -1
		ret.Msg = scopeErr.Error()
		return
	}

	savePath = strings.TrimSpace(savePath)
	if savePath == "" {
		job, tmpDir, err := model.CreateExportStage(boxID, "htmlmd")
		if err != nil {
			ret.Code = -1
			ret.Msg = err.Error()
			return
		}
		stageAvailable := false
		defer func() {
			if stageAvailable {
				return
			}
			if cleanupErr := model.DiscardExportStage(job, boxID); cleanupErr != nil && !errors.Is(cleanupErr, model.ErrManagedEncryptedExportUnavailable) {
				logging.LogWarnf("discard Markdown HTML export stage for notebook [%s] failed: %s", boxID, cleanupErr)
				if ret.Code == 0 {
					ret.Code = -1
					ret.Msg = "export stage cleanup failed" + errMsgSeeKernelLog
					ret.Data = nil
				}
			}
		}()
		name, content, err := model.ExportMarkdownHTMLInBox(id, tmpDir, false, false, boxID)
		if err != nil {
			ret.Code = -1
			ret.Msg = err.Error()
			return
		}
		if err = model.CompleteExportStage(job, boxID); err != nil {
			ret.Code = -1
			ret.Msg = err.Error()
			return
		}
		stageAvailable = true
		ret.Data = map[string]any{
			"id":      id,
			"name":    name,
			"content": content,
			"job":     job,
		}
		return
	}

	savePath, err := model.ValidatePlaintextExportDestination(savePath)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}

	name, content, err := model.ExportMarkdownHTMLInBox(id, savePath, false, false, boxID)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	ret.Data = map[string]any{
		"id":      id,
		"name":    name,
		"content": content,
	}
}

func exportTempContent(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}

	var content string
	if !util.ParseJsonArgs(arg, ret,
		util.BindJsonArg("content", &content, true, false),
	) {
		return
	}
	boxID, scopeErr := declaredNotebookForResponse(c, arg)
	if scopeErr != nil {
		ret.Code = -1
		ret.Msg = scopeErr.Error()
		return
	}
	tmpExport := filepath.Join(util.TempDir, "export")
	if model.IsEncryptedBox(boxID) {
		tmpExport = filepath.Join(tmpExport, boxID)
	}
	tmpExport = filepath.Join(tmpExport, "temp")
	if err := os.MkdirAll(tmpExport, 0755); err != nil {
		ret.Code = 1
		ret.Msg = err.Error()
		ret.Data = map[string]any{"closeTimeout": 7000}
		return
	}
	file, err := os.CreateTemp(tmpExport, "")
	if err != nil {
		ret.Code = 1
		ret.Msg = err.Error()
		ret.Data = map[string]any{"closeTimeout": 7000}
		return
	}
	p := file.Name()
	if _, err = file.WriteString(content); err == nil {
		err = file.Sync()
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		_ = os.Remove(p)
		ret.Code = 1
		ret.Msg = err.Error()
		ret.Data = map[string]any{"closeTimeout": 7000}
		return
	}
	baseName := filepath.Base(p)
	urlPath := "/export/"
	if model.IsEncryptedBox(boxID) {
		// 加密笔记本的临时导出产物须注册到托管表，否则服务端守卫（IsManagedEncryptedExportPath）会拒绝下载
		token, registerErr := model.RegisterManagedEncryptedExport(boxID, "temp", p, "export.html")
		if registerErr != nil {
			_ = os.Remove(p)
			ret.Code = 1
			ret.Msg = registerErr.Error()
			ret.Data = map[string]any{"closeTimeout": 7000}
			return
		}
		urlPath += token
	} else {
		urlPath = path.Join(urlPath, "temp", baseName)
	}
	ret.Data = map[string]any{
		"url": util.ServerURL.Scheme + "://" + util.LocalHost + ":" + util.ServerPort + urlPath,
	}
}

func exportBrowserHTML(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}

	var job, htmlContent, name string
	if !util.ParseJsonArgs(arg, ret,
		util.BindJsonArg("job", &job, true, true),
		util.BindJsonArg("html", &htmlContent, true, true),
		util.BindJsonArg("name", &name, true, true),
	) {
		return
	}
	boxID, scopeErr := declaredNotebookForResponse(c, arg)
	if scopeErr != nil {
		ret.Code = -1
		ret.Msg = scopeErr.Error()
		return
	}
	stage, ok := model.TakeExportStage(job, boxID)
	if !ok {
		ret.Code = -1
		ret.Msg = "invalid or expired export job"
		return
	}
	tmpDir := stage.Directory
	defer func() {
		if closeErr := stage.Close(); closeErr != nil {
			logging.LogWarnf("close browser HTML export stage for notebook [%s] failed: %s", boxID, closeErr)
			if ret.Code == 0 {
				ret.Code = -1
				ret.Msg = "export stage cleanup failed" + errMsgSeeKernelLog
				ret.Data = nil
			}
		}
	}()

	htmlPath := filepath.Join(tmpDir, "index.html")
	if err := filelock.WriteFile(htmlPath, []byte(htmlContent)); err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		ret.Data = nil
		return
	}

	zipBaseName := util.FilterFileName(name)
	if zipBaseName == "" || zipBaseName == "." || zipBaseName == ".." {
		zipBaseName = "export"
	}
	zipFileName := zipBaseName + ".zip"
	zipDir := filepath.Join(util.TempDir, "export", job)
	if model.IsEncryptedBox(boxID) {
		zipDir = filepath.Join(util.TempDir, "export", boxID, "html", job)
	}
	if err := os.MkdirAll(zipDir, 0755); err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	zipAbsPath := filepath.Join(zipDir, zipFileName)
	zipPartialPath := zipAbsPath + ".partial"
	defer os.Remove(zipPartialPath)

	zip, err := gulu.Zip.Create(zipPartialPath)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		ret.Data = nil
		return
	}

	err = zip.AddDirectory("", tmpDir, func(string) {})
	if err != nil {
		_ = zip.Close()
		ret.Code = -1
		ret.Msg = err.Error()
		ret.Data = nil
		return
	}

	if err = zip.Close(); err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		ret.Data = nil
		return
	}
	if err = os.Rename(zipPartialPath, zipAbsPath); err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		ret.Data = nil
		return
	}

	var zipURL string
	if model.IsEncryptedBox(boxID) {
		managedPath, registerErr := model.RegisterManagedEncryptedExport(boxID, "html", zipAbsPath, zipFileName)
		if registerErr != nil {
			_ = os.Remove(zipAbsPath)
			ret.Code = -1
			ret.Msg = registerErr.Error()
			ret.Data = nil
			return
		}
		zipURL = "/export/" + managedPath
	} else {
		zipURL = path.Join("/export", job, url.PathEscape(zipFileName))
	}
	ret.Data = map[string]any{
		"zip": zipURL,
	}
}

func exportPreviewHTML(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}

	var id string
	var keepFold, merge, image bool
	if !util.ParseJsonArgs(arg, ret,
		util.BindJsonArg("id", &id, true, true),
		util.BindJsonArg("keepFold", &keepFold, false, false),
		util.BindJsonArg("merge", &merge, false, false),
		util.BindJsonArg("image", &image, false, false),
	) {
		return
	}
	boxID, scopeErr := declaredNotebookForResponse(c, arg)
	if scopeErr != nil {
		ret.Code = -1
		ret.Msg = scopeErr.Error()
		return
	}
	name, content, node, err := model.ExportHTMLInBox(id, "", true, keepFold, merge, boxID)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	// 导出 PDF 预览时点击块引转换后的脚注跳转不正确 https://github.com/siyuan-note/siyuan/issues/5894
	content = strings.ReplaceAll(content, "http://"+util.LocalHost+":"+util.ServerPort+"/#", "#")

	// Add `data-doc-type` and attribute when exporting image and PDF https://github.com/siyuan-note/siyuan/issues/9497
	attrs := map[string]string{}
	var typ string
	if nil != node {
		attrs = parse.IAL2Map(node.KramdownIAL)
		typ = node.Type.String()
	}

	ret.Data = map[string]any{
		"id":      id,
		"name":    name,
		"content": content,
		"attrs":   attrs,
		"type":    typ,
	}
}

func exportHTML(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}

	var id, savePath string
	var pdf, keepFold, merge bool
	if !util.ParseJsonArgs(arg, ret,
		util.BindJsonArg("id", &id, true, true),
		util.BindJsonArg("pdf", &pdf, true, false),
		util.BindJsonArg("savePath", &savePath, false, false),
		util.BindJsonArg("keepFold", &keepFold, false, false),
		util.BindJsonArg("merge", &merge, false, false),
	) {
		return
	}
	boxID, scopeErr := declaredNotebookForResponse(c, arg)
	if scopeErr != nil {
		ret.Code = -1
		ret.Msg = scopeErr.Error()
		return
	}

	savePath = strings.TrimSpace(savePath)
	if savePath == "" {
		job, tmpDir, err := model.CreateExportStage(boxID, "html")
		if err != nil {
			ret.Code = -1
			ret.Msg = err.Error()
			return
		}
		stageAvailable := false
		defer func() {
			if stageAvailable {
				return
			}
			if cleanupErr := model.DiscardExportStage(job, boxID); cleanupErr != nil && !errors.Is(cleanupErr, model.ErrManagedEncryptedExportUnavailable) {
				logging.LogWarnf("discard HTML export stage for notebook [%s] failed: %s", boxID, cleanupErr)
				if ret.Code == 0 {
					ret.Code = -1
					ret.Msg = "export stage cleanup failed" + errMsgSeeKernelLog
					ret.Data = nil
				}
			}
		}()
		name, content, _, err := model.ExportHTMLInBox(id, tmpDir, pdf, keepFold, merge, boxID)
		if err != nil {
			ret.Code = -1
			ret.Msg = err.Error()
			return
		}
		if err = model.CompleteExportStage(job, boxID); err != nil {
			ret.Code = -1
			ret.Msg = err.Error()
			return
		}
		stageAvailable = true
		ret.Data = map[string]any{
			"id":      id,
			"name":    name,
			"content": content,
			"job":     job,
		}
		return
	}

	savePath, err := model.ValidatePlaintextExportDestination(savePath)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}

	name, content, _, err := model.ExportHTMLInBox(id, savePath, pdf, keepFold, merge, boxID)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	ret.Data = map[string]any{
		"id":      id,
		"name":    name,
		"content": content,
	}
}

func processPDF(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}

	var id, pdfPath string
	var merge, removeAssets, watermark bool
	if !util.ParseJsonArgs(arg, ret,
		util.BindJsonArg("id", &id, true, true),
		util.BindJsonArg("path", &pdfPath, true, true),
		util.BindJsonArg("merge", &merge, false, false),
		util.BindJsonArg("removeAssets", &removeAssets, true, false),
		util.BindJsonArg("watermark", &watermark, true, false),
	) {
		return
	}
	boxID, scopeErr := declaredNotebookForResponse(c, arg)
	if scopeErr != nil {
		ret.Code = -1
		ret.Msg = scopeErr.Error()
		return
	}
	pdfPath, err := model.ValidatePlaintextExportDestination(pdfPath)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	err = model.ProcessPDFInBox(id, pdfPath, merge, removeAssets, watermark, boxID)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
}

func exportPreview(c *gin.Context) {
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
	boxID, scopeErr := declaredNotebookForResponse(c, arg)
	if scopeErr != nil {
		ret.Code = -1
		ret.Msg = scopeErr.Error()
		return
	}

	userAgentStr := c.GetHeader("User-Agent")
	fillCSSVar := true
	if userAgentStr != "" {
		ua := useragent.New(userAgentStr)
		name, _ := ua.Browser()
		// Chrome、Edge、SiYuan 桌面端不需要替换 CSS 变量
		if !ua.Mobile() && (name == "Chrome" || name == "Edge" || strings.Contains(userAgentStr, "Electron") || strings.Contains(userAgentStr, "SiYuan/")) {
			fillCSSVar = false
		}
	}

	stdHTML, err := model.ExportPreviewInBox(id, fillCSSVar, boxID)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	if model.IsReadOnlyRoleContext(c) {
		bt := treenode.GetBlockTreeInBox(id, boxID)
		if bt != nil {
			publishAccess := model.GetPublishAccess()
			stdHTML = model.FilterContentByPublishAccess(c, publishAccess, bt.BoxID, bt.Path, stdHTML, true)
		}
	}
	ret.Data = map[string]any{
		"html":       stdHTML,
		"fillCSSVar": fillCSSVar,
	}
}

func exportAsFile(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	form, err := c.MultipartForm()
	if err != nil {
		logging.LogErrorf("export as file failed: %s", err)
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}

	files := form.File["file"]
	if len(files) == 0 {
		ret.Code = -1
		ret.Msg = "file is required"
		return
	}
	types := form.Value["type"]
	if len(types) == 0 || types[0] == "" {
		ret.Code = -1
		ret.Msg = "type is required"
		return
	}
	boxID := ""
	if notebooks := form.Value["notebook"]; len(notebooks) > 0 && notebooks[0] != "" {
		boxID, err = declaredNotebookForResponse(c, map[string]any{"notebook": notebooks[0]})
		if err != nil {
			ret.Code = -1
			ret.Msg = err.Error()
			return
		}
	}

	file := files[0]
	reader, err := file.Open()
	if err != nil {
		logging.LogErrorf("export as file failed: %s", err)
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	defer reader.Close()

	data, err := io.ReadAll(reader)
	if err != nil {
		logging.LogErrorf("export as file failed: %s", err)
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}

	typ := types[0]
	exts, _ := mime.ExtensionsByType(typ)
	displayFileName := util.FilterFileName(file.Filename)
	if displayFileName == "" || displayFileName == "." || displayFileName == ".." {
		displayFileName = "export"
	}
	ext := filepath.Ext(displayFileName)
	if 0 < len(exts) && !strings.EqualFold(ext, exts[0]) {
		displayFileName = strings.TrimSuffix(displayFileName, ext) + exts[0]
		ext = exts[0]
	}

	exportRoot := filepath.Join(util.TempDir, "export")
	if err = os.MkdirAll(exportRoot, 0755); err != nil {
		logging.LogErrorf("export as file failed: %s", err)
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}

	var tmp string
	var tmpFile *os.File
	var ordinaryArtifactDir string
	if model.IsEncryptedBox(boxID) {
		tmpDir := filepath.Join(exportRoot, boxID, "file")
		if err = os.MkdirAll(tmpDir, 0755); err == nil {
			tmpFile, err = os.CreateTemp(tmpDir, "file-*"+ext)
			if err == nil {
				tmp = tmpFile.Name()
			}
		}
	} else {
		ordinaryArtifactDir, err = os.MkdirTemp(exportRoot, "file-")
		if err == nil {
			tmp = filepath.Join(ordinaryArtifactDir, displayFileName)
			tmpFile, err = os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		}
	}
	if err != nil {
		if ordinaryArtifactDir != "" {
			_ = os.RemoveAll(ordinaryArtifactDir)
		}
		logging.LogErrorf("export as file failed: %s", err)
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	if _, err = tmpFile.Write(data); err == nil {
		err = tmpFile.Sync()
	}
	if closeErr := tmpFile.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		_ = os.Remove(tmp)
		if ordinaryArtifactDir != "" {
			_ = os.RemoveAll(ordinaryArtifactDir)
		}
		logging.LogErrorf("export as file failed: %s", err)
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}

	fileURL := path.Join("/export", filepath.Base(ordinaryArtifactDir), url.PathEscape(displayFileName))
	if model.IsEncryptedBox(boxID) {
		managedPath, registerErr := model.RegisterManagedEncryptedExport(boxID, "file", tmp, displayFileName)
		if registerErr != nil {
			_ = os.Remove(tmp)
			ret.Code = -1
			ret.Msg = registerErr.Error()
			return
		}
		fileURL = "/export/" + managedPath
	}
	ret.Data = map[string]any{
		"file": fileURL,
	}
}

func copyExportFile(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}

	var srcPath, dest string
	if !util.ParseJsonArgs(arg, ret,
		util.BindJsonArg("srcPath", &srcPath, true, true),
		util.BindJsonArg("dest", &dest, true, true),
	) {
		return
	}

	if !filepath.IsAbs(dest) {
		ret.Code = -1
		ret.Msg = "dest must be an absolute path"
		return
	}
	dest, err := model.ValidatePlaintextExportDestination(dest)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}

	relativeExportPath, parseErr := parseExportSourcePath(srcPath)
	if parseErr != nil {
		ret.Code = -1
		ret.Msg = "invalid source path"
		return
	}
	if model.IsManagedEncryptedExportPath(relativeExportPath) {
		claim, claimErr := model.ClaimManagedEncryptedExport(relativeExportPath)
		if claimErr != nil {
			ret.Code = -1
			if errors.Is(claimErr, model.ErrManagedEncryptedExportUnavailable) {
				ret.Msg = model.ErrManagedEncryptedExportUnavailable.Error()
			} else {
				ret.Msg = model.ErrManagedEncryptedExportArtifact.Error()
			}
			return
		}
		defer func() {
			if closeErr := claim.Close(); closeErr != nil {
				logging.LogWarnf("close copied managed export claim for notebook [%s] failed: %s", claim.BoxID, closeErr)
				if ret.Code == 0 {
					ret.Code = -1
					ret.Msg = "copy export cleanup failed" + errMsgSeeKernelLog
				}
			}
		}()
		dek, dekErr := model.GetDEKIfUnlocked(claim.BoxID)
		if dekErr != nil {
			ret.Code = -1
			ret.Msg = "encrypted notebook locked"
			return
		}
		clear(dek)

		copyErr := util.PublishFile(claim.File, 0600, dest)
		if copyErr != nil {
			logging.LogErrorf("copy managed export for notebook [%s] to [%s] failed: %s", claim.BoxID, dest, copyErr)
			ret.Code = -1
			ret.Msg = "copy export failed" + errMsgSeeKernelLog
		}
		return
	}

	opened, openErr := util.OpenLocalExportFile(relativeExportPath)
	if openErr != nil {
		ret.Code = -1
		ret.Msg = "invalid source path"
		return
	}
	copyErr := util.PublishFile(opened.File, opened.Info.Mode(), dest)
	copyErr = errors.Join(copyErr, opened.Close())
	if copyErr != nil {
		logging.LogErrorf("copy ordinary export [%s] to [%s] failed: %s", relativeExportPath, dest, copyErr)
		ret.Code = -1
		ret.Msg = "copy export failed" + errMsgSeeKernelLog
	}
}

func parseExportSourcePath(source string) (string, error) {
	decoded, err := url.PathUnescape(source)
	if err != nil || strings.Contains(decoded, `\`) {
		return "", errors.New("invalid export source path")
	}
	var relative string
	switch {
	case strings.HasPrefix(decoded, "/export/"):
		relative = strings.TrimPrefix(decoded, "/export/")
	case strings.HasPrefix(decoded, "export/"):
		relative = strings.TrimPrefix(decoded, "export/")
	default:
		return "", errors.New("invalid export source path")
	}
	return util.CanonicalExportRelativePath(relative)
}
