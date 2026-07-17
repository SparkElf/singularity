// SiYuan - Refactor your thinking
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

package model

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/siyuan-note/siyuan/kernel/conf"
	"github.com/siyuan-note/siyuan/kernel/util"
)

func TestFindUnindexedTreePathRespectsContentStoreIdentity(t *testing.T) {
	originalDataDir := util.DataDir
	originalConf := Conf
	util.DataDir = t.TempDir()
	Conf = NewAppConf()
	Conf.FileTree = conf.NewFileTree()
	t.Cleanup(func() {
		util.DataDir = originalDataDir
		Conf = originalConf
	})

	ordinaryBox := "20260716000100-normal1"
	otherOrdinaryBox := "20260716000101-normal2"
	encryptedBox := "20260716000102-encrypt"
	ordinaryTarget := "20260716000200-block01"
	encryptedTarget := "20260716000201-block02"
	writeTreeSearchNotebook(t, ordinaryBox, false, "20260716000300-tree001", ordinaryTarget)
	writeTreeSearchNotebook(t, otherOrdinaryBox, false, "20260716000301-tree002", "unrelated")
	writeTreeSearchNotebook(t, encryptedBox, true, "20260716000302-tree003", encryptedTarget)

	if got := findUnindexedTreePath(ordinaryTarget, otherOrdinaryBox); got != "" {
		t.Fatalf("explicit notebook search crossed into another ordinary notebook: %s", got)
	}
	if got := findUnindexedTreePath(encryptedTarget, ""); got != "" {
		t.Fatalf("global search crossed into an encrypted notebook: %s", got)
	}
}

func writeTreeSearchNotebook(t *testing.T, boxID string, encrypted bool, rootID, content string) {
	t.Helper()
	boxConf := conf.NewBoxConf()
	boxConf.Name = boxID
	boxConf.Encrypted = encrypted
	if err := (&Box{ID: boxID}).SaveConf(boxConf); err != nil {
		t.Fatalf("save notebook config: %v", err)
	}
	treePath := filepath.Join(util.DataDir, boxID, rootID+".sy")
	if err := os.WriteFile(treePath, []byte(content), 0644); err != nil {
		t.Fatalf("write tree search fixture: %v", err)
	}
}
