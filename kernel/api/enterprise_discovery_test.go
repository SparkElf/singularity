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
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/88250/lute/ast"
	"github.com/gin-gonic/gin"
	kernelconf "github.com/siyuan-note/siyuan/kernel/conf"
	"github.com/siyuan-note/siyuan/kernel/model"
	"github.com/siyuan-note/siyuan/kernel/treenode"
)

func TestEnterpriseDiscoveryReturnsMinimalExplicitSpaceIdentities(t *testing.T) {
	setupEncryptedResponseTest(t, 0)
	model.Conf.Graph = kernelconf.NewGraph()
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
		map[string]any{"query": ""},
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

func TestEnterpriseDiscoveryDocumentProjectionKeepsSourceIdentities(t *testing.T) {
	contentNode := &model.GraphNode{
		Box:        "20990719160000-dscbox1",
		DocumentID: "20990719160001-dscdoc1",
		ID:         "20990719160002-dscblk1",
		Label:      "Knowledge",
	}
	tagNode := &model.GraphNode{ID: "knowledge/tag", Label: "knowledge/tag"}
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
		Box:   contentNode.Box,
		HPath: "/Knowledge",
		ID:    contentNode.DocumentID,
	}})
	if len(backlinks) != 1 || backlinks[0].DocumentID != contentNode.DocumentID || backlinks[0].NotebookID != contentNode.Box {
		t.Fatalf("backlink projection = %#v, want source identities", backlinks)
	}
}

func enterpriseDiscoveryTestRouter(t *testing.T) *gin.Engine {
	t.Helper()
	previousMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(previousMode) })
	router := gin.New()
	router.POST("/internal/enterprise/discovery/search", EnterpriseSearchSpace)
	router.POST("/internal/enterprise/discovery/graph", EnterpriseReadSpaceGraph)
	return router
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
