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
	"testing"
	"time"

	"github.com/siyuan-note/siyuan/kernel/conf"
	"github.com/siyuan-note/siyuan/kernel/sql"
	"github.com/siyuan-note/siyuan/kernel/util"
)

func TestUnmountUserGuideReleasesResponseGateBeforeRemoval(t *testing.T) {
	setupIndexFailureEnvironment(t)
	Conf.Sync = conf.NewSync()
	if err := sql.InitDatabase(true); err != nil {
		t.Fatalf("initialize content database: %v", err)
	}
	sql.InitHistoryDatabase(true)
	sql.InitAssetContentDatabase(true)
	t.Cleanup(sql.CloseDatabase)

	const boxID = "20210808180117-czj9bvb"
	saveIndexFailureBox(t, boxID, false)

	done := make(chan error, 1)
	go func() { done <- Unmount(boxID) }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("unmount user guide: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("unmount user guide deadlocked while removing the closed notebook")
	}

	_, err := os.Stat(filepath.Join(util.DataDir, boxID))
	if !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("user guide directory remains after unmount: %v", err)
	}
}
