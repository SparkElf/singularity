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

package util

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"runtime/debug"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/88250/go-humanize"
	"github.com/88250/gulu"
	"github.com/88250/lute/ast"
	"github.com/88250/lute/html"
	"github.com/siyuan-note/filelock"
	"github.com/siyuan-note/logging"
)

var (
	TesseractBin     = "tesseract"
	TesseractEnabled bool
	TesseractMaxSize = 2 * 1000 * uint64(1000)
	TesseractLangs   []string

	assetsTexts         = map[string]string{}
	assetsTextsLock     = sync.Mutex{}
	assetsTextsSaveLock = sync.Mutex{}
	assetsTextsChanged  = atomic.Bool{}
	IsEncryptedBoxFn    func(boxID string) bool
)

var errUnsafeOCRSource = errors.New("unsafe OCR source")

func CleanNotExistAssetsTexts() {
	assetsTextsLock.Lock()
	defer assetsTextsLock.Unlock()

	var toRemoves []string
	for asset := range assetsTexts {
		assetKey, ok := CanonicalAssetTextKey(asset)
		if !ok || assetKey != asset || !assetTextAllowed(assetKey) {
			toRemoves = append(toRemoves, asset)
			continue
		}
		assetAbsPath := filepath.Join(DataDir, filepath.FromSlash(assetKey))
		if !filelock.IsExist(assetAbsPath) {
			toRemoves = append(toRemoves, asset)
		}
	}

	for _, asset := range toRemoves {
		delete(assetsTexts, asset)
		assetsTextsChanged.Store(true)
	}
	return
}

func LoadAssetsTexts() {
	assetsPath := GetDataAssetsAbsPath()
	assetsTextsPath := filepath.Join(assetsPath, "ocr-texts.json")
	if !filelock.IsExist(assetsTextsPath) {
		return
	}

	start := time.Now()
	data, err := filelock.ReadFile(assetsTextsPath)
	if err != nil {
		logOCRFailure("load.read", err)
		return
	}

	loaded := map[string]string{}
	err = gulu.JSON.UnmarshalJSON(data, &loaded)
	if err != nil {
		logOCRFailure("load.decode", err)
		if err = filelock.Remove(assetsTextsPath); err != nil {
			logOCRFailure("load.remove-corrupt", err)
		}
		return
	}
	loaded, migrated := canonicalizeLoadedAssetTexts(loaded)
	assetsTextsLock.Lock()
	assetsTexts = loaded
	assetsTextsLock.Unlock()
	if migrated {
		assetsTextsChanged.Store(true)
	}
	debug.FreeOSMemory()

	if elapsed := time.Since(start).Seconds(); 2 < elapsed {
		logging.LogWarnf("read assets texts [size=%s], elapsed [%.2fs]", humanize.BytesCustomCeil(uint64(len(data)), 2), elapsed)
	}
	return
}

func SaveAssetsTexts() {
	assetsTextsSaveLock.Lock()
	defer assetsTextsSaveLock.Unlock()
	if !assetsTextsChanged.Swap(false) {
		return
	}

	start := time.Now()

	assetsPath := GetDataAssetsAbsPath()
	assetsTextsPath := filepath.Join(assetsPath, "ocr-texts.json")

	assetsTextsLock.Lock()
	// OCR 功能未开启且 ocr-texts.json 不存在时，如果 assetsTexts 为空则不创建文件
	if !TesseractEnabled && !filelock.IsExist(assetsTextsPath) && 0 == len(assetsTexts) {
		assetsTextsLock.Unlock()
		return
	}
	data, err := gulu.JSON.MarshalIndentJSON(assetsTexts, "", "  ")
	if err != nil {
		logOCRFailure("save.encode", err)
		assetsTextsLock.Unlock()
		assetsTextsChanged.Store(true)
		return
	}
	assetsTextsLock.Unlock()

	if err = filelock.WriteFile(assetsTextsPath, data); err != nil {
		logOCRFailure("save.write", err)
		assetsTextsChanged.Store(true)
		return
	}
	debug.FreeOSMemory()

	if elapsed := time.Since(start).Seconds(); 2 < elapsed {
		logging.LogWarnf("save assets texts [size=%s], elapsed [%.2fs]", humanize.BytesCustomCeil(uint64(len(data)), 2), elapsed)
	}
}

func SetAssetText(asset, text string) {
	asset, ok := CanonicalAssetTextKey(asset)
	if !ok || !assetTextAllowed(asset) {
		return
	}
	assetsTextsLock.Lock()
	oldText, ok := assetsTexts[asset]
	assetsTexts[asset] = text
	assetsTextsLock.Unlock()
	if !ok || oldText != text {
		assetsTextsChanged.Store(true)
	}
}

func ExistsAssetText(asset string) (ret bool) {
	asset, ok := CanonicalAssetTextKey(asset)
	if !ok || !assetTextAllowed(asset) {
		return false
	}
	assetsTextsLock.Lock()
	_, ret = assetsTexts[asset]
	assetsTextsLock.Unlock()
	return
}

func ExistsAssetTextInDocument(asset, boxID, documentPath string) bool {
	assetKey, ok := ResolveAssetTextKey(asset, boxID, documentPath)
	return ok && ExistsAssetText(assetKey)
}

func OcrAsset(assetKey, assetAbsPath string) (ret []map[string]any, err error) {
	if !TesseractEnabled {
		err = errors.New(Langs[Lang][266])
		return
	}
	ret = Tesseract(assetAbsPath)
	ocrText := GetOcrJsonText(ret)
	SetAssetText(assetKey, ocrText)
	return
}

func OcrAssetFromFile(assetKey, assetAbsPath string, source *os.File) (ret []map[string]any, err error) {
	if !TesseractEnabled {
		err = errors.New(Langs[Lang][266])
		return
	}
	ret = TesseractFile(assetAbsPath, source)
	ocrText := GetOcrJsonText(ret)
	SetAssetText(assetKey, ocrText)
	return
}

func GetAssetText(asset string) (ret string) {
	asset, ok := CanonicalAssetTextKey(asset)
	if !ok || !assetTextAllowed(asset) {
		return ""
	}
	assetsTextsLock.Lock()
	ret = assetsTexts[asset]
	assetsTextsLock.Unlock()
	return
}

// GetAssetTextInDocument 从指定文档引用解析OCR文本，读取范围只属于当前 notebook。
func GetAssetTextInDocument(asset, boxID, documentPath string) string {
	assetKey, ok := ResolveAssetTextKey(asset, boxID, documentPath)
	if !ok {
		return ""
	}
	return GetAssetText(assetKey)
}

func RemoveAssetText(asset string) {
	asset, ok := CanonicalAssetTextKey(asset)
	if !ok {
		return
	}
	assetsTextsLock.Lock()
	_, existed := assetsTexts[asset]
	if existed {
		delete(assetsTexts, asset)
	}
	assetsTextsLock.Unlock()
	if existed {
		assetsTextsChanged.Store(true)
	}
}

func RenameAssetText(oldAsset, newAsset string) {
	oldAsset, oldOK := CanonicalAssetTextKey(oldAsset)
	newAsset, newOK := CanonicalAssetTextKey(newAsset)
	if !oldOK || !newOK || oldAsset == newAsset {
		return
	}
	assetsTextsLock.Lock()
	text, exists := assetsTexts[oldAsset]
	if exists {
		delete(assetsTexts, oldAsset)
		if assetTextAllowed(newAsset) {
			assetsTexts[newAsset] = text
		}
	}
	assetsTextsLock.Unlock()
	if exists {
		assetsTextsChanged.Store(true)
	}
}

// CanonicalAssetTextKey 将 OCR 键规范为相对 DataDir 的资源路径。box 查询参数承载身份，调用方必须先解析为真实路径。
func CanonicalAssetTextKey(asset string) (string, bool) {
	asset = strings.TrimSpace(asset)
	if fragment := strings.IndexByte(asset, '#'); fragment >= 0 {
		asset = asset[:fragment]
	}
	if queryStart := strings.IndexByte(asset, '?'); queryStart >= 0 {
		query, err := url.ParseQuery(asset[queryStart+1:])
		if err != nil || query.Has("box") {
			return "", false
		}
		asset = asset[:queryStart]
	}
	asset = path.Clean(filepath.ToSlash(asset))
	if asset == "." || asset == ".." || path.IsAbs(asset) || strings.HasPrefix(asset, "../") {
		return "", false
	}
	parts := strings.Split(asset, "/")
	if parts[0] != "assets" && !ast.IsNodeIDPattern(parts[0]) {
		return "", false
	}
	assetsSegment := -1
	for index, part := range parts {
		if part == "assets" {
			assetsSegment = index
			break
		}
	}
	if assetsSegment < 0 || assetsSegment == len(parts)-1 {
		return "", false
	}
	if parts[0] == "assets" && assetsSegment != 0 {
		return "", false
	}
	return asset, true
}

func assetTextAllowed(assetKey string) bool {
	parts := strings.SplitN(assetKey, "/", 2)
	if len(parts) < 2 || !ast.IsNodeIDPattern(parts[0]) {
		return true
	}
	return IsEncryptedBoxFn != nil && !IsEncryptedBoxFn(parts[0])
}

// AssetTextKeyFromAbsPath 根据资源解析后的路径生成唯一持久化 OCR 身份。
func AssetTextKeyFromAbsPath(assetAbsPath string) (string, error) {
	relativePath, err := filepath.Rel(DataDir, assetAbsPath)
	if err != nil {
		return "", fmt.Errorf("derive asset OCR identity: %w", err)
	}
	assetKey, ok := CanonicalAssetTextKey(filepath.ToSlash(relativePath))
	if !ok {
		return "", errors.New("resolved OCR asset is outside the data asset stores")
	}
	return assetKey, nil
}

// ResolveAssetTextKey 在文档上下文中解析资源链接，不扫描其他笔记本。
// ResolveAssetTextKey 将文档引用映射为稳定的相对OCR缓存键，避免用全局扫描补齐身份。
func ResolveAssetTextKey(asset, boxID, documentPath string) (string, bool) {
	assetPath, boxID, boxBound, ok := assetTextReference(asset, boxID)
	if !ok || !strings.HasPrefix(assetPath, "assets/") {
		return "", false
	}
	if boxID != "" && (!ast.IsNodeIDPattern(boxID) || IsEncryptedBoxFn == nil || IsEncryptedBoxFn(boxID)) {
		return "", false
	}

	type assetCandidate struct {
		path string
		root string
	}
	var candidates []assetCandidate
	if boxID != "" {
		boxRoot := filepath.Join(DataDir, boxID)
		documentPath = strings.TrimPrefix(filepath.ToSlash(strings.TrimSpace(documentPath)), "/")
		cleanDocumentPath := path.Clean(documentPath)
		if cleanDocumentPath != "." && cleanDocumentPath != ".." && !path.IsAbs(cleanDocumentPath) &&
			!strings.HasPrefix(cleanDocumentPath, "../") {
			documentDir := filepath.Dir(filepath.Join(boxRoot, filepath.FromSlash(cleanDocumentPath)))
			candidates = append(candidates, assetCandidate{
				path: filepath.Join(documentDir, filepath.FromSlash(assetPath)),
				root: boxRoot,
			})
		}
		candidates = append(candidates, assetCandidate{
			path: filepath.Join(boxRoot, filepath.FromSlash(assetPath)),
			root: boxRoot,
		})
	}
	if !boxBound {
		candidates = append(candidates, assetCandidate{
			path: filepath.Join(DataDir, filepath.FromSlash(assetPath)),
			root: filepath.Join(DataDir, "assets"),
		})
	}

	seen := map[string]struct{}{}
	for _, candidate := range candidates {
		candidate.path = filepath.Clean(candidate.path)
		if _, duplicate := seen[candidate.path]; duplicate {
			continue
		}
		seen[candidate.path] = struct{}{}
		if !pathWithinRoot(candidate.root, candidate.path) || !isRegularAssetCandidate(candidate.root, candidate.path) {
			continue
		}
		assetKey, keyErr := AssetTextKeyFromAbsPath(candidate.path)
		if keyErr == nil {
			return assetKey, true
		}
	}
	return "", false
}

func assetTextReference(asset, defaultBoxID string) (assetPath, boxID string, boxBound, ok bool) {
	asset = strings.TrimSpace(asset)
	if fragment := strings.IndexByte(asset, '#'); fragment >= 0 {
		asset = asset[:fragment]
	}
	boxID = defaultBoxID
	if queryStart := strings.IndexByte(asset, '?'); queryStart >= 0 {
		query, err := url.ParseQuery(asset[queryStart+1:])
		if err != nil {
			return "", "", false, false
		}
		if queryBoxes, found := query["box"]; found {
			if len(queryBoxes) != 1 || !ast.IsNodeIDPattern(strings.TrimSpace(queryBoxes[0])) {
				return "", "", false, false
			}
			queryBoxID := strings.TrimSpace(queryBoxes[0])
			if defaultBoxID != "" && defaultBoxID != queryBoxID {
				return "", "", false, false
			}
			boxID = queryBoxID
			boxBound = true
		}
		asset = asset[:queryStart]
	}
	assetPath, ok = CanonicalAssetTextKey(asset)
	return assetPath, boxID, boxBound, ok
}

func isRegularAssetCandidate(rootPath, candidatePath string) bool {
	file, err := openRegularAssetCandidate(rootPath, candidatePath)
	if err != nil {
		return false
	}
	return file.Close() == nil
}

func openRegularAssetCandidate(rootPath, candidatePath string) (*os.File, error) {
	expectedRoot, err := os.Lstat(rootPath)
	if err != nil || !expectedRoot.IsDir() || expectedRoot.Mode()&os.ModeSymlink != 0 {
		return nil, errors.Join(err, errUnsafeOCRSource)
	}
	root, err := os.OpenRoot(rootPath)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	actualRoot, err := root.Stat(".")
	if err != nil || !os.SameFile(expectedRoot, actualRoot) {
		return nil, errors.Join(err, errUnsafeOCRSource)
	}
	relativePath, err := filepath.Rel(rootPath, candidatePath)
	if err != nil {
		return nil, err
	}
	file, err := OpenRegularFileInRoot(root, relativePath)
	if err != nil {
		return nil, err
	}
	return file, nil
}

func pathWithinRoot(root, candidate string) bool {
	relativePath, err := filepath.Rel(root, candidate)
	return err == nil && relativePath != ".." && !strings.HasPrefix(relativePath, ".."+string(filepath.Separator)) &&
		!filepath.IsAbs(relativePath)
}

func canonicalizeLoadedAssetTexts(loaded map[string]string) (map[string]string, bool) {
	keys := make([]string, 0, len(loaded))
	for key := range loaded {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	canonical := make(map[string]string, len(loaded))
	canonicalSource := make(map[string]bool, len(loaded))
	migrated := false
	for _, key := range keys {
		canonicalKey, ok := CanonicalAssetTextKey(key)
		if !ok || !assetTextAllowed(canonicalKey) {
			migrated = true
			continue
		}
		isCanonical := key == canonicalKey
		if existingCanonical := canonicalSource[canonicalKey]; existingCanonical && !isCanonical {
			migrated = true
			continue
		}
		if _, duplicate := canonical[canonicalKey]; duplicate {
			migrated = true
		}
		canonical[canonicalKey] = loaded[key]
		canonicalSource[canonicalKey] = isCanonical
		migrated = migrated || !isCanonical
	}
	return canonical, migrated
}

var tesseractExts = []string{
	".png",
	".jpg",
	".jpeg",
	".tif",
	".tiff",
	".bmp",
	".gif",
	".webp",
	".pbm",
	".pgm",
	".ppm",
	".pnm",
}

func IsTesseractExtractable(p string) bool {
	lowerName := strings.ToLower(p)
	for _, ext := range tesseractExts {
		if strings.HasSuffix(lowerName, ext) {
			return true
		}
	}
	return false
}

// tesseractOCRLock 用于 Tesseract OCR 加锁串行执行提升稳定性 https://github.com/siyuan-note/siyuan/issues/7265
var tesseractOCRLock = sync.Mutex{}

func Tesseract(imgAbsPath string) (ret []map[string]any) {
	if ContainerStd != Container || !TesseractEnabled {
		return
	}
	if !IsTesseractExtractable(imgAbsPath) {
		return
	}
	source, err := openOCRSource(imgAbsPath)
	if err != nil {
		logOCRFailure("tesseract.open-source", err)
		return
	}
	defer func() {
		if closeErr := source.Close(); closeErr != nil {
			logOCRFailure("tesseract.close-source", closeErr)
		}
	}()
	return TesseractFile(imgAbsPath, source)
}

func TesseractFile(imgAbsPath string, source *os.File) (ret []map[string]any) {
	if ContainerStd != Container || !TesseractEnabled {
		return
	}

	defer logging.Recover()
	tesseractOCRLock.Lock()
	defer tesseractOCRLock.Unlock()

	if !IsTesseractExtractable(imgAbsPath) {
		return
	}

	displayName := filepath.Base(imgAbsPath)
	if source == nil {
		logOCRFailure("tesseract.open-source", errors.New("OCR source file is unavailable"))
		return
	}
	snapshotPath, size, cleanup, err := createOCRSnapshot(imgAbsPath, source)
	if err != nil {
		logOCRFailure("tesseract.snapshot", err)
		return
	}
	defer cleanup()

	defer logging.Recover()

	timeout := 7000
	timeoutEnv := os.Getenv("SIYUAN_TESSERACT_TIMEOUT")
	if "" != timeoutEnv {
		if timeoutParsed, parseErr := strconv.Atoi(timeoutEnv); nil == parseErr {
			timeout = timeoutParsed
		} else {
			logOCRFailure("tesseract.timeout-config", parseErr)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeout)*time.Millisecond)
	defer cancel()

	cmd := exec.CommandContext(ctx, TesseractBin, "-c", "debug_file=/dev/null", snapshotPath, "stdout", "-l", strings.Join(TesseractLangs, "+"), "tsv")
	gulu.CmdAttr(cmd)
	output, err := cmd.CombinedOutput()
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		logOCRFailure("tesseract.timeout", fmt.Errorf("size [%d], timeout [%dms]: %w", size, timeout, ctx.Err()))
		return
	}

	if err != nil {
		exitCode := -1
		var exitError *exec.ExitError
		if errors.As(err, &exitError) {
			exitCode = exitError.ExitCode()
		}
		logOCRFailure("tesseract.execute", fmt.Errorf("size [%d], exit code [%d]: %w", size, exitCode, err))
		return
	}

	tsv := string(output)
	//logging.LogInfof("tesseract [path=%s] success [%s]", imgAbsPath, tsv)

	// 按行分割 TSV 数据
	tsv = strings.ReplaceAll(tsv, "\r", "")
	lines := strings.Split(tsv, "\n")

	// 解析 TSV 数据 跳过标题行，从第二行开始处理
	for _, line := range lines[1:] {
		if line == "" {
			continue // 跳过空行
		}
		// 分割每列数据
		fields := strings.Split(line, "\t")
		// 将字段名和字段值映射到一个 map 中
		dataMap := make(map[string]any)
		headers := strings.Split(lines[0], "\t")
		for i, header := range headers {
			if i < len(fields) {
				dataMap[header] = fields[i]
			} else {
				dataMap[header] = ""
			}
		}
		ret = append(ret, dataMap)
	}

	tsv = RemoveInvalid(tsv)
	tsv = RemoveRedundantSpace(tsv)
	msg := fmt.Sprintf("OCR [%s] [%s]", html.EscapeString(displayName), html.EscapeString(GetOcrJsonText(ret)))
	PushStatusBar(msg)
	return
}

// GetOcrJsonText 提取并连接所有 text 字段的函数
func GetOcrJsonText(jsonData []map[string]any) (ret string) {
	for _, dataMap := range jsonData {
		// 检查 text 字段是否存在
		if text, ok := dataMap["text"]; ok {
			// 确保 text 是字符串类型
			if textStr, ok := text.(string); ok {
				ret += " " + strings.ReplaceAll(textStr, "\r", "")
			}
		}
	}
	ret = RemoveInvalid(ret)
	ret = RemoveRedundantSpace(ret)
	return ret
}

var tesseractInited = atomic.Bool{}

func WaitForTesseractInit() {
	for {
		if tesseractInited.Load() {
			return
		}
		time.Sleep(time.Second)
	}
}

func InitTesseract() {
	ver := getTesseractVer()
	if "" == ver {
		tesseractInited.Store(true)
		return
	}

	langs := getTesseractLangs()
	if 1 > len(langs) {
		logging.LogWarnf("no tesseract langs found, disabling tesseract-ocr")
		TesseractEnabled = false
		tesseractInited.Store(true)
		return
	}

	maxSizeVal := os.Getenv("SIYUAN_TESSERACT_MAX_SIZE")
	if "" != maxSizeVal {
		if maxSize, parseErr := strconv.ParseUint(maxSizeVal, 10, 64); nil == parseErr {
			TesseractMaxSize = maxSize
		}
	}

	// Supports via environment var `SIYUAN_TESSERACT_ENABLED=false` to close OCR https://github.com/siyuan-note/siyuan/issues/9619
	if enabled := os.Getenv("SIYUAN_TESSERACT_ENABLED"); "" != enabled {
		if enabledBool, parseErr := strconv.ParseBool(enabled); nil == parseErr {
			TesseractEnabled = enabledBool
			if !enabledBool {
				logging.LogInfof("tesseract-ocr disabled by env")
				tesseractInited.Store(true)
				return
			}
		}
	}

	TesseractLangs = filterTesseractLangs(langs)
	logging.LogInfof("tesseract-ocr enabled [ver=%s, maxSize=%s, langs=%s]", ver, humanize.BytesCustomCeil(TesseractMaxSize, 2), strings.Join(TesseractLangs, "+"))
	tesseractInited.Store(true)
}

func filterTesseractLangs(langs []string) (ret []string) {
	ret = []string{}

	envLangsVal := os.Getenv("SIYUAN_TESSERACT_LANGS")
	if "" != envLangsVal {
		envLangs := strings.Split(envLangsVal, "+")
		for _, lang := range langs {
			if gulu.Str.Contains(lang, envLangs) {
				ret = append(ret, lang)
			}
		}
	} else {
		for _, lang := range langs {
			if "eng" == lang || strings.HasPrefix(lang, "chi") || "fra" == lang || "spa" == lang || "deu" == lang ||
				"rus" == lang || "jpn" == lang || "osd" == lang {
				ret = append(ret, lang)
			}
		}
	}
	return ret
}

func getTesseractVer() (ret string) {
	if ContainerStd != Container {
		return
	}

	cmd := exec.Command(TesseractBin, "--version")
	gulu.CmdAttr(cmd)
	data, err := cmd.CombinedOutput()
	if err != nil {
		errMsg := strings.ToLower(err.Error())
		if strings.Contains(errMsg, "executable file not found") || strings.Contains(errMsg, "no such file or directory") {
			// macOS 端 Tesseract OCR 安装后不识别 https://github.com/siyuan-note/siyuan/issues/7107
			TesseractBin = "/usr/local/bin/tesseract"
			cmd = exec.Command(TesseractBin, "--version")
			gulu.CmdAttr(cmd)
			data, err = cmd.CombinedOutput()
			if err != nil {
				errMsg = strings.ToLower(err.Error())
				if strings.Contains(errMsg, "executable file not found") || strings.Contains(errMsg, "no such file or directory") {
					TesseractBin = "/opt/homebrew/bin/tesseract"
					cmd = exec.Command(TesseractBin, "--version")
					gulu.CmdAttr(cmd)
					data, err = cmd.CombinedOutput()
				}
			}
		}
	}
	if err != nil {
		return
	}

	if strings.HasPrefix(string(data), "tesseract ") {
		parts := bytes.Split(data, []byte("\n"))
		if 0 < len(parts) {
			ret = strings.TrimPrefix(string(parts[0]), "tesseract ")
			ret = strings.TrimSpace(ret)
			TesseractEnabled = true
		}
		return
	}
	return
}

func openOCRSource(imgAbsPath string) (*os.File, error) {
	assetKey, err := AssetTextKeyFromAbsPath(imgAbsPath)
	if err != nil {
		return nil, err
	}
	if !assetTextAllowed(assetKey) {
		return nil, errors.New("OCR is unavailable for this content store")
	}
	candidatePath := filepath.Join(DataDir, filepath.FromSlash(assetKey))
	if filepath.Clean(candidatePath) != filepath.Clean(imgAbsPath) {
		return nil, errors.New("OCR source identity does not match its canonical path")
	}
	parts := strings.SplitN(assetKey, "/", 2)
	if len(parts) != 2 {
		return nil, errors.New("OCR source identity is unavailable")
	}
	rootPath := filepath.Join(DataDir, "assets")
	if parts[0] != "assets" {
		rootPath = filepath.Join(DataDir, parts[0])
	}
	return openRegularAssetCandidate(rootPath, candidatePath)
}

func createOCRSnapshot(imgAbsPath string, source *os.File) (snapshotPath string, size int64, cleanup func(), err error) {
	cleanup = func() {}
	info, err := source.Stat()
	if err != nil {
		return "", 0, cleanup, err
	}
	if !info.Mode().IsRegular() {
		return "", 0, cleanup, errors.New("OCR source is not a regular file")
	}
	if info.Size() < 0 || uint64(info.Size()) > TesseractMaxSize {
		return "", 0, cleanup, errors.New("OCR source exceeds the configured size limit")
	}
	if _, err = source.Seek(0, io.SeekStart); err != nil {
		return "", 0, cleanup, err
	}

	extension := strings.ToLower(filepath.Ext(imgAbsPath))
	snapshot, err := os.CreateTemp(TempDir, "siyuan-ocr-*"+extension)
	if err != nil {
		return "", 0, cleanup, err
	}
	snapshotPath = snapshot.Name()
	cleanup = func() {
		if removeErr := os.Remove(snapshotPath); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
			logOCRFailure("tesseract.snapshot-remove", removeErr)
		}
	}
	defer func() {
		if err != nil {
			err = errors.Join(err, snapshot.Close())
			cleanup()
		}
	}()

	limit := int64(TesseractMaxSize)
	if TesseractMaxSize >= uint64(^uint64(0)>>1) {
		limit = int64(^uint64(0) >> 1)
	} else {
		limit++
	}
	written, copyErr := io.Copy(snapshot, io.LimitReader(source, limit))
	if copyErr != nil {
		err = copyErr
		return
	}
	if uint64(written) > TesseractMaxSize {
		err = errors.New("OCR source exceeds the configured size limit")
		return
	}
	afterCopy, statErr := source.Stat()
	if statErr != nil || !os.SameFile(info, afterCopy) || info.Size() != afterCopy.Size() || !info.ModTime().Equal(afterCopy.ModTime()) {
		err = errors.Join(statErr, errors.New("OCR source changed while creating its snapshot"))
		return
	}
	if closeErr := snapshot.Close(); closeErr != nil {
		err = closeErr
		return
	}
	return snapshotPath, written, cleanup, nil
}

func logOCRFailure(operation string, err error) {
	logging.LogErrorf("ocr.%s failed [causes=%s]\n%s", operation, sanitizedOCRErrorCauses(err), debug.Stack())
}

func sanitizedOCRErrorCauses(err error) string {
	var causes []string
	var appendCause func(error, int)
	appendCause = func(current error, depth int) {
		if current == nil || depth >= 16 {
			return
		}
		causes = append(causes, fmt.Sprintf("%T: %s", current, sanitizedOCRErrorMessage(current)))
		if joined, ok := current.(interface{ Unwrap() []error }); ok {
			for _, cause := range joined.Unwrap() {
				appendCause(cause, depth+1)
			}
			return
		}
		appendCause(errors.Unwrap(current), depth+1)
	}
	appendCause(err, 0)
	return strings.Join(causes, " <- ")
}

func sanitizedOCRErrorMessage(err error) string {
	message := err.Error()
	paths := []string{WorkspaceDir, DataDir, TempDir}
	sort.Slice(paths, func(i, j int) bool { return len(paths[i]) > len(paths[j]) })
	for _, sensitivePath := range paths {
		if sensitivePath == "" {
			continue
		}
		message = strings.ReplaceAll(message, sensitivePath, "<path>")
		message = strings.ReplaceAll(message, filepath.ToSlash(sensitivePath), "<path>")
	}
	message = strings.NewReplacer("\r", " ", "\n", " ", "\t", " ").Replace(message)
	return strings.TrimSpace(message)
}

func getTesseractLangs() (ret []string) {
	if !TesseractEnabled {
		return nil
	}

	cmd := exec.Command(TesseractBin, "--list-langs")
	gulu.CmdAttr(cmd)
	data, err := cmd.CombinedOutput()
	if err != nil {
		return nil
	}

	parts := bytes.Split(data, []byte("\n"))
	if 0 < len(parts) {
		parts = parts[1:]
	}
	for _, part := range parts {
		part = bytes.TrimSpace(part)
		if 0 == len(part) {
			continue
		}
		ret = append(ret, string(part))
	}
	return
}

var (
	NodeOCRQueue     []string
	NodeOCRQueueLock = sync.Mutex{}
)

func PushNodeOCRQueue(n *ast.Node) {
	if nil == n {
		return
	}

	NodeOCRQueueLock.Lock()
	defer NodeOCRQueueLock.Unlock()
	NodeOCRQueue = append(NodeOCRQueue, n.ID)
}
