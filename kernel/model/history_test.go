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
	"strconv"
	"testing"
	"time"

	"github.com/siyuan-note/siyuan/kernel/conf"
	"github.com/siyuan-note/siyuan/kernel/sql"
	"github.com/siyuan-note/siyuan/kernel/util"
)

func TestHistoryQueriesRejectInvalidNotebookWithoutGlobalFallback(t *testing.T) {
	if _, _, _, err := FullTextSearchHistory("", "invalid", "", HistoryTypeDoc, 1); !errors.Is(err, ErrInvalidID) {
		t.Fatalf("history search error = %v, want ErrInvalidID", err)
	}
	if _, err := FullTextSearchHistoryItems("1", "", "invalid", "", HistoryTypeDoc); !errors.Is(err, ErrInvalidID) {
		t.Fatalf("history item search error = %v, want ErrInvalidID", err)
	}
}

func TestHistoryDocIDFilterKeepsDuplicateIDsInTheirNotebook(t *testing.T) {
	originalDataDir := util.DataDir
	originalTempDir := util.TempDir
	originalQueueDir := util.QueueDir
	originalConfDir := util.ConfDir
	originalHistoryDir := util.HistoryDir
	originalWorkspaceDir := util.WorkspaceDir
	originalDBPath := util.DBPath
	originalHistoryDBPath := util.HistoryDBPath
	originalAssetContentDBPath := util.AssetContentDBPath
	originalBlockTreeDBPath := util.BlockTreeDBPath
	originalIsExiting := util.IsExiting.Load()
	originalConf := Conf

	tempRoot := t.TempDir()
	util.WorkspaceDir = tempRoot
	util.DataDir = filepath.Join(tempRoot, "data")
	util.TempDir = filepath.Join(tempRoot, "temp")
	util.QueueDir = filepath.Join(util.TempDir, "queue")
	util.ConfDir = filepath.Join(tempRoot, "conf")
	util.HistoryDir = filepath.Join(tempRoot, "history")
	util.DBPath = filepath.Join(util.TempDir, util.DBName)
	util.HistoryDBPath = filepath.Join(util.TempDir, "history.db")
	util.AssetContentDBPath = filepath.Join(util.TempDir, "asset_content.db")
	util.BlockTreeDBPath = filepath.Join(util.TempDir, "blocktree.db")
	for _, dir := range []string{util.DataDir, util.TempDir, util.QueueDir, util.ConfDir, util.HistoryDir} {
		if err := os.MkdirAll(dir, 0755); err != nil {
			t.Fatalf("create history query test directory %s: %v", dir, err)
		}
	}
	Conf = NewAppConf()
	Conf.Editor = conf.NewEditor()
	Conf.FileTree = conf.NewFileTree()
	util.IsExiting.Store(false)
	databasesReady := false
	t.Cleanup(func() {
		if databasesReady {
			sql.CloseDatabase()
		}
		Conf = originalConf
		util.IsExiting.Store(originalIsExiting)
		util.BlockTreeDBPath = originalBlockTreeDBPath
		util.AssetContentDBPath = originalAssetContentDBPath
		util.HistoryDBPath = originalHistoryDBPath
		util.DBPath = originalDBPath
		util.WorkspaceDir = originalWorkspaceDir
		util.HistoryDir = originalHistoryDir
		util.ConfDir = originalConfDir
		util.QueueDir = originalQueueDir
		util.TempDir = originalTempDir
		util.DataDir = originalDataDir
	})

	if err := sql.InitDatabase(true); err != nil {
		t.Fatalf("initialize history query content database: %v", err)
	}
	sql.InitHistoryDatabase(true)
	sql.InitAssetContentDatabase(true)
	databasesReady = true

	const (
		ordinaryBox  = "20990717130000-history"
		encryptedBox = "20990717130001-history"
		docID        = "20990717130002-history"
	)
	for _, notebook := range []struct {
		id        string
		encrypted bool
	}{
		{id: ordinaryBox},
		{id: encryptedBox, encrypted: true},
	} {
		boxConf := conf.NewBoxConf()
		boxConf.Name = notebook.id
		boxConf.Encrypted = notebook.encrypted
		if err := (&Box{ID: notebook.id}).SaveConf(boxConf); err != nil {
			t.Fatalf("save history query notebook %s: %v", notebook.id, err)
		}
	}

	ordinaryCreated := strconv.FormatInt(time.Now().Unix(), 10)
	encryptedCreated := strconv.FormatInt(time.Now().Add(-time.Second).Unix(), 10)
	sql.IndexHistoriesQueue([]*sql.History{
		{
			ID: docID, Type: HistoryTypeDoc, Op: HistoryOpUpdate, Title: "Ordinary duplicate",
			Path: "2099-07-17-130000-update/" + ordinaryBox + "/" + docID + ".sy", Created: ordinaryCreated,
		},
		{
			ID: docID, Type: HistoryTypeDoc, Op: HistoryOpUpdate, Title: "Encrypted duplicate",
			Path: "2099-07-17-130001-update/" + encryptedBox + "/" + docID + ".sy", Created: encryptedCreated,
		},
	})
	sql.FlushHistoryQueue()

	for _, expected := range []struct {
		notebook string
		created  string
		title    string
	}{
		{notebook: ordinaryBox, created: ordinaryCreated, title: "Ordinary duplicate"},
		{notebook: encryptedBox, created: encryptedCreated, title: "Encrypted duplicate"},
	} {
		timestamps, pageCount, totalCount, err := FullTextSearchHistory(docID, expected.notebook, "", HistoryTypeDocID, 1)
		if err != nil {
			t.Fatalf("search duplicate history ID in notebook %s: %v", expected.notebook, err)
		}
		if len(timestamps) != 1 || timestamps[0] != expected.created || pageCount != 1 || totalCount != 1 {
			t.Fatalf("history timestamps for notebook %s = %v, pageCount=%d totalCount=%d", expected.notebook, timestamps, pageCount, totalCount)
		}
		items, err := FullTextSearchHistoryItems(expected.created, docID, expected.notebook, "", HistoryTypeDocID)
		if err != nil {
			t.Fatalf("search duplicate history items in notebook %s: %v", expected.notebook, err)
		}
		if len(items) != 1 || items[0].Notebook != expected.notebook || items[0].Title != expected.title {
			t.Fatalf("history items for notebook %s = %#v", expected.notebook, items)
		}
	}
}
