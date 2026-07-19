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
	"io"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/siyuan-note/logging"
	"github.com/siyuan-note/siyuan/kernel/model"
	"github.com/siyuan-note/siyuan/kernel/serviceauth"
	nethtml "golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

const (
	enterpriseDiscoveryRequestMaxBytes    = 4096
	enterpriseDiscoveryQueryMaxRunes      = 512
	enterpriseDiscoveryContentMaxRunes    = 4096
	enterpriseDiscoveryGraphLabelMaxRunes = 512
	enterpriseDiscoveryPageSize           = 64
	enterpriseDiscoveryGraphMaxNodes      = 2048
	enterpriseDiscoveryGraphMaxLinks      = 4096
)

type enterpriseDiscoverySearchRequest struct {
	Method string  `json:"method"`
	Query  *string `json:"query"`
}

type enterpriseDiscoveryGraphRequest struct {
	Query *string `json:"query"`
}

type enterpriseDiscoveryBlock struct {
	Content    string `json:"content"`
	DocumentID string `json:"documentId"`
	ID         string `json:"id"`
	NotebookID string `json:"notebookId"`
}

type enterpriseDiscoverySearchResponse struct {
	Blocks            []enterpriseDiscoveryBlock `json:"blocks"`
	MatchedBlockCount int                        `json:"matchedBlockCount"`
	PageCount         int                        `json:"pageCount"`
}

type enterpriseDiscoveryGraphNode struct {
	DocumentID string `json:"documentId"`
	ID         string `json:"id"`
	Label      string `json:"label"`
	NotebookID string `json:"notebookId"`
}

type enterpriseDiscoveryGraphLink struct {
	From string `json:"from"`
	To   string `json:"to"`
}

type enterpriseDiscoveryGraphResponse struct {
	Links []enterpriseDiscoveryGraphLink `json:"links"`
	Nodes []enterpriseDiscoveryGraphNode `json:"nodes"`
}

type enterpriseDiscoveryDocumentScope struct {
	DocumentID string
	NotebookID string
	Path       string
}

type enterpriseDiscoveryBacklink struct {
	DocumentID string `json:"documentId"`
	NotebookID string `json:"notebookId"`
	Title      string `json:"title"`
}

type enterpriseDiscoveryLocalGraphNode struct {
	DocumentID *string `json:"documentId"`
	ID         string  `json:"id"`
	Label      string  `json:"label"`
	NotebookID *string `json:"notebookId"`
}

type enterpriseDiscoveryOutlineItem struct {
	Children []enterpriseDiscoveryOutlineItem `json:"children"`
	ID       string                           `json:"id"`
	Name     string                           `json:"name"`
}

// enterpriseDiscoveryHTMLText 将旧 Kernel 返回的 HTML 片段收敛为 React 使用的纯文本。
func enterpriseDiscoveryHTMLText(value string) string {
	if strings.TrimSpace(value) == "" {
		return ""
	}
	nodes, err := nethtml.ParseFragment(strings.NewReader(value), &nethtml.Node{
		Data:     "div",
		DataAtom: atom.Div,
		Type:     nethtml.ElementNode,
	})
	if err != nil {
		return ""
	}
	var text strings.Builder
	var walk func(*nethtml.Node)
	walk = func(node *nethtml.Node) {
		if node.Type == nethtml.TextNode {
			text.WriteString(node.Data)
			return
		}
		if node.Type == nethtml.ElementNode && node.Data == "img" {
			for _, attr := range node.Attr {
				if attr.Key == "alt" {
					text.WriteString(attr.Val)
					break
				}
			}
			return
		}
		if node.Type == nethtml.ElementNode && node.Data == "br" {
			text.WriteByte('\n')
			return
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			walk(child)
		}
	}
	for _, node := range nodes {
		walk(node)
	}
	return strings.TrimSpace(text.String())
}

// GraphNode 对文档、标题和标签使用 Label，对其他内容块使用 Title。
func enterpriseDiscoveryGraphDisplayText(node *model.GraphNode) string {
	if label := strings.TrimSpace(node.Label); label != "" {
		return label
	}
	return strings.TrimSpace(node.Title)
}

func enterpriseDiscoveryOutlineProjections(paths []*model.Path) []enterpriseDiscoveryOutlineItem {
	ret := make([]enterpriseDiscoveryOutlineItem, 0, len(paths))
	for _, path := range paths {
		if path == nil || path.ID == "" {
			continue
		}
		ret = append(ret, enterpriseDiscoveryOutlineItem{
			Children: enterpriseDiscoveryOutlineBlockProjections(path.Blocks),
			ID:       path.ID,
			Name: truncateEnterpriseDiscoveryText(
				enterpriseDiscoveryHTMLText(path.Name),
				enterpriseDiscoveryGraphLabelMaxRunes,
			),
		})
	}
	return ret
}

func enterpriseDiscoveryOutlineBlockProjections(blocks []*model.Block) []enterpriseDiscoveryOutlineItem {
	ret := make([]enterpriseDiscoveryOutlineItem, 0, len(blocks))
	for _, block := range blocks {
		if block == nil || block.ID == "" {
			continue
		}
		ret = append(ret, enterpriseDiscoveryOutlineItem{
			Children: enterpriseDiscoveryOutlineBlockProjections(block.Children),
			ID:       block.ID,
			Name: truncateEnterpriseDiscoveryText(
				enterpriseDiscoveryHTMLText(block.Content),
				enterpriseDiscoveryGraphLabelMaxRunes,
			),
		})
	}
	return ret
}

func enterpriseDiscoveryBlockProjections(blocks []*model.Block) []enterpriseDiscoveryBlock {
	ret := make([]enterpriseDiscoveryBlock, 0, len(blocks))
	for _, block := range blocks {
		if block == nil || block.ID == "" || block.Box == "" || block.RootID == "" {
			continue
		}
		content := block.Content
		if content == "" {
			content = block.FContent
		}
		content = enterpriseDiscoveryHTMLText(content)
		ret = append(ret, enterpriseDiscoveryBlock{
			Content:    truncateEnterpriseDiscoveryText(content, enterpriseDiscoveryContentMaxRunes),
			DocumentID: block.RootID,
			ID:         block.ID,
			NotebookID: block.Box,
		})
	}
	return ret
}

func enterpriseDiscoveryBacklinkProjections(paths []*model.Path) []enterpriseDiscoveryBacklink {
	ret := make([]enterpriseDiscoveryBacklink, 0, len(paths))
	for _, path := range paths {
		if path == nil || path.ID == "" || path.Box == "" {
			continue
		}
		title := enterpriseDiscoveryHTMLText(path.Name)
		if title == "" {
			continue
		}
		ret = append(ret, enterpriseDiscoveryBacklink{
			DocumentID: path.ID,
			NotebookID: path.Box,
			Title:      truncateEnterpriseDiscoveryText(title, enterpriseDiscoveryGraphLabelMaxRunes),
		})
	}
	return ret
}

func enterpriseDiscoveryLocalGraphProjections(nodes []*model.GraphNode) []enterpriseDiscoveryLocalGraphNode {
	ret := make([]enterpriseDiscoveryLocalGraphNode, 0, min(len(nodes), enterpriseDiscoveryGraphMaxNodes))
	for _, node := range nodes {
		if node == nil || node.ID == "" {
			continue
		}
		if utf8.RuneCountInString(node.ID) > enterpriseDiscoveryGraphLabelMaxRunes {
			continue
		}
		if len(ret) == enterpriseDiscoveryGraphMaxNodes {
			break
		}
		label := enterpriseDiscoveryHTMLText(enterpriseDiscoveryGraphDisplayText(node))
		if label == "" {
			continue
		}
		projected := enterpriseDiscoveryLocalGraphNode{
			ID:    node.ID,
			Label: truncateEnterpriseDiscoveryText(label, enterpriseDiscoveryGraphLabelMaxRunes),
		}
		if node.DocumentID != "" && node.Box != "" {
			documentID := node.DocumentID
			notebookID := node.Box
			projected.DocumentID = &documentID
			projected.NotebookID = &notebookID
		}
		ret = append(ret, projected)
	}
	return ret
}

func enterpriseDiscoveryGraphLinkProjections(links []*model.GraphLink, nodes []enterpriseDiscoveryLocalGraphNode) []enterpriseDiscoveryGraphLink {
	ret := make([]enterpriseDiscoveryGraphLink, 0, min(len(links), enterpriseDiscoveryGraphMaxLinks))
	projectedNodeIDs := make(map[string]struct{}, len(nodes))
	for _, node := range nodes {
		projectedNodeIDs[node.ID] = struct{}{}
	}
	for _, link := range links {
		if link == nil || link.From == "" || link.To == "" {
			continue
		}
		if utf8.RuneCountInString(link.From) > enterpriseDiscoveryGraphLabelMaxRunes || utf8.RuneCountInString(link.To) > enterpriseDiscoveryGraphLabelMaxRunes {
			continue
		}
		if _, ok := projectedNodeIDs[link.From]; !ok {
			continue
		}
		if _, ok := projectedNodeIDs[link.To]; !ok {
			continue
		}
		if len(ret) == enterpriseDiscoveryGraphMaxLinks {
			break
		}
		ret = append(ret, enterpriseDiscoveryGraphLink{
			From: link.From,
			To:   link.To,
		})
	}
	return ret
}

// enterpriseDiscoveryDocumentScopeFromRequest只消费serviceauth已经解析的身份，不重复解析请求头或从请求体推断文档；
// 请求体只与声明身份比对。
func enterpriseDiscoveryDocumentScopeFromRequest(c *gin.Context, arg map[string]any, bodyID string) (enterpriseDiscoveryDocumentScope, bool, bool) {
	identity, enterprise := serviceauth.RequestContentIdentity(c.Request)
	if !enterprise {
		return enterpriseDiscoveryDocumentScope{}, false, true
	}
	if bodyID != "" {
		value, ok := arg[bodyID].(string)
		if !ok || value != identity.DocumentID {
			return enterpriseDiscoveryDocumentScope{}, true, false
		}
	}
	notebookID, err := declaredEnterpriseNotebook(c, arg, identity.NotebookID)
	if err != nil {
		return enterpriseDiscoveryDocumentScope{}, true, false
	}
	tree, err := model.LoadTreeByBlockIDInBox(identity.DocumentID, notebookID)
	if err != nil || tree == nil || tree.ID != identity.DocumentID || tree.Root == nil || tree.Root.ID != identity.DocumentID || tree.Box != identity.NotebookID {
		return enterpriseDiscoveryDocumentScope{}, true, false
	}
	return enterpriseDiscoveryDocumentScope{
		DocumentID: identity.DocumentID,
		NotebookID: notebookID,
		Path:       tree.Path,
	}, true, true
}

func enterpriseDiscoveryBoxID(notebookID string) string {
	if model.IsEncryptedBox(notebookID) {
		return notebookID
	}
	return ""
}

func EnterpriseSearchSpace(c *gin.Context) {
	request := &enterpriseDiscoverySearchRequest{}
	if !bindEnterpriseDiscoveryJSON(c, request) || request.Query == nil ||
		(request.Method != "keyword" && request.Method != "preferred") ||
		utf8.RuneCountInString(*request.Query) > enterpriseDiscoveryQueryMaxRunes {
		c.AbortWithStatus(http.StatusBadRequest)
		return
	}
	blocks, matchedBlockCount, _, pageCount, _ := model.FullTextSearchBlock(
		*request.Query,
		nil,
		nil,
		map[string]bool{},
		map[string]bool{},
		0,
		7,
		0,
		1,
		enterpriseDiscoveryPageSize,
	)
	projection := enterpriseDiscoveryBlockProjections(blocks)
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, enterpriseDiscoverySearchResponse{
		Blocks:            projection,
		MatchedBlockCount: matchedBlockCount,
		PageCount:         pageCount,
	})
	logEnterpriseDiscovery(c, "search", len(projection))
}

func EnterpriseReadSpaceGraph(c *gin.Context) {
	request := &enterpriseDiscoveryGraphRequest{}
	if !bindEnterpriseDiscoveryJSON(c, request) || request.Query == nil ||
		utf8.RuneCountInString(*request.Query) > enterpriseDiscoveryQueryMaxRunes {
		c.AbortWithStatus(http.StatusBadRequest)
		return
	}
	_, nodes, links := model.BuildGraph(*request.Query)
	projectionNodes := make([]enterpriseDiscoveryGraphNode, 0, min(len(nodes), enterpriseDiscoveryGraphMaxNodes))
	navigable := make(map[string]struct{}, len(nodes))
	for _, node := range nodes {
		if node.DocumentID == "" || node.Box == "" {
			continue
		}
		if len(projectionNodes) == enterpriseDiscoveryGraphMaxNodes {
			break
		}
		label := enterpriseDiscoveryHTMLText(enterpriseDiscoveryGraphDisplayText(node))
		if label == "" {
			continue
		}
		projectionNodes = append(projectionNodes, enterpriseDiscoveryGraphNode{
			DocumentID: node.DocumentID,
			ID:         node.ID,
			Label:      truncateEnterpriseDiscoveryText(label, enterpriseDiscoveryGraphLabelMaxRunes),
			NotebookID: node.Box,
		})
		navigable[node.ID] = struct{}{}
	}
	projectionLinks := make([]enterpriseDiscoveryGraphLink, 0, len(links))
	for _, link := range links {
		if len(projectionLinks) == enterpriseDiscoveryGraphMaxLinks {
			break
		}
		_, fromNavigable := navigable[link.From]
		_, toNavigable := navigable[link.To]
		if fromNavigable && toNavigable {
			projectionLinks = append(projectionLinks, enterpriseDiscoveryGraphLink{
				From: link.From,
				To:   link.To,
			})
		}
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, enterpriseDiscoveryGraphResponse{
		Links: projectionLinks,
		Nodes: projectionNodes,
	})
	logEnterpriseDiscovery(c, "graph", len(projectionNodes))
}

func bindEnterpriseDiscoveryJSON(c *gin.Context, target any) bool {
	body, err := io.ReadAll(io.LimitReader(c.Request.Body, enterpriseDiscoveryRequestMaxBytes+1))
	if err != nil || len(body) > enterpriseDiscoveryRequestMaxBytes {
		return false
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(target); err != nil {
		return false
	}
	return decoder.Decode(&struct{}{}) == io.EOF
}

func truncateEnterpriseDiscoveryText(value string, maximumRunes int) string {
	if utf8.RuneCountInString(value) <= maximumRunes {
		return value
	}
	return string([]rune(value)[:maximumRunes])
}

func logEnterpriseDiscovery(c *gin.Context, operation string, resultCount int) {
	logging.LogInfof(
		"content.discovery [requestId=%s, operation=%s, resultCount=%d, outcome=succeeded]",
		c.GetHeader(serviceauth.RequestIDHeader),
		operation,
		resultCount,
	)
}
