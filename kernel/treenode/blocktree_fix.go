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

package treenode

import (
	"fmt"

	"github.com/88250/gulu"
	"github.com/siyuan-note/logging"
)

func ClearRedundantBlockTrees(boxID string, paths []string) error {
	redundantPaths, err := getRedundantPaths(boxID, paths)
	if err != nil {
		return err
	}
	for _, p := range redundantPaths {
		if err = removeBlockTreesByPath(boxID, p); err != nil {
			return err
		}
	}
	return nil
}

func getRedundantPaths(boxID string, paths []string) (ret []string, err error) {
	pathsMap := map[string]bool{}
	for _, path := range paths {
		pathsMap[path] = true
	}

	btPathsMap := map[string]bool{}
	sqlStmt := "SELECT path FROM blocktrees WHERE box_id = ?"
	rows, err := queryForBox(boxID, sqlStmt, boxID)
	if err != nil {
		return nil, fmt.Errorf("query blocktree paths for notebook [%s]: %w", boxID, err)
	}
	defer rows.Close()
	for rows.Next() {
		var path string
		if err = rows.Scan(&path); err != nil {
			return nil, fmt.Errorf("scan blocktree path for notebook [%s]: %w", boxID, err)
		}
		btPathsMap[path] = true
	}

	for p := range btPathsMap {
		if !pathsMap[p] {
			ret = append(ret, p)
		}
	}
	ret = gulu.Str.RemoveDuplicatedElem(ret)
	return ret, rows.Err()
}

func removeBlockTreesByPath(boxID, path string) error {
	sqlStmt := "DELETE FROM blocktrees WHERE box_id = ? AND path = ?"
	_, err := execForBox(boxID, sqlStmt, boxID, path)
	if err != nil {
		return fmt.Errorf("remove blocktrees by path [%s/%s]: %w", boxID, path, err)
	}
	return nil
}

func GetNotExistPaths(boxID string, paths []string) (ret []string, err error) {
	pathsMap := map[string]bool{}
	for _, path := range paths {
		pathsMap[path] = true
	}

	btPathsMap := map[string]bool{}
	sqlStmt := "SELECT path FROM blocktrees WHERE box_id = ?"
	rows, err := queryForBox(boxID, sqlStmt, boxID)
	if err != nil {
		return nil, fmt.Errorf("query existing blocktree paths for notebook [%s]: %w", boxID, err)
	}
	defer rows.Close()
	for rows.Next() {
		var path string
		if err = rows.Scan(&path); err != nil {
			return nil, fmt.Errorf("scan existing blocktree path for notebook [%s]: %w", boxID, err)
		}
		btPathsMap[path] = true
	}

	for p := range pathsMap {
		if !btPathsMap[p] {
			ret = append(ret, p)
		}
	}
	ret = gulu.Str.RemoveDuplicatedElem(ret)
	return ret, rows.Err()
}

func GetRootUpdated() (ret map[string]string) {
	return GetRootUpdatedInBox("")
}

// GetRootUpdatedInBox returns document update times from one block-tree store.
func GetRootUpdatedInBox(boxID string) (ret map[string]string) {
	ret = map[string]string{}
	sqlStmt := "SELECT root_id, updated FROM blocktrees WHERE root_id = id AND type = 'd'"
	var args []any
	if boxID != "" {
		sqlStmt += " AND box_id = ?"
		args = append(args, boxID)
	}
	rows, err := queryForBox(boxID, sqlStmt, args...)
	if err != nil {
		logging.LogErrorf("query block tree failed: %s", err)
		return
	}
	defer rows.Close()
	for rows.Next() {
		var rootID, updated string
		if err = rows.Scan(&rootID, &updated); err != nil {
			logging.LogErrorf("scan block tree failed: %s", err)
			return
		}
		ret[rootID] = updated
	}
	return
}
