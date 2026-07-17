// SiYuan - Refactor your thinking
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

package model

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/88250/lute/ast"
	"github.com/siyuan-note/siyuan/kernel/cache"
	"github.com/siyuan-note/siyuan/kernel/conf"
	"github.com/siyuan-note/siyuan/kernel/filesys"
	kernelsql "github.com/siyuan-note/siyuan/kernel/sql"
	"github.com/siyuan-note/siyuan/kernel/treenode"
	"github.com/siyuan-note/siyuan/kernel/util"
)

type headingNotebookFixture struct {
	ordinaryBox      string
	otherOrdinaryBox string
	encryptedBox     string
	headingID        string
	ordinaryChildID  string
	encryptedChildID string
}

// TestHeadingHelpersRespectExplicitNotebookIdentity 验证标题辅助能力只读取调用方声明的笔记本内容库。
func TestHeadingHelpersRespectExplicitNotebookIdentity(t *testing.T) {
	fixture := setupHeadingNotebookFixture(t)

	t.Run("routes colliding block IDs by notebook", func(t *testing.T) {
		ordinaryIDs, err := GetHeadingChildrenIDsInNotebook(fixture.headingID, fixture.ordinaryBox)
		if err != nil {
			t.Fatalf("load ordinary heading children: %v", err)
		}
		if len(ordinaryIDs) != 1 || ordinaryIDs[0] != fixture.ordinaryChildID {
			t.Fatalf("ordinary heading children = %#v, want [%s]", ordinaryIDs, fixture.ordinaryChildID)
		}

		encryptedIDs, err := GetHeadingChildrenIDsInNotebook(fixture.headingID, fixture.encryptedBox)
		if err != nil {
			t.Fatalf("load encrypted heading children: %v", err)
		}
		if len(encryptedIDs) != 1 || encryptedIDs[0] != fixture.encryptedChildID {
			t.Fatalf("encrypted heading children = %#v, want [%s]", encryptedIDs, fixture.encryptedChildID)
		}

		ordinaryDOM, err := GetHeadingChildrenDOMInNotebook(fixture.headingID, fixture.ordinaryBox, true)
		if err != nil {
			t.Fatalf("render ordinary heading DOM: %v", err)
		}
		encryptedDOM, err := GetHeadingChildrenDOMInNotebook(fixture.headingID, fixture.encryptedBox, true)
		if err != nil {
			t.Fatalf("render encrypted heading DOM: %v", err)
		}
		if !strings.Contains(ordinaryDOM, "Ordinary child") || strings.Contains(ordinaryDOM, "Encrypted child") {
			t.Fatalf("ordinary heading DOM crossed content stores: %s", ordinaryDOM)
		}
		if !strings.Contains(encryptedDOM, "Encrypted child") || strings.Contains(encryptedDOM, "Ordinary child") {
			t.Fatalf("encrypted heading DOM crossed content stores: %s", encryptedDOM)
		}
	})

	transactionCases := []struct {
		name string
		call func() (*Transaction, error)
	}{
		{name: "delete", call: func() (*Transaction, error) {
			return GetHeadingDeleteTransactionInNotebook(fixture.headingID, fixture.encryptedBox)
		}},
		{name: "insert", call: func() (*Transaction, error) {
			return GetHeadingInsertTransactionInNotebook(fixture.headingID, fixture.encryptedBox)
		}},
		{name: "level", call: func() (*Transaction, error) {
			return GetHeadingLevelTransactionInNotebook(fixture.headingID, fixture.encryptedBox, 3)
		}},
	}
	for _, test := range transactionCases {
		t.Run("encrypted transaction/"+test.name, func(t *testing.T) {
			transaction, callErr := test.call()
			if callErr != nil {
				t.Fatalf("encrypted heading %s transaction: %v", test.name, callErr)
			}
			if transaction == nil || transaction.Notebook != fixture.encryptedBox || len(transaction.DoOperations) == 0 {
				t.Fatalf("encrypted heading %s transaction = %#v", test.name, transaction)
			}
		})
	}

	ordinaryTransactionCases := []struct {
		name string
		call func() (*Transaction, error)
	}{
		{name: "delete", call: func() (*Transaction, error) {
			return GetHeadingDeleteTransactionInNotebook(fixture.headingID, fixture.ordinaryBox)
		}},
		{name: "insert", call: func() (*Transaction, error) {
			return GetHeadingInsertTransactionInNotebook(fixture.headingID, fixture.ordinaryBox)
		}},
		{name: "level", call: func() (*Transaction, error) {
			return GetHeadingLevelTransactionInNotebook(fixture.headingID, fixture.ordinaryBox, 3)
		}},
	}
	for _, test := range ordinaryTransactionCases {
		t.Run("ordinary transaction/"+test.name, func(t *testing.T) {
			transaction, callErr := test.call()
			if callErr != nil {
				t.Fatalf("ordinary heading %s transaction: %v", test.name, callErr)
			}
			if transaction == nil || transaction.Notebook != "" || len(transaction.DoOperations) == 0 {
				t.Fatalf("ordinary heading %s transaction = %#v, want global content-store identity", test.name, transaction)
			}
		})
	}

	mismatchCases := []struct {
		name string
		call func() error
	}{
		{name: "children ids", call: func() error {
			_, callErr := GetHeadingChildrenIDsInNotebook(fixture.headingID, fixture.otherOrdinaryBox)
			return callErr
		}},
		{name: "children DOM", call: func() error {
			_, callErr := GetHeadingChildrenDOMInNotebook(fixture.headingID, fixture.otherOrdinaryBox, true)
			return callErr
		}},
		{name: "delete", call: func() error {
			_, callErr := GetHeadingDeleteTransactionInNotebook(fixture.headingID, fixture.otherOrdinaryBox)
			return callErr
		}},
		{name: "insert", call: func() error {
			_, callErr := GetHeadingInsertTransactionInNotebook(fixture.headingID, fixture.otherOrdinaryBox)
			return callErr
		}},
		{name: "level", call: func() error {
			_, callErr := GetHeadingLevelTransactionInNotebook(fixture.headingID, fixture.otherOrdinaryBox, 3)
			return callErr
		}},
	}
	for _, test := range mismatchCases {
		t.Run("mismatch/"+test.name, func(t *testing.T) {
			if callErr := test.call(); !errors.Is(callErr, ErrBlockNotFound) {
				t.Fatalf("block/notebook mismatch error = %v, want ErrBlockNotFound", callErr)
			}
		})
	}

	t.Run("missing notebook", func(t *testing.T) {
		if _, err := GetHeadingChildrenIDsInNotebook(fixture.headingID, "20990101120003-missing"); !errors.Is(err, ErrBoxNotFound) {
			t.Fatalf("missing notebook error = %v, want ErrBoxNotFound", err)
		}
	})

	t.Run("locked encrypted notebook", func(t *testing.T) {
		cachedDEKsLock.Lock()
		if cached := cachedDEKs[fixture.encryptedBox]; cached != nil {
			clear(cached)
		}
		delete(cachedDEKs, fixture.encryptedBox)
		cachedDEKsLock.Unlock()
		if _, err := GetHeadingChildrenIDsInNotebook(fixture.headingID, fixture.encryptedBox); err == nil {
			t.Fatal("locked encrypted notebook was read by heading helper")
		}
	})
}

func setupHeadingNotebookFixture(t *testing.T) headingNotebookFixture {
	t.Helper()
	fixture := headingNotebookFixture{
		ordinaryBox:      "20990101120000-normal1",
		otherOrdinaryBox: "20990101120001-normal2",
		encryptedBox:     "20990101120002-encrypt",
		headingID:        "20990101120200-heading",
		ordinaryChildID:  "20990101120300-ordchld",
		encryptedChildID: "20990101120301-encchld",
	}

	originalDataDir := util.DataDir
	originalTempDir := util.TempDir
	originalBlockTreeDBPath := util.BlockTreeDBPath
	originalConf := Conf
	tempRoot := t.TempDir()
	util.DataDir = filepath.Join(tempRoot, "data")
	util.TempDir = filepath.Join(tempRoot, "temp")
	util.BlockTreeDBPath = filepath.Join(util.TempDir, "blocktree.db")
	if err := os.MkdirAll(util.DataDir, 0755); err != nil {
		t.Fatalf("create data directory: %v", err)
	}
	if err := os.MkdirAll(util.TempDir, 0755); err != nil {
		t.Fatalf("create temp directory: %v", err)
	}
	Conf = NewAppConf()
	Conf.FileTree = conf.NewFileTree()
	cache.ClearTreeCache()
	t.Cleanup(func() {
		kernelsql.CloseEncryptedDB(fixture.encryptedBox)
		treenode.CloseEncryptedBlockTreeDB(fixture.encryptedBox)
		treenode.CloseDatabase()
		cachedDEKsLock.Lock()
		if cached := cachedDEKs[fixture.encryptedBox]; cached != nil {
			clear(cached)
			delete(cachedDEKs, fixture.encryptedBox)
		}
		cachedDEKsLock.Unlock()
		cache.ClearTreeCache()
		Conf = originalConf
		util.BlockTreeDBPath = originalBlockTreeDBPath
		util.TempDir = originalTempDir
		util.DataDir = originalDataDir
	})
	treenode.InitBlockTree(true)

	for boxID, encrypted := range map[string]bool{
		fixture.ordinaryBox:      false,
		fixture.otherOrdinaryBox: false,
		fixture.encryptedBox:     true,
	} {
		boxConf := conf.NewBoxConf()
		boxConf.Name = boxID
		boxConf.Encrypted = encrypted
		if err := (&Box{ID: boxID}).SaveConf(boxConf); err != nil {
			t.Fatalf("save notebook config %s: %v", boxID, err)
		}
	}

	dek, err := util.GenerateDEK()
	if err != nil {
		t.Fatalf("generate encrypted notebook key: %v", err)
	}
	if err = kernelsql.OpenEncryptedDB(fixture.encryptedBox, dek); err != nil {
		t.Fatalf("open encrypted content database: %v", err)
	}
	if err = treenode.OpenEncryptedBlockTreeDB(fixture.encryptedBox, dek); err != nil {
		t.Fatalf("open encrypted blocktree database: %v", err)
	}
	cachedDEKsLock.Lock()
	cachedDEKs[fixture.encryptedBox] = append([]byte(nil), dek...)
	cachedDEKsLock.Unlock()
	clear(dek)

	writeHeadingTreeFixture(t, fixture.ordinaryBox, "20990101120100-ordroot", fixture.headingID,
		fixture.ordinaryChildID, "Ordinary heading", "Ordinary child")
	writeHeadingTreeFixture(t, fixture.encryptedBox, "20990101120101-encroot", fixture.headingID,
		fixture.encryptedChildID, "Encrypted heading", "Encrypted child")

	return fixture
}

func writeHeadingTreeFixture(t *testing.T, boxID, rootID, headingID, childID, headingText, childText string) {
	t.Helper()
	path := "/" + rootID + ".sy"
	tree := treenode.NewTree(boxID, path, "/"+headingText, headingText)
	tree.Root.FirstChild.Unlink()
	tree.Root.ID = rootID
	tree.ID = rootID
	tree.Root.SetIALAttr("id", rootID)

	heading := &ast.Node{Type: ast.NodeHeading, ID: headingID, Box: boxID, Path: path, HeadingLevel: 2}
	heading.SetIALAttr("id", headingID)
	heading.SetIALAttr("updated", headingID[:14])
	heading.AppendChild(&ast.Node{Type: ast.NodeText, Tokens: []byte(headingText)})
	child := &ast.Node{Type: ast.NodeParagraph, ID: childID, Box: boxID, Path: path}
	child.SetIALAttr("id", childID)
	child.SetIALAttr("updated", childID[:14])
	child.AppendChild(&ast.Node{Type: ast.NodeText, Tokens: []byte(childText)})
	tree.Root.AppendChild(heading)
	tree.Root.AppendChild(child)

	if _, err := filesys.WriteTree(tree); err != nil {
		t.Fatalf("write heading tree %s: %v", boxID, err)
	}
	if err := treenode.UpsertBlockTree(tree); err != nil {
		t.Fatalf("index heading tree %s: %v", boxID, err)
	}
	contentStore := ""
	if IsEncryptedBox(boxID) {
		contentStore = boxID
	}
	if blockTree := treenode.GetBlockTreeInBox(headingID, contentStore); blockTree == nil {
		t.Fatalf("index heading tree %s", boxID)
	}
}
