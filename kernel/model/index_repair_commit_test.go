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
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/88250/lute/parse"
	"github.com/siyuan-note/siyuan/kernel/filesys"
	"github.com/siyuan-note/siyuan/kernel/sql"
	"github.com/siyuan-note/siyuan/kernel/treenode"
	"github.com/siyuan-note/siyuan/kernel/util"
)

func TestIndexRepairRenameConflictRestoresStateAndAllowsRetry(t *testing.T) {
	const (
		boxID       = "20990718020000-repairx"
		oldRootID   = "20990718020001-repairx"
		childRootID = "20990718020002-repairx"
	)
	setupIndexFailureEnvironment(t)
	saveIndexFailureBox(t, boxID, false)
	originalHook := indexRepairAfterResetHook
	t.Cleanup(func() { indexRepairAfterResetHook = originalHook })

	original := writeIndexFailureTree(t, boxID, oldRootID, "Original duplicate")
	oldPath := original.Path
	childPath := "/" + oldRootID + "/" + childRootID + ".sy"
	child := treenode.NewTree(boxID, childPath, "/Original duplicate/Child", "Child")
	if _, err := filesys.WriteTree(child); err != nil {
		t.Fatalf("write duplicate-tree child: %v", err)
	}
	if _, err := treenode.ReplaceBlockTrees([]*parse.Tree{original, child}); err != nil {
		t.Fatalf("seed duplicate-tree blocktrees: %v", err)
	}
	queueSeedID := "20990718029999-queuexx"
	queueSeed := treenode.NewTree(boxID, "/"+queueSeedID+".sy", "/Queue seed", "Queue seed")
	if err := sql.UpsertTreeQueue(queueSeed); err != nil {
		t.Fatalf("seed duplicate-tree durable queue: %v", err)
	}

	boxDir := filepath.Join(util.DataDir, boxID)
	oldAbsPath := filepath.Join(boxDir, oldRootID+".sy")
	oldChildrenDir := filepath.Join(boxDir, oldRootID)
	childAbsPath := filepath.Join(oldChildrenDir, childRootID+".sy")
	oldFileData, err := os.ReadFile(oldAbsPath)
	if err != nil {
		t.Fatalf("read original duplicate tree: %v", err)
	}
	childFileData, err := os.ReadFile(childAbsPath)
	if err != nil {
		t.Fatalf("read original duplicate-tree child: %v", err)
	}
	oldTreeData, oldDocIAL := waitForContentCommitCache(t, oldRootID, boxID, oldPath, oldFileData, map[string]string{"title": "Original duplicate"})
	oldRootRows := snapshotContentCommitBlocktrees(oldRootID, boxID)
	childRootRows := snapshotContentCommitBlocktrees(childRootID, boxID)
	queueData, err := os.ReadFile(filepath.Join(util.QueueDir, "index.queue"))
	if err != nil {
		t.Fatalf("read seeded duplicate-tree queue: %v", err)
	}

	var failedRootID, failedPath, conflictDir, conflictMarker string
	var hookErr error
	indexRepairAfterResetHook = func(tree *parse.Tree) {
		failedRootID = tree.ID
		failedPath = tree.Path
		conflictDir = filepath.Join(boxDir, tree.ID)
		conflictMarker = filepath.Join(conflictDir, "conflict")
		if hookErr = os.MkdirAll(conflictDir, 0755); hookErr != nil {
			return
		}
		hookErr = os.WriteFile(conflictMarker, []byte("occupied"), 0644)
	}

	err = recreateTree(original, oldAbsPath)
	if hookErr != nil {
		t.Fatalf("create real rename conflict: %v", hookErr)
	}
	if err == nil {
		t.Fatal("duplicate-tree repair succeeded with a non-empty rename destination")
	}
	if failedRootID == "" || failedPath == "" {
		t.Fatal("duplicate-tree repair did not generate a replacement identity")
	}

	gotOldFile, err := os.ReadFile(oldAbsPath)
	if err != nil {
		t.Fatalf("read original tree after rejected repair: %v", err)
	}
	if !bytes.Equal(gotOldFile, oldFileData) {
		t.Fatal("rejected duplicate-tree repair changed the original file")
	}
	gotChildFile, err := os.ReadFile(childAbsPath)
	if err != nil {
		t.Fatalf("read child after rejected repair: %v", err)
	}
	if !bytes.Equal(gotChildFile, childFileData) {
		t.Fatal("rejected duplicate-tree repair changed the child file")
	}
	if _, err = os.Stat(conflictMarker); err != nil {
		t.Fatalf("rejected duplicate-tree repair changed the conflict destination: %v", err)
	}
	if _, err = os.Stat(filepath.Join(boxDir, failedRootID+".sy")); !os.IsNotExist(err) {
		t.Fatalf("rejected duplicate-tree repair retained the new file: %v", err)
	}
	if got := snapshotContentCommitBlocktrees(oldRootID, boxID); !reflect.DeepEqual(got, oldRootRows) {
		t.Fatalf("rejected duplicate-tree repair changed old root blocktrees: got %#v want %#v", got, oldRootRows)
	}
	if got := snapshotContentCommitBlocktrees(childRootID, boxID); !reflect.DeepEqual(got, childRootRows) {
		t.Fatalf("rejected duplicate-tree repair changed child blocktrees: got %#v want %#v", got, childRootRows)
	}
	if got := snapshotContentCommitBlocktrees(failedRootID, boxID); len(got) != 0 {
		t.Fatalf("rejected duplicate-tree repair retained new blocktrees: %#v", got)
	}
	gotTreeData, gotDocIAL := waitForContentCommitCache(t, oldRootID, boxID, oldPath, oldTreeData, oldDocIAL)
	if !bytes.Equal(gotTreeData, oldTreeData) || !reflect.DeepEqual(gotDocIAL, oldDocIAL) {
		t.Fatalf("rejected duplicate-tree repair changed old caches: tree=%q ial=%#v", gotTreeData, gotDocIAL)
	}
	waitForContentCommitCacheAbsent(t, failedRootID, boxID, failedPath)
	gotQueueData, err := os.ReadFile(filepath.Join(util.QueueDir, "index.queue"))
	if err != nil {
		t.Fatalf("read queue after rejected duplicate-tree repair: %v", err)
	}
	if !bytes.Equal(gotQueueData, queueData) {
		t.Fatalf("rejected duplicate-tree repair changed durable queue:\n got %s\nwant %s", gotQueueData, queueData)
	}
	assertNoIndexRepairTombstones(t, boxDir)

	if err = os.Remove(conflictMarker); err != nil {
		t.Fatalf("remove rename conflict marker: %v", err)
	}
	if err = os.Remove(conflictDir); err != nil {
		t.Fatalf("remove rename conflict directory: %v", err)
	}
	var committedRootID, committedPath string
	indexRepairAfterResetHook = func(tree *parse.Tree) {
		committedRootID = tree.ID
		committedPath = tree.Path
	}
	reloaded, err := filesys.LoadTree(boxID, oldPath, util.NewLute())
	if err != nil {
		t.Fatalf("reload original tree for repair retry: %v", err)
	}
	if err = recreateTree(reloaded, oldAbsPath); err != nil {
		t.Fatalf("retry duplicate-tree repair: %v", err)
	}
	if committedRootID == "" || committedPath == "" {
		t.Fatal("duplicate-tree repair retry did not generate a replacement identity")
	}

	if _, err = os.Stat(oldAbsPath); !os.IsNotExist(err) {
		t.Fatalf("committed duplicate-tree repair retained the old file: %v", err)
	}
	if _, err = os.Stat(oldChildrenDir); !os.IsNotExist(err) {
		t.Fatalf("committed duplicate-tree repair retained the old child directory: %v", err)
	}
	newAbsPath := filepath.Join(boxDir, committedRootID+".sy")
	newFileData, err := os.ReadFile(newAbsPath)
	if err != nil {
		t.Fatalf("read committed replacement file: %v", err)
	}
	newChildPath := filepath.Join(boxDir, committedRootID, childRootID+".sy")
	newChildData, err := os.ReadFile(newChildPath)
	if err != nil {
		t.Fatalf("read migrated child file: %v", err)
	}
	if !bytes.Equal(newChildData, childFileData) {
		t.Fatal("committed duplicate-tree repair changed the migrated child file")
	}
	if got := snapshotContentCommitBlocktrees(oldRootID, boxID); len(got) != 0 {
		t.Fatalf("committed duplicate-tree repair retained old root blocktrees: %#v", got)
	}
	if got := snapshotContentCommitBlocktrees(childRootID, boxID); len(got) != 0 {
		t.Fatalf("committed duplicate-tree repair retained migrated child blocktrees: %#v", got)
	}
	root := treenode.GetBlockTreeInBox(committedRootID, boxID)
	if root == nil || root.Path != committedPath {
		t.Fatalf("committed duplicate-tree replacement blocktree = %#v, want path %q", root, committedPath)
	}
	waitForContentCommitCacheAbsent(t, oldRootID, boxID, oldPath)
	waitForContentCommitCache(t, committedRootID, boxID, committedPath, newFileData, map[string]string{"title": "Original duplicate"})
	if !contentCommitQueueContains(t, util.QueueDir, "upsert", boxID, committedRootID, committedPath) {
		t.Fatalf("committed duplicate-tree repair queue has no upsert for [%s/%s]", boxID, committedPath)
	}
	assertNoIndexRepairTombstones(t, boxDir)
}

func assertNoIndexRepairTombstones(t *testing.T, boxDir string) {
	t.Helper()
	matches, err := filepath.Glob(filepath.Join(boxDir, ".*.recreate-tombstone"))
	if err != nil {
		t.Fatalf("list duplicate-tree tombstones: %v", err)
	}
	if len(matches) != 0 {
		t.Fatalf("duplicate-tree tombstones remain: %v", matches)
	}
}
