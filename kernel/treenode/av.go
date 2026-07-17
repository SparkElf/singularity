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

	"github.com/siyuan-note/logging"
	"github.com/siyuan-note/siyuan/kernel/av"
)

func GetMirrorAttrViewBlockIDs(avID string) (ret []string) {
	return GetMirrorAttrViewBlockIDsInBox(avID, "")
}

// GetMirrorAttrViewBlockIDsInBox 返回指定内容库中引用该 AV 且仍存在的块 ID。
func GetMirrorAttrViewBlockIDsInBox(avID, boxID string) (ret []string) {
	ret, err := GetMirrorAttrViewBlockIDsInBoxStrict(avID, boxID)
	if err != nil {
		logging.LogErrorf("read attribute view mirror block IDs [%s/%s] failed: %s", boxID, avID, err)
	}
	return ret
}

func GetMirrorAttrViewBlockIDsInBoxStrict(avID, boxID string) (ret []string, err error) {
	ret = []string{}
	avBlocks, err := av.GetBlockRelsInBoxStrict(boxID)
	if err != nil {
		return nil, fmt.Errorf("read attribute view mirror relations [%s/%s]: %w", boxID, avID, err)
	}
	blockIDs := avBlocks[avID]
	bts, err := GetBlockTreesInBoxStrict(blockIDs, boxID)
	if err != nil {
		return nil, fmt.Errorf("read attribute view mirror blocktrees [%s/%s]: %w", boxID, avID, err)
	}
	for blockID := range bts {
		ret = append(ret, blockID)
	}
	return
}
