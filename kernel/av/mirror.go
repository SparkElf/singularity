package av

import (
	"errors"
	"fmt"
	"os"
	"sync"

	"github.com/88250/gulu"
	"github.com/88250/lute/ast"
	"github.com/siyuan-note/logging"
)

type MirrorBlocksSnapshot struct {
	boxID   string
	blocks  map[string][]string
	existed bool
}

func CaptureMirrorBlocks(boxID string) (*MirrorBlocksSnapshot, error) {
	release := holdAVStoreReadLock(boxID)
	defer release()
	AttributeViewBlocksLock.Lock()
	defer AttributeViewBlocksLock.Unlock()
	blocks, err := readMirrorBlocksStrict(boxID)
	if err != nil {
		return nil, fmt.Errorf("capture attribute view mirror index for box %q: %w", boxID, err)
	}
	_, statErr := os.Stat(mirrorBlocksPath(boxID))
	if statErr != nil && !os.IsNotExist(statErr) {
		return nil, fmt.Errorf("stat attribute view mirror index for box %q: %w", boxID, statErr)
	}
	return &MirrorBlocksSnapshot{boxID: boxID, blocks: blocks, existed: statErr == nil}, nil
}

func (snapshot *MirrorBlocksSnapshot) Restore() error {
	if snapshot == nil {
		return nil
	}
	release := holdAVStoreReadLock(snapshot.boxID)
	defer release()
	AttributeViewBlocksLock.Lock()
	defer AttributeViewBlocksLock.Unlock()
	if !snapshot.existed {
		if err := os.Remove(mirrorBlocksPath(snapshot.boxID)); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("remove replacement attribute view mirror index for box %q: %w", snapshot.boxID, err)
		}
		return nil
	}
	if err := writeMirrorBlocks(snapshot.boxID, snapshot.blocks); err != nil {
		return fmt.Errorf("restore attribute view mirror index for box %q: %w", snapshot.boxID, err)
	}
	return nil
}

var (
	AttributeViewBlocksLock           = sync.Mutex{}
	ErrAttributeViewMirrorUnavailable = errors.New("attribute view mirror index is unavailable")
)

func GetBlockRels() (ret map[string][]string) {
	return GetBlockRelsInBox("")
}

func GetBlockRelsInBox(boxID string) (ret map[string][]string) {
	ret, err := GetBlockRelsInBoxStrict(boxID)
	if err != nil {
		logging.LogErrorf("read attribute view blocks failed: %s", err)
	}
	return ret
}

func GetBlockRelsInBoxStrict(boxID string) (ret map[string][]string, err error) {
	release := holdAVStoreReadLock(boxID)
	defer release()
	AttributeViewBlocksLock.Lock()
	defer AttributeViewBlocksLock.Unlock()
	return readMirrorBlocksStrict(boxID)
}

func IsMirror(avID string) bool {
	return IsMirrorInBox(avID, "")
}

func IsMirrorInBox(avID, boxID string) bool {
	ret, err := IsMirrorInBoxStrict(avID, boxID)
	if err != nil {
		logging.LogErrorf("read attribute view mirror state failed: %s", err)
	}
	return ret
}

func IsMirrorInBoxStrict(avID, boxID string) (bool, error) {
	release := holdAVStoreReadLock(boxID)
	defer release()
	AttributeViewBlocksLock.Lock()
	defer AttributeViewBlocksLock.Unlock()

	avBlocks, err := readMirrorBlocksStrict(boxID)
	if err != nil {
		return false, fmt.Errorf("%w for box %q: %w", ErrAttributeViewMirrorUnavailable, boxID, err)
	}
	blockIDs := avBlocks[avID]
	return nil != blockIDs && 1 < len(blockIDs), nil
}

func RemoveBlockRel(avID, blockID string, existBlockTree func(string) bool) (ret bool, err error) {
	return RemoveBlockRelInBox(avID, blockID, "", existBlockTree)
}

func RemoveBlockRelInBox(avID, blockID, boxID string, existBlockTree func(string) bool) (ret bool, err error) {
	release := holdAVStoreReadLock(boxID)
	defer release()
	AttributeViewBlocksLock.Lock()
	defer AttributeViewBlocksLock.Unlock()

	avBlocks, err := readMirrorBlocksStrict(boxID)
	if err != nil {
		return false, fmt.Errorf("%w for box %q: %w", ErrAttributeViewMirrorUnavailable, boxID, err)
	}

	blockIDs := avBlocks[avID]
	if nil == blockIDs {
		return
	}

	var newBlockIDs []string
	for _, v := range blockIDs {
		if v != blockID {
			if existBlockTree(v) {
				newBlockIDs = append(newBlockIDs, v)
			}
		}
	}
	avBlocks[avID] = newBlockIDs
	ret = len(newBlockIDs) != len(blockIDs)

	if err := writeMirrorBlocks(boxID, avBlocks); err != nil {
		return false, fmt.Errorf("write attribute view mirror index for box %q: %w", boxID, err)
	}
	return
}

func BatchUpsertBlockRel(nodes []*ast.Node) error {
	return BatchUpsertBlockRelInBox(nodes, "")
}

func BatchUpsertBlockRelInBox(nodes []*ast.Node, boxID string) error {
	release := holdAVStoreReadLock(boxID)
	defer release()
	AttributeViewBlocksLock.Lock()
	defer AttributeViewBlocksLock.Unlock()

	avBlocks, err := readMirrorBlocksStrict(boxID)
	if err != nil {
		return fmt.Errorf("%w for box %q: %w", ErrAttributeViewMirrorUnavailable, boxID, err)
	}
	changed := false
	for _, n := range nodes {
		if ast.NodeAttributeView != n.Type {
			continue
		}

		if "" == n.AttributeViewID || "" == n.ID {
			continue
		}

		if !IsAttributeViewExistInBox(n.AttributeViewID, boxID) {
			logging.LogWarnf("skip AV mirror without definition in target store: avID=%s box=%s", n.AttributeViewID, boxID)
			continue
		}

		blockIDs := avBlocks[n.AttributeViewID]
		oldLen := len(blockIDs)
		blockIDs = append(blockIDs, n.ID)
		blockIDs = gulu.Str.RemoveDuplicatedElem(blockIDs)
		avBlocks[n.AttributeViewID] = blockIDs
		changed = changed || oldLen != len(blockIDs)
	}

	if changed {
		if err := writeMirrorBlocks(boxID, avBlocks); err != nil {
			return fmt.Errorf("write attribute view mirror index for box %q: %w", boxID, err)
		}
	}
	return nil
}

func ReplaceBlockRelsInBox(nodes []*ast.Node, boxID string) error {
	release := holdAVStoreReadLock(boxID)
	defer release()
	AttributeViewBlocksLock.Lock()
	defer AttributeViewBlocksLock.Unlock()

	avBlocks := map[string][]string{}
	for _, n := range nodes {
		if ast.NodeAttributeView != n.Type || n.AttributeViewID == "" || n.ID == "" {
			continue
		}
		if !IsAttributeViewExistInBox(n.AttributeViewID, boxID) {
			logging.LogWarnf("skip AV mirror without definition in target store: avID=%s box=%s", n.AttributeViewID, boxID)
			continue
		}
		avBlocks[n.AttributeViewID] = append(avBlocks[n.AttributeViewID], n.ID)
		avBlocks[n.AttributeViewID] = gulu.Str.RemoveDuplicatedElem(avBlocks[n.AttributeViewID])
	}
	if err := writeMirrorBlocks(boxID, avBlocks); err != nil {
		return fmt.Errorf("replace attribute view mirror index for box %q: %w", boxID, err)
	}
	return nil
}

func UpsertBlockRel(avID, blockID string) (ret bool, err error) {
	return UpsertBlockRelInBox(avID, blockID, "")
}

func UpsertBlockRelInBox(avID, blockID, boxID string) (ret bool, err error) {
	release := holdAVStoreReadLock(boxID)
	defer release()
	AttributeViewBlocksLock.Lock()
	defer AttributeViewBlocksLock.Unlock()

	if !IsAttributeViewExistInBox(avID, boxID) {
		logging.LogWarnf("skip AV mirror without definition in target store: avID=%s box=%s", avID, boxID)
		return
	}
	avBlocks, err := readMirrorBlocksStrict(boxID)
	if err != nil {
		return false, fmt.Errorf("%w for box %q: %w", ErrAttributeViewMirrorUnavailable, boxID, err)
	}

	blockIDs := avBlocks[avID]
	oldLen := len(blockIDs)
	blockIDs = append(blockIDs, blockID)
	blockIDs = gulu.Str.RemoveDuplicatedElem(blockIDs)
	avBlocks[avID] = blockIDs
	ret = oldLen != len(blockIDs) && 0 != oldLen

	if err := writeMirrorBlocks(boxID, avBlocks); err != nil {
		return false, fmt.Errorf("write attribute view mirror index for box %q: %w", boxID, err)
	}
	return
}
