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
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"

	"github.com/gin-gonic/gin"
	kernelconf "github.com/siyuan-note/siyuan/kernel/conf"
	"github.com/siyuan-note/siyuan/kernel/model"
	"github.com/siyuan-note/siyuan/kernel/treenode"
	"github.com/siyuan-note/siyuan/kernel/util"
)

func TestEnterpriseDirectoryReturnsMinimalRootAndChildIdentity(t *testing.T) {
	setupEncryptedResponseTest(t, 0)
	util.SetBooted()
	const (
		boxID      = "20990718010000-dirbox1"
		parent     = "20990718010001-dirpar1"
		child      = "20990718010002-dirchi1"
		grandchild = "20990718010003-dirgra1"
		sibling    = "20990718010004-dirsib1"
	)
	createEnterpriseDirectoryNotebook(t, boxID, "Directory", false)
	createEnterpriseDirectoryTree(t, boxID, parent, "/"+parent+".sy", "/Parent", "Parent")
	createEnterpriseDirectoryTree(t, boxID, child, "/"+parent+"/"+child+".sy", "/Parent/Child", "Child")
	createEnterpriseDirectoryTree(t, boxID, grandchild, "/"+parent+"/"+child+"/"+grandchild+".sy", "/Parent/Child/Grandchild", "Grandchild")
	createEnterpriseDirectoryTree(t, boxID, sibling, "/"+sibling+".sy", "/Sibling", "Sibling")

	router := enterpriseDirectoryTestRouter(t)
	notebookResponse := serveEnterpriseDirectoryRequest(router, "/internal/enterprise/directory/notebooks")
	if notebookResponse.Code != http.StatusOK {
		t.Fatalf("notebook directory status = %d, want 200", notebookResponse.Code)
	}
	var notebookPayload struct {
		Notebooks []model.EnterpriseDirectoryNotebook `json:"notebooks"`
	}
	if err := json.Unmarshal(notebookResponse.Body.Bytes(), &notebookPayload); err != nil {
		t.Fatalf("decode notebook directory: %v", err)
	}
	if len(notebookPayload.Notebooks) != 1 || notebookPayload.Notebooks[0].NotebookID != boxID || notebookPayload.Notebooks[0].Locked {
		t.Fatalf("notebook directory = %#v, want one open notebook", notebookPayload.Notebooks)
	}

	rootResponse := serveEnterpriseDirectoryRequest(
		router,
		"/internal/enterprise/directory/documents?notebookId="+boxID+"&offset=0",
	)
	rootPage := decodeEnterpriseDirectoryPage(t, rootResponse)
	hasParent := slices.ContainsFunc(rootPage.Documents, func(document model.EnterpriseDirectoryDocument) bool {
		return document.NotebookID == boxID && document.DocumentID == parent && document.HasChildren
	})
	hasSibling := slices.ContainsFunc(rootPage.Documents, func(document model.EnterpriseDirectoryDocument) bool {
		return document.NotebookID == boxID && document.DocumentID == sibling && !document.HasChildren
	})
	if len(rootPage.Documents) != 2 || !hasParent || !hasSibling {
		t.Fatalf("root directory = %#v, want parent and sibling", rootPage.Documents)
	}

	childResponse := serveEnterpriseDirectoryRequest(
		router,
		"/internal/enterprise/directory/documents?notebookId="+boxID+"&parentDocumentId="+parent+"&offset=0",
	)
	childPage := decodeEnterpriseDirectoryPage(t, childResponse)
	if len(childPage.Documents) != 1 || childPage.Documents[0].NotebookID != boxID ||
		childPage.Documents[0].DocumentID != child || !childPage.Documents[0].HasChildren {
		t.Fatalf("child directory = %#v, want declared child", childPage.Documents)
	}
	nestedResponse := serveEnterpriseDirectoryRequest(
		router,
		"/internal/enterprise/directory/documents?notebookId="+boxID+"&parentDocumentId="+child+"&offset=0",
	)
	nestedPage := decodeEnterpriseDirectoryPage(t, nestedResponse)
	if len(nestedPage.Documents) != 1 || nestedPage.Documents[0].NotebookID != boxID ||
		nestedPage.Documents[0].DocumentID != grandchild || nestedPage.Documents[0].HasChildren {
		t.Fatalf("nested directory = %#v, want declared grandchild", nestedPage.Documents)
	}
	var rawPayload struct {
		Documents []map[string]any `json:"documents"`
	}
	if err := json.Unmarshal(childResponse.Body.Bytes(), &rawPayload); err != nil {
		t.Fatal(err)
	}
	rawDocument := rawPayload.Documents[0]
	for _, forbidden := range []string{"path", "hPath", "content", "summary"} {
		if _, exists := rawDocument[forbidden]; exists {
			t.Fatalf("directory document exposes forbidden field %q: %#v", forbidden, rawDocument)
		}
	}
}

func TestEnterpriseDirectoryPaginatesEverySibling(t *testing.T) {
	setupEncryptedResponseTest(t, 0)
	util.SetBooted()
	const boxID = "20990718020000-dirbox2"
	createEnterpriseDirectoryNotebook(t, boxID, "Pagination", false)
	for index := 0; index < model.EnterpriseDirectoryPageSize+1; index++ {
		documentID := fmt.Sprintf("20990718%06d-p%06d", index, index)
		createEnterpriseDirectoryTree(t, boxID, documentID, "/"+documentID+".sy", "/Page", "Page")
	}

	router := enterpriseDirectoryTestRouter(t)
	first := decodeEnterpriseDirectoryPage(t, serveEnterpriseDirectoryRequest(
		router,
		"/internal/enterprise/directory/documents?notebookId="+boxID+"&offset=0",
	))
	if len(first.Documents) != model.EnterpriseDirectoryPageSize || first.NextOffset == nil ||
		*first.NextOffset != model.EnterpriseDirectoryPageSize {
		t.Fatalf("first page = %#v, want %d documents and next offset", first, model.EnterpriseDirectoryPageSize)
	}
	second := decodeEnterpriseDirectoryPage(t, serveEnterpriseDirectoryRequest(
		router,
		fmt.Sprintf(
			"/internal/enterprise/directory/documents?notebookId=%s&offset=%d",
			boxID,
			*first.NextOffset,
		),
	))
	if len(second.Documents) != 1 || second.NextOffset != nil {
		t.Fatalf("second page = %#v, want final document", second)
	}
}

func TestEnterpriseDirectoryRejectsCrossNotebookParentAndUnknownQuery(t *testing.T) {
	setupEncryptedResponseTest(t, 0)
	util.SetBooted()
	const (
		boxA   = "20990718030000-dirbox3"
		boxB   = "20990718030001-dirbox3"
		parent = "20990718030002-dirpar3"
	)
	createEnterpriseDirectoryNotebook(t, boxA, "A", false)
	createEnterpriseDirectoryNotebook(t, boxB, "B", false)
	createEnterpriseDirectoryTree(t, boxB, parent, "/"+parent+".sy", "/Other", "Other")

	router := enterpriseDirectoryTestRouter(t)
	crossNotebook := serveEnterpriseDirectoryRequest(
		router,
		"/internal/enterprise/directory/documents?notebookId="+boxA+"&parentDocumentId="+parent+"&offset=0",
	)
	if crossNotebook.Code != http.StatusNotFound {
		t.Fatalf("cross-notebook parent status = %d, want 404", crossNotebook.Code)
	}
	unknownQuery := serveEnterpriseDirectoryRequest(
		router,
		"/internal/enterprise/directory/documents?notebookId="+boxA+"&offset=0&path=/",
	)
	if unknownQuery.Code != http.StatusBadRequest {
		t.Fatalf("unknown directory query status = %d, want 400", unknownQuery.Code)
	}
}

func TestEnterpriseDirectoryHoldsEncryptedResponseUntilSerializationAndHidesLockedDocuments(t *testing.T) {
	boxID := setupEncryptedResponseTest(t, 1)[0]
	util.SetBooted()
	const documentID = "20990718040000-direncr"
	createEnterpriseDirectoryTree(t, boxID, documentID, "/"+documentID+".sy", "/Protected", "Protected")

	router := enterpriseDirectoryTestRouter(t)
	request := httptest.NewRequest(
		http.MethodGet,
		"/internal/enterprise/directory/documents?notebookId="+boxID+"&offset=0",
		nil,
	)
	writer := &blockingResponseWriter{
		ResponseRecorder: httptest.NewRecorder(),
		writeStarted:     make(chan struct{}),
		writeRelease:     make(chan struct{}),
	}
	t.Cleanup(writer.release)
	responseDone := make(chan struct{})
	go func() {
		router.ServeHTTP(writer, request)
		close(responseDone)
	}()
	waitResponseTestSignal(t, writer.writeStarted, "directory response did not reach JSON serialization")

	lockDone := make(chan error, 1)
	writeBlocked := observeBoxResponseWriteBlocked(t, boxID)
	go func() { lockDone <- model.LockBox(boxID) }()
	waitResponseTestSignal(t, writeBlocked, "LockBox was not blocked by the directory response")
	writer.release()
	waitResponseTestSignal(t, responseDone, "directory response did not complete")
	if err := waitResponseTestError(t, lockDone, "LockBox did not complete after directory serialization"); err != nil {
		t.Fatalf("LockBox after directory response: %v", err)
	}
	page := decodeEnterpriseDirectoryPage(t, writer.ResponseRecorder)
	if page.Locked || len(page.Documents) != 1 || page.Documents[0].Title != "Protected" {
		t.Fatalf("unlocked directory response = %#v, want protected document", page)
	}

	locked := decodeEnterpriseDirectoryPage(t, serveEnterpriseDirectoryRequest(
		router,
		"/internal/enterprise/directory/documents?notebookId="+boxID+"&offset=0",
	))
	if !locked.Locked || len(locked.Documents) != 0 || locked.NextOffset != nil {
		t.Fatalf("locked directory response = %#v, want no document disclosure", locked)
	}
}

func enterpriseDirectoryTestRouter(t *testing.T) *gin.Engine {
	t.Helper()
	previousMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(previousMode) })
	router := gin.New()
	router.Use(ContentResponseLifecycle)
	router.GET("/internal/enterprise/directory/notebooks", EnterpriseListDirectoryNotebooks)
	router.GET("/internal/enterprise/directory/documents", EnterpriseListDirectoryDocuments)
	return router
}

func createEnterpriseDirectoryNotebook(t *testing.T, boxID, name string, closed bool) {
	t.Helper()
	boxConf := kernelconf.NewBoxConf()
	boxConf.Name = name
	boxConf.Closed = closed
	if err := (&model.Box{ID: boxID}).SaveConf(boxConf); err != nil {
		t.Fatalf("create directory notebook %s: %v", boxID, err)
	}
}

func createEnterpriseDirectoryTree(t *testing.T, boxID, documentID, path, hPath, title string) {
	t.Helper()
	tree := treenode.NewTree(boxID, path, hPath, title)
	tree.ID = documentID
	tree.Root.ID = documentID
	tree.Root.SetIALAttr("id", documentID)
	tree.Root.SetIALAttr("updated", documentID[:14])
	if err := model.PerformTxSync(&model.Transaction{
		Notebook: model.TransactionNotebookForBox(boxID),
		DoOperations: []*model.Operation{{
			Action: "create",
			Data:   tree,
		}},
	}); err != nil {
		t.Fatalf("create directory document %s/%s: %v", boxID, documentID, err)
	}
}

func serveEnterpriseDirectoryRequest(router *gin.Engine, path string) *httptest.ResponseRecorder {
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
	return response
}

func decodeEnterpriseDirectoryPage(t *testing.T, response *httptest.ResponseRecorder) model.EnterpriseDirectoryPage {
	t.Helper()
	if response.Code != http.StatusOK {
		t.Fatalf("directory status = %d, want 200: %s", response.Code, response.Body.String())
	}
	var page model.EnterpriseDirectoryPage
	if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil {
		t.Fatalf("decode directory page: %v", err)
	}
	return page
}
