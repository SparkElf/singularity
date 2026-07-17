// SiYuan - Refactor your thinking
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

package model

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/88250/lute/ast"
	"github.com/siyuan-note/siyuan/kernel/conf"
	"github.com/siyuan-note/siyuan/kernel/filesys"
	kernelsql "github.com/siyuan-note/siyuan/kernel/sql"
	"github.com/siyuan-note/siyuan/kernel/treenode"
	"github.com/siyuan-note/siyuan/kernel/util"
)

func TestRecentDocPersistencePreservesLegacyAndCompositeIdentity(t *testing.T) {
	originalConf := Conf
	originalDataDir := util.DataDir
	Conf = NewAppConf()
	Conf.FileTree = conf.NewFileTree()
	Conf.FileTree.RecentDocsMaxListCount = 32
	util.DataDir = t.TempDir()
	t.Cleanup(func() {
		Conf = originalConf
		util.DataDir = originalDataDir
	})

	const (
		rootID     = "20260716000000-recentx"
		notebookID = "20260716000001-boxone1"
		otherBoxID = "20260716000002-boxtwo2"
	)
	docs := []*RecentDoc{
		{RootID: rootID, NotebookID: notebookID, Title: "Encrypted title", Icon: "icon"},
		{RootID: rootID, NotebookID: otherBoxID, Title: "Other title", Icon: "other-icon"},
		{RootID: rootID, NotebookID: notebookID},
		{RootID: rootID},
	}
	if err := setRecentDocs(docs); err != nil {
		t.Fatalf("persist recent documents: %v", err)
	}

	stored, err := loadRecentDocsRaw()
	if err != nil {
		t.Fatalf("load persisted recent documents: %v", err)
	}
	if len(stored) != 3 {
		t.Fatalf("persisted recent docs = %d, want two composite identities plus the legacy row", len(stored))
	}
	identities := map[string]bool{}
	for _, doc := range stored {
		identities[recentDocIdentityKey(doc.RootID, doc.NotebookID)] = true
	}
	for _, expected := range []string{
		recentDocIdentityKey(rootID, notebookID),
		recentDocIdentityKey(rootID, otherBoxID),
		recentDocIdentityKey(rootID, ""),
	} {
		if !identities[expected] {
			t.Fatalf("persisted recent document identities = %#v, missing %q", identities, expected)
		}
	}

	data, err := os.ReadFile(filepath.Join(util.DataDir, "storage", "recent-doc.json"))
	if err != nil {
		t.Fatalf("read persisted recent documents: %v", err)
	}
	var payload []map[string]any
	if err = json.Unmarshal(data, &payload); err != nil {
		t.Fatalf("decode persisted recent documents: %v", err)
	}
	legacyFound := false
	for _, doc := range payload {
		if doc["rootID"] != rootID {
			t.Fatalf("recent document identity payload = %#v", doc)
		}
		if _, exists := doc["title"]; exists {
			t.Fatalf("recent document persistence leaked derived title: %#v", doc)
		}
		if _, exists := doc["icon"]; exists {
			t.Fatalf("recent document persistence leaked derived icon: %#v", doc)
		}
		if _, exists := doc["notebookId"]; !exists {
			legacyFound = true
		}
	}
	if !legacyFound {
		t.Fatalf("recent document payload = %#v, want legacy row without notebookId", payload)
	}
}

func TestRecentDocsUpdatedMergeOrdinaryAndEncryptedDuplicateRoot(t *testing.T) {
	fixture := setupHeadingNotebookFixture(t)
	originalDBPath := util.DBPath
	originalHistoryDBPath := util.HistoryDBPath
	originalAssetContentDBPath := util.AssetContentDBPath
	originalQueueDir := util.QueueDir
	originalConfDir := util.ConfDir
	util.DBPath = filepath.Join(util.TempDir, "recent-updated.db")
	util.HistoryDBPath = filepath.Join(util.TempDir, "recent-updated-history.db")
	util.AssetContentDBPath = filepath.Join(util.TempDir, "recent-updated-asset-content.db")
	util.QueueDir = filepath.Join(util.TempDir, "recent-updated-queue")
	util.ConfDir = filepath.Join(util.TempDir, "recent-updated-conf")
	for _, dir := range []string{util.QueueDir, util.ConfDir} {
		if err := os.MkdirAll(dir, 0755); err != nil {
			t.Fatalf("create recent updated test directory %s: %v", dir, err)
		}
	}
	Conf.System = conf.NewSystem()
	Conf.FileTree.RecentDocsMaxListCount = conf.MinFileTreeRecentDocsListCount
	if err := kernelsql.InitDatabase(true); err != nil {
		t.Fatalf("initialize recent updated database: %v", err)
	}
	kernelsql.InitHistoryDatabase(true)
	kernelsql.InitAssetContentDatabase(true)
	t.Cleanup(func() {
		kernelsql.CloseDatabase()
		util.ConfDir = originalConfDir
		util.QueueDir = originalQueueDir
		util.AssetContentDBPath = originalAssetContentDBPath
		util.HistoryDBPath = originalHistoryDBPath
		util.DBPath = originalDBPath
	})

	const rootID = "20990101121000-recents"
	indexUpdatedRecentTree(t, fixture.ordinaryBox, rootID, "Ordinary recent", "ordinary-icon", "20990101121000")
	indexUpdatedRecentTree(t, fixture.encryptedBox, rootID, "Encrypted recent", "encrypted-icon", "20990102121000")
	if err := kernelsql.FlushQueue(); err != nil {
		t.Fatalf("flush recent updated indexes: %v", err)
	}
	for _, contentStore := range []string{"", fixture.encryptedBox} {
		blocks := kernelsql.SelectBlocksRawStmtInBox("SELECT * FROM blocks WHERE type = 'd' ORDER BY updated DESC", 1, 8, contentStore)
		if len(blocks) != 1 || blocks[0].ID != rootID {
			t.Fatalf("indexed document blocks in store %q = %#v, want duplicate root %s", contentStore, blocks, rootID)
		}
		blockTree := treenode.GetBlockTreeInBox(rootID, contentStore)
		if blockTree == nil {
			t.Fatalf("blocktree store %q is missing duplicate root %s", contentStore, rootID)
		}
		if blocks[0].Box != blockTree.BoxID {
			t.Fatalf("store %q SQL notebook %q does not match blocktree notebook %q", contentStore, blocks[0].Box, blockTree.BoxID)
		}
		if contentStore == "" && IsEncryptedBox(blockTree.BoxID) {
			t.Fatalf("ordinary store root resolved to encrypted notebook %q", blockTree.BoxID)
		}
	}

	docs, err := GetRecentDocs("updated")
	if err != nil {
		t.Fatalf("get updated recent documents: %v", err)
	}
	if len(docs) != 2 {
		t.Fatalf("updated recent docs = %#v, want ordinary and encrypted duplicate roots", docs)
	}
	if docs[0].RootID != rootID || docs[0].NotebookID != fixture.encryptedBox || docs[0].Title != "Encrypted recent" || docs[0].Icon != "encrypted-icon" {
		t.Fatalf("newest encrypted recent doc = %#v", docs[0])
	}
	if docs[1].RootID != rootID || docs[1].NotebookID != fixture.ordinaryBox || docs[1].Title != "Ordinary recent" || docs[1].Icon != "ordinary-icon" {
		t.Fatalf("ordinary recent doc = %#v", docs[1])
	}
}

func indexUpdatedRecentTree(t *testing.T, boxID, rootID, title, icon, updated string) {
	t.Helper()
	treePath := "/" + rootID + ".sy"
	tree := treenode.NewTree(boxID, treePath, "/"+title, title)
	tree.Root.FirstChild.Unlink()
	tree.ID = rootID
	tree.Root.ID = rootID
	tree.Root.Box = boxID
	tree.Root.Path = treePath
	tree.Root.SetIALAttr("id", rootID)
	tree.Root.SetIALAttr("title", title)
	tree.Root.SetIALAttr("icon", icon)
	tree.Root.SetIALAttr("updated", updated)
	paragraphID := updated + "-recentx"
	paragraph := &ast.Node{Type: ast.NodeParagraph, ID: paragraphID, Box: boxID, Path: treePath}
	paragraph.SetIALAttr("id", paragraphID)
	paragraph.SetIALAttr("updated", updated)
	paragraph.AppendChild(&ast.Node{Type: ast.NodeText, Tokens: []byte(title)})
	tree.Root.AppendChild(paragraph)
	if _, err := filesys.WriteTree(tree); err != nil {
		t.Fatalf("write recent updated tree for %s: %v", boxID, err)
	}
	if err := treenode.UpsertBlockTree(tree); err != nil {
		t.Fatalf("index recent updated blocktree for %s: %v", boxID, err)
	}
	if err := kernelsql.IndexTreeQueue(tree); err != nil {
		t.Fatalf("index recent updated tree for %s: %v", boxID, err)
	}
}

func TestLegacyRecentDocsMigrateOnlyUniqueOpenedOwnership(t *testing.T) {
	fixture := setupHeadingNotebookFixture(t)
	Conf.FileTree.RecentDocsMaxListCount = conf.MinFileTreeRecentDocsListCount
	ordinary := treenode.GetBlockTreeInBox(fixture.ordinaryChildID, "")
	encrypted := treenode.GetBlockTreeInBox(fixture.encryptedChildID, fixture.encryptedBox)
	if ordinary == nil || encrypted == nil {
		t.Fatal("heading fixture did not initialize both content stores")
	}

	unresolvedID := "20990101120400-missing"
	legacy := []map[string]any{
		{"rootID": ordinary.RootID, "viewedAt": int64(4), "title": "Ordinary title", "icon": "ordinary-icon"},
		{"rootID": encrypted.RootID, "viewedAt": int64(3), "title": "Encrypted title", "icon": "encrypted-icon"},
		{"rootID": fixture.headingID, "viewedAt": int64(2)},
		{"rootID": unresolvedID, "viewedAt": int64(1)},
	}
	data, err := json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	storageDir := filepath.Join(util.DataDir, "storage")
	if err = os.MkdirAll(storageDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(storageDir, "recent-doc.json"), data, 0644); err != nil {
		t.Fatal(err)
	}

	docs, err := GetRecentDocs("viewedAt")
	if err != nil {
		t.Fatalf("migrate legacy recent documents: %v", err)
	}
	if len(docs) != 2 {
		t.Fatalf("visible migrated recent docs = %d, want only two uniquely owned documents", len(docs))
	}
	visible := make(map[string]bool, len(docs))
	for _, doc := range docs {
		visible[recentDocIdentityKey(doc.RootID, doc.NotebookID)] = true
	}
	for _, expected := range []string{
		recentDocIdentityKey(ordinary.RootID, ordinary.BoxID),
		recentDocIdentityKey(encrypted.RootID, encrypted.BoxID),
	} {
		if !visible[expected] {
			t.Fatalf("visible migrated identities = %#v, missing %q", visible, expected)
		}
	}

	stored, err := loadRecentDocsRaw()
	if err != nil {
		t.Fatalf("load migrated recent documents: %v", err)
	}
	if len(stored) != 4 {
		t.Fatalf("stored recent docs = %d, want migrated and pending rows", len(stored))
	}
	pending := map[string]bool{}
	for _, doc := range stored {
		if doc.NotebookID == "" {
			pending[doc.RootID] = true
		}
	}
	if !pending[fixture.headingID] || !pending[unresolvedID] {
		t.Fatalf("pending legacy recent docs = %#v, want ambiguous and unresolved rows", pending)
	}
	persistedData, err := os.ReadFile(filepath.Join(storageDir, "recent-doc.json"))
	if err != nil {
		t.Fatal(err)
	}
	var persistedPayload []map[string]any
	if err = json.Unmarshal(persistedData, &persistedPayload); err != nil {
		t.Fatal(err)
	}
	for _, doc := range persistedPayload {
		if _, exists := doc["title"]; exists {
			t.Fatalf("migrated recent document leaked title to disk: %#v", doc)
		}
		if _, exists := doc["icon"]; exists {
			t.Fatalf("migrated recent document leaked icon to disk: %#v", doc)
		}
	}

	if err = setRecentDocs(stored); err != nil {
		t.Fatalf("persist migrated recent documents again: %v", err)
	}
	roundTrip, err := loadRecentDocsRaw()
	if err != nil {
		t.Fatalf("reload migrated recent documents: %v", err)
	}
	pending = map[string]bool{}
	for _, doc := range roundTrip {
		if doc.NotebookID == "" {
			pending[doc.RootID] = true
		}
	}
	if !pending[fixture.headingID] || !pending[unresolvedID] {
		t.Fatalf("pending legacy rows after round trip = %#v", pending)
	}
}

func TestLegacyRecentDocsWaitUntilEveryEncryptedStoreIsOpened(t *testing.T) {
	fixture := setupHeadingNotebookFixture(t)
	ordinary := treenode.GetBlockTreeInBox(fixture.ordinaryChildID, "")
	if ordinary == nil {
		t.Fatal("heading fixture did not initialize the ordinary content store")
	}
	treenode.CloseEncryptedBlockTreeDB(fixture.encryptedBox)

	data, err := json.Marshal([]map[string]any{{
		"rootID": ordinary.RootID, "viewedAt": int64(1), "title": "Pending title",
	}})
	if err != nil {
		t.Fatal(err)
	}
	storageDir := filepath.Join(util.DataDir, "storage")
	if err = os.MkdirAll(storageDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(storageDir, "recent-doc.json"), data, 0644); err != nil {
		t.Fatal(err)
	}

	docs, err := GetRecentDocs("viewedAt")
	if err != nil {
		t.Fatalf("read pending legacy recent documents: %v", err)
	}
	if len(docs) != 0 {
		t.Fatalf("visible legacy recent docs = %#v, want migration deferred while an encrypted store is locked", docs)
	}
	stored, err := loadRecentDocsRaw()
	if err != nil {
		t.Fatalf("reload pending legacy recent documents: %v", err)
	}
	if len(stored) != 1 || stored[0].RootID != ordinary.RootID || stored[0].NotebookID != "" {
		t.Fatalf("pending legacy recent docs = %#v, want original identity without notebook", stored)
	}
	if stored[0].Title != "" || stored[0].Icon != "" {
		t.Fatalf("pending legacy recent doc persisted derived display fields: %#v", stored[0])
	}
}
