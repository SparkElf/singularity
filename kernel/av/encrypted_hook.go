// SiYuan - Refactor your thinking
// Copyright (c) 2020-present, b3log.org
//
// 本文件为加密笔记本的 AV 定义提供笔记本级存储与 DEK 加解密支持。
// 与 filesys/crypto_hook.go 同模式：av 包不直接 import model（避免循环依赖），
// 由 model 层在 init 时注入回调函数。

package av

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/siyuan-note/filelock"
	"github.com/siyuan-note/logging"
	"github.com/siyuan-note/siyuan/kernel/util"
	"github.com/vmihailenco/msgpack/v5"
)

// AVDEKProvider 由 model 层注入，返回已解锁加密笔记本的 DEK 副本。
// 调用方负责在使用后清零；返回 (nil, nil) 表示该 box 非加密。
var AVDEKProvider func(boxID string) ([]byte, error)

// AVLockAcquire / AVLockRelease 由 model 层注入，在获取 DEK 前后持 box 读锁，
// 防止 LockBox 在 AV 加解密期间清除缓存。非加密 box 的注入为空时不影响行为。
var AVLockAcquire func(boxID string)
var AVLockRelease func(boxID string)

func holdAVStoreReadLock(boxID string) func() {
	if boxID == "" || AVLockAcquire == nil || AVLockRelease == nil {
		return func() {}
	}
	AVLockAcquire(boxID)
	return func() { AVLockRelease(boxID) }
}

// attributeViewDataPathByBox 返回指定 box 的 AV 定义路径。
// 加密 box：<DataDir>/<boxID>/storage/av/<avID>.json
// 普通 box（boxID 为空）：<DataDir>/storage/av/<avID>.json
func attributeViewDataPathByBox(avID, boxID string) string {
	if boxID != "" {
		return filepath.Join(util.DataDir, boxID, "storage", "av", avID+".json")
	}
	return filepath.Join(util.DataDir, "storage", "av", avID+".json")
}

// FindAttributeViewPath 只查找全局 AV 定义。加密笔记本必须使用 InBox 入口。
func FindAttributeViewPath(avID string) (path string, boxID string) {
	globalPath := attributeViewDataPathByBox(avID, "")
	if filelock.IsExist(globalPath) {
		return globalPath, ""
	}
	return "", ""
}

// FindAttributeViewPathInBox 只在指定 box 内查找 AV 定义。
func FindAttributeViewPathInBox(avID, boxID string) (path string, retBoxID string) {
	avPath := attributeViewDataPathByBox(avID, boxID)
	if filelock.IsExist(avPath) {
		return avPath, boxID
	}
	return "", boxID
}

// readAttributeViewData 读取全局 AV 定义数据。
func readAttributeViewData(avID string) ([]byte, error) {
	path, _ := FindAttributeViewPath(avID)
	if path == "" {
		return nil, nil // 文件不存在，由调用方处理
	}
	return filelock.ReadFile(path)
}

// ReadAttributeViewData 是 readAttributeViewData 的导出版本，只读取全局 AV 定义明文。
func ReadAttributeViewData(avID string) ([]byte, error) {
	return readAttributeViewData(avID)
}

// ReadAttributeViewDataInBox 只读取指定 box 内的 AV 定义明文。
func ReadAttributeViewDataInBox(avID, boxID string) ([]byte, error) {
	release := holdAVStoreReadLock(boxID)
	defer release()
	return ReadAttributeViewDataInBoxLocked(avID, boxID)
}

// ReadAttributeViewDataInBoxLocked 与 ReadAttributeViewDataInBox 相同，但调用方必须已持有 box 生命周期读锁。
func ReadAttributeViewDataInBoxLocked(avID, boxID string) ([]byte, error) {
	path, retBoxID := FindAttributeViewPathInBox(avID, boxID)
	if path == "" {
		return nil, nil
	}
	data, err := filelock.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if retBoxID != "" {
		data, err = decryptAVDataLocked(retBoxID, avID, data)
		if err != nil {
			return nil, err
		}
	}
	return data, nil
}

// mirrorBlocksPath 返回镜像索引文件的路径。
// 加密 box：<DataDir>/<boxID>/storage/av/blocks.msgpack
// 普通 box：<DataDir>/storage/av/blocks.msgpack
func mirrorBlocksPath(boxID string) string {
	if boxID != "" {
		return filepath.Join(util.DataDir, boxID, "storage", "av", "blocks.msgpack")
	}
	return filepath.Join(util.DataDir, "storage", "av", "blocks.msgpack")
}

// readMirrorBlocks 按路径读取镜像索引（boxID 为空读全局，非空读加密 box）。
// 加密笔记本的镜像索引是 DEK 加密的密文，读取后需解密。
func readMirrorBlocks(boxID string) (ret map[string][]string) {
	ret, err := readMirrorBlocksStrict(boxID)
	if err != nil {
		logging.LogErrorf("read attribute view blocks failed: %s", err)
		return nil
	}
	return ret
}

func readMirrorBlocksStrict(boxID string) (ret map[string][]string, err error) {
	ret = map[string][]string{}
	p := mirrorBlocksPath(boxID)
	if !filelock.IsExist(p) {
		return ret, nil
	}
	data, err := filelock.ReadFile(p)
	if err != nil {
		return nil, fmt.Errorf("read attribute view mirror [%s]: %w", p, err)
	}
	if boxID != "" {
		// 加密笔记本的镜像索引是密文，解密后再反序列化
		dec, decErr := decryptAVDataLocked(boxID, "mirror", data)
		if decErr != nil {
			return nil, fmt.Errorf("decrypt attribute view mirror [%s]: %w", p, decErr)
		}
		data = dec
	}
	if err = msgpack.Unmarshal(data, &ret); err != nil {
		return nil, fmt.Errorf("decode attribute view mirror [%s]: %w", p, err)
	}
	return ret, nil
}

// writeMirrorBlocks 按路径写入镜像索引。
// 加密笔记本的镜像索引写入前用 DEK 加密。
func writeMirrorBlocks(boxID string, data map[string][]string) error {
	p := mirrorBlocksPath(boxID)
	if err := os.MkdirAll(filepath.Dir(p), 0755); err != nil {
		return err
	}
	raw, err := msgpack.Marshal(data)
	if err != nil {
		return err
	}
	if boxID != "" {
		// 加密笔记本的镜像索引写入前加密
		enc, encErr := encryptAVDataLocked(boxID, "mirror", raw)
		if encErr != nil {
			return encErr
		}
		raw = enc
	}
	return filelock.WriteFile(p, raw)
}

func encryptAVData(boxID, avID string, data []byte) ([]byte, error) {
	if AVDEKProvider == nil {
		return data, nil
	}
	if AVLockAcquire != nil && AVLockRelease != nil {
		AVLockAcquire(boxID)
		defer AVLockRelease(boxID)
	}
	return encryptAVDataLocked(boxID, avID, data)
}

func encryptAVDataLocked(boxID, avID string, data []byte) ([]byte, error) {
	if AVDEKProvider == nil {
		return data, nil
	}
	dek, err := AVDEKProvider(boxID)
	if err != nil {
		return nil, err // 加密但未解锁，拒绝写盘避免明文泄漏
	}
	if dek == nil {
		return data, nil // 非加密 box
	}
	defer clear(dek)
	avKey := util.DeriveSubKey(dek, "siyuan/av")
	defer clear(avKey)
	aad := avAAD(boxID, avID)
	return util.EncryptWithAAD(avKey, data, []byte(aad))
}

func decryptAVData(boxID, avID string, data []byte) ([]byte, error) {
	if AVDEKProvider == nil {
		return data, nil
	}
	if AVLockAcquire != nil && AVLockRelease != nil {
		AVLockAcquire(boxID)
		defer AVLockRelease(boxID)
	}
	return decryptAVDataLocked(boxID, avID, data)
}

func decryptAVDataLocked(boxID, avID string, data []byte) ([]byte, error) {
	if AVDEKProvider == nil {
		return data, nil
	}
	dek, err := AVDEKProvider(boxID)
	if err != nil {
		return nil, err // 加密但未解锁，拒绝读盘
	}
	if dek == nil {
		return data, nil // 非加密 box
	}
	defer clear(dek)
	avKey := util.DeriveSubKey(dek, "siyuan/av")
	defer clear(avKey)
	aad := avAAD(boxID, avID)
	return util.DecryptWithAAD(avKey, data, []byte(aad))
}

func avAAD(boxID, avID string) string {
	switch avID {
	case "mirror":
		return "siyuan:v1:av-mirror:" + boxID
	case "relation":
		return "siyuan:v1:av-relation:" + boxID
	default:
		return "siyuan:v1:av:" + boxID + ":" + avID
	}
}

// EncryptAVData 是 encryptAVData 的导出版本，供 model 层（导入/复制数据库等）统一加密 AV 定义。
func EncryptAVData(boxID, avID string, data []byte) ([]byte, error) {
	return encryptAVData(boxID, avID, data)
}

// DecryptAVData 是 decryptAVData 的导出版本。
func DecryptAVData(boxID, avID string, data []byte) ([]byte, error) {
	return decryptAVData(boxID, avID, data)
}

// DecryptAVDataLocked 在调用方已持有对应 box 读锁时解密 AV 数据。
func DecryptAVDataLocked(boxID, avID string, data []byte) ([]byte, error) {
	return decryptAVDataLocked(boxID, avID, data)
}
