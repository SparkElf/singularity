// SiYuan - Refactor your thinking
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

package model

import (
	"strings"
	"testing"

	"github.com/siyuan-note/siyuan/kernel/conf"
	"github.com/siyuan-note/siyuan/kernel/treenode"
	"github.com/siyuan-note/siyuan/kernel/util"
)

func TestCreateTreeTxRejectsNonCanonicalNotebookOwnership(t *testing.T) {
	const (
		ordinaryBox  = "20990717160000-normal1"
		encryptedBox = "20990717160000-encrypt"
		missingBox   = "20990717160000-missing"
		rootID       = "20990717160001-docone1"
	)
	originalDataDir := util.DataDir
	originalConf := Conf
	util.DataDir = t.TempDir()
	Conf = NewAppConf()
	Conf.FileTree = conf.NewFileTree()
	t.Cleanup(func() {
		Conf = originalConf
		util.DataDir = originalDataDir
	})

	for boxID, encrypted := range map[string]bool{ordinaryBox: false, encryptedBox: true} {
		boxConf := conf.NewBoxConf()
		boxConf.Name = boxID
		boxConf.Encrypted = encrypted
		if err := (&Box{ID: boxID}).SaveConf(boxConf); err != nil {
			t.Fatalf("save notebook fixture %s: %v", boxID, err)
		}
	}

	tests := []struct {
		name                string
		treeBox             string
		transactionNotebook string
		want                string
	}{
		{name: "ordinary tree with encrypted identity", treeBox: ordinaryBox, transactionNotebook: encryptedBox, want: "does not own tree box"},
		{name: "encrypted tree with global identity", treeBox: encryptedBox, transactionNotebook: "", want: "does not own tree box"},
		{name: "unknown tree box", treeBox: missingBox, transactionNotebook: "", want: ErrBoxNotFound.Error()},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			tree := treenode.NewTree(test.treeBox, "/"+rootID+".sy", "/Identity", "Identity")
			err := createTreeTx(tree, test.transactionNotebook)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("create tree transaction error = %v, want error containing %q", err, test.want)
			}
		})
	}
}
