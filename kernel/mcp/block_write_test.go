// SiYuan - Refactor your thinking
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

package mcp

import (
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/88250/lute/ast"
	"github.com/gin-gonic/gin"
	kernelapi "github.com/siyuan-note/siyuan/kernel/api"
	"github.com/siyuan-note/siyuan/kernel/cache"
	"github.com/siyuan-note/siyuan/kernel/filesys"
	"github.com/siyuan-note/siyuan/kernel/mcp/tools"
	"github.com/siyuan-note/siyuan/kernel/model"
	"github.com/siyuan-note/siyuan/kernel/treenode"
	"github.com/siyuan-note/siyuan/kernel/util"
)

func TestMCPBlockDeleteTargetsDeclaredContentStore(t *testing.T) {
	encryptedBox, rootID := setupMCPEncryptedExport(t)
	ordinaryBox, err := model.CreateBox("MCP Ordinary Block Contract")
	if err != nil {
		t.Fatalf("create ordinary notebook: %v", err)
	}

	const omittedBlockID = "20990717120002-mcpomit"
	encryptedPath := "/" + rootID + ".sy"
	encryptedTree, err := filesys.LoadTree(encryptedBox, encryptedPath, util.NewLute())
	if err != nil {
		t.Fatalf("load encrypted collision tree: %v", err)
	}
	explicitBlockID := encryptedTree.Root.FirstChild.ID
	omittedEncrypted := &ast.Node{Type: ast.NodeParagraph, ID: omittedBlockID, Box: encryptedBox, Path: encryptedPath}
	omittedEncrypted.SetIALAttr("id", omittedBlockID)
	omittedEncrypted.SetIALAttr("updated", omittedBlockID[:14])
	omittedEncrypted.AppendChild(&ast.Node{Type: ast.NodeText, Tokens: []byte("encrypted omitted target")})
	encryptedTree.Root.AppendChild(omittedEncrypted)
	if _, err = filesys.WriteTree(encryptedTree); err != nil {
		t.Fatalf("write encrypted collision tree: %v", err)
	}
	if err = treenode.UpsertBlockTree(encryptedTree); err != nil {
		t.Fatalf("index encrypted collision tree: %v", err)
	}

	ordinaryTree := treenode.NewTree(ordinaryBox, encryptedPath, "/MCP Ordinary Block Contract", "MCP Ordinary Block Contract")
	ordinaryTree.Root.FirstChild.Unlink()
	ordinaryTree.ID = rootID
	ordinaryTree.Root.ID = rootID
	ordinaryTree.Root.Box = ordinaryBox
	ordinaryTree.Root.Path = encryptedPath
	ordinaryTree.Root.SetIALAttr("id", rootID)
	ordinaryTree.Root.SetIALAttr("updated", rootID[:14])
	for id, content := range map[string]string{
		explicitBlockID: "ordinary explicit target",
		omittedBlockID:  "ordinary omitted target",
	} {
		paragraph := &ast.Node{Type: ast.NodeParagraph, ID: id, Box: ordinaryBox, Path: encryptedPath}
		paragraph.SetIALAttr("id", id)
		paragraph.SetIALAttr("updated", id[:14])
		paragraph.AppendChild(&ast.Node{Type: ast.NodeText, Tokens: []byte(content)})
		ordinaryTree.Root.AppendChild(paragraph)
	}
	if _, err = filesys.WriteTree(ordinaryTree); err != nil {
		t.Fatalf("write ordinary collision tree: %v", err)
	}
	if err = treenode.UpsertBlockTree(ordinaryTree); err != nil {
		t.Fatalf("index ordinary collision tree: %v", err)
	}
	cache.RemoveTreeDataInBox(rootID, "")
	cache.RemoveTreeDataInBox(rootID, encryptedBox)

	router := gin.New()
	router.Use(kernelapi.ContentResponseLifecycle)
	Serve(router)
	callDelete := func(args map[string]any) {
		t.Helper()
		writer := httptest.NewRecorder()
		router.ServeHTTP(writer, newMCPToolCallRequest(t, "block", args))
		result := decodeMCPToolResult(t, writer.Body.Bytes())
		if result.IsError || len(result.Content) != 1 || !strings.Contains(result.Content[0].Text, "block deleted") {
			t.Fatalf("MCP block delete result = %#v, want success", result)
		}
	}

	callDelete(map[string]any{"action": "delete", "id": explicitBlockID, "notebook": encryptedBox})
	if treenode.GetBlockTreeInBox(explicitBlockID, encryptedBox) != nil {
		t.Fatal("explicit encrypted delete left the encrypted block")
	}
	if treenode.GetBlockTreeInBox(explicitBlockID, "") == nil {
		t.Fatal("explicit encrypted delete crossed into the ordinary content store")
	}

	callDelete(map[string]any{"action": "delete", "id": explicitBlockID, "notebook": ordinaryBox})
	if treenode.GetBlockTreeInBox(explicitBlockID, "") != nil {
		t.Fatal("explicit ordinary delete did not use the global content store")
	}

	callDelete(map[string]any{"action": "delete", "id": omittedBlockID})
	if treenode.GetBlockTreeInBox(omittedBlockID, "") != nil {
		t.Fatal("delete without notebook did not use the global content store")
	}
	if treenode.GetBlockTreeInBox(omittedBlockID, encryptedBox) == nil {
		t.Fatal("delete without notebook crossed into the encrypted content store")
	}
}

func TestMCPBlockWritesRejectExplicitInvalidNotebook(t *testing.T) {
	actions := []struct {
		name string
		args map[string]any
	}{
		{name: "insert", args: map[string]any{"action": "insert", "data": "content"}},
		{name: "append", args: map[string]any{"action": "append", "data": "content", "parentID": "20990717120100-parentx"}},
		{name: "prepend", args: map[string]any{"action": "prepend", "data": "content", "parentID": "20990717120100-parentx"}},
		{name: "update", args: map[string]any{"action": "update", "id": "20990717120101-blockxx", "data": "content"}},
		{name: "delete", args: map[string]any{"action": "delete", "id": "20990717120101-blockxx"}},
		{name: "move", args: map[string]any{"action": "move", "id": "20990717120101-blockxx", "parentID": "20990717120100-parentx"}},
	}
	for _, action := range actions {
		t.Run(action.name, func(t *testing.T) {
			action.args["notebook"] = "invalid"
			result, err := tools.BlockTool.Handler(tools.CallContext{}, action.args)
			if err != nil {
				t.Fatalf("MCP block %s returned protocol error: %v", action.name, err)
			}
			if !result.IsError || len(result.Content) != 1 || !strings.Contains(result.Content[0].Text, model.ErrInvalidID.Error()) {
				t.Fatalf("MCP block %s result = %#v, want invalid notebook error", action.name, result)
			}
		})
	}
}
