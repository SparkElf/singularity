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

package model

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"

	"github.com/88250/gulu"
	"github.com/88250/lute/ast"
	"github.com/gin-gonic/gin"
	"github.com/siyuan-note/filelock"
	"github.com/siyuan-note/logging"
	"github.com/siyuan-note/siyuan/kernel/cache"
	"github.com/siyuan-note/siyuan/kernel/treenode"
	"github.com/siyuan-note/siyuan/kernel/util"
)

func InsertLocalAssets(id string, assetAbsPaths []string, isUpload bool) (succMap map[string]any, err error) {
	succMap = map[string]any{}

	bt := treenode.GetBlockTree(id)
	if nil == bt {
		err = errors.New(Conf.Language(71))
		return
	}

	docDirLocalPath := filepath.Join(util.DataDir, bt.BoxID, path.Dir(bt.Path))
	assetsDirPath := getAssetsDir(filepath.Join(util.DataDir, bt.BoxID), docDirLocalPath)
	if !gulu.File.IsExist(assetsDirPath) {
		if err = os.MkdirAll(assetsDirPath, 0755); err != nil {
			return
		}
	}

	for _, assetAbsPath := range assetAbsPaths {
		baseName := filepath.Base(assetAbsPath)
		fName := baseName
		fName = util.FilterUploadFileName(fName)
		ext := filepath.Ext(fName)
		fName = strings.TrimSuffix(fName, ext)
		ext = strings.ToLower(ext)
		fName += ext
		if gulu.File.IsDir(assetAbsPath) || !isUpload {
			if !strings.HasPrefix(assetAbsPath, "\\\\") {
				assetAbsPath = "file://" + assetAbsPath
			}
			succMap[baseName] = assetAbsPath
			continue
		}

		if gulu.File.IsSubPath(assetsDirPath, assetAbsPath) {
			// 已经位于 assets 目录下的资源文件不处理
			// Dragging a file from the assets folder into the editor causes the kernel to exit https://github.com/siyuan-note/siyuan/issues/15355
			succMap[baseName] = "assets/" + baseName
			continue
		}

		fi, statErr := os.Stat(assetAbsPath)
		if nil != statErr {
			err = statErr
			return
		}
		f, openErr := os.Open(assetAbsPath)
		if nil != openErr {
			err = openErr
			return
		}

		hash, hashErr := util.GetEtagByHandle(f, fi.Size())
		if nil != hashErr {
			f.Close()
			return
		}

		if 1 > fi.Size() {
			hash = "random_1_" + gulu.Rand.String(12)
		}

		existAssetPath := GetAssetPathByHash(hash, bt.BoxID)
		if "" != existAssetPath {
			originalName := util.RemoveID(filepath.Base(existAssetPath))
			if strings.ToLower(fName) != strings.ToLower(originalName) {
				hash = "random_2_" + gulu.Rand.String(12)
			}
		}

		if "" != existAssetPath && !strings.HasPrefix(hash, "random_") {
			succMap[baseName] = strings.TrimPrefix(existAssetPath, "/")
			f.Close()
		} else {
			blockID := ast.NewNodeID()
			if IsEncryptedBox(bt.BoxID) {
				// 加密 box：磁盘文件名脱敏为 uuid-blockID.ext，原始名存加密映射
				fName = encryptedAssetName(util.Ext(fName), blockID)
			} else {
				fName = util.AssetName(fName, blockID)
			}
			writePath := filepath.Join(assetsDirPath, fName)
			if _, err = f.Seek(0, io.SeekStart); err != nil {
				f.Close()
				return
			}
			if err = writeAssetFile(writePath, f, bt.BoxID, baseName); err != nil {
				f.Close()
				return
			}
			f.Close()

			p := "assets/" + fName
			if IsEncryptedBox(bt.BoxID) {
				p += "?box=" + bt.BoxID
			}
			succMap[baseName] = p
			if !IsEncryptedBox(bt.BoxID) {
				cache.SetAssetHash(hash, p) // 加密笔记本不写全局 cache，避免跨边界去重污染
			}
		}
	}
	IncSync()
	return
}

func Upload(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(200, ret)

	form, err := c.MultipartForm()
	if err != nil {
		logging.LogErrorf("insert asset failed: %s", err)
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	declaredNotebookID := ""
	if values, ok := form.Value["notebook"]; ok {
		if len(values) != 1 || !ast.IsNodeIDPattern(values[0]) {
			ret.Code = -1
			ret.Msg = fmt.Errorf("%w: notebook", ErrInvalidID).Error()
			return
		}
		declaredNotebookID = values[0]
		if Conf.GetBox(declaredNotebookID) == nil {
			ret.Code = -1
			ret.Msg = fmt.Errorf("%w: %s", ErrBoxNotFound, declaredNotebookID).Error()
			return
		}
	}
	assetsDirPath := filepath.Join(util.DataDir, "assets")
	var uploadBoxID string // 记录上传目标 boxID，供 writeAssetFile 判断是否需加密
	if nil != form.Value["id"] {
		id := form.Value["id"][0]
		var bt *treenode.BlockTree
		if declaredNotebookID != "" && IsEncryptedBox(declaredNotebookID) {
			bt = treenode.GetBlockTreeInBox(id, declaredNotebookID)
		} else {
			bt = treenode.GetBlockTree(id)
			if declaredNotebookID != "" && (bt == nil || bt.BoxID != declaredNotebookID) {
				bt = nil
			}
		}
		if nil == bt {
			ret.Code = -1
			ret.Msg = Conf.Language(71)
			return
		}
		uploadBoxID = bt.BoxID
		docDirLocalPath := filepath.Join(util.DataDir, bt.BoxID, path.Dir(bt.Path))
		assetsDirPath = getAssetsDir(filepath.Join(util.DataDir, bt.BoxID), docDirLocalPath)
	}

	relAssetsDirPath := "assets"
	if nil != form.Value["assetsDirPath"] {
		relAssetsDirPath = form.Value["assetsDirPath"][0]
		assetsDirPath = filepath.Join(util.DataDir, relAssetsDirPath)
		if !util.IsAbsPathInWorkspace(assetsDirPath) {
			ret.Code = -1
			ret.Msg = "Path [" + assetsDirPath + "] is not in workspace"
			return
		}
		pathBoxID := ExtractBoxIDFromAssetsPath(assetsDirPath)
		expectedBoxID := uploadBoxID
		if expectedBoxID == "" {
			expectedBoxID = declaredNotebookID
		}
		if expectedBoxID != "" && pathBoxID != expectedBoxID {
			ret.Code = -1
			ret.Msg = fmt.Sprintf("assets directory notebook [%s] does not match declared notebook [%s]", pathBoxID, expectedBoxID)
			return
		}
		if pathBoxID != "" && IsEncryptedBox(pathBoxID) && expectedBoxID == "" {
			ret.Code = -1
			ret.Msg = "encrypted asset upload requires an explicit notebook"
			return
		}
		uploadBoxID = expectedBoxID
	} else if declaredNotebookID != "" && uploadBoxID == "" {
		ret.Code = -1
		ret.Msg = "asset upload with an explicit notebook requires a document or assets directory target"
		return
	}
	if !gulu.File.IsExist(assetsDirPath) {
		if err = os.MkdirAll(assetsDirPath, 0755); err != nil {
			ret.Code = -1
			ret.Msg = err.Error()
			return
		}
	}

	var errFiles []string
	succMap := map[string]any{}
	files := form.File["file[]"]
	skipIfDuplicated := false // 默认不跳过重复文件，但是有的场景需要跳过，比如上传 PDF 标注图片 https://github.com/siyuan-note/siyuan/issues/10666
	if nil != form.Value["skipIfDuplicated"] {
		skipIfDuplicated = "true" == form.Value["skipIfDuplicated"][0]
	}

	for _, file := range files {
		baseName := file.Filename
		_, lastID := util.LastID(baseName)
		if !ast.IsNodeIDPattern(lastID) {
			lastID = ""
		}

		needUnzip2Dir := false
		if gulu.OS.IsDarwin() {
			if strings.HasSuffix(baseName, ".rtfd.zip") {
				needUnzip2Dir = true
			}
		}

		fName := baseName
		fName = util.FilterUploadFileName(fName)
		ext := filepath.Ext(fName)
		fName = strings.TrimSuffix(fName, ext)
		ext = strings.ToLower(ext)
		fName += ext
		f, openErr := file.Open()
		if nil != openErr {
			errFiles = append(errFiles, fName)
			ret.Msg = openErr.Error()
			break
		}
		if needUnzip2Dir && IsEncryptedBox(uploadBoxID) {
			errFiles = append(errFiles, fName)
			ret.Msg = "directory assets are not supported in encrypted notebooks"
			f.Close()
			break
		}

		hash, hashErr := util.GetEtagByHandle(f, file.Size)
		if nil != hashErr {
			errFiles = append(errFiles, fName)
			ret.Msg = err.Error()
			f.Close()
			break
		}

		if 1 > file.Size {
			hash = "random_1_" + gulu.Rand.String(12)
		}

		existAssetPath := GetAssetPathByHash(hash, uploadBoxID)
		if "" != existAssetPath {
			originalName := util.RemoveID(filepath.Base(existAssetPath))
			if strings.ToLower(fName) != strings.ToLower(originalName) {
				hash = "random_2_" + gulu.Rand.String(12)
			}
		}

		if "" != existAssetPath && !strings.HasPrefix(hash, "random_") {
			succMap[baseName] = strings.TrimPrefix(existAssetPath, "/")
			f.Close()
		} else {
			if skipIfDuplicated {
				// 复制 PDF 矩形注解时不再重复插入图片 No longer upload image repeatedly when copying PDF rectangle annotation https://github.com/siyuan-note/siyuan/issues/10666
				pattern := assetsDirPath + string(os.PathSeparator) + strings.TrimSuffix(fName, ext)
				_, patternLastID := util.LastID(fName)
				if lastID != "" && lastID != patternLastID {
					// 文件名太长被截断了，通过之前的 lastID 来匹配 PDF files with too long file names cannot generate annotated images https://github.com/siyuan-note/siyuan/issues/15739
					pattern = assetsDirPath + string(os.PathSeparator) + "*" + lastID + ext
				} else {
					pattern += "*" + ext
				}

				matches, globErr := filepath.Glob(pattern)
				if nil != globErr {
					logging.LogErrorf("glob failed: %s", globErr)
				} else {
					if 0 < len(matches) {
						fName = filepath.Base(matches[0])
						succMap[baseName] = strings.TrimPrefix(path.Join(relAssetsDirPath, fName), "/")
						f.Close()
						break
					}
				}
			}

			if "" == lastID {
				lastID = ast.NewNodeID()
			}
			if IsEncryptedBox(uploadBoxID) {
				// 加密 box：磁盘文件名脱敏为 uuid-blockID.ext，原始名存加密映射
				fName = encryptedAssetName(util.Ext(fName), lastID)
			} else {
				fName = util.AssetName(fName, lastID)
			}
			writePath := filepath.Join(assetsDirPath, fName)
			tmpDir := filepath.Join(util.TempDir, "convert", "zip", gulu.Rand.String(7))
			if needUnzip2Dir {
				if err = os.MkdirAll(tmpDir, 0755); err != nil {
					errFiles = append(errFiles, fName)
					ret.Msg = err.Error()
					f.Close()
					break
				}
				writePath = filepath.Join(tmpDir, fName)
			}

			if _, err = f.Seek(0, io.SeekStart); err != nil {
				logging.LogErrorf("seek failed: %s", err)
				errFiles = append(errFiles, fName)
				ret.Msg = err.Error()
				f.Close()
				break
			}
			if err = writeAssetFile(writePath, f, uploadBoxID, baseName); err != nil {
				logging.LogErrorf("write file failed: %s", err)
				errFiles = append(errFiles, fName)
				ret.Msg = err.Error()
				f.Close()
				break
			}
			f.Close()

			if needUnzip2Dir {
				baseName = strings.TrimSuffix(file.Filename, ".rtfd.zip") + ".rtfd"
				fName = baseName
				fName = util.FilterUploadFileName(fName)
				ext = filepath.Ext(fName)
				fName = strings.TrimSuffix(fName, ext)
				ext = strings.ToLower(ext)
				fName += ext
				fName = util.AssetName(fName, ast.NewNodeID())
				tmpDir2 := filepath.Join(util.TempDir, "convert", "zip", gulu.Rand.String(7))
				if err = gulu.Zip.Unzip(writePath, tmpDir2); err != nil {
					errFiles = append(errFiles, fName)
					ret.Msg = err.Error()
					break
				}

				entries, readErr := os.ReadDir(tmpDir2)
				if nil != readErr {
					logging.LogErrorf("read dir [%s] failed: %s", tmpDir2, readErr)
					errFiles = append(errFiles, fName)
					ret.Msg = readErr.Error()
					break
				}
				if 1 > len(entries) {
					logging.LogErrorf("read dir [%s] failed: no entry", tmpDir2)
					errFiles = append(errFiles, fName)
					ret.Msg = "no entry"
					break
				}
				dirName := entries[0].Name()
				srcDir := filepath.Join(tmpDir2, dirName)
				entries, readErr = os.ReadDir(srcDir)
				if nil != readErr {
					logging.LogErrorf("read dir [%s] failed: %s", filepath.Join(tmpDir2, entries[0].Name()), readErr)
					errFiles = append(errFiles, fName)
					ret.Msg = readErr.Error()
					break
				}
				destDir := filepath.Join(assetsDirPath, fName)
				for _, entry := range entries {
					from := filepath.Join(srcDir, entry.Name())
					to := filepath.Join(destDir, entry.Name())
					if copyErr := gulu.File.Copy(from, to); nil != copyErr {
						logging.LogErrorf("copy [%s] to [%s] failed: %s", from, to, copyErr)
						errFiles = append(errFiles, fName)
						ret.Msg = copyErr.Error()
						break
					}
				}
				os.RemoveAll(tmpDir)
				os.RemoveAll(tmpDir2)
			}

			p := strings.TrimPrefix(path.Join(relAssetsDirPath, fName), "/")
			if uploadBoxID != "" && IsEncryptedBox(uploadBoxID) {
				p += "?box=" + uploadBoxID
			}
			succMap[baseName] = p
			if uploadBoxID == "" || !IsEncryptedBox(uploadBoxID) {
				cache.SetAssetHash(hash, p) // 加密笔记本不写全局 cache
			}
		}
	}

	ret.Data = map[string]any{
		"errFiles": errFiles,
		"succMap":  succMap,
	}

	IncSync()
}

func getAssetsDir(boxLocalPath, docDirLocalPath string) (assets string) {
	assets = filepath.Join(docDirLocalPath, "assets")
	if !filelock.IsExist(assets) {
		assets = filepath.Join(boxLocalPath, "assets")
		if !filelock.IsExist(assets) {
			// 加密笔记本禁用全局 data/assets 回退，强制使用笔记本级 assets，避免明文资源泄漏到全局
			boxID := filepath.Base(boxLocalPath)
			if IsEncryptedBox(boxID) {
				_ = os.MkdirAll(assets, 0755)
				return
			}
			assets = filepath.Join(util.DataDir, "assets")
		}
	}
	return
}

// writeAssetFile 把 src 写入目标资源目录。boxID 是内容库身份，writePath 只用于交叉校验；
// 加密笔记本在同一提交锁内写密文和名称映射，普通笔记本沿用明文 reader 写入。
func writeAssetFile(writePath string, src io.Reader, boxID, originalName string) (err error) {
	pathBoxID := ExtractBoxIDFromAssetsPath(writePath)
	if boxID != "" && pathBoxID != "" && boxID != pathBoxID {
		return fmt.Errorf("boxID mismatch: param=%s, path=%s", boxID, pathBoxID)
	}
	if pathBoxID != "" && IsEncryptedBox(pathBoxID) && boxID == "" {
		return fmt.Errorf("encrypted asset path for notebook [%s] requires an explicit notebook", pathBoxID)
	}
	if boxID != "" && IsEncryptedBox(boxID) {
		if pathBoxID != boxID {
			return fmt.Errorf("encrypted asset path belongs to box [%s], but caller specified box [%s]", pathBoxID, boxID)
		}
		return writeEncryptedAssetFile(boxID, writePath, originalName, src)
	}
	return filelock.WriteFileByReader(writePath, src)
}

func writeEncryptedAssetFile(boxID, writePath, originalName string, src io.Reader) (err error) {
	if originalName == "" {
		return errors.New("encrypted asset original name is required")
	}
	HoldBoxReadLock(boxID)
	defer ReleaseBoxReadLock(boxID)

	dek, err := GetDEKIfUnlocked(boxID)
	if err != nil {
		return err
	}
	defer zeroAndClear(dek)
	raw, err := io.ReadAll(src)
	if err != nil {
		return err
	}
	diskName := filepath.Base(writePath)
	encAsset, err := EncryptAsset(boxID, diskName, dek, raw)
	if err != nil {
		return err
	}

	gate := assetNameMappingLock(boxID)
	gate.lock(nil)
	defer gate.unlock()
	if filelock.IsExist(writePath) {
		return fmt.Errorf("encrypted asset [%s] already exists", diskName)
	}
	mapping, err := readAssetNameMappingLocked(boxID, dek)
	if err != nil {
		return err
	}
	if _, exists := mapping[diskName]; exists {
		return fmt.Errorf("encrypted asset name mapping [%s] already exists", diskName)
	}
	mapping[diskName] = originalName
	mappingData, err := json.Marshal(mapping)
	if err != nil {
		return fmt.Errorf("marshal asset name mapping for notebook [%s] failed: %w", boxID, err)
	}
	encMapping, err := EncryptAssetNameMapping(boxID, dek, mappingData)
	if err != nil {
		return fmt.Errorf("encrypt asset name mapping for notebook [%s] failed: %w", boxID, err)
	}

	if err = filelock.WriteFile(writePath, encAsset); err != nil {
		_ = filelock.Remove(writePath)
		return fmt.Errorf("write encrypted asset [%s] failed: %w", diskName, err)
	}
	if encryptedAssetCommitAfterFileWriteHook != nil {
		encryptedAssetCommitAfterFileWriteHook(boxID)
	}
	if err = atomicWriteFile(assetNameMappingPath(boxID), encMapping); err != nil {
		if removeErr := filelock.Remove(writePath); removeErr != nil && !os.IsNotExist(removeErr) {
			return fmt.Errorf("write asset name mapping failed: %w; rollback encrypted asset failed: %v", err, removeErr)
		}
		return fmt.Errorf("write asset name mapping failed: %w", err)
	}
	return nil
}

// StoreAssetForBox 统一资产写入入口：根据 boxID 决定加密/明文写入，返回磁盘文件名（不含路径前缀）。
// 加密 box：生成脱敏名后原子提交密文与名称映射。
// 普通 box：util.AssetName 生成名 → filelock.WriteFile 明文写入
// boxID 为空时按普通 box 处理（写入全局 assets）。
func StoreAssetForBox(boxID, assetDirPath, originalName string, data []byte) (diskName string, err error) {
	return storeAssetForBox(boxID, assetDirPath, originalName, data)
}

// storeAssetForBox 统一资产写入入口：根据 boxID 决定加密/明文写入，返回磁盘文件名（不含路径前缀）。
// 加密 box：生成脱敏名后原子提交密文与名称映射。
// 普通 box：util.AssetName 生成名 → filelock.WriteFile 明文写入
// boxID 为空时按普通 box 处理（写入全局 assets）。
func storeAssetForBox(boxID, assetDirPath, originalName string, data []byte) (diskName string, err error) {
	if IsEncryptedBox(boxID) {
		ext := filepath.Ext(originalName)
		blockID := ast.NewNodeID()
		diskName = encryptedAssetName(ext, blockID)
		writePath := filepath.Join(assetDirPath, diskName)
		if err = writeAssetFile(writePath, bytes.NewReader(data), boxID, originalName); err != nil {
			return "", err
		}
		return diskName, nil
	}

	// 普通 box：生成带 ID 的文件名，明文写入
	diskName = util.AssetName(originalName, ast.NewNodeID())
	writePath := filepath.Join(assetDirPath, diskName)
	if err = filelock.WriteFile(writePath, data); err != nil {
		return "", err
	}
	return diskName, nil
}

// encryptedAssetName 生成加密笔记本专用的无语义资源文件名：uuid-blockID.ext。
// 原始语义文件名（如"合同.pdf"）存入加密映射，磁盘上只保留随机名。
func encryptedAssetName(ext, blockID string) string {
	return gulu.Rand.String(16) + "-" + blockID + ext
}

// assetNameMappingPath 返回加密笔记本资源名映射文件路径 <boxID>/assets/.names.json。
func assetNameMappingPath(boxID string) string {
	return filepath.Join(util.DataDir, boxID, "assets", ".names.json")
}

// assetNameMappingLocks 按 boxID 串行化“资源文件 + .names.json”提交和搜索快照。
var assetNameMappingLocks sync.Map // map[string]*exclusiveGate

// Deterministic boundaries for the encrypted asset commit concurrency contract.
var (
	encryptedAssetCommitAfterFileWriteHook func(boxID string)
	encryptedAssetSearchBlockedHook        func(boxID string)
)

func assetNameMappingLock(boxID string) *exclusiveGate {
	gateI, _ := assetNameMappingLocks.LoadOrStore(boxID, newExclusiveGate())
	return gateI.(*exclusiveGate)
}

// readAssetNameMappingLocked 严格解码资源名映射。调用方必须持有 assetNameMappingLock。
func readAssetNameMappingLocked(boxID string, dek []byte) (ret map[string]string, err error) {
	ret = map[string]string{}
	p := assetNameMappingPath(boxID)
	enc, err := filelock.ReadFile(p)
	if err != nil {
		if os.IsNotExist(err) {
			return ret, nil
		}
		return nil, fmt.Errorf("read encrypted asset name mapping for notebook [%s] failed: %w", boxID, err)
	}
	data, err := DecryptAssetNameMapping(boxID, dek, enc)
	if err != nil {
		return nil, fmt.Errorf("decrypt asset name mapping for notebook [%s] failed: %w", boxID, err)
	}
	if err = json.Unmarshal(data, &ret); err != nil {
		return nil, fmt.Errorf("parse asset name mapping for notebook [%s] failed: %w", boxID, err)
	}
	if ret == nil {
		return nil, fmt.Errorf("parse asset name mapping for notebook [%s] failed: null mapping", boxID)
	}
	for diskName, originalName := range ret {
		if diskName == "" || filepath.Base(diskName) != diskName || originalName == "" {
			return nil, fmt.Errorf("parse asset name mapping for notebook [%s] failed: invalid entry [%s]", boxID, diskName)
		}
	}
	return ret, nil
}

// LookupAssetOriginalName 查询加密笔记本资源的原始文件名（供下载 Content-Disposition 等展示用）。
// 未找到时返回空串。
func LookupAssetOriginalName(boxID, diskName string) string {
	if boxID == "" || !IsEncryptedBox(boxID) {
		return ""
	}
	HoldBoxReadLock(boxID)
	defer ReleaseBoxReadLock(boxID)
	return lookupAssetOriginalNameLocked(boxID, diskName)
}

// LookupAssetOriginalNameLocked 在调用方已持有 box 读锁时查询原始资源名。
func LookupAssetOriginalNameLocked(boxID, diskName string) string {
	return lookupAssetOriginalNameLocked(boxID, diskName)
}

func lookupAssetOriginalNameLocked(boxID, diskName string) string {
	dek, err := GetDEKIfUnlocked(boxID)
	if err != nil {
		logging.LogErrorf("get DEK for asset name mapping failed: %s", err)
		return ""
	}
	defer zeroAndClear(dek)
	gate := assetNameMappingLock(boxID)
	gate.lock(nil)
	defer gate.unlock()
	mapping, err := readAssetNameMappingLocked(boxID, dek)
	if err != nil {
		logging.LogErrorf("read asset name mapping failed: %s", err)
		return ""
	}
	return mapping[diskName]
}
