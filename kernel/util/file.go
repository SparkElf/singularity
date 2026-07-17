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
	"errors"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/88250/gulu"
	"github.com/88250/lute/ast"
	"github.com/gabriel-vasile/mimetype"
	"github.com/siyuan-note/filelock"
	"github.com/siyuan-note/logging"
)

var ErrUnsafeExportFile = errors.New("unsafe export file")

// CanonicalExportRelativePath validates a decoded URL path using URL rather
// than host-platform path semantics.
func CanonicalExportRelativePath(relativePath string) (string, error) {
	if relativePath == "" || strings.Contains(relativePath, `\`) || strings.HasPrefix(relativePath, "/") {
		return "", fmt.Errorf("%w: invalid export path %q", ErrUnsafeExportFile, relativePath)
	}
	cleaned := path.Clean(relativePath)
	if cleaned == "." || cleaned == ".." || cleaned != relativePath || strings.HasPrefix(cleaned, "../") {
		return "", fmt.Errorf("%w: invalid export path %q", ErrUnsafeExportFile, relativePath)
	}
	return cleaned, nil
}

// ResolveLocalExportFilePath converts a single-file /export download URL into
// the corresponding physical file under the workspace export directory.
func ResolveLocalExportFilePath(downloadPath string) (string, error) {
	relativePath, err := localExportDownloadRelativePath(downloadPath)
	if err != nil {
		return "", err
	}
	localPath, err := filepath.Abs(filepath.Join(TempDir, "export", filepath.FromSlash(relativePath)))
	if err != nil {
		return "", fmt.Errorf("resolve export download path %q: %w", downloadPath, err)
	}
	return localPath, nil
}

func localExportDownloadRelativePath(downloadPath string) (string, error) {
	const prefix = "/export/"
	if !strings.HasPrefix(downloadPath, prefix) {
		return "", fmt.Errorf("invalid export download path %q", downloadPath)
	}
	decoded, err := url.PathUnescape(strings.TrimPrefix(downloadPath, prefix))
	if err != nil {
		return "", fmt.Errorf("decode export download path %q: %w", downloadPath, err)
	}
	if decoded, err = CanonicalExportRelativePath(decoded); err != nil {
		return "", fmt.Errorf("invalid export download path %q: %w", downloadPath, err)
	}
	return decoded, nil
}

type LocalExportFile struct {
	Path string
	File *os.File
	Info os.FileInfo
	root *os.Root
}

func OpenLocalExportDownload(downloadPath string) (*LocalExportFile, error) {
	relativePath, err := localExportDownloadRelativePath(downloadPath)
	if err != nil {
		return nil, err
	}
	return OpenLocalExportFile(relativePath)
}

// OpenLocalExportFile opens one ordinary export without following symbolic
// links in any path component.
func OpenLocalExportFile(relativePath string) (*LocalExportFile, error) {
	relativePath, err := CanonicalExportRelativePath(relativePath)
	if err != nil {
		return nil, err
	}
	exportRoot, err := filepath.Abs(filepath.Join(TempDir, "export"))
	if err != nil {
		return nil, err
	}
	expectedRoot, err := os.Lstat(exportRoot)
	if err != nil || !expectedRoot.IsDir() || expectedRoot.Mode()&os.ModeSymlink != 0 {
		return nil, errors.Join(err, ErrUnsafeExportFile)
	}
	root, err := os.OpenRoot(exportRoot)
	if err != nil {
		return nil, err
	}
	actualRoot, statErr := root.Stat(".")
	if statErr != nil || !os.SameFile(expectedRoot, actualRoot) {
		return nil, errors.Join(statErr, ErrUnsafeExportFile, root.Close())
	}
	file, err := OpenRegularFileInRoot(root, filepath.FromSlash(relativePath))
	if err != nil {
		return nil, errors.Join(err, root.Close())
	}
	info, err := file.Stat()
	if err != nil {
		return nil, errors.Join(err, file.Close(), root.Close())
	}
	return &LocalExportFile{
		Path: filepath.Join(exportRoot, filepath.FromSlash(relativePath)),
		File: file,
		Info: info,
		root: root,
	}, nil
}

func (opened *LocalExportFile) Close() error {
	if opened == nil {
		return nil
	}
	var fileErr, rootErr error
	if opened.File != nil {
		fileErr = opened.File.Close()
		opened.File = nil
	}
	if opened.root != nil {
		rootErr = opened.root.Close()
		opened.root = nil
	}
	return errors.Join(fileErr, rootErr)
}

// OpenRegularFileInRoot rejects traversal, symbolic links, directories, and
// path replacement between validation and open.
func OpenRegularFileInRoot(root *os.Root, name string) (*os.File, error) {
	cleanName := filepath.Clean(name)
	if cleanName == "." || filepath.IsAbs(cleanName) || cleanName == ".." || strings.HasPrefix(cleanName, ".."+string(os.PathSeparator)) {
		return nil, ErrUnsafeExportFile
	}
	parts := strings.Split(cleanName, string(os.PathSeparator))
	current := ""
	var expected os.FileInfo
	for i, part := range parts {
		if part == "" || part == "." || part == ".." {
			return nil, ErrUnsafeExportFile
		}
		current = filepath.Join(current, part)
		info, statErr := root.Lstat(current)
		if statErr != nil {
			return nil, statErr
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return nil, ErrUnsafeExportFile
		}
		if i < len(parts)-1 && !info.IsDir() {
			return nil, ErrUnsafeExportFile
		}
		expected = info
	}
	if expected == nil || !expected.Mode().IsRegular() {
		return nil, ErrUnsafeExportFile
	}
	file, err := root.Open(cleanName)
	if err != nil {
		return nil, err
	}
	actual, err := file.Stat()
	if err != nil || !actual.Mode().IsRegular() || !os.SameFile(expected, actual) {
		_ = file.Close()
		return nil, errors.Join(err, ErrUnsafeExportFile)
	}
	return file, nil
}

// IsPathAtOrBelowResolved checks both lexical paths and their longest existing
// parents so a symlink cannot redirect a new destination into a controlled root.
func IsPathAtOrBelowResolved(root, candidate string) bool {
	root = filepath.Clean(root)
	candidate = filepath.Clean(candidate)
	if candidate == root || gulu.File.IsSubPath(root, candidate) {
		return true
	}
	resolvedRoot := ResolveLongestExistingParent(root)
	resolvedCandidate := ResolveLongestExistingParent(candidate)
	return resolvedCandidate == resolvedRoot || gulu.File.IsSubPath(resolvedRoot, resolvedCandidate)
}

// PublishFile writes source to a same-directory temporary file and replaces
// destination only after the new file is complete and synced. On Windows the
// final replacement is not guaranteed to be atomic by the operating system.
func PublishFile(source io.Reader, mode fs.FileMode, destination string) (err error) {
	destinationDir := filepath.Dir(destination)
	if err = os.MkdirAll(destinationDir, 0755); err != nil {
		return err
	}

	partial, err := os.CreateTemp(destinationDir, ".siyuan-export-partial-*")
	if err != nil {
		return err
	}
	partialPath := partial.Name()
	published := false
	defer func() {
		if partial != nil {
			err = errors.Join(err, partial.Close())
		}
		if !published {
			if removeErr := os.Remove(partialPath); removeErr != nil && !os.IsNotExist(removeErr) {
				err = errors.Join(err, removeErr)
			}
		}
	}()

	if _, err = io.Copy(partial, source); err != nil {
		return err
	}
	if err = partial.Chmod(mode.Perm()); err != nil {
		return err
	}
	if err = partial.Sync(); err != nil {
		return err
	}
	if err = partial.Close(); err != nil {
		partial = nil
		return err
	}
	partial = nil
	if err = os.Rename(partialPath, destination); err != nil {
		return err
	}
	published = true
	return nil
}

// PublishFilePath publishes a regular source file without truncating an
// existing destination before the replacement is ready.
func PublishFilePath(sourcePath, destination string) (err error) {
	source, err := os.Open(sourcePath)
	if err != nil {
		return err
	}
	defer func() {
		err = errors.Join(err, source.Close())
	}()

	sourceInfo, err := source.Stat()
	if err != nil {
		return err
	}
	if !sourceInfo.Mode().IsRegular() {
		return fmt.Errorf("publish source %q is not a regular file", sourcePath)
	}
	if destinationInfo, statErr := os.Stat(destination); statErr == nil {
		if os.SameFile(sourceInfo, destinationInfo) {
			return errors.New("publish source and destination refer to the same file")
		}
		if destinationInfo.IsDir() {
			return fmt.Errorf("publish destination %q is a directory", destination)
		}
	} else if !os.IsNotExist(statErr) {
		return statErr
	}
	return PublishFile(source, sourceInfo.Mode(), destination)
}

// IsOfficeTempFile 判断是否为 Office（Word/Excel/PowerPoint/WPS）打开文档时生成的临时文件。
// 这些文件名以 `~$` 开头，且被宿主程序独占，尝试读取会触发 filelock 的致命错误，需跳过。
func IsOfficeTempFile(assetAbsPath string) bool {
	return strings.HasPrefix(filepath.Base(assetAbsPath), "~$")
}

func GetFilePathsByExts(dirPath string, exts []string) (ret []string) {
	filelock.Walk(dirPath, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			logging.LogErrorf("get file paths by ext failed: %s", err)
			return err
		}

		if d.IsDir() {
			return nil
		}

		for _, ext := range exts {
			if strings.HasSuffix(path, ext) {
				ret = append(ret, path)
				break
			}
		}
		return nil
	})
	return
}

func GetUniqueFilename(filePath string) string {
	if !gulu.File.IsExist(filePath) {
		return filePath
	}

	ext := filepath.Ext(filePath)
	base := strings.TrimSuffix(filepath.Base(filePath), ext)
	dir := filepath.Dir(filePath)
	i := 1
	for {
		newPath := filepath.Join(dir, base+" ("+strconv.Itoa(i)+")"+ext)
		if !gulu.File.IsExist(newPath) {
			return newPath
		}
		i++
	}
}

func GetMimeTypeByExt(filePath string) (ret string) {
	ret = mime.TypeByExtension(filepath.Ext(filePath))
	if "" == ret {
		if m, ok := GetMimeTypeByPath(filePath); ok {
			ret = m.String()
		}
	}
	return
}

func GetMimeTypeByPath(filePath string) (m *mimetype.MIME, ok bool) {
	f, err := filelock.OpenFile(filePath, os.O_RDONLY, 0644)
	if err != nil {
		logging.LogErrorf("open file [%s] failed: %s", filePath, err)
		return
	}
	defer filelock.CloseFile(f)

	m, err = mimetype.DetectReader(f)
	if nil != err {
		logging.LogWarnf("detect file [%s] mimetype failed: %v", filePath, err)
		return
	}
	ok = true
	return
}

func IsSymlinkPath(absPath string) bool {
	fi, err := os.Lstat(absPath)
	if err != nil {
		return false
	}
	return 0 != fi.Mode()&os.ModeSymlink
}

func IsEmptyDir(p string) bool {
	if !gulu.File.IsDir(p) {
		return false
	}

	files, err := os.ReadDir(p)
	if err != nil {
		return false
	}
	return 1 > len(files)
}

func IsSymlink(dir fs.DirEntry) bool {
	return dir.Type() == fs.ModeSymlink
}

func IsDirRegularOrSymlink(dir fs.DirEntry) bool {
	return dir.IsDir() || IsSymlink(dir)
}

func IsPathRegularDirOrSymlinkDir(path string) bool {
	fio, err := os.Stat(path)
	if os.IsNotExist(err) {
		return false
	}

	if err != nil {
		return false
	}

	return fio.IsDir()
}

func RemoveID(name string) string {
	ext := Ext(name)
	name = strings.TrimSuffix(name, ext)
	if 23 < len(name) {
		if id := name[len(name)-22:]; ast.IsNodeIDPattern(id) {
			name = name[:len(name)-23]
		}
	}
	return name + ext
}

var commonSuffixes = []string{
	".jpg", ".jpeg", ".png", ".gif", ".bmp", ".svg", ".webp", ".tif", ".tiff",
	".txt", ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".md", ".rtf",
	".zip", ".rar", ".7z", ".tar", ".gz", ".bz2",
	".mp3", ".wav", ".aac", ".flac", ".ogg", ".m4a",
	".mp4", ".avi", ".mkv", ".mov", ".wmv", ".flv",
	".exe", ".bat", ".sh", ".app",
	".js", ".ts", ".html", ".css", ".go", ".py", ".java", ".c", ".cpp", ".json", ".xml", ".yaml", ".toml",
	".sql", ".db", ".sqlite", ".csv",
	".iso", ".dmg", ".apk", ".bin",
}

func IsCommonExt(ext string) bool {
	return strings.HasPrefix(ext, ".") && gulu.Str.Contains(strings.ToLower(ext), commonSuffixes)
}

func Ext(name string) (ret string) {
	ret = path.Ext(name)
	if "." == ret {
		ret = ""
	}
	return
}

func AssetName(name, newID string) string {
	_, id := LastID(name)
	ext := Ext(name)
	name = name[0 : len(name)-len(ext)]
	if !ast.IsNodeIDPattern(id) {
		id = newID
		name = name + "-" + id + ext
	} else {
		if !ast.IsNodeIDPattern(name) {
			name = name[:len(name)-len(id)-1] + "-" + id + ext
		} else {
			name = name + ext
		}
	}
	return name
}

func LastID(p string) (name, id string) {
	name = path.Base(p)
	ext := Ext(name)
	id = strings.TrimSuffix(name, ext)
	if 22 < len(id) {
		id = id[len(id)-22:]
	}
	return
}

func IsValidUploadFileName(name string) bool {
	return name == FilterUploadFileName(name)
}

func FilterUploadEmojiFileName(name string) string {
	if strings.HasPrefix(name, "api/icon/") {
		// 忽略动态图标 https://github.com/siyuan-note/siyuan/issues/15139
		return name
	}

	name = strings.ReplaceAll(name, "/", "_@slash@_")
	name = FilterUploadFileName(name)
	name = strings.ReplaceAll(name, "_@slash@_", "/")
	return name
}

func FilterUploadFileName(name string) string {
	ret := FilterFileName(name)

	// 插入资源文件时去除 `[`、`(` 等符号 https://github.com/siyuan-note/siyuan/issues/6708
	ret = strings.ReplaceAll(ret, "~", "")
	//ret = strings.ReplaceAll(ret, "_", "") // 插入资源文件时允许下划线 https://github.com/siyuan-note/siyuan/issues/3534
	ret = strings.ReplaceAll(ret, "[", "")
	ret = strings.ReplaceAll(ret, "]", "")
	ret = strings.ReplaceAll(ret, "(", "")
	ret = strings.ReplaceAll(ret, ")", "")
	ret = strings.ReplaceAll(ret, "!", "")
	ret = strings.ReplaceAll(ret, "`", "")
	ret = strings.ReplaceAll(ret, "&", "")
	ret = strings.ReplaceAll(ret, "{", "")
	ret = strings.ReplaceAll(ret, "}", "")
	ret = strings.ReplaceAll(ret, "=", "")
	ret = strings.ReplaceAll(ret, "#", "")
	ret = strings.ReplaceAll(ret, "%", "")
	ret = strings.ReplaceAll(ret, "$", "")
	ret = strings.ReplaceAll(ret, ";", "")
	ret = TruncateLenFileName(ret)
	return ret
}

func TruncateLenFileName(name string) (ret string) {
	// 插入资源文件时文件名长度最大限制 189 字节 https://github.com/siyuan-note/siyuan/issues/7099
	ext := filepath.Ext(name)
	extLen := len(ext)
	var byteCount int
	truncated := false
	buf := bytes.Buffer{}
	maxLen := 189 - extLen
	var pdfAnnoPngPart string
	if ".png" == ext {
		// PNG 图片可能是 PDF 标注的截图，包含页面和旋转角度（name--P1--270-id.png），所以允许的长度更短一些
		// https://github.com/siyuan-note/siyuan/pull/16714#issuecomment-3737987302

		pdfAnnoPngPattern := "-{0,1}P{0,1}[0-9]{0,4}-{0,1}[0-9]{1,3}-[0-9]{14}-[0-9a-zA-Z]{7}\\.png$"
		regx := regexp.MustCompile(pdfAnnoPngPattern)
		pdfAnnoPngPart = regx.FindString(name)
		if "" != pdfAnnoPngPart {
			maxLen -= len(pdfAnnoPngPart) + len(".png")
			name = strings.TrimSuffix(name, pdfAnnoPngPart)
		}
	}

	// 深入理解计算机系统原书第3版彩色扫描 -- 美兰德尔 E_布莱恩特Randal,E_·Bryant,等 龚奕利,贺莲 -- 计算机科学丛书, 3rd, 2016 -- 机械工业出版社123-P57-90-20260113113402-prc0u4k.png

	for _, r := range name {
		byteCount += utf8.RuneLen(r)
		if maxLen < byteCount {
			truncated = true
			break
		}
		buf.WriteRune(r)
	}
	if truncated {
		if "" != pdfAnnoPngPart {
			buf.WriteString(pdfAnnoPngPart)
		} else {
			buf.WriteString(ext)
		}
	} else {
		if "" != pdfAnnoPngPart {
			buf.WriteString(pdfAnnoPngPart)
		}
	}
	ret = buf.String()
	return
}

func FilterFilePath(p string) (ret string) {
	parts := strings.Split(p, "/")
	var filteredParts []string
	for _, part := range parts {
		filteredParts = append(filteredParts, FilterFileName(part))
	}
	ret = strings.Join(filteredParts, "/")
	return
}

func FilterFileName(name string) string {
	name = strings.ReplaceAll(name, "\\", "_")
	name = strings.ReplaceAll(name, "/", "_")
	name = strings.ReplaceAll(name, ":", "_")
	name = strings.ReplaceAll(name, "*", "_")
	name = strings.ReplaceAll(name, "?", "_")
	name = strings.ReplaceAll(name, "\"", "_")
	name = strings.ReplaceAll(name, "'", "_")
	name = strings.ReplaceAll(name, "<", "_")
	name = strings.ReplaceAll(name, ">", "_")
	name = strings.ReplaceAll(name, "|", "_")
	name = RemoveInvalid(name) // Remove invisible characters from file names when uploading assets https://github.com/siyuan-note/siyuan/issues/11683
	name = strings.TrimSpace(name)
	name = strings.TrimSuffix(name, ".")
	return name
}

func IsCompressibleAssetImage(p string) bool {
	lowerName := strings.ToLower(p)
	return strings.HasPrefix(lowerName, "assets/") &&
		(strings.HasSuffix(lowerName, ".png") || strings.HasSuffix(lowerName, ".jpg") || strings.HasSuffix(lowerName, ".jpeg"))
}

func SizeOfDirectory(path string) (size int64, err error) {
	err = filelock.Walk(path, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}

		info, err := d.Info()
		if err != nil {
			logging.LogErrorf("size of dir [%s] failed: %s", path, err)
			return err
		}

		if !info.IsDir() {
			size += info.Size()
		} else {
			size += 4096
		}
		return nil
	})
	if err != nil {
		logging.LogErrorf("size of dir [%s] failed: %s", path, err)
	}
	return
}

func DataSize() (dataSize, assetsSize int64) {
	filelock.Walk(DataDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			if os.IsNotExist(err) {
				return nil
			}
			logging.LogErrorf("size of data failed: %s", err)
			return io.EOF
		}

		info, err := d.Info()
		if err != nil {
			logging.LogErrorf("size of data failed: %s", err)
			return nil
		}

		if !info.IsDir() {
			s := info.Size()
			dataSize += s

			if strings.Contains(strings.TrimPrefix(path, DataDir), "assets") {
				assetsSize += s
			}
		} else {
			dataSize += 4096
		}
		return nil
	})
	return
}

func CeilSize(size int64) int64 {
	if 100*1024*1024 > size {
		return 100 * 1024 * 1024
	}

	for i := int64(1); i < 40; i++ {
		if 1024*1024*200*i > size {
			return 1024 * 1024 * 200 * i
		}
	}
	return 1024*1024*200*40 + 1
}

func IsReservedFilename(baseName string) bool {
	return "assets" == baseName || "templates" == baseName || "widgets" == baseName || "emojis" == baseName || ".siyuan" == baseName || strings.HasPrefix(baseName, ".")
}

func WalkWithSymlinks(root string, fn fs.WalkDirFunc) error {
	// 感谢 https://github.com/edwardrf/symwalk/blob/main/symwalk.go

	rr, err := filepath.EvalSymlinks(root) // Find real base if there is any symlinks in the path
	if err != nil {
		return err
	}

	visitedDirs := make(map[string]struct{})
	return filelock.Walk(rr, getWalkFn(visitedDirs, fn))
}

func getWalkFn(visitedDirs map[string]struct{}, fn fs.WalkDirFunc) fs.WalkDirFunc {
	return func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return fn(path, d, err)
		}

		if d.IsDir() {
			if _, ok := visitedDirs[path]; ok {
				return filepath.SkipDir
			}
			visitedDirs[path] = struct{}{}
		}

		if err := fn(path, d, err); err != nil {
			return err
		}

		info, err := d.Info()
		if nil != err {
			return err
		}
		if info.Mode()&os.ModeSymlink == 0 {
			return nil
		}

		// path is a symlink
		rp, err := filepath.EvalSymlinks(path)
		if err != nil {
			return err
		}

		ri, err := os.Stat(rp)
		if err != nil {
			return err
		}

		if ri.IsDir() {
			return filelock.Walk(rp, getWalkFn(visitedDirs, fn))
		}

		return nil
	}
}
