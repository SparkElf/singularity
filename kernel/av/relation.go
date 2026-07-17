package av

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"github.com/88250/gulu"
	"github.com/siyuan-note/filelock"
	"github.com/siyuan-note/logging"
	"github.com/siyuan-note/siyuan/kernel/util"
	"github.com/vmihailenco/msgpack/v5"
)

var (
	attributeViewRelationsLock = sync.Mutex{}
)

type RelationsSnapshot struct {
	boxID   string
	path    string
	data    []byte
	existed bool
}

func CaptureRelations(boxID string) (*RelationsSnapshot, error) {
	release := holdAVStoreReadLock(boxID)
	defer release()
	attributeViewRelationsLock.Lock()
	defer attributeViewRelationsLock.Unlock()

	path := relationsPath(boxID)
	data, err := filelock.ReadFile(path)
	if os.IsNotExist(err) {
		return &RelationsSnapshot{boxID: boxID, path: path}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("capture attribute view relations for box %q: %w", boxID, err)
	}
	if _, err = decodeRelations(boxID, data); err != nil {
		return nil, fmt.Errorf("capture attribute view relations for box %q: %w", boxID, err)
	}
	return &RelationsSnapshot{boxID: boxID, path: path, data: data, existed: true}, nil
}

func (snapshot *RelationsSnapshot) Restore() error {
	if snapshot == nil {
		return nil
	}
	release := holdAVStoreReadLock(snapshot.boxID)
	defer release()
	attributeViewRelationsLock.Lock()
	defer attributeViewRelationsLock.Unlock()

	if !snapshot.existed {
		if err := filelock.Remove(snapshot.path); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("remove replacement attribute view relations for box %q: %w", snapshot.boxID, err)
		}
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(snapshot.path), 0755); err != nil {
		return fmt.Errorf("restore attribute view relations directory for box %q: %w", snapshot.boxID, err)
	}
	if err := filelock.WriteFile(snapshot.path, snapshot.data); err != nil {
		return fmt.Errorf("restore attribute view relations for box %q: %w", snapshot.boxID, err)
	}
	return nil
}

// relationsPath 返回 relations 索引文件路径，按 AV 归属 box 分箱。
// 加密 box：<DataDir>/<boxID>/storage/av/relations.msgpack（DEK 加密）
// 普通 box：<DataDir>/storage/av/relations.msgpack（明文）
func relationsPath(boxID string) string {
	if boxID != "" {
		return filepath.Join(util.DataDir, boxID, "storage", "av", "relations.msgpack")
	}
	return filepath.Join(util.DataDir, "storage", "av", "relations.msgpack")
}

// readRelations 读取 relations 索引（boxID 非空时自动解密）。
func readRelations(boxID string) (avRels map[string][]string, err error) {
	p := relationsPath(boxID)
	if !filelock.IsExist(p) {
		return map[string][]string{}, nil
	}
	data, err := filelock.ReadFile(p)
	if err != nil {
		return nil, fmt.Errorf("read attribute view relations for box %q: %w", boxID, err)
	}
	avRels, err = decodeRelations(boxID, data)
	if err != nil {
		return nil, fmt.Errorf("decode attribute view relations for box %q: %w", boxID, err)
	}
	return avRels, nil
}

func decodeRelations(boxID string, data []byte) (avRels map[string][]string, err error) {
	if boxID != "" {
		dec, decErr := decryptAVDataLocked(boxID, "relation", data)
		if decErr != nil {
			return nil, fmt.Errorf("decrypt attribute view relations: %w", decErr)
		}
		data = dec
	}
	if err = msgpack.Unmarshal(data, &avRels); err != nil {
		return nil, fmt.Errorf("unmarshal attribute view relations: %w", err)
	}
	if avRels == nil {
		avRels = map[string][]string{}
	}
	return avRels, nil
}

// writeRelations 写入 relations 索引（boxID 非空时加密）。
func writeRelations(boxID string, avRels map[string][]string) error {
	p := relationsPath(boxID)
	if err := os.MkdirAll(filepath.Dir(p), 0755); err != nil {
		return fmt.Errorf("create attribute view relations directory for box %q: %w", boxID, err)
	}
	data, err := msgpack.Marshal(avRels)
	if err != nil {
		return fmt.Errorf("marshal attribute view relations for box %q: %w", boxID, err)
	}
	if boxID != "" {
		enc, encErr := encryptAVDataLocked(boxID, "relation", data)
		if encErr != nil {
			return fmt.Errorf("encrypt attribute view relations for box %q: %w", boxID, encErr)
		}
		data = enc
	}
	if err = filelock.WriteFile(p, data); err != nil {
		return fmt.Errorf("write attribute view relations for box %q: %w", boxID, err)
	}
	return nil
}

func GetSrcAvIDs(destAvID string) []string {
	return GetSrcAvIDsInBox(destAvID, "")
}

func GetSrcAvIDsInBox(destAvID, boxID string) []string {
	release := holdAVStoreReadLock(boxID)
	defer release()
	attributeViewRelationsLock.Lock()
	defer attributeViewRelationsLock.Unlock()

	avRels, err := readRelations(boxID)
	if err != nil {
		logging.LogErrorf("read attribute view relations failed: %s", err)
		return nil
	}
	srcAvIDs := avRels[destAvID]
	if nil == srcAvIDs {
		return nil
	}
	return srcAvIDs
}

func RemoveAvRel(srcAvID, destAvID string) error {
	return RemoveAvRelInBox(srcAvID, destAvID, "")
}

func RemoveAvRelInBox(srcAvID, destAvID, boxID string) error {
	release := holdAVStoreReadLock(boxID)
	defer release()
	attributeViewRelationsLock.Lock()
	defer attributeViewRelationsLock.Unlock()

	avRels, err := readRelations(boxID)
	if err != nil {
		return err
	}

	srcAvIDs := avRels[destAvID]
	if nil == srcAvIDs {
		return nil
	}

	var newAvIDs []string
	for _, v := range srcAvIDs {
		if v != srcAvID {
			newAvIDs = append(newAvIDs, v)
		}
	}
	avRels[destAvID] = newAvIDs
	return writeRelations(boxID, avRels)
}

func UpsertAvBackRel(srcAvID, destAvID string) error {
	return UpsertAvBackRelInBox(srcAvID, destAvID, "")
}

func UpsertAvBackRelInBox(srcAvID, destAvID, boxID string) error {
	release := holdAVStoreReadLock(boxID)
	defer release()
	attributeViewRelationsLock.Lock()
	defer attributeViewRelationsLock.Unlock()

	if !IsAttributeViewExistInBox(srcAvID, boxID) || !IsAttributeViewExistInBox(destAvID, boxID) {
		logging.LogWarnf("skip AV relation without both definitions in target store: src=%s dest=%s box=%s", srcAvID, destAvID, boxID)
		return nil
	}

	avRels, err := readRelations(boxID)
	if err != nil {
		return err
	}

	srcAvIDs := avRels[destAvID]
	srcAvIDs = append(srcAvIDs, srcAvID)
	srcAvIDs = gulu.Str.RemoveDuplicatedElem(srcAvIDs)
	avRels[destAvID] = srcAvIDs
	return writeRelations(boxID, avRels)
}
