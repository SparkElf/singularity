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
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"syscall"
	"testing"
	"time"

	"github.com/88250/lute/ast"
	"github.com/88250/lute/parse"
	"github.com/siyuan-note/siyuan/kernel/cache"
	"github.com/siyuan-note/siyuan/kernel/sql"
	"github.com/siyuan-note/siyuan/kernel/treenode"
	"github.com/siyuan-note/siyuan/kernel/util"
)

type contentCommitBlocktreeRow struct {
	ID       string
	RootID   string
	ParentID string
	BoxID    string
	Path     string
	HPath    string
	Updated  string
	Type     string
}

type contentCommitFixture struct {
	boxID      string
	rootID     string
	treePath   string
	queueDir   string
	fileData   []byte
	treeData   []byte
	docIAL     map[string]string
	blocktrees []contentCommitBlocktreeRow
	queueData  []byte
}

func newContentCommitFixture(t *testing.T, boxID, rootID string) *contentCommitFixture {
	t.Helper()
	setupIndexFailureEnvironment(t)
	saveIndexFailureBox(t, boxID, false)
	tree := writeIndexFailureTree(t, boxID, rootID, "Original")
	if _, err := treenode.ReplaceBlockTrees([]*parse.Tree{tree}); err != nil {
		t.Fatalf("seed original blocktrees: %v", err)
	}

	queueSeedID := "20990718019999-queuexx"
	queueSeed := treenode.NewTree(boxID, "/"+queueSeedID+".sy", "/Queue seed", "Queue seed")
	if err := sql.UpsertTreeQueue(queueSeed); err != nil {
		t.Fatalf("seed durable queue: %v", err)
	}

	absPath := filepath.Join(util.DataDir, boxID, rootID+".sy")
	fileData, err := os.ReadFile(absPath)
	if err != nil {
		t.Fatalf("read original tree file: %v", err)
	}
	treeData, docIAL := waitForContentCommitCache(t, rootID, boxID, tree.Path, fileData, map[string]string{"title": "Original"})
	queueData, err := os.ReadFile(filepath.Join(util.QueueDir, "index.queue"))
	if err != nil {
		t.Fatalf("read seeded durable queue: %v", err)
	}
	return &contentCommitFixture{
		boxID:      boxID,
		rootID:     rootID,
		treePath:   tree.Path,
		queueDir:   util.QueueDir,
		fileData:   append([]byte(nil), fileData...),
		treeData:   treeData,
		docIAL:     docIAL,
		blocktrees: snapshotContentCommitBlocktrees(rootID, boxID),
		queueData:  append([]byte(nil), queueData...),
	}
}

func waitForContentCommitCache(t *testing.T, rootID, boxID, treePath string, wantTree []byte, wantIAL map[string]string) ([]byte, map[string]string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		treeData, treeOK := cache.GetTreeDataInBox(rootID, boxID)
		docIAL := cache.GetDocIALInBox(treePath, boxID)
		if treeOK && bytes.Equal(treeData, wantTree) && contentCommitIALContains(docIAL, wantIAL) {
			return append([]byte(nil), treeData...), docIAL
		}
		if time.Now().After(deadline) {
			t.Fatalf("content cache did not converge: tree=%q ial=%#v", treeData, docIAL)
		}
		runtime.Gosched()
	}
}

func waitForContentCommitCacheAbsent(t *testing.T, rootID, boxID, treePath string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		_, treeOK := cache.GetTreeDataInBox(rootID, boxID)
		docIAL := cache.GetDocIALInBox(treePath, boxID)
		if !treeOK && docIAL == nil {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("content cache remained present: root=%s path=%s ial=%#v", rootID, treePath, docIAL)
		}
		runtime.Gosched()
	}
}

func contentCommitIALContains(got, want map[string]string) bool {
	if got == nil {
		return false
	}
	for key, value := range want {
		if got[key] != value {
			return false
		}
	}
	return true
}

func snapshotContentCommitBlocktrees(rootID, boxID string) []contentCommitBlocktreeRow {
	rows := treenode.GetBlockTreesByRootIDInBox(rootID, boxID)
	ret := make([]contentCommitBlocktreeRow, 0, len(rows))
	for _, row := range rows {
		ret = append(ret, contentCommitBlocktreeRow{
			ID: row.ID, RootID: row.RootID, ParentID: row.ParentID, BoxID: row.BoxID,
			Path: row.Path, HPath: row.HPath, Updated: row.Updated, Type: row.Type,
		})
	}
	sort.Slice(ret, func(i, j int) bool {
		if ret[i].RootID != ret[j].RootID {
			return ret[i].RootID < ret[j].RootID
		}
		return ret[i].ID < ret[j].ID
	})
	return ret
}

func assertContentCommitFixtureUnchanged(t *testing.T, fixture *contentCommitFixture) {
	t.Helper()
	absPath := filepath.Join(util.DataDir, fixture.boxID, fixture.rootID+".sy")
	fileData, err := os.ReadFile(absPath)
	if err != nil {
		t.Fatalf("read tree after rejected commit: %v", err)
	}
	if !bytes.Equal(fileData, fixture.fileData) {
		t.Fatal("rejected content commit changed the tree file")
	}
	treeData, docIAL := waitForContentCommitCache(t, fixture.rootID, fixture.boxID, fixture.treePath, fixture.treeData, fixture.docIAL)
	if !bytes.Equal(treeData, fixture.treeData) || !reflect.DeepEqual(docIAL, fixture.docIAL) {
		t.Fatalf("rejected content commit changed caches: tree=%q ial=%#v", treeData, docIAL)
	}
	if got := snapshotContentCommitBlocktrees(fixture.rootID, fixture.boxID); !reflect.DeepEqual(got, fixture.blocktrees) {
		t.Fatalf("rejected content commit changed blocktrees:\n got %#v\nwant %#v", got, fixture.blocktrees)
	}
	queueData, err := os.ReadFile(filepath.Join(fixture.queueDir, "index.queue"))
	if err != nil {
		t.Fatalf("read queue after rejected content commit: %v", err)
	}
	if !bytes.Equal(queueData, fixture.queueData) {
		t.Fatalf("rejected content commit changed durable queue:\n got %s\nwant %s", queueData, fixture.queueData)
	}
}

func assertContentCommitRetry(t *testing.T, fixture *contentCommitFixture, replacement *parse.Tree, action string) {
	t.Helper()
	absPath := filepath.Join(util.DataDir, fixture.boxID, fixture.rootID+".sy")
	fileData, err := os.ReadFile(absPath)
	if err != nil {
		t.Fatalf("read tree after committed retry: %v", err)
	}
	if bytes.Equal(fileData, fixture.fileData) {
		t.Fatal("committed retry did not update the tree file")
	}
	wantIAL := map[string]string{"title": replacement.Root.IALAttr("title")}
	treeData, docIAL := waitForContentCommitCache(t, fixture.rootID, fixture.boxID, fixture.treePath, fileData, wantIAL)
	if !bytes.Equal(treeData, fileData) || !contentCommitIALContains(docIAL, wantIAL) {
		t.Fatalf("committed retry caches do not match the new tree: tree=%q ial=%#v", treeData, docIAL)
	}
	root := treenode.GetBlockTreeInBox(fixture.rootID, fixture.boxID)
	if root == nil || root.HPath != replacement.HPath || root.Path != replacement.Path {
		t.Fatalf("committed retry blocktree = %#v, want path=%q hpath=%q", root, replacement.Path, replacement.HPath)
	}
	if !contentCommitQueueContains(t, fixture.queueDir, action, fixture.boxID, fixture.rootID, fixture.treePath) {
		t.Fatalf("committed retry queue has no %s entry for [%s/%s]", action, fixture.boxID, fixture.rootID)
	}
}

func contentCommitQueueContains(t *testing.T, queueDir, action, boxID, rootID, treePath string) bool {
	t.Helper()
	queueData, err := os.ReadFile(filepath.Join(queueDir, "index.queue"))
	if err != nil {
		t.Fatalf("read durable queue: %v", err)
	}
	for _, line := range bytes.Split(bytes.TrimSpace(queueData), []byte("\n")) {
		if len(line) == 0 {
			continue
		}
		var entry struct {
			Action string `json:"action"`
			ID     string `json:"id"`
			Box    string `json:"box"`
			Path   string `json:"path"`
		}
		if err = json.Unmarshal(line, &entry); err != nil {
			t.Fatalf("decode durable queue entry: %v", err)
		}
		if entry.Action == action && entry.ID == rootID && entry.Box == boxID && entry.Path == treePath {
			return true
		}
	}
	return false
}

func TestContentCommitQueueFailureRestoresStateAndAllowsRetry(t *testing.T) {
	tests := []struct {
		name   string
		action string
		run    func(*parse.Tree) error
	}{
		{name: "write upsert", action: "upsert", run: writeTreeUpsertQueue},
		{name: "index write", action: "index", run: indexWriteTreeIndexQueue},
		{name: "index upsert", action: "upsert", run: indexWriteTreeUpsertQueue},
		{name: "rename write", action: "rename", run: renameWriteJSONQueue},
	}
	for i, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			boxID := "20990718010000-commitx"
			rootID := []string{
				"20990718010001-commitx",
				"20990718010002-commitx",
				"20990718010003-commitx",
				"20990718010004-commitx",
			}[i]
			fixture := newContentCommitFixture(t, boxID, rootID)
			replacement := treenode.NewTree(boxID, fixture.treePath, "/Replacement "+test.name, "Replacement "+test.name)

			blockedQueuePath := filepath.Join(t.TempDir(), "not-a-directory")
			if err := os.WriteFile(blockedQueuePath, []byte("blocked"), 0644); err != nil {
				t.Fatalf("create queue ENOTDIR boundary: %v", err)
			}
			err := func() error {
				util.QueueDir = blockedQueuePath
				defer func() { util.QueueDir = fixture.queueDir }()
				return test.run(replacement)
			}()
			if !errors.Is(err, syscall.ENOTDIR) {
				t.Fatalf("content commit error = %v, want ENOTDIR", err)
			}
			assertContentCommitFixtureUnchanged(t, fixture)

			if err = test.run(replacement); err != nil {
				t.Fatalf("retry content commit: %v", err)
			}
			assertContentCommitRetry(t, fixture, replacement, test.action)
		})
	}
}

func TestContentCommitInvalidTreeLeavesStateUnchangedAndAllowsRetry(t *testing.T) {
	const (
		boxID  = "20990718010100-invalid"
		rootID = "20990718010101-invalid"
	)
	fixture := newContentCommitFixture(t, boxID, rootID)
	invalid := &parse.Tree{
		Root:  &ast.Node{Type: ast.NodeDocument, Box: boxID, Path: fixture.treePath},
		ID:    rootID,
		Box:   boxID,
		Path:  fixture.treePath,
		HPath: "/Invalid",
	}
	if err := writeTreeUpsertQueue(invalid); err == nil {
		t.Fatal("content commit accepted a tree without indexable blocks")
	}
	assertContentCommitFixtureUnchanged(t, fixture)

	replacement := treenode.NewTree(boxID, fixture.treePath, "/Valid retry", "Valid retry")
	if err := writeTreeUpsertQueue(replacement); err != nil {
		t.Fatalf("retry valid content commit: %v", err)
	}
	assertContentCommitRetry(t, fixture, replacement, "upsert")
}
