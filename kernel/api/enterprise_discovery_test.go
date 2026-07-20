// SiYuan - Refactor your thinking
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

package api

import (
	"bytes"
	"crypto/ed25519"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/88250/lute/ast"
	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	kernelconf "github.com/siyuan-note/siyuan/kernel/conf"
	"github.com/siyuan-note/siyuan/kernel/model"
	"github.com/siyuan-note/siyuan/kernel/serviceauth"
	"github.com/siyuan-note/siyuan/kernel/treenode"
)

func TestEnterpriseDiscoveryReturnsMinimalExplicitSpaceIdentities(t *testing.T) {
	setupEncryptedResponseTest(t, 0)
	model.Conf.Graph = kernelconf.NewGraph()
	model.Conf.Graph.Global.Paragraph = true
	const (
		notebookID = "20990719160000-dscbox1"
		documentID = "20990719160001-dscdoc1"
		blockID    = "20990719160002-dscblk1"
	)
	createEnterpriseDirectoryNotebook(t, notebookID, "Discovery", false)
	tree := treenode.NewTree(notebookID, "/"+documentID+".sy", "/Discovery", "Discovery")
	tree.ID = documentID
	tree.Root.ID = documentID
	tree.Root.SetIALAttr("id", documentID)
	tree.Root.SetIALAttr("updated", documentID[:14])
	paragraph := tree.Root.FirstChild
	paragraph.ID = blockID
	paragraph.Box = notebookID
	paragraph.Path = tree.Path
	paragraph.SetIALAttr("id", blockID)
	paragraph.SetIALAttr("updated", blockID[:14])
	paragraph.AppendChild(&ast.Node{Type: ast.NodeText, Tokens: []byte("Alpha knowledge")})
	if err := model.PerformTxSync(&model.Transaction{
		Notebook: model.TransactionNotebookForBox(notebookID),
		DoOperations: []*model.Operation{{
			Action: "create",
			Data:   tree,
		}},
	}); err != nil {
		t.Fatalf("create discovery fixture: %v", err)
	}

	router := enterpriseDiscoveryTestRouter(t)
	search := serveEnterpriseDiscoveryRequest(
		router,
		"/internal/enterprise/discovery/search",
		map[string]any{"method": "keyword", "query": "Alpha"},
	)
	if search.Code != http.StatusOK {
		t.Fatalf("search status = %d, want 200: %s", search.Code, search.Body.String())
	}
	searchResponse := &enterpriseDiscoverySearchResponse{}
	if err := json.Unmarshal(search.Body.Bytes(), searchResponse); err != nil {
		t.Fatalf("decode discovery search: %v", err)
	}
	if len(searchResponse.Blocks) != 1 ||
		searchResponse.Blocks[0].ID != blockID ||
		searchResponse.Blocks[0].DocumentID != documentID ||
		searchResponse.Blocks[0].NotebookID != notebookID {
		t.Fatalf("search projection = %#v, want explicit source identities", searchResponse)
	}
	_, localNodes, _ := model.BuildTreeGraphInBox(documentID, "", notebookID)
	if len(localNodes) == 0 {
		t.Fatal("document-scoped graph projection is empty")
	}
	for _, node := range localNodes {
		if node.Box == "" && node.DocumentID == "" {
			continue
		}
		if node.Box == "" || node.DocumentID == "" {
			t.Fatalf("local graph node has partial source identity: %#v", node)
		}
	}

	graph := serveEnterpriseDiscoveryRequest(
		router,
		"/internal/enterprise/discovery/graph",
		map[string]any{"query": "  Alpha  "},
	)
	if graph.Code != http.StatusOK {
		t.Fatalf("graph status = %d, want 200: %s", graph.Code, graph.Body.String())
	}
	graphResponse := &enterpriseDiscoveryGraphResponse{}
	if err := json.Unmarshal(graph.Body.Bytes(), graphResponse); err != nil {
		t.Fatalf("decode discovery graph: %v", err)
	}
	if len(graphResponse.Nodes) == 0 {
		t.Fatal("graph projection is empty")
	}
	for _, node := range graphResponse.Nodes {
		if node.DocumentID != documentID || node.NotebookID != notebookID {
			t.Fatalf("graph node = %#v, want explicit source document identity", node)
		}
	}
	var rawGraph struct {
		Nodes []map[string]any `json:"nodes"`
	}
	if err := json.Unmarshal(graph.Body.Bytes(), &rawGraph); err != nil {
		t.Fatalf("decode raw graph projection: %v", err)
	}
	for _, node := range rawGraph.Nodes {
		for _, forbidden := range []string{"box", "path", "refs", "defs", "size", "type"} {
			if _, exists := node[forbidden]; exists {
				t.Fatalf("graph projection exposes %q: %#v", forbidden, node)
			}
		}
	}
}

func TestEnterpriseDiscoveryAggregatesUnlockedEncryptedStoresAndExcludesLockedStores(t *testing.T) {
	encryptedBoxIDs := setupEncryptedResponseTest(t, 2)
	model.Conf.Graph = kernelconf.NewGraph()
	model.Conf.Graph.Global.Paragraph = true
	const (
		ordinaryNotebookID = "20990720100000-dscord1"
		ordinaryDocumentID = "20990720100001-dscord1"
		ordinaryBlockID    = "20990720100002-dscord1"
		unlockedDocumentID = "20990720100003-dscenc1"
		unlockedBlockID    = "20990720100004-dscenc1"
		lockedDocumentID   = "20990720100005-dscenc2"
		lockedBlockID      = "20990720100006-dscenc2"
		query              = "nebula"
	)
	createEnterpriseDirectoryNotebook(t, ordinaryNotebookID, "Ordinary", false)
	createEnterpriseDiscoveryTree(t, ordinaryNotebookID, ordinaryDocumentID, ordinaryBlockID, "nebula ordinary", "")
	createEnterpriseDiscoveryTree(t, encryptedBoxIDs[0], unlockedDocumentID, unlockedBlockID, "nebula unlocked", "")
	createEnterpriseDiscoveryTree(t, encryptedBoxIDs[1], lockedDocumentID, lockedBlockID, "nebula locked", "")
	if err := model.LockBox(encryptedBoxIDs[1]); err != nil {
		t.Fatalf("lock excluded discovery notebook: %v", err)
	}

	router := enterpriseDiscoveryTestRouter(t)
	search := serveEnterpriseDiscoveryRequest(
		router,
		"/internal/enterprise/discovery/search",
		map[string]any{"method": "keyword", "query": query},
	)
	if search.Code != http.StatusOK {
		t.Fatalf("cross-store search status = %d, want 200: %s", search.Code, search.Body.String())
	}
	searchResponse := &enterpriseDiscoverySearchResponse{}
	if err := json.Unmarshal(search.Body.Bytes(), searchResponse); err != nil {
		t.Fatalf("decode cross-store search: %v", err)
	}
	if searchResponse.MatchedBlockCount != 2 || searchResponse.PageCount != 1 || len(searchResponse.Blocks) != 2 {
		t.Fatalf("cross-store search = %#v, want ordinary plus one unlocked encrypted result", searchResponse)
	}
	searchIdentities := map[string]string{}
	for _, block := range searchResponse.Blocks {
		searchIdentities[block.NotebookID] = block.ID
	}
	if searchIdentities[ordinaryNotebookID] != ordinaryBlockID ||
		searchIdentities[encryptedBoxIDs[0]] != unlockedBlockID {
		t.Fatalf("cross-store search identities = %#v", searchIdentities)
	}
	if _, leaked := searchIdentities[encryptedBoxIDs[1]]; leaked {
		t.Fatalf("locked notebook entered search results: %#v", searchIdentities)
	}

	graph := serveEnterpriseDiscoveryRequest(
		router,
		"/internal/enterprise/discovery/graph",
		map[string]any{"query": query},
	)
	if graph.Code != http.StatusOK {
		t.Fatalf("cross-store graph status = %d, want 200: %s", graph.Code, graph.Body.String())
	}
	graphResponse := &enterpriseDiscoveryGraphResponse{}
	if err := json.Unmarshal(graph.Body.Bytes(), graphResponse); err != nil {
		t.Fatalf("decode cross-store graph: %v", err)
	}
	graphIdentities := map[string]string{}
	for _, node := range graphResponse.Nodes {
		graphIdentities[node.NotebookID] = node.ID
	}
	if graphIdentities[ordinaryNotebookID] != ordinaryBlockID ||
		graphIdentities[encryptedBoxIDs[0]] != unlockedBlockID {
		t.Fatalf("cross-store graph identities = %#v", graphIdentities)
	}
	if _, leaked := graphIdentities[encryptedBoxIDs[1]]; leaked {
		t.Fatalf("locked notebook entered graph results: %#v", graphIdentities)
	}
}

func TestEnterpriseDiscoveryHoldsEncryptedResponseUntilSerializationCompletes(t *testing.T) {
	boxID := setupEncryptedResponseTest(t, 1)[0]
	router := enterpriseDiscoveryTestRouter(t)
	requestBody, err := json.Marshal(map[string]any{"method": "keyword", "query": "absent"})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(
		http.MethodPost,
		"/internal/enterprise/discovery/search",
		bytes.NewReader(requestBody),
	)
	request.Header.Set("Content-Type", "application/json")
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
	waitResponseTestSignal(t, writer.writeStarted, "discovery response did not reach JSON serialization")

	writeBlocked := observeBoxResponseWriteBlocked(t, boxID)
	lockDone := make(chan error, 1)
	go func() { lockDone <- model.LockBox(boxID) }()
	waitResponseTestSignal(t, writeBlocked, "LockBox was not blocked by the discovery response")
	writer.release()
	waitResponseTestSignal(t, responseDone, "discovery response did not complete")
	if err = waitResponseTestError(t, lockDone, "LockBox did not complete after discovery serialization"); err != nil {
		t.Fatalf("LockBox after discovery response: %v", err)
	}
	if writer.Code != http.StatusOK {
		t.Fatalf("discovery response status = %d, want 200", writer.Code)
	}
}

func TestEnterpriseEncryptedDocumentGraphIsRejectedBeforeDocumentLookup(t *testing.T) {
	boxID := setupEncryptedResponseTest(t, 1)[0]
	configuration, signingKey := newImageOCRServiceAuthConfiguration(t)
	router := enterpriseDiscoveryServiceAuthRouter(t, configuration)
	const missingDocumentID = "20990720110000-dscmiss"
	response := serveAuthenticatedEnterpriseDiscoveryRequest(
		t,
		router,
		signingKey,
		boxID,
		missingDocumentID,
		map[string]any{
			"conf": map[string]any{
				"d3":   kernelconf.NewLocalGraph().D3,
				"type": kernelconf.NewLocalGraph().TypeFilter,
			},
			"id": missingDocumentID,
			"k":  "",
		},
	)
	if response.Code != http.StatusOK {
		t.Fatalf("encrypted document graph HTTP status = %d, want 200", response.Code)
	}
	var result struct {
		Code int    `json:"code"`
		Msg  string `json:"msg"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatalf("decode encrypted document graph response: %v", err)
	}
	if result.Code != -1 || result.Msg != "document graph is unavailable for this notebook" {
		t.Fatalf("encrypted document graph response = %#v, want capability rejection", result)
	}
}

func TestGraphTagNamespaceDoesNotCollideWithBlockIdentity(t *testing.T) {
	setupEncryptedResponseTest(t, 0)
	model.Conf.Graph = kernelconf.NewGraph()
	model.Conf.Graph.Local.Paragraph = true
	model.Conf.Graph.Local.Tag = true
	const (
		notebookID = "20990720120000-dsctag1"
		documentID = "20990720120001-dsctag1"
		blockID    = "20990720120002-dsctag1"
	)
	createEnterpriseDirectoryNotebook(t, notebookID, "Tags", false)
	createEnterpriseDiscoveryTree(t, notebookID, documentID, blockID, "collision", blockID)

	_, nodes, links := model.BuildTreeGraphInBox(documentID, "", notebookID)
	tagID := "tag:" + blockID
	var blockFound, tagFound, linkFound bool
	for _, node := range nodes {
		switch node.ID {
		case blockID:
			blockFound = node.Box == notebookID && node.DocumentID == documentID
		case tagID:
			tagFound = node.Label == blockID && node.Box == "" && node.DocumentID == ""
		}
	}
	for _, link := range links {
		if link.From == tagID && link.To == blockID {
			linkFound = true
			break
		}
	}
	if !blockFound || !tagFound || !linkFound {
		t.Fatalf("tag collision graph nodes=%#v links=%#v", nodes, links)
	}
}

func TestEnterpriseDiscoveryRejectsUnknownFields(t *testing.T) {
	router := enterpriseDiscoveryTestRouter(t)
	response := serveEnterpriseDiscoveryRequest(
		router,
		"/internal/enterprise/discovery/search",
		map[string]any{
			"documentId": "20990719160001-dscdoc1",
			"method":     "keyword",
			"query":      "Alpha",
		},
	)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("identity-bearing search status = %d, want 400", response.Code)
	}
}

func TestGetLocalGraphRejectsNullConfigurationSectionsAtHTTPBoundary(t *testing.T) {
	router := enterpriseDiscoveryTestRouter(t)
	for _, test := range []struct {
		name string
		conf map[string]any
	}{
		{name: "null type filter", conf: map[string]any{"type": nil}},
		{name: "null d3 settings", conf: map[string]any{"d3": nil}},
	} {
		t.Run(test.name, func(t *testing.T) {
			response := serveEnterpriseDiscoveryRequest(
				router,
				"/api/graph/getLocalGraph",
				map[string]any{
					"conf": test.conf,
					"id":   "20990719160001-dscdoc1",
					"k":    "",
				},
			)
			if response.Code != http.StatusOK {
				t.Fatalf("HTTP status = %d, want 200", response.Code)
			}
			var result struct {
				Code int    `json:"code"`
				Msg  string `json:"msg"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
				t.Fatalf("decode local graph response: %v", err)
			}
			if result.Code != -1 || result.Msg == "" {
				t.Fatalf("local graph response = %#v, want Kernel envelope rejection", result)
			}
		})
	}
}

func TestEnterpriseDiscoveryCanonicalTextProjections(t *testing.T) {
	const (
		notebookID = "20990719160000-dscbox1"
		documentID = "20990719160001-dscdoc1"
		blockID    = "20990719160002-dscblk1"
		childID    = "20990719160003-dscblk2"
	)
	blocks := enterpriseDiscoveryBlockProjections([]*model.Block{{
		Box:     notebookID,
		Content: "<mark>Alpha</mark> &amp; &lt;script&gt;",
		ID:      blockID,
		RootID:  documentID,
	}})
	if len(blocks) != 1 || blocks[0].Content != "Alpha & <script>" {
		t.Fatalf("search projection = %#v, want plain text", blocks)
	}

	backlinks := enterpriseDiscoveryBacklinkProjections([]*model.Path{
		{
			Box:   notebookID,
			HPath: "/unused-path",
			ID:    documentID,
			Name:  "<span>Named &amp; linked</span>",
		},
		{
			Box:   notebookID,
			HPath: "/must-not-be-used",
			ID:    childID,
		},
	})
	if len(backlinks) != 1 || backlinks[0].Title != "Named & linked" {
		t.Fatalf("backlink projection = %#v, want only the explicit plain-text name", backlinks)
	}

	outline := enterpriseDiscoveryOutlineProjections([]*model.Path{{
		Blocks: []*model.Block{{
			Children: []*model.Block{{
				Content: "<mark>Nested</mark>",
				ID:      childID,
			}},
			Content: "Child &amp; heading",
			ID:      blockID,
		}},
		ID:   documentID,
		Name: "<span>Root&nbsp;heading</span>",
	}})
	if len(outline) != 1 || outline[0].Name != "Root\u00a0heading" ||
		len(outline[0].Children) != 1 || outline[0].Children[0].Name != "Child & heading" ||
		len(outline[0].Children[0].Children) != 1 || outline[0].Children[0].Children[0].Name != "Nested" {
		t.Fatalf("outline projection = %#v, want canonical plain-text children", outline)
	}

	graph := enterpriseDiscoveryLocalGraphProjections([]*model.GraphNode{
		{
			Box:        notebookID,
			DocumentID: documentID,
			ID:         blockID,
			Title:      "Paragraph & node",
		},
		{
			Box:        notebookID,
			DocumentID: documentID,
			ID:         childID,
		},
	})
	if len(graph) != 1 || graph[0].Label != "Paragraph & node" {
		t.Fatalf("graph projection = %#v, want source display text without an ID fallback", graph)
	}
}

func TestEnterpriseDiscoveryDocumentProjectionKeepsSourceIdentities(t *testing.T) {
	contentNode := &model.GraphNode{
		Box:        "20990719160000-dscbox1",
		DocumentID: "20990719160001-dscdoc1",
		ID:         "20990719160002-dscblk1",
		Label:      "Knowledge",
	}
	tagNode := &model.GraphNode{ID: "tag:knowledge/tag", Label: "knowledge/tag"}
	projected := enterpriseDiscoveryLocalGraphProjections([]*model.GraphNode{contentNode, tagNode})
	if len(projected) != 2 {
		t.Fatalf("projected graph nodes = %d, want 2", len(projected))
	}
	if projected[0].DocumentID == nil || *projected[0].DocumentID != contentNode.DocumentID || projected[0].NotebookID == nil || *projected[0].NotebookID != contentNode.Box {
		t.Fatalf("content node projection = %#v, want source identities", projected[0])
	}
	if projected[1].DocumentID != nil || projected[1].NotebookID != nil {
		t.Fatalf("tag node projection = %#v, want non-navigable null identity", projected[1])
	}

	backlinks := enterpriseDiscoveryBacklinkProjections([]*model.Path{{
		Box:  contentNode.Box,
		ID:   contentNode.DocumentID,
		Name: "Knowledge",
	}})
	if len(backlinks) != 1 || backlinks[0].DocumentID != contentNode.DocumentID || backlinks[0].NotebookID != contentNode.Box {
		t.Fatalf("backlink projection = %#v, want source identities", backlinks)
	}

	links := enterpriseDiscoveryGraphLinkProjections([]*model.GraphLink{
		{From: contentNode.ID, To: tagNode.ID},
		{From: tagNode.ID, To: "missing-node"},
	}, projected)
	if len(links) != 1 || links[0].From != contentNode.ID || links[0].To != tagNode.ID {
		t.Fatalf("graph links = %#v, want only links between projected nodes", links)
	}
}

func enterpriseDiscoveryTestRouter(t *testing.T) *gin.Engine {
	t.Helper()
	previousMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(previousMode) })
	router := gin.New()
	router.Use(ContentResponseLifecycle)
	router.POST("/internal/enterprise/discovery/search", EnterpriseSearchSpace)
	router.POST("/internal/enterprise/discovery/graph", EnterpriseReadSpaceGraph)
	router.POST("/api/graph/getLocalGraph", getLocalGraph)
	return router
}

func enterpriseDiscoveryServiceAuthRouter(t *testing.T, configuration *serviceauth.Configuration) *gin.Engine {
	t.Helper()
	previousMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(previousMode) })
	router := gin.New()
	router.Use(configuration.Middleware(), ContentResponseLifecycle)
	router.POST("/api/graph/getLocalGraph", getLocalGraph)
	return router
}

func serveAuthenticatedEnterpriseDiscoveryRequest(
	t *testing.T,
	router *gin.Engine,
	signingKey ed25519.PrivateKey,
	notebookID,
	documentID string,
	payload any,
) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("encode authenticated discovery request: %v", err)
	}
	now := time.Now()
	claims := serviceauth.Claims{
		SpaceID: imageOCRServiceSpaceID,
		RegisteredClaims: jwt.RegisteredClaims{
			Audience:  jwt.ClaimStrings{imageOCRServiceInstanceID},
			ExpiresAt: jwt.NewNumericDate(now.Add(20 * time.Second)),
			ID:        imageOCRServiceRequestID,
			IssuedAt:  jwt.NewNumericDate(now),
			Issuer:    "singularity-api",
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodEdDSA, claims)
	token.Header["kid"] = imageOCRServiceKeyID
	signedToken, err := token.SignedString(signingKey)
	if err != nil {
		t.Fatalf("sign authenticated discovery request: %v", err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/graph/getLocalGraph", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set(serviceauth.DocumentIDHeader, documentID)
	request.Header.Set(serviceauth.NotebookIDHeader, notebookID)
	request.Header.Set(serviceauth.RequestIDHeader, imageOCRServiceRequestID)
	request.Header.Set(serviceauth.ServiceTokenHeader, signedToken)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	return response
}

func createEnterpriseDiscoveryTree(
	t *testing.T,
	notebookID,
	documentID,
	blockID,
	content,
	tag string,
) {
	t.Helper()
	tree := treenode.NewTree(notebookID, "/"+documentID+".sy", "/Discovery", "Discovery")
	tree.ID = documentID
	tree.Root.ID = documentID
	tree.Root.SetIALAttr("id", documentID)
	tree.Root.SetIALAttr("updated", documentID[:14])
	paragraph := tree.Root.FirstChild
	paragraph.ID = blockID
	paragraph.Box = notebookID
	paragraph.Path = tree.Path
	paragraph.SetIALAttr("id", blockID)
	paragraph.SetIALAttr("updated", blockID[:14])
	paragraph.AppendChild(&ast.Node{Type: ast.NodeText, Tokens: []byte(content)})
	if tag != "" {
		paragraph.AppendChild(&ast.Node{
			Type:                ast.NodeTextMark,
			TextMarkTextContent: tag,
			TextMarkType:        "tag",
		})
	}
	if err := model.PerformTxSync(&model.Transaction{
		Notebook: model.TransactionNotebookForBox(notebookID),
		DoOperations: []*model.Operation{{
			Action: "create",
			Data:   tree,
		}},
	}); err != nil {
		t.Fatalf("create discovery tree %s/%s: %v", notebookID, documentID, err)
	}
}

func serveEnterpriseDiscoveryRequest(
	router *gin.Engine,
	path string,
	payload any,
) *httptest.ResponseRecorder {
	body, err := json.Marshal(payload)
	if err != nil {
		panic(err)
	}
	request := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	return response
}
