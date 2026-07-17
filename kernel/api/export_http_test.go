package api

import (
	archivezip "archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	kernelconf "github.com/siyuan-note/siyuan/kernel/conf"
	"github.com/siyuan-note/siyuan/kernel/model"
	"github.com/siyuan-note/siyuan/kernel/treenode"
	"github.com/siyuan-note/siyuan/kernel/util"
)

const (
	exportHTTPBoxA = "20260716120000-boxaaaa"
	exportHTTPBoxB = "20260716120001-boxbbbb"
)

type exportBrowserHTTPResult struct {
	Code int    `json:"code"`
	Msg  string `json:"msg"`
	Data struct {
		Zip string `json:"zip"`
	} `json:"data"`
}

type exportNotebookSYHTTPResult struct {
	Code int             `json:"code"`
	Msg  string          `json:"msg"`
	Data json.RawMessage `json:"data"`
}

type exportCopyHTTPResult struct {
	Code int    `json:"code"`
	Msg  string `json:"msg"`
}

type exportAsFileHTTPResult struct {
	Code int    `json:"code"`
	Msg  string `json:"msg"`
	Data struct {
		File string `json:"file"`
	} `json:"data"`
}

func TestManagedResourceExportCopyPublishesAndConsumesToken(t *testing.T) {
	managedPath, _ := createManagedResourceExportHTTPFixture(t)
	router := gin.New()
	router.Use(ContentResponseLifecycle)
	router.POST("/api/export/copyExportFile", copyExportFile)

	destination := filepath.Join(util.WorkspaceDir, "downloads", "resources.zip")
	if err := os.MkdirAll(filepath.Dir(destination), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(destination, []byte("previous archive"), 0600); err != nil {
		t.Fatal(err)
	}
	result := postExportCopy(t, router, managedPath, destination)
	if result.Code != 0 {
		t.Fatalf("managed resource copy failed: code=%d msg=%q", result.Code, result.Msg)
	}
	assertManagedResourceArchive(t, destination)

	replayDestination := filepath.Join(filepath.Dir(destination), "replay.zip")
	replay := postExportCopy(t, router, managedPath, replayDestination)
	if replay.Code == 0 {
		t.Fatal("managed resource copy token was reusable")
	}
	if _, err := os.Stat(replayDestination); !os.IsNotExist(err) {
		t.Fatalf("replayed managed copy created a destination: %v", err)
	}
}

func TestManagedResourceExportCopyFailureCleansPartialAndConsumesToken(t *testing.T) {
	managedPath, _ := createManagedResourceExportHTTPFixture(t)
	router := gin.New()
	router.Use(ContentResponseLifecycle)
	router.POST("/api/export/copyExportFile", copyExportFile)

	downloads := filepath.Join(util.WorkspaceDir, "downloads")
	destination := filepath.Join(downloads, "existing-directory")
	if err := os.MkdirAll(destination, 0755); err != nil {
		t.Fatal(err)
	}
	sentinel := filepath.Join(destination, "sentinel.txt")
	if err := os.WriteFile(sentinel, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	before := directoryEntryNames(t, downloads)

	result := postExportCopy(t, router, managedPath, destination)
	if result.Code == 0 {
		t.Fatal("managed resource copy unexpectedly replaced a directory")
	}
	assertManagedExportHTTPFileContent(t, sentinel, "keep")
	after := directoryEntryNames(t, downloads)
	if strings.Join(after, "\x00") != strings.Join(before, "\x00") {
		t.Fatalf("failed managed copy left filesystem residue: before=%v after=%v", before, after)
	}

	replayDestination := filepath.Join(downloads, "replay.zip")
	replay := postExportCopy(t, router, managedPath, replayDestination)
	if replay.Code == 0 {
		t.Fatal("failed managed resource copy left its token reusable")
	}
	if _, err := os.Stat(replayDestination); !os.IsNotExist(err) {
		t.Fatalf("replayed failed managed copy created a destination: %v", err)
	}
}

func TestManagedExportCopyRejectsEncryptedDestinationBeforeConsumingToken(t *testing.T) {
	managedPath, boxID := createManagedResourceExportHTTPFixture(t)
	router := gin.New()
	router.Use(ContentResponseLifecycle)
	router.POST("/api/export/copyExportFile", copyExportFile)

	encryptedDestination := filepath.Join(util.DataDir, boxID, "plaintext-export.zip")
	rejected := postExportCopy(t, router, managedPath, encryptedDestination)
	if rejected.Code == 0 {
		t.Fatal("managed export copied plaintext into an encrypted notebook")
	}
	if _, err := os.Stat(encryptedDestination); !os.IsNotExist(err) {
		t.Fatalf("rejected encrypted destination exists: %v", err)
	}

	validDestination := filepath.Join(util.WorkspaceDir, "downloads", "managed-export.zip")
	accepted := postExportCopy(t, router, managedPath, validDestination)
	if accepted.Code != 0 {
		t.Fatalf("destination rejection consumed managed token: code=%d msg=%q", accepted.Code, accepted.Msg)
	}
	assertManagedResourceArchive(t, validDestination)
}

func TestExportNotebookSYUsesNotebookField(t *testing.T) {
	router := setupExportBrowserHTTPTest(t)
	result := postExportNotebookSY(t, router, map[string]any{"notebook": exportHTTPBoxA})
	if result.Code != 0 {
		t.Fatalf("notebook SY export failed: code=%d msg=%q", result.Code, result.Msg)
	}
	var data struct {
		Zip string `json:"zip"`
	}
	if err := json.Unmarshal(result.Data, &data); err != nil {
		t.Fatalf("decode notebook SY export data: %v", err)
	}
	if !strings.HasPrefix(data.Zip, "/export/") {
		t.Fatalf("notebook SY export zip = %q, want /export/ download path", data.Zip)
	}
}

func TestOrdinaryExportCopyPublishesCompletedFile(t *testing.T) {
	previousTempDir := util.TempDir
	previousWorkspaceDir := util.WorkspaceDir
	root := t.TempDir()
	util.TempDir = filepath.Join(root, "temp")
	util.WorkspaceDir = root
	t.Cleanup(func() {
		util.WorkspaceDir = previousWorkspaceDir
		util.TempDir = previousTempDir
	})
	source := filepath.Join(util.TempDir, "export", "ordinary.zip")
	destination := filepath.Join(root, "downloads", "ordinary.zip")
	if err := os.MkdirAll(filepath.Dir(source), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(source, []byte("completed ordinary export"), 0640); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(destination), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(destination, []byte("previous export"), 0600); err != nil {
		t.Fatal(err)
	}
	router := gin.New()
	router.POST("/api/export/copyExportFile", copyExportFile)

	result := postExportCopy(t, router, "/export/ordinary.zip", destination)
	if result.Code != 0 {
		t.Fatalf("ordinary export copy failed: code=%d msg=%q", result.Code, result.Msg)
	}
	assertManagedExportHTTPFileContent(t, destination, "completed ordinary export")
	entries := directoryEntryNames(t, filepath.Dir(destination))
	if len(entries) != 1 || entries[0] != filepath.Base(destination) {
		t.Fatalf("ordinary export copy left filesystem residue: %v", entries)
	}
}

func TestExportAsFileKeepsAuthoritativeDisplayNameForOrdinaryAndEncryptedArtifacts(t *testing.T) {
	boxID := setupEncryptedResponseTest(t, 1)[0]
	router := gin.New()
	router.Use(ContentResponseLifecycle)
	router.POST("/api/export/exportAsFile", exportAsFile)
	const (
		fileName    = "Quarterly Report.bin"
		displayName = "Quarterly Report.pdf"
		content     = "export-as-file-content"
	)

	ordinary := postExportAsFile(t, router, fileName, "application/pdf", "", content)
	if ordinary.Code != 0 {
		t.Fatalf("ordinary export-as-file failed: code=%d msg=%q", ordinary.Code, ordinary.Msg)
	}
	decodedOrdinary, err := url.PathUnescape(ordinary.Data.File)
	if err != nil || path.Base(decodedOrdinary) != displayName || path.Dir(strings.TrimPrefix(decodedOrdinary, "/export/")) == "." {
		t.Fatalf("ordinary export-as-file URL = %q, %v; want random directory and basename %q", ordinary.Data.File, err, displayName)
	}
	opened, err := util.OpenLocalExportDownload(ordinary.Data.File)
	if err != nil {
		t.Fatalf("open ordinary export-as-file artifact: %v", err)
	}
	ordinaryData, readErr := io.ReadAll(opened.File)
	closeErr := opened.Close()
	if err = errors.Join(readErr, closeErr); err != nil || string(ordinaryData) != content {
		t.Fatalf("ordinary export-as-file content = %q, %v", ordinaryData, err)
	}

	encrypted := postExportAsFile(t, router, fileName, "application/pdf", boxID, content)
	if encrypted.Code != 0 || !strings.HasPrefix(encrypted.Data.File, "/export/managed/") {
		t.Fatalf("encrypted export-as-file result = %#v, want managed capability", encrypted)
	}
	claim, err := model.ClaimManagedEncryptedExport(strings.TrimPrefix(encrypted.Data.File, "/export/"))
	if err != nil {
		t.Fatalf("claim encrypted export-as-file artifact: %v", err)
	}
	encryptedData, readErr := io.ReadAll(claim.File)
	closeErr = claim.Close()
	if err = errors.Join(readErr, closeErr); err != nil || claim.DisplayFileName != displayName || string(encryptedData) != content {
		t.Fatalf("encrypted export-as-file display/content = %q/%q, %v; want %q/%q", claim.DisplayFileName, encryptedData, err, displayName, content)
	}
}

func TestOrdinaryExportCopyRejectsSymbolicLinkSource(t *testing.T) {
	previousTempDir := util.TempDir
	previousWorkspaceDir := util.WorkspaceDir
	root := t.TempDir()
	util.TempDir = filepath.Join(root, "temp")
	util.WorkspaceDir = root
	t.Cleanup(func() {
		util.WorkspaceDir = previousWorkspaceDir
		util.TempDir = previousTempDir
	})
	exportRoot := filepath.Join(util.TempDir, "export")
	target := filepath.Join(exportRoot, "target.zip")
	link := filepath.Join(exportRoot, "source.zip")
	if err := os.MkdirAll(exportRoot, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, []byte("source target"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symbolic links unavailable: %v", err)
	}
	destination := filepath.Join(root, "downloads", "copied.zip")
	router := gin.New()
	router.POST("/api/export/copyExportFile", copyExportFile)

	result := postExportCopy(t, router, "/export/source.zip", destination)
	if result.Code == 0 {
		t.Fatal("ordinary export copied a symbolic-link source")
	}
	if _, err := os.Stat(destination); !os.IsNotExist(err) {
		t.Fatalf("rejected symbolic-link source created destination: %v", err)
	}
	assertManagedExportHTTPFileContent(t, target, "source target")
}

func TestOrdinaryExportCopyRejectsSymlinkIntoManagedExportDirectory(t *testing.T) {
	previousTempDir := util.TempDir
	previousWorkspaceDir := util.WorkspaceDir
	root := t.TempDir()
	util.TempDir = filepath.Join(root, "temp")
	util.WorkspaceDir = root
	t.Cleanup(func() {
		util.WorkspaceDir = previousWorkspaceDir
		util.TempDir = previousTempDir
	})
	source := filepath.Join(util.TempDir, "export", "ordinary.zip")
	if err := os.MkdirAll(filepath.Dir(source), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(source, []byte("ordinary"), 0600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "export-link")
	if err := os.Symlink(filepath.Dir(source), link); err != nil {
		t.Skipf("symbolic links unavailable: %v", err)
	}
	destination := filepath.Join(link, "copied.zip")
	router := gin.New()
	router.POST("/api/export/copyExportFile", copyExportFile)

	result := postExportCopy(t, router, "/export/ordinary.zip", destination)
	if result.Code == 0 {
		t.Fatal("ordinary export copied into the managed export directory through a symlink")
	}
	if _, err := os.Stat(destination); !os.IsNotExist(err) {
		t.Fatalf("rejected managed destination exists: %v", err)
	}
}

func TestParseExportSourcePathPreservesNestedManagedCapability(t *testing.T) {
	token := strings.Repeat("a", 32)
	for source, expected := range map[string]string{
		"/export/managed/" + token:                    "managed/" + token,
		"export/20260716120000-boxaaaa/html/file.zip": "20260716120000-boxaaaa/html/file.zip",
		"/export/" + token + "/report.zip":            token + "/report.zip",
	} {
		actual, err := parseExportSourcePath(source)
		if err != nil || actual != expected {
			t.Fatalf("parse export source %q = %q, %v; want %q", source, actual, err, expected)
		}
	}
}

func TestParseExportSourcePathRejectsWindowsSeparatorsAndTraversal(t *testing.T) {
	for _, source := range []string{
		`\export\managed\aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
		"/export/managed%5Caaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		"/export/../data/secret.zip",
		"/export/nested/../../secret.zip",
	} {
		if parsed, err := parseExportSourcePath(source); err == nil {
			t.Fatalf("unsafe export source %q parsed as %q", source, parsed)
		}
	}
}

func TestExportNotebookSYRejectsLegacyIDOnlyPayload(t *testing.T) {
	router := setupExportBrowserHTTPTest(t)
	result := postExportNotebookSY(t, router, map[string]any{"id": exportHTTPBoxA})
	if result.Code == 0 {
		t.Fatalf("legacy id-only notebook SY payload unexpectedly succeeded: %s", result.Data)
	}
	if len(result.Data) != 0 && string(result.Data) != "null" {
		t.Fatalf("legacy id-only notebook SY payload returned success data: %s", result.Data)
	}
}

func TestExportMarkdownContentRejectsNotebookMismatchWithoutData(t *testing.T) {
	boxIDs := setupEncryptedResponseTest(t, 2)
	const rootID = "20990716130000-mismtch"
	tree := treenode.NewTree(boxIDs[0], "/"+rootID+".sy", "/Mismatch Contract", "Mismatch Contract")
	if err := treenode.UpsertBlockTree(tree); err != nil {
		t.Fatalf("index notebook mismatch fixture: %v", err)
	}
	if treenode.GetBlockTreeInBox(rootID, boxIDs[0]) == nil {
		t.Fatal("failed to index source notebook export fixture")
	}

	previousMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(previousMode) })
	router := gin.New()
	router.Use(ContentResponseLifecycle)
	router.POST("/api/export/exportMdContent", exportMdContent)
	body, err := json.Marshal(map[string]any{
		"id":        rootID,
		"notebook":  boxIDs[1],
		"refMode":   3,
		"embedMode": 1,
		"yfm":       false,
	})
	if err != nil {
		t.Fatalf("marshal export mismatch request: %v", err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/export/exportMdContent", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("export mismatch HTTP status = %d, want %d", response.Code, http.StatusOK)
	}
	var result struct {
		Code int             `json:"code"`
		Msg  string          `json:"msg"`
		Data json.RawMessage `json:"data"`
	}
	if err = json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatalf("decode export mismatch response: %v", err)
	}
	if result.Code == 0 || !strings.Contains(result.Msg, model.ErrBlockNotFound.Error()) {
		t.Fatalf("export mismatch result = %#v, want nonzero block-not-found error", result)
	}
	if len(result.Data) != 0 && string(result.Data) != "null" {
		t.Fatalf("export mismatch returned success data: %s", result.Data)
	}
}

func TestExportBrowserHTMLRejectsUnregisteredJob(t *testing.T) {
	router := setupExportBrowserHTTPTest(t)

	result := postExportBrowserHTML(t, router, map[string]any{
		"job":      strings.Repeat("a", 32),
		"notebook": exportHTTPBoxA,
		"html":     "<p>forged</p>",
		"name":     "forged",
	})
	if result.Code != -1 || result.Data.Zip != "" {
		t.Fatalf("unregistered export job result = %#v, want code -1 without zip", result)
	}
}

func TestExportBrowserHTMLDoesNotInterpretPathInput(t *testing.T) {
	router := setupExportBrowserHTTPTest(t)
	sentinel := filepath.Join(filepath.Dir(util.TempDir), "victim", "sentinel.txt")
	if err := os.MkdirAll(filepath.Dir(sentinel), 0755); err != nil {
		t.Fatalf("create sentinel directory: %v", err)
	}
	if err := os.WriteFile(sentinel, []byte("preserve"), 0600); err != nil {
		t.Fatalf("write sentinel: %v", err)
	}

	result := postExportBrowserHTML(t, router, map[string]any{
		"job":      "../../victim",
		"folder":   "../../victim",
		"notebook": exportHTTPBoxA,
		"html":     "<p>path input</p>",
		"name":     "path-input",
	})
	if result.Code != -1 || result.Data.Zip != "" {
		t.Fatalf("path-like export job result = %#v, want code -1 without zip", result)
	}
	content, err := os.ReadFile(sentinel)
	if err != nil || string(content) != "preserve" {
		t.Fatalf("path-like job changed sentinel: content=%q err=%v", content, err)
	}
}

func TestExportBrowserHTMLBindsJobToNotebookWithoutConsumingMismatch(t *testing.T) {
	router := setupExportBrowserHTTPTest(t)
	job, stageDir, err := model.CreateExportStage(exportHTTPBoxA, "html")
	if err != nil {
		t.Fatalf("create export stage: %v", err)
	}
	if err = model.CompleteExportStage(job, exportHTTPBoxA); err != nil {
		t.Fatalf("complete export stage: %v", err)
	}

	mismatch := postExportBrowserHTML(t, router, map[string]any{
		"job":      job,
		"notebook": exportHTTPBoxB,
		"html":     "<p>wrong notebook</p>",
		"name":     "mismatch",
	})
	if mismatch.Code != -1 || mismatch.Data.Zip != "" {
		t.Fatalf("notebook-mismatched export job result = %#v, want code -1 without zip", mismatch)
	}

	html := "<!doctype html><p>bound notebook</p>"
	result := postExportBrowserHTML(t, router, map[string]any{
		"job":      job,
		"notebook": exportHTTPBoxA,
		"html":     html,
		"name":     "bound-notebook",
	})
	assertExportBrowserHTMLSuccess(t, result, stageDir, "bound-notebook.zip", html)
}

func TestExportBrowserHTMLConsumesJobOnce(t *testing.T) {
	router := setupExportBrowserHTTPTest(t)
	job, stageDir, err := model.CreateExportStage(exportHTTPBoxA, "html")
	if err != nil {
		t.Fatalf("create export stage: %v", err)
	}
	if err = model.CompleteExportStage(job, exportHTTPBoxA); err != nil {
		t.Fatalf("complete export stage: %v", err)
	}
	html := "<!doctype html><p>single use</p>"
	payload := map[string]any{
		"job":      job,
		"notebook": exportHTTPBoxA,
		"html":     html,
		"name":     "single-use",
	}

	result := postExportBrowserHTML(t, router, payload)
	assertExportBrowserHTMLSuccess(t, result, stageDir, "single-use.zip", html)
	replay := postExportBrowserHTML(t, router, payload)
	if replay.Code != -1 || replay.Data.Zip != "" {
		t.Fatalf("replayed export job result = %#v, want code -1 without zip", replay)
	}
}

func setupExportBrowserHTTPTest(t *testing.T) *gin.Engine {
	t.Helper()
	previousMode := gin.Mode()
	previousTempDir := util.TempDir
	previousDataDir := util.DataDir
	previousConf := model.Conf
	root := t.TempDir()
	util.TempDir = filepath.Join(root, "temp")
	util.DataDir = filepath.Join(root, "data")
	model.Conf = model.NewAppConf()
	model.Conf.FileTree = kernelconf.NewFileTree()
	model.Conf.Export = kernelconf.NewExport()
	model.Conf.Editor = kernelconf.NewEditor()
	model.Conf.Flashcard = kernelconf.NewFlashcard()
	for _, dir := range []string{util.TempDir, util.DataDir} {
		if err := os.MkdirAll(dir, 0755); err != nil {
			t.Fatalf("create export HTTP fixture directory: %v", err)
		}
	}
	for boxID, name := range map[string]string{exportHTTPBoxA: "Box A", exportHTTPBoxB: "Box B"} {
		boxConf := kernelconf.NewBoxConf()
		boxConf.Name = name
		boxConf.Closed = false
		if err := (&model.Box{ID: boxID}).SaveConf(boxConf); err != nil {
			t.Fatalf("save notebook fixture %s: %v", boxID, err)
		}
	}
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() {
		model.RevokeManagedEncryptedExportsForBox(exportHTTPBoxA)
		model.RevokeManagedEncryptedExportsForBox(exportHTTPBoxB)
		model.Conf = previousConf
		util.DataDir = previousDataDir
		util.TempDir = previousTempDir
		gin.SetMode(previousMode)
	})

	router := gin.New()
	router.Use(ContentResponseLifecycle)
	router.POST("/api/export/exportBrowserHTML", exportBrowserHTML)
	router.POST("/api/export/exportNotebookSY", exportNotebookSY)
	return router
}

func postExportNotebookSY(t *testing.T, router http.Handler, payload map[string]any) exportNotebookSYHTTPResult {
	t.Helper()
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal notebook SY request: %v", err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/export/exportNotebookSY", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("notebook SY HTTP status = %d, want %d", response.Code, http.StatusOK)
	}
	var result exportNotebookSYHTTPResult
	if err = json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatalf("decode notebook SY response: %v", err)
	}
	return result
}

func createManagedResourceExportHTTPFixture(t *testing.T) (managedPath, boxID string) {
	t.Helper()
	boxID = setupEncryptedResponseTest(t, 1)[0]
	previousWorkspaceDir := util.WorkspaceDir
	util.WorkspaceDir = filepath.Dir(util.DataDir)
	t.Cleanup(func() { util.WorkspaceDir = previousWorkspaceDir })

	assetsDir := filepath.Join(util.DataDir, boxID, "assets")
	if err := os.MkdirAll(assetsDir, 0755); err != nil {
		t.Fatal(err)
	}
	diskName, err := model.StoreAssetForBox(boxID, assetsDir, "managed-resource.txt", []byte("managed resource plaintext"))
	if err != nil {
		t.Fatalf("store encrypted resource fixture: %v", err)
	}
	resourcePath, err := filepath.Rel(util.WorkspaceDir, filepath.Join(assetsDir, diskName))
	if err != nil {
		t.Fatal(err)
	}
	managedPath, err = model.ExportResources([]string{resourcePath}, "managed-resources")
	if err != nil {
		t.Fatalf("generate managed resource export: %v", err)
	}
	if !strings.HasPrefix(managedPath, "/export/managed/") {
		t.Fatalf("managed resource export path = %q, want /export/managed/<token>", managedPath)
	}
	return managedPath, boxID
}

func postExportCopy(t *testing.T, router http.Handler, sourcePath, destination string) exportCopyHTTPResult {
	t.Helper()
	body, err := json.Marshal(map[string]any{"srcPath": sourcePath, "dest": destination})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/export/copyExportFile", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("copy managed export HTTP status = %d, want %d", response.Code, http.StatusOK)
	}
	var result exportCopyHTTPResult
	if err = json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatalf("decode managed export copy result: %v; body=%q", err, response.Body.String())
	}
	return result
}

func postExportAsFile(t *testing.T, router http.Handler, fileName, contentType, notebook, content string) exportAsFileHTTPResult {
	t.Helper()
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	part, err := writer.CreateFormFile("file", fileName)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = io.WriteString(part, content); err != nil {
		t.Fatal(err)
	}
	if err = writer.WriteField("type", contentType); err != nil {
		t.Fatal(err)
	}
	if notebook != "" {
		if err = writer.WriteField("notebook", notebook); err != nil {
			t.Fatal(err)
		}
	}
	if err = writer.Close(); err != nil {
		t.Fatal(err)
	}

	request := httptest.NewRequest(http.MethodPost, "/api/export/exportAsFile", body)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("export-as-file HTTP status = %d, want %d", response.Code, http.StatusOK)
	}
	var result exportAsFileHTTPResult
	if err = json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatalf("decode export-as-file response: %v; body=%q", err, response.Body.String())
	}
	return result
}

func assertManagedResourceArchive(t *testing.T, archivePath string) {
	t.Helper()
	data, err := os.ReadFile(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	archive, err := archivezip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatalf("open managed resource archive: %v", err)
	}
	for _, entry := range archive.File {
		if entry.FileInfo().IsDir() {
			continue
		}
		reader, openErr := entry.Open()
		if openErr != nil {
			t.Fatal(openErr)
		}
		content, readErr := io.ReadAll(reader)
		closeErr := reader.Close()
		if readErr != nil || closeErr != nil {
			t.Fatalf("read managed resource archive entry %q: %v", entry.Name, errors.Join(readErr, closeErr))
		}
		if string(content) == "managed resource plaintext" {
			return
		}
	}
	t.Fatal("managed resource archive did not contain decrypted resource content")
}

func directoryEntryNames(t *testing.T, directory string) []string {
	t.Helper()
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	return names
}

func assertManagedExportHTTPFileContent(t *testing.T, path, expected string) {
	t.Helper()
	content, err := os.ReadFile(path)
	if err != nil || string(content) != expected {
		t.Fatalf("managed export destination [%s] = %q, %v; want %q", path, content, err, expected)
	}
}

func postExportBrowserHTML(t *testing.T, router http.Handler, payload map[string]any) exportBrowserHTTPResult {
	t.Helper()
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal export browser request: %v", err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/export/exportBrowserHTML", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("export browser HTTP status = %d, want %d", response.Code, http.StatusOK)
	}
	var result exportBrowserHTTPResult
	if err = json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatalf("decode export browser response: %v", err)
	}
	return result
}

func assertExportBrowserHTMLSuccess(t *testing.T, result exportBrowserHTTPResult, stageDir, expectedFileName, expectedHTML string) {
	t.Helper()
	if result.Code != 0 || result.Data.Zip == "" {
		t.Fatalf("export browser result = %#v, want successful zip", result)
	}
	if _, err := os.Stat(stageDir); !os.IsNotExist(err) {
		t.Fatalf("consumed export stage still exists: %s (err=%v)", stageDir, err)
	}
	zipName, err := url.PathUnescape(strings.TrimPrefix(result.Data.Zip, "/export/"))
	if err != nil {
		t.Fatalf("decode export zip path: %v", err)
	}
	if path.Base(zipName) != expectedFileName {
		t.Fatalf("export download file name = %q, want %q", path.Base(zipName), expectedFileName)
	}
	zipPath := filepath.Join(util.TempDir, "export", filepath.FromSlash(zipName))
	reader, err := archivezip.OpenReader(zipPath)
	if err != nil {
		t.Fatalf("open export zip: %v", err)
	}
	defer reader.Close()
	for _, file := range reader.File {
		if file.Name != "index.html" {
			continue
		}
		entry, openErr := file.Open()
		if openErr != nil {
			t.Fatalf("open index.html in export zip: %v", openErr)
		}
		content, readErr := io.ReadAll(entry)
		closeErr := entry.Close()
		if readErr != nil || closeErr != nil {
			t.Fatalf("read index.html in export zip: read=%v close=%v", readErr, closeErr)
		}
		if string(content) != expectedHTML {
			t.Fatalf("exported index.html = %q, want %q", content, expectedHTML)
		}
		return
	}
	t.Fatal("export zip does not contain index.html")
}
