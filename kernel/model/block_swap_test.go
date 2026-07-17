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
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/88250/lute/ast"
	"github.com/88250/lute/parse"
	"github.com/siyuan-note/siyuan/kernel/filesys"
	kernelsql "github.com/siyuan-note/siyuan/kernel/sql"
	"github.com/siyuan-note/siyuan/kernel/treenode"
	"github.com/siyuan-note/siyuan/kernel/util"
)

func TestEncryptedSwapBlockRefCommitsOnlyDeclaredStore(t *testing.T) {
	fixture := setupDerivedContentStoreFixture(t)
	const (
		rootID = "20990717020000-swaprot"
		refID  = "20990717020001-swapref"
		defID  = "20990717020002-swapdef"
	)
	target := writeEncryptedSwapTree(t, fixture.boxA, rootID, refID, defID, "Target")
	other := writeEncryptedSwapTree(t, fixture.boxB, rootID, refID, defID, "Other")
	if err := kernelsql.FlushQueue(); err != nil {
		t.Fatalf("flush encrypted swap fixtures: %v", err)
	}
	otherPath := transactionTreeFilePath(other)
	otherBefore, err := os.ReadFile(otherPath)
	if err != nil {
		t.Fatalf("read other encrypted tree before swap: %v", err)
	}
	otherRefBefore := kernelsql.GetBlockInBox(refID, fixture.boxB)
	otherDefBefore := kernelsql.GetBlockInBox(defID, fixture.boxB)

	if err = SwapBlockRefInBox(refID, defID, false, fixture.boxA); err != nil {
		t.Fatalf("swap blocks in encrypted tree: %v", err)
	}
	assertSwapTreeOrder(t, target, defID, refID)
	if targetRef := kernelsql.GetBlockInBox(refID, fixture.boxA); targetRef == nil || targetRef.Box != fixture.boxA {
		t.Fatalf("target reference SQL row = %#v", targetRef)
	}
	if targetDef := kernelsql.GetBlockInBox(defID, fixture.boxA); targetDef == nil || targetDef.Box != fixture.boxA {
		t.Fatalf("target definition SQL row = %#v", targetDef)
	}

	otherAfter, err := os.ReadFile(otherPath)
	if err != nil {
		t.Fatalf("read other encrypted tree after swap: %v", err)
	}
	if !bytes.Equal(otherAfter, otherBefore) {
		t.Fatal("encrypted swap rewrote the colliding tree in another notebook")
	}
	if !reflect.DeepEqual(kernelsql.GetBlockInBox(refID, fixture.boxB), otherRefBefore) ||
		!reflect.DeepEqual(kernelsql.GetBlockInBox(defID, fixture.boxB), otherDefBefore) {
		t.Fatal("encrypted swap changed SQL rows in another notebook")
	}
	assertSwapTreeOrder(t, other, refID, defID)
}

func TestEncryptedSwapBlockRefRejectsCrossTreeBeforePersistentChanges(t *testing.T) {
	fixture := setupDerivedContentStoreFixture(t)
	const (
		refRootID = "20990717020100-swproot"
		refID     = "20990717020101-swprefx"
		defRootID = "20990717020102-swpdest"
		defID     = "20990717020103-swpdefx"
	)
	refTree := writeEncryptedSwapTree(t, fixture.boxA, refRootID, refID, "", "Reference")
	defTree := writeEncryptedSwapTree(t, fixture.boxA, defRootID, defID, "", "Definition")
	if err := kernelsql.FlushQueue(); err != nil {
		t.Fatalf("flush cross-tree swap fixtures: %v", err)
	}

	paths := []string{transactionTreeFilePath(refTree), transactionTreeFilePath(defTree)}
	beforeFiles := make([][]byte, len(paths))
	for i, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read cross-tree fixture %s: %v", path, err)
		}
		beforeFiles[i] = data
	}
	beforeRefBlockTree := treenode.GetBlockTreeInBox(refID, fixture.boxA)
	beforeDefBlockTree := treenode.GetBlockTreeInBox(defID, fixture.boxA)
	beforeRefSQL := kernelsql.GetBlockInBox(refID, fixture.boxA)
	beforeDefSQL := kernelsql.GetBlockInBox(defID, fixture.boxA)
	queuePath := filepath.Join(util.QueueDir, "index.queue")
	beforeQueue, err := readOptionalTransactionFile(queuePath)
	if err != nil {
		t.Fatalf("read queue before rejected cross-tree swap: %v", err)
	}

	err = SwapBlockRefInBox(refID, defID, false, fixture.boxA)
	if !errors.Is(err, ErrEncryptedCrossTreeSwap) {
		t.Fatalf("cross-tree encrypted swap error = %v, want %v", err, ErrEncryptedCrossTreeSwap)
	}
	for i, path := range paths {
		after, readErr := os.ReadFile(path)
		if readErr != nil {
			t.Fatalf("read cross-tree fixture after rejection %s: %v", path, readErr)
		}
		if !bytes.Equal(after, beforeFiles[i]) {
			t.Fatalf("rejected cross-tree swap rewrote %s", path)
		}
	}
	if !reflect.DeepEqual(treenode.GetBlockTreeInBox(refID, fixture.boxA), beforeRefBlockTree) ||
		!reflect.DeepEqual(treenode.GetBlockTreeInBox(defID, fixture.boxA), beforeDefBlockTree) {
		t.Fatal("rejected cross-tree swap changed blocktree state")
	}
	if !reflect.DeepEqual(kernelsql.GetBlockInBox(refID, fixture.boxA), beforeRefSQL) ||
		!reflect.DeepEqual(kernelsql.GetBlockInBox(defID, fixture.boxA), beforeDefSQL) {
		t.Fatal("rejected cross-tree swap changed SQL state")
	}
	afterQueue, err := readOptionalTransactionFile(queuePath)
	if err != nil {
		t.Fatalf("read queue after rejected cross-tree swap: %v", err)
	}
	if !bytes.Equal(afterQueue, beforeQueue) {
		t.Fatal("rejected cross-tree swap changed durable queue")
	}
}

func writeEncryptedSwapTree(t *testing.T, boxID, rootID, firstID, secondID, label string) *parse.Tree {
	t.Helper()
	path := "/" + rootID + ".sy"
	tree := treenode.NewTree(boxID, path, "/"+label, label)
	tree.Root.FirstChild.Unlink()
	tree.ID = rootID
	tree.Root.ID = rootID
	tree.Root.Box = boxID
	tree.Root.Path = path
	tree.Root.SetIALAttr("id", rootID)
	for _, block := range []struct {
		id      string
		content string
	}{{firstID, label + " first"}, {secondID, label + " second"}} {
		if block.id == "" {
			continue
		}
		node := &ast.Node{Type: ast.NodeParagraph, ID: block.id, Box: boxID, Path: path}
		node.SetIALAttr("id", block.id)
		node.SetIALAttr("updated", block.id[:14])
		node.AppendChild(&ast.Node{Type: ast.NodeText, Tokens: []byte(block.content)})
		tree.Root.AppendChild(node)
	}
	if _, err := filesys.WriteTree(tree); err != nil {
		t.Fatalf("write encrypted swap tree [%s/%s]: %v", boxID, rootID, err)
	}
	if err := treenode.UpsertBlockTree(tree); err != nil {
		t.Fatalf("index encrypted swap blocktree [%s/%s]: %v", boxID, rootID, err)
	}
	if err := kernelsql.UpsertTreeQueue(tree); err != nil {
		t.Fatalf("queue encrypted swap tree [%s/%s]: %v", boxID, rootID, err)
	}
	return tree
}

func assertSwapTreeOrder(t *testing.T, tree *parse.Tree, firstID, secondID string) {
	t.Helper()
	loaded, err := filesys.LoadTree(tree.Box, tree.Path, util.NewLute())
	if err != nil {
		t.Fatalf("load encrypted swap tree [%s/%s]: %v", tree.Box, tree.ID, err)
	}
	if loaded.Root.FirstChild == nil || loaded.Root.FirstChild.ID != firstID ||
		loaded.Root.FirstChild.Next == nil || loaded.Root.FirstChild.Next.ID != secondID {
		var ids []string
		for node := loaded.Root.FirstChild; node != nil; node = node.Next {
			ids = append(ids, node.ID)
		}
		t.Fatalf("encrypted swap tree order = %s, want [%s %s]", strings.Join(ids, " "), firstID, secondID)
	}
}

func transactionTreeFilePath(tree *parse.Tree) string {
	return filepath.Join(util.DataDir, tree.Box, filepath.FromSlash(strings.TrimPrefix(tree.Path, "/")))
}
