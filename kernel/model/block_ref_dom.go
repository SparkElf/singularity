// SiYuan - Refactor your thinking
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

package model

import (
	"bytes"
	"strings"

	"github.com/siyuan-note/logging"
	"github.com/siyuan-note/siyuan/kernel/treenode"
	nethtml "golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

// FillBlockRefContentIdentities 将渲染后的块引用绑定到目标块树声明的权威内容身份。
// contentStore 为空时查询普通块树库，否则只查询指定加密笔记本的块树库。
func FillBlockRefContentIdentities(dom, contentStore string) string {
	if !strings.Contains(dom, "block-ref") {
		return dom
	}

	context := &nethtml.Node{Type: nethtml.ElementNode, Data: "div", DataAtom: atom.Div}
	nodes, err := nethtml.ParseFragment(strings.NewReader(dom), context)
	if err != nil {
		logging.LogErrorf("parse block DOM before binding block reference content identities failed: %s", err)
		return ""
	}

	var refs []*nethtml.Node
	refIDs := map[string]struct{}{}
	for _, node := range nodes {
		collectBlockRefElements(node, &refs, refIDs)
	}
	if len(refs) == 0 {
		return dom
	}

	ids := make([]string, 0, len(refIDs))
	for id := range refIDs {
		ids = append(ids, id)
	}
	targets, queryErr := treenode.GetBlockTreesInBoxStrict(ids, contentStore)
	if queryErr != nil {
		logging.LogErrorf("resolve block reference content identities in content store [%s] failed: %s", contentStore, queryErr)
	}

	changed := false
	for _, ref := range refs {
		id, _ := htmlAttr(ref, "data-id")
		notebookID := ""
		documentID := ""
		if target := targets[id]; target != nil {
			notebookID = target.BoxID
			documentID = target.RootID
		}
		if setAuthoritativeHTMLAttr(ref, "data-notebook-id", notebookID) {
			changed = true
		}
		if setAuthoritativeHTMLAttr(ref, "data-document-id", documentID) {
			changed = true
		}
	}
	if !changed {
		return dom
	}

	var output bytes.Buffer
	for _, node := range nodes {
		if err = nethtml.Render(&output, node); err != nil {
			logging.LogErrorf("render block DOM after binding block reference notebooks failed: %s", err)
			return ""
		}
	}
	return output.String()
}

// FillTransactionBlockRefContentIdentities 在事务持久化完成后统一生成响应中的块引用身份。
func FillTransactionBlockRefContentIdentities(transactions []*Transaction) {
	for _, transaction := range transactions {
		if transaction == nil {
			continue
		}
		fillOperationBlockRefContentIdentities(transaction.DoOperations, transaction.Notebook)
		fillOperationBlockRefContentIdentities(transaction.UndoOperations, transaction.Notebook)
	}
}

func fillOperationBlockRefContentIdentities(operations []*Operation, contentStore string) {
	for _, operation := range operations {
		if operation == nil {
			continue
		}
		if dom, ok := operation.Data.(string); ok {
			operation.Data = FillBlockRefContentIdentities(dom, contentStore)
		}
		if dom, ok := operation.RetData.(string); ok {
			operation.RetData = FillBlockRefContentIdentities(dom, contentStore)
		}
	}
}

func collectBlockRefElements(node *nethtml.Node, refs *[]*nethtml.Node, refIDs map[string]struct{}) {
	if node.Type == nethtml.ElementNode {
		dataType, _ := htmlAttr(node, "data-type")
		if containsHTMLToken(dataType, "block-ref") {
			id, _ := htmlAttr(node, "data-id")
			*refs = append(*refs, node)
			if id != "" {
				refIDs[id] = struct{}{}
			}
		}
	}
	for child := node.FirstChild; child != nil; child = child.NextSibling {
		collectBlockRefElements(child, refs, refIDs)
	}
}

func containsHTMLToken(value, target string) bool {
	for _, token := range strings.Fields(value) {
		if token == target {
			return true
		}
	}
	return false
}

func htmlAttr(node *nethtml.Node, key string) (string, bool) {
	for _, attr := range node.Attr {
		if attr.Key == key {
			return attr.Val, true
		}
	}
	return "", false
}

func setAuthoritativeHTMLAttr(node *nethtml.Node, key, value string) bool {
	attrs := node.Attr[:0]
	previous := ""
	found := false
	count := 0
	for _, attr := range node.Attr {
		if attr.Key == key {
			count++
			if !found {
				previous = attr.Val
			}
			found = true
			continue
		}
		attrs = append(attrs, attr)
	}
	if value != "" {
		attrs = append(attrs, nethtml.Attribute{Key: key, Val: value})
	}
	node.Attr = attrs
	return found != (value != "") || previous != value || count > 1
}
