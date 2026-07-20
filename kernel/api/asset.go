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
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/88250/go-humanize"
	"github.com/88250/gulu"
	"github.com/djherbis/times"
	"github.com/gin-gonic/gin"
	"github.com/siyuan-note/filelock"
	"github.com/siyuan-note/siyuan/kernel/model"
	"github.com/siyuan-note/siyuan/kernel/serviceauth"
	"github.com/siyuan-note/siyuan/kernel/sql"
	"github.com/siyuan-note/siyuan/kernel/util"
)

func statAsset(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}

	path := arg["path"].(string)
	var p string
	if strings.HasPrefix(path, "assets/") {
		var err error
		p, err = model.GetAssetAbsPathInBox(path, "")
		if err != nil {
			ret.Code = 1
			return
		}

	} else if localPath := util.FileURLToLocalPath(path); localPath != "" {
		p = localPath
	} else {
		ret.Code = 1
		return
	}

	if !util.IsAbsPathInWorkspace(p) {
		ret.Code = 1
		return
	}

	info, err := os.Stat(p)
	if err != nil {
		ret.Code = 1
		return
	}

	t, err := times.Stat(p)
	if err != nil {
		ret.Code = 1
		return
	}

	updated := t.ModTime().UnixMilli()
	hUpdated := t.ModTime().Format("2006-01-02 15:04:05")
	created := updated
	hCreated := hUpdated
	// Check birthtime before use
	if t.HasBirthTime() {
		created = t.BirthTime().UnixMilli()
		hCreated = t.BirthTime().Format("2006-01-02 15:04:05")
	}

	ret.Data = map[string]any{
		"size":     info.Size(),
		"hSize":    humanize.IBytesCustomCeil(uint64(info.Size()), 2),
		"created":  created,
		"hCreated": hCreated,
		"updated":  updated,
		"hUpdated": hUpdated,
	}
}

func fullReindexAssetContent(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	model.ReindexAssetContent()
}

type resolvedImageOCRAsset struct {
	absPath   string
	assetKey  string
	encrypted bool
	source    *os.File
}

const imageOCREncryptedAssetUnsupported = "OCR is not supported for assets in encrypted notebooks"

func resolveImageOCRAsset(c *gin.Context, arg map[string]any, retainSource bool) (resolvedImageOCRAsset, error) {
	assetPath, ok := arg["path"].(string)
	if !ok || strings.TrimSpace(assetPath) == "" {
		return resolvedImageOCRAsset{}, errors.New("field [path] must be a non-empty string")
	}
	notebookID, err := declaredNotebookForResponse(c, arg)
	if err != nil {
		return resolvedImageOCRAsset{}, err
	}
	var absPath, assetKey string
	var source *os.File
	if identity, enterpriseRequest := serviceauth.RequestContentIdentity(c.Request); enterpriseRequest {
		var documentAsset *model.DocumentAssetForOCR
		documentAsset, err = model.ResolveDocumentAssetForOCR(notebookID, identity.DocumentID, assetPath)
		if err == nil {
			absPath = documentAsset.AbsPath
			assetKey = documentAsset.AssetKey
			source = documentAsset.Source
		}
	} else {
		absPath, err = model.GetAssetAbsPathInBox(assetPath, notebookID)
		if err == nil {
			resolvedNotebookID := model.ExtractBoxIDFromAssetsPath(absPath)
			if notebookID != "" && resolvedNotebookID != "" && resolvedNotebookID != notebookID {
				return resolvedImageOCRAsset{}, errors.New("asset does not belong to the declared notebook")
			}
			assetKey, err = util.AssetTextKeyFromAbsPath(absPath)
		}
	}
	if err != nil {
		return resolvedImageOCRAsset{}, err
	}
	if source != nil && !retainSource {
		if err = source.Close(); err != nil {
			return resolvedImageOCRAsset{}, err
		}
		source = nil
	}
	return resolvedImageOCRAsset{
		absPath:   absPath,
		assetKey:  assetKey,
		encrypted: model.IsEncryptedAssetPath(absPath),
		source:    source,
	}, nil
}

func (asset *resolvedImageOCRAsset) close() error {
	if asset.source == nil {
		return nil
	}
	err := asset.source.Close()
	asset.source = nil
	return err
}

func getImageOCRText(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}

	asset, err := resolveImageOCRAsset(c, arg, false)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	if asset.encrypted {
		ret.Data = map[string]any{
			"text": "",
		}
		return
	}

	ret.Data = map[string]any{
		"text": util.GetAssetText(asset.assetKey),
	}
}

func setImageOCRText(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}

	asset, err := resolveImageOCRAsset(c, arg, false)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	text, ok := arg["text"].(string)
	if !ok {
		ret.Code = -1
		ret.Msg = "field [text] must be a string"
		return
	}
	if asset.encrypted {
		ret.Code = -1
		ret.Msg = imageOCREncryptedAssetUnsupported
		return
	}
	util.SetAssetText(asset.assetKey, text)

	// 刷新 OCR 结果到数据库
	util.NodeOCRQueueLock.Lock()
	defer util.NodeOCRQueueLock.Unlock()
	for _, id := range util.NodeOCRQueue {
		if err := sql.IndexNodeQueue(id, ""); err != nil {
			ret.Code = -1
			ret.Msg = err.Error()
			return
		}
	}
	util.NodeOCRQueue = nil
}

func ocr(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}

	asset, err := resolveImageOCRAsset(c, arg, true)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	if asset.encrypted {
		if closeErr := asset.close(); closeErr != nil {
			ret.Code = -1
			ret.Msg = closeErr.Error()
			return
		}
		ret.Code = -1
		ret.Msg = imageOCREncryptedAssetUnsupported
		ret.Data = map[string]any{"closeTimeout": 3000}
		return
	}

	var ocrJSON []map[string]any
	if asset.source == nil {
		ocrJSON, err = util.OcrAsset(asset.assetKey, asset.absPath)
	} else {
		ocrJSON, err = util.OcrAssetFromFile(asset.assetKey, asset.absPath, asset.source)
	}
	if closeErr := asset.close(); err == nil && closeErr != nil {
		err = closeErr
	}
	if nil != err {
		ret.Code = -1
		ret.Msg = err.Error()
		ret.Data = map[string]any{"closeTimeout": 7000}
		return
	}

	ret.Data = map[string]any{
		"text":    util.GetOcrJsonText(ocrJSON),
		"ocrJSON": ocrJSON,
	}
}

func renameAsset(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}

	oldPath := arg["oldPath"].(string)
	newName := arg["newName"].(string)
	newPath, err := model.RenameAsset(oldPath, newName)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		ret.Data = map[string]any{"closeTimeout": 5000}
		return
	}
	ret.Data = map[string]any{
		"newPath": newPath,
	}
}

func getDocImageAssets(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}

	id := arg["id"].(string)
	boxID, err := encryptedNotebookForResponse(c, arg)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	assets, err := model.DocImageAssetsInBox(id, boxID)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	if model.IsReadOnlyRoleContext(c) {
		publishAccess := model.GetPublishAccess()
		if !model.CheckBlockIdAccessableByPublishAccess(c, publishAccess, id) {
			ret.Code = -1
			ret.Msg = fmt.Sprintf(model.Conf.Language(15), id)
			return
		}
	}
	ret.Data = assets
}

func getDocAssets(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}

	id := arg["id"].(string)
	retainQueryStr := true
	if nil != arg["retainQueryStr"] {
		retainQueryStr = arg["retainQueryStr"].(bool)
	}

	boxID, err := encryptedNotebookForResponse(c, arg)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	assets, err := model.DocAssetsInBox(id, retainQueryStr, boxID)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	if model.IsReadOnlyRoleContext(c) {
		publishAccess := model.GetPublishAccess()
		if !model.CheckBlockIdAccessableByPublishAccess(c, publishAccess, id) {
			ret.Code = -1
			ret.Msg = fmt.Sprintf(model.Conf.Language(15), id)
			return
		}
	}
	ret.Data = assets
}

func setFileAnnotation(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}

	p := arg["path"].(string)
	p = strings.ReplaceAll(p, "%23", "#")
	data := arg["data"].(string)
	writePath, err := resolveFileAnnotationAbsPath(p)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	if err = model.CommitFileAnnotation(writePath, []byte(data), data == "{}"); err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
	}
}

func getFileAnnotation(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}

	p := arg["path"].(string)
	p = strings.ReplaceAll(p, "%23", "#")
	readPath, err := resolveFileAnnotationAbsPath(p)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		ret.Data = map[string]any{"closeTimeout": 5000}
		return
	}
	if !filelock.IsExist(readPath) {
		ret.Code = 1
		return
	}

	data, err := filelock.ReadFile(readPath)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	// 加密笔记本的 .sya 读盘后必须解密；未解锁时拒绝返回（fail-closed，避免返回密文或误判）
	if boxID := model.ExtractBoxIDFromAssetsPath(readPath); boxID != "" && model.IsEncryptedBox(boxID) {
		if err = RegisterEncryptedResponse(c, boxID); err != nil {
			ret.Code = -1
			ret.Msg = err.Error()
			return
		}
		dek, dekErr := model.GetDEKIfUnlocked(boxID)
		if dekErr != nil {
			ret.Code = -1
			ret.Msg = dekErr.Error()
			return
		}
		defer clear(dek)
		plain, decErr := model.DecryptAsset(boxID, filepath.Base(readPath), dek, data)
		if decErr != nil {
			ret.Code = -1
			ret.Msg = decErr.Error()
			return
		}
		data = plain
	}
	ret.Data = map[string]any{
		"data": string(data),
	}
}

func resolveFileAnnotationAbsPath(assetRelPath string) (ret string, err error) {
	// .sya 在 URL 末尾，例如 assets/a.pdf?box=<id>.sya
	// TrimSuffix 去掉 .sya 得到 assets/a.pdf?box=<id>，保留 query 供 box-aware 解析
	filePath := strings.TrimSuffix(assetRelPath, ".sya")
	absPath, err := model.GetAssetAbsPathInBox(filePath, "")
	if err != nil {
		return
	}
	ret = absPath + ".sya"
	return
}

func removeUnusedAsset(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}

	p := arg["path"].(string)
	asset, err := model.RemoveUnusedAsset(p)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	ret.Data = map[string]any{
		"path": asset,
	}
}

func removeUnusedAssets(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	paths, err := model.RemoveUnusedAssets()
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	ret.Data = map[string]any{
		"paths": paths,
	}
}

func getUnusedAssets(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	unusedAssets := model.UnusedAssets(true)
	total := len(unusedAssets)

	// List only 512 unreferenced assets https://github.com/siyuan-note/siyuan/issues/13075
	const maxUnusedAssets = 512
	if total > maxUnusedAssets {
		unusedAssets = unusedAssets[:maxUnusedAssets]
		util.PushMsg(fmt.Sprintf(model.Conf.Language(251), total, maxUnusedAssets), 5000)
	}

	ret.Data = unusedAssets
}

func getMissingAssets(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	missingAssets := model.MissingAssets()
	ret.Data = missingAssets
}

func resolveAssetPath(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}

	path := arg["path"].(string)
	p, err := model.GetAssetAbsPathInBox(path, "")
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		ret.Data = map[string]any{"closeTimeout": 3000}
		return
	}
	if model.IsEncryptedAssetPath(p) {
		ret.Code = -1
		ret.Msg = model.Conf.Language(314)
		ret.Data = map[string]any{"closeTimeout": 3000}
		return
	}
	ret.Data = p
	return
}

func uploadCloud(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}

	ignorePushMsg := false
	if nil != arg["ignorePushMsg"] {
		ignorePushMsg = arg["ignorePushMsg"].(bool)
	}

	id := arg["id"].(string)
	count, err := model.UploadAssets2Cloud(id, ignorePushMsg)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		ret.Data = map[string]any{"closeTimeout": 3000}
		return
	}

	util.PushMsg(fmt.Sprintf(model.Conf.Language(41), count), 3000)
}

func uploadCloudByAssetsPaths(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}

	if nil == arg["paths"] {
		ret.Code = -1
		ret.Msg = "[paths] is required"
		return
	}

	pathsArg := arg["paths"].([]any)
	var assets []string
	for _, pathArg := range pathsArg {
		assets = append(assets, pathArg.(string))
	}

	ignorePushMsg := false
	if nil != arg["ignorePushMsg"] {
		ignorePushMsg = arg["ignorePushMsg"].(bool)
	}

	count, err := model.UploadAssets2CloudByAssetsPaths(assets, ignorePushMsg)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		ret.Data = map[string]any{"closeTimeout": 3000}
		return
	}

	if !ignorePushMsg {
		util.PushMsg(fmt.Sprintf(model.Conf.Language(41), count), 3000)
	}
}

func insertLocalAssets(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}

	assetPathsArg := arg["assetPaths"].([]any)
	var assetPaths []string
	for _, pathArg := range assetPathsArg {
		assetPaths = append(assetPaths, pathArg.(string))
	}
	isUpload := true
	isUploadArg := arg["isUpload"]
	if nil != isUploadArg {
		isUpload = isUploadArg.(bool)
	}
	id := arg["id"].(string)
	succMap, err := model.InsertLocalAssets(id, assetPaths, isUpload)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	ret.Data = map[string]any{
		"succMap": succMap,
	}
}

func insertCover(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}

	name := arg["name"].(string)
	// 防止路径穿越：只允许文件名，不能含分隔符或 ..
	name = filepath.Base(name)
	if "" == name || "." == name || ".." == name {
		ret.Code = -1
		ret.Msg = "invalid name"
		return
	}

	srcPath := filepath.Join(util.AppearancePath, "covers", name)
	if gulu.File.IsDir(srcPath) {
		ret.Code = -1
		ret.Msg = "invalid cover"
		return
	}
	if _, statErr := os.Stat(srcPath); nil != statErr {
		ret.Code = -1
		ret.Msg = "cover not found"
		return
	}

	id := arg["id"].(string)
	succMap, err := model.InsertLocalAssets(id, []string{srcPath}, true)
	if nil != err {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}

	ret.Data = map[string]any{
		"succMap": succMap,
	}
}
