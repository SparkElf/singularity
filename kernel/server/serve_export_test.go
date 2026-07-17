package server

import (
	archivezip "archive/zip"
	"bytes"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/siyuan-note/siyuan/kernel/api"
	"github.com/siyuan-note/siyuan/kernel/cache"
	kernelconf "github.com/siyuan-note/siyuan/kernel/conf"
	"github.com/siyuan-note/siyuan/kernel/model"
	kernelsql "github.com/siyuan-note/siyuan/kernel/sql"
	"github.com/siyuan-note/siyuan/kernel/util"
)

func TestManagedResourceExportGenerationReturnsDownloadableCapability(t *testing.T) {
	boxID, router := setupManagedExportDownloadTest(t)
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
	downloadPath, err := model.ExportResources([]string{resourcePath}, "managed-resources")
	if err != nil {
		t.Fatalf("generate managed resource export: %v", err)
	}
	if !strings.HasPrefix(downloadPath, "/export/managed/") {
		t.Fatalf("managed resource export path = %q, want /export/managed/<token>", downloadPath)
	}

	relativePath := strings.TrimPrefix(downloadPath, "/export/")
	response := getManagedExport(t, router, relativePath)
	if response.Code != http.StatusOK {
		t.Fatalf("generated managed resource GET status = %d, want %d", response.Code, http.StatusOK)
	}
	disposition, params, err := mime.ParseMediaType(response.Header().Get("Content-Disposition"))
	if err != nil || disposition != "attachment" || params["filename"] != "managed-resources.zip" {
		t.Fatalf("generated managed resource disposition = %q, %v; want attachment filename managed-resources.zip", response.Header().Get("Content-Disposition"), err)
	}
	assertManagedResourceResponseArchive(t, response.Body.Bytes())
	if replay := getManagedExport(t, router, relativePath); replay.Code != http.StatusNotFound {
		t.Fatalf("generated managed resource replay status = %d, want %d", replay.Code, http.StatusNotFound)
	}
}

func TestOrdinaryNestedExportUsesCleanDownloadFileName(t *testing.T) {
	_, router := setupManagedExportDownloadTest(t)
	artifact := filepath.Join(util.TempDir, "export", strings.Repeat("a", 32), "Readable Report.zip")
	if err := os.MkdirAll(filepath.Dir(artifact), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(artifact, []byte("ordinary export"), 0600); err != nil {
		t.Fatal(err)
	}

	response := getManagedExport(t, router, strings.Repeat("a", 32)+"/Readable%20Report.zip")
	if response.Code != http.StatusOK || response.Body.String() != "ordinary export" {
		t.Fatalf("ordinary nested export: status=%d body=%q", response.Code, response.Body.String())
	}
	disposition, params, err := mime.ParseMediaType(response.Header().Get("Content-Disposition"))
	if err != nil || disposition != "attachment" || params["filename"] != "Readable Report.zip" {
		t.Fatalf("ordinary nested export disposition = %q, %v", response.Header().Get("Content-Disposition"), err)
	}
}

func TestOrdinaryExportDownloadRejectsSymbolicLinkSource(t *testing.T) {
	_, router := setupManagedExportDownloadTest(t)
	exportRoot := filepath.Join(util.TempDir, "export")
	target := filepath.Join(util.WorkspaceDir, "outside-export.txt")
	link := filepath.Join(exportRoot, "ordinary-link.txt")
	if err := os.WriteFile(target, []byte("outside export"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(exportRoot, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symbolic links unavailable: %v", err)
	}

	response := getManagedExport(t, router, filepath.Base(link))
	if response.Code != http.StatusNotFound || response.Body.String() == "outside export" {
		t.Fatalf("symbolic-link ordinary export: status=%d body=%q", response.Code, response.Body.String())
	}
}

func TestManagedEncryptedExportDownloadConsumesTokenOnce(t *testing.T) {
	boxID, router := setupManagedExportDownloadTest(t)
	artifact := writeManagedExportFixture(t, boxID, "available.zip", "available")
	availablePath := registerManagedExportFixture(t, boxID, artifact)
	if strings.Contains(availablePath, boxID) || strings.Contains(availablePath, filepath.Base(artifact)) {
		t.Fatalf("managed export path is not opaque: %q", availablePath)
	}

	response := getManagedExport(t, router, availablePath)
	if response.Code != http.StatusOK || response.Body.String() != "available" {
		t.Fatalf("available managed export: status=%d body=%q", response.Code, response.Body.String())
	}
	replay := getManagedExport(t, router, availablePath)
	if replay.Code != http.StatusNotFound || replay.Body.Len() != 0 {
		t.Fatalf("replayed managed export: status=%d body=%q", replay.Code, replay.Body.String())
	}
	if _, err := os.Stat(artifact); !os.IsNotExist(err) {
		t.Fatalf("consumed artifact remains on disk: %v", err)
	}
}

func TestManagedEncryptedExportConcurrentDownloadHasOneWinner(t *testing.T) {
	boxID, router := setupManagedExportDownloadTest(t)
	artifact := writeManagedExportFixture(t, boxID, "concurrent.zip", "concurrent")
	managedPath := registerManagedExportFixture(t, boxID, artifact)
	start := make(chan struct{})
	statuses := make(chan int, 2)
	for range 2 {
		go func() {
			<-start
			statuses <- performManagedExport(router, managedPath).Code
		}()
	}
	close(start)
	actual := []int{<-statuses, <-statuses}
	sort.Ints(actual)
	expected := []int{http.StatusOK, http.StatusNotFound}
	sort.Ints(expected)
	if actual[0] != expected[0] || actual[1] != expected[1] {
		t.Fatalf("concurrent managed export statuses = %v, want %v", actual, expected)
	}
}

func TestManagedEncryptedExportRejectsLockedNotebook(t *testing.T) {
	boxID, router := setupManagedExportDownloadTest(t)

	if err := model.LockBox(boxID); err != nil {
		t.Fatalf("lock managed export notebook: %v", err)
	}
	lockedArtifact := writeManagedExportFixture(t, boxID, "locked.zip", "locked")
	lockedPath := registerManagedExportFixture(t, boxID, lockedArtifact)
	response := getManagedExport(t, router, lockedPath)
	if response.Code != http.StatusForbidden {
		t.Fatalf("locked managed export status = %d, want %d", response.Code, http.StatusForbidden)
	}
}

func TestManagedEncryptedExportRevocationRemovesArtifact(t *testing.T) {
	boxID, router := setupManagedExportDownloadTest(t)
	artifact := writeManagedExportFixture(t, boxID, "revoked.zip", "revoked")
	managedPath := registerManagedExportFixture(t, boxID, artifact)

	model.RevokeManagedEncryptedExportsForBox(boxID)
	response := getManagedExport(t, router, managedPath)
	if response.Code != http.StatusNotFound {
		t.Fatalf("revoked managed export status = %d, want %d", response.Code, http.StatusNotFound)
	}
	if _, err := os.Stat(artifact); !os.IsNotExist(err) {
		t.Fatalf("revoked managed artifact remains on disk: %v", err)
	}
}

func TestManagedEncryptedExportRejectsCrossNotebookArtifact(t *testing.T) {
	boxID, _ := setupManagedExportDownloadTest(t)
	otherBoxID := "20260716125959-otherxx"
	artifact := writeManagedExportFixture(t, otherBoxID, "cross-box.zip", "cross-box")
	if _, err := model.RegisterManagedEncryptedExport(boxID, "server", artifact, filepath.Base(artifact)); err == nil {
		t.Fatal("cross-notebook artifact was registered")
	}
	if content, err := os.ReadFile(artifact); err != nil || string(content) != "cross-box" {
		t.Fatalf("rejected cross-notebook artifact changed: content=%q err=%v", content, err)
	}
}

func TestManagedEncryptedExportRejectsForgedToken(t *testing.T) {
	_, router := setupManagedExportDownloadTest(t)
	response := getManagedExport(t, router, "managed/"+strings.Repeat("a", 32))
	if response.Code != http.StatusNotFound || response.Body.Len() != 0 {
		t.Fatalf("forged managed export: status=%d body=%q", response.Code, response.Body.String())
	}
}

func TestManagedEncryptedExportTraversalDoesNotFallBackToOrdinaryFile(t *testing.T) {
	boxID, router := setupManagedExportDownloadTest(t)
	sentinel := filepath.Join(util.TempDir, "export", "sentinel.zip")
	if err := os.MkdirAll(filepath.Dir(sentinel), 0755); err != nil {
		t.Fatalf("create sentinel root: %v", err)
	}
	if err := os.WriteFile(sentinel, []byte("sentinel"), 0600); err != nil {
		t.Fatalf("write sentinel: %v", err)
	}

	response := getManagedExport(t, router, boxID+"/server/%2e%2e/%2e%2e/sentinel.zip")
	if response.Code < http.StatusBadRequest || response.Body.String() == "sentinel" {
		t.Fatalf("legacy managed traversal: status=%d body=%q", response.Code, response.Body.String())
	}
	response = getManagedExport(t, router, "managed/%2e%2e/sentinel.zip")
	if response.Code < http.StatusBadRequest || response.Body.String() == "sentinel" {
		t.Fatalf("opaque managed traversal: status=%d body=%q", response.Code, response.Body.String())
	}
	managedArtifact := writeManagedExportFixture(t, boxID, "double-encoded.zip", "managed secret")
	response = getManagedExport(t, router, "ordinary/%252e%252e/"+boxID+"/server/"+filepath.Base(managedArtifact))
	if response.Code < http.StatusBadRequest || response.Body.String() == "managed secret" {
		t.Fatalf("double-encoded ordinary traversal: status=%d body=%q", response.Code, response.Body.String())
	}
}

func TestManagedEncryptedExportRejectsSymbolicLink(t *testing.T) {
	boxID, router := setupManagedExportDownloadTest(t)
	artifact := writeManagedExportFixture(t, boxID, "target.zip", "target")
	link := filepath.Join(filepath.Dir(artifact), "link.zip")
	if err := os.Symlink(artifact, link); err != nil {
		t.Skipf("symbolic links unavailable: %v", err)
	}
	if _, err := model.RegisterManagedEncryptedExport(boxID, "server", link, filepath.Base(link)); err == nil {
		t.Fatal("symbolic-link artifact was registered")
	}
	response := getManagedExport(t, router, filepath.ToSlash(filepath.Join(boxID, "server", filepath.Base(link))))
	if response.Code != http.StatusNotFound || response.Body.Len() != 0 {
		t.Fatalf("unregistered symbolic-link export: status=%d body=%q", response.Code, response.Body.String())
	}
}

func TestManagedEncryptedExportOpenFailureConsumesToken(t *testing.T) {
	boxID, router := setupManagedExportDownloadTest(t)
	artifact := writeManagedExportFixture(t, boxID, "missing.zip", "missing")
	managedPath := registerManagedExportFixture(t, boxID, artifact)
	if err := os.Remove(artifact); err != nil {
		t.Fatalf("remove registered artifact: %v", err)
	}
	response := getManagedExport(t, router, managedPath)
	if response.Code != http.StatusGone {
		t.Fatalf("missing managed artifact status = %d, want %d", response.Code, http.StatusGone)
	}
	replay := getManagedExport(t, router, managedPath)
	if replay.Code != http.StatusNotFound {
		t.Fatalf("replayed missing managed artifact status = %d, want %d", replay.Code, http.StatusNotFound)
	}
}

func TestManagedEncryptedExportSendFailureConsumesToken(t *testing.T) {
	boxID, router := setupManagedExportDownloadTest(t)
	artifact := writeManagedExportFixture(t, boxID, "send-failure.zip", "send-failure")
	managedPath := registerManagedExportFixture(t, boxID, artifact)
	response := &failingBodyResponseWriter{header: http.Header{}}
	request := httptest.NewRequest(http.MethodGet, "/export/"+managedPath, nil)
	request.RemoteAddr = "127.0.0.1:12345"
	router.ServeHTTP(response, request)
	if response.writeCount == 0 || response.writeErr == nil {
		t.Fatal("managed export did not expose the transport write failure")
	}
	replay := getManagedExport(t, router, managedPath)
	if replay.Code != http.StatusNotFound {
		t.Fatalf("replayed failed managed export status = %d, want %d", replay.Code, http.StatusNotFound)
	}
}

func TestManagedEncryptedExportHoldsLockUntilBodyAndCleanupComplete(t *testing.T) {
	boxID, router := setupManagedExportDownloadTest(t)
	artifact := writeManagedExportFixture(t, boxID, "blocked-body.zip", "blocked-body")
	managedPath := registerManagedExportFixture(t, boxID, artifact)
	response := newBlockingBodyResponseWriter()
	t.Cleanup(response.Release)
	requestDone := make(chan struct{})
	request := httptest.NewRequest(http.MethodGet, "/export/"+managedPath, nil)
	request.RemoteAddr = "127.0.0.1:12345"
	go func() {
		router.ServeHTTP(response, request)
		close(requestDone)
	}()
	waitManagedExportSignal(t, response.started, "managed export body did not start")

	lockResult := make(chan error, 1)
	writeBlocked := observeServerBoxResponseWriteBlocked(t, boxID)
	go func() { lockResult <- model.LockBox(boxID) }()
	waitManagedExportSignal(t, writeBlocked, "LockBox was not blocked by the managed export response gate")

	response.Release()
	waitManagedExportSignal(t, requestDone, "managed export request did not finish")
	select {
	case err := <-lockResult:
		if err != nil {
			t.Fatalf("LockBox after managed export cleanup: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("LockBox did not finish after managed export cleanup")
	}
	if response.recorder.Code != http.StatusOK || response.recorder.Body.String() != "blocked-body" {
		t.Fatalf("blocked managed export: status=%d body=%q", response.recorder.Code, response.recorder.Body.String())
	}
	if _, err := os.Stat(artifact); !os.IsNotExist(err) {
		t.Fatalf("managed export artifact remains after LockBox completion: %v", err)
	}
}

func TestManagedEncryptedExportClaimHoldsGateThroughGzipFooter(t *testing.T) {
	boxID, _ := setupManagedExportDownloadTest(t)
	content := strings.Repeat("managed-export-gzip-response\n", 32)
	artifact := writeManagedExportFixture(t, boxID, "gzip-response.txt", content)
	managedPath := registerManagedExportFixture(t, boxID, artifact)

	handlerReturned := make(chan struct{})
	var handlerReturnedOnce sync.Once
	router := gin.New()
	router.Use(func(c *gin.Context) {
		c.Set(model.RoleContextKey, model.RoleAdministrator)
		c.Next()
	})
	router.Use(contentResponseMiddlewares()...)
	router.Use(func(c *gin.Context) {
		c.Next()
		handlerReturnedOnce.Do(func() { close(handlerReturned) })
	})
	serveExport(router)

	response := newGzipFooterBlockingResponseWriter(handlerReturned)
	t.Cleanup(response.Release)
	request := httptest.NewRequest(http.MethodGet, "/export/"+managedPath, nil)
	request.Header.Set("Accept-Encoding", "gzip")
	request.RemoteAddr = "127.0.0.1:12345"
	requestDone := make(chan struct{})
	go func() {
		router.ServeHTTP(response, request)
		close(requestDone)
	}()
	waitManagedExportSignal(t, response.footerStarted, "managed export response did not reach gzip finalization")

	lockDone := make(chan error, 1)
	writeBlocked := observeServerBoxResponseWriteBlocked(t, boxID)
	go func() { lockDone <- model.LockBox(boxID) }()
	waitManagedExportSignal(t, writeBlocked, "LockBox was not blocked by the managed export gzip footer")

	response.Release()
	waitManagedExportSignal(t, requestDone, "managed export gzip response did not finish")
	select {
	case err := <-lockDone:
		if err != nil {
			t.Fatalf("LockBox after managed export gzip response: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("LockBox did not finish after managed export gzip response")
	}
	body := readGzipResponse(t, response.recorder)
	if response.recorder.Code != http.StatusOK || body != content {
		t.Fatalf("managed export gzip response: status=%d body=%q", response.recorder.Code, body)
	}
	if _, err := os.Stat(artifact); !os.IsNotExist(err) {
		t.Fatalf("managed export artifact remains after gzip response cleanup: %v", err)
	}
}

type failingBodyResponseWriter struct {
	header     http.Header
	status     int
	writeCount int
	writeErr   error
}

type blockingBodyResponseWriter struct {
	recorder    *httptest.ResponseRecorder
	started     chan struct{}
	release     chan struct{}
	startOnce   sync.Once
	releaseOnce sync.Once
}

func newBlockingBodyResponseWriter() *blockingBodyResponseWriter {
	return &blockingBodyResponseWriter{
		recorder: httptest.NewRecorder(),
		started:  make(chan struct{}),
		release:  make(chan struct{}),
	}
}

func (writer *blockingBodyResponseWriter) Header() http.Header { return writer.recorder.Header() }

func (writer *blockingBodyResponseWriter) WriteHeader(status int) {
	writer.recorder.WriteHeader(status)
}

func (writer *blockingBodyResponseWriter) Write(data []byte) (int, error) {
	writer.startOnce.Do(func() { close(writer.started) })
	<-writer.release
	return writer.recorder.Write(data)
}

func (writer *blockingBodyResponseWriter) Release() {
	writer.releaseOnce.Do(func() { close(writer.release) })
}

func waitManagedExportSignal(t *testing.T, signal <-chan struct{}, failure string) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(5 * time.Second):
		t.Fatal(failure)
	}
}

func observeServerBoxResponseWriteBlocked(t *testing.T, boxID string) <-chan struct{} {
	t.Helper()
	blocked := make(chan struct{})
	var once sync.Once
	restore := model.SetBoxResponseWriteBlockedObserverForTest(func(blockedBoxID string) {
		if blockedBoxID == boxID {
			once.Do(func() { close(blocked) })
		}
	})
	t.Cleanup(restore)
	return blocked
}

func (writer *failingBodyResponseWriter) Header() http.Header { return writer.header }

func (writer *failingBodyResponseWriter) WriteHeader(status int) { writer.status = status }

func (writer *failingBodyResponseWriter) Write([]byte) (int, error) {
	writer.writeCount++
	writer.writeErr = errors.New("test transport write failure")
	return 0, writer.writeErr
}

func setupManagedExportDownloadTest(t *testing.T) (string, *gin.Engine) {
	t.Helper()
	previousMode := gin.Mode()
	previousWorkspaceDir := util.WorkspaceDir
	previousDataDir := util.DataDir
	previousTempDir := util.TempDir
	previousQueueDir := util.QueueDir
	previousConfDir := util.ConfDir
	previousBlockTreeDBPath := util.BlockTreeDBPath
	previousConf := model.Conf
	previousReadOnly := util.ReadOnly
	previousIsExiting := util.IsExiting.Load()

	root := t.TempDir()
	util.WorkspaceDir = root
	util.DataDir = filepath.Join(root, "data")
	util.TempDir = filepath.Join(root, "temp")
	util.QueueDir = filepath.Join(util.TempDir, "queue")
	util.ConfDir = filepath.Join(root, "conf")
	util.BlockTreeDBPath = filepath.Join(util.TempDir, "blocktree.db")
	for _, dir := range []string{util.DataDir, util.TempDir, util.QueueDir, util.ConfDir} {
		if err := os.MkdirAll(dir, 0755); err != nil {
			t.Fatalf("create managed export fixture directory: %v", err)
		}
	}
	util.ReadOnly = false
	util.IsExiting.Store(false)
	model.Conf = model.NewAppConf()
	model.Conf.System = kernelconf.NewSystem()
	model.Conf.Sync = kernelconf.NewSync()
	model.Conf.FileTree = kernelconf.NewFileTree()
	model.Conf.Editor = kernelconf.NewEditor()
	model.Conf.Export = kernelconf.NewExport()
	model.Conf.Search = kernelconf.NewSearch()
	model.Conf.NotebookCrypto = kernelconf.NewNotebookCrypto()
	cache.ClearTreeCache()
	if err := kernelsql.ClearQueue(); err != nil {
		t.Fatalf("clear managed export queue: %v", err)
	}

	const password = "managed-export-download-password"
	if err := model.EnableEncryptedNotebook(password); err != nil {
		t.Fatalf("enable encrypted notebook fixture: %v", err)
	}
	boxID, err := model.CreateEncryptedBox("Managed Export Download", password)
	if err != nil {
		t.Fatalf("create encrypted notebook fixture: %v", err)
	}
	t.Cleanup(func() {
		_ = model.LockBox(boxID)
		if err := kernelsql.ClearQueue(); err != nil {
			t.Errorf("clear managed export queue during cleanup: %v", err)
		}
		cache.ClearTreeCache()
		model.Conf = previousConf
		util.IsExiting.Store(previousIsExiting)
		util.ReadOnly = previousReadOnly
		util.BlockTreeDBPath = previousBlockTreeDBPath
		util.ConfDir = previousConfDir
		util.QueueDir = previousQueueDir
		util.TempDir = previousTempDir
		util.DataDir = previousDataDir
		util.WorkspaceDir = previousWorkspaceDir
		gin.SetMode(previousMode)
	})

	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(func(c *gin.Context) {
		c.Set(model.RoleContextKey, model.RoleAdministrator)
		c.Next()
	})
	router.Use(api.ContentResponseLifecycle)
	serveExport(router)
	return boxID, router
}

func writeManagedExportFixture(t *testing.T, boxID, name, content string) string {
	t.Helper()
	artifact := filepath.Join(util.TempDir, "export", boxID, "server", name)
	if err := os.MkdirAll(filepath.Dir(artifact), 0755); err != nil {
		t.Fatalf("create managed export artifact directory: %v", err)
	}
	if err := os.WriteFile(artifact, []byte(content), 0600); err != nil {
		t.Fatalf("write managed export artifact: %v", err)
	}
	return artifact
}

func registerManagedExportFixture(t *testing.T, boxID, artifact string) string {
	t.Helper()
	managedPath, err := model.RegisterManagedEncryptedExport(boxID, "server", artifact, filepath.Base(artifact))
	if err != nil {
		t.Fatalf("register managed export: %v", err)
	}
	return managedPath
}

func getManagedExport(t *testing.T, router http.Handler, relativePath string) *httptest.ResponseRecorder {
	t.Helper()
	return performManagedExport(router, relativePath)
}

func performManagedExport(router http.Handler, relativePath string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodGet, "/export/"+relativePath, nil)
	request.RemoteAddr = "127.0.0.1:12345"
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	return response
}

func assertManagedResourceResponseArchive(t *testing.T, data []byte) {
	t.Helper()
	archive, err := archivezip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatalf("open generated managed resource archive: %v", err)
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
			t.Fatalf("read generated managed resource entry %q: %v", entry.Name, errors.Join(readErr, closeErr))
		}
		if string(content) == "managed resource plaintext" {
			return
		}
	}
	t.Fatal("generated managed resource archive did not contain decrypted content")
}
