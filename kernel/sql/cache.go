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

package sql

import (
	"strings"
	"sync"
	"time"

	"github.com/88250/lute/ast"
	"github.com/88250/lute/parse"
	"github.com/dgraph-io/ristretto"
	"github.com/jinzhu/copier"
	gcache "github.com/patrickmn/go-cache"
	"github.com/siyuan-note/logging"
	"github.com/siyuan-note/siyuan/kernel/search"
)

var cacheDisabled = true

var blockCacheStateMu sync.Mutex
var blockCacheEpoch uint64

// blockCacheAfterQueryHook 仅用于并发合同测试，在块查询完成后、尝试写回缓存前暂停。
var blockCacheAfterQueryHook func(id string)

func enableCache() {
	blockCacheStateMu.Lock()
	cacheDisabled = false
	blockCacheStateMu.Unlock()
}

func disableCache() {
	blockCacheStateMu.Lock()
	cacheDisabled = true
	blockCacheStateMu.Unlock()
}

var blockCache, _ = ristretto.NewCache(&ristretto.Config{
	NumCounters: 100000,
	MaxCost:     10240,
	BufferItems: 64,
	OnExit: func(value any) {
		if entry, ok := value.(*blockCacheEntry); ok {
			removeBlockCacheKey(entry.block.ID, entry.key)
		}
	},
})

var blockCacheKeys = map[string]map[string]struct{}{}
var blockCacheKeysMu sync.Mutex

type blockCacheEntry struct {
	key   string
	block *Block
}

func contentStoreBoxID(boxID string) string {
	if IsEncryptedBoxFn != nil && IsEncryptedBoxFn(boxID) {
		return boxID
	}
	return ""
}

// blockCacheKey 为加密笔记本使用 box 维度缓存键；普通笔记本统一使用全局内容库键。
func blockCacheKey(id, boxID string) string {
	if contentStore := contentStoreBoxID(boxID); contentStore != "" {
		return contentStore + "\x00" + id
	}
	return id
}

func ClearCache() {
	clearBlockCache()
	clearRefCache()
}

func clearBlockCache() {
	blockCacheStateMu.Lock()
	defer blockCacheStateMu.Unlock()
	blockCacheEpoch++
	blockCache.Clear()
	blockCacheKeysMu.Lock()
	blockCacheKeys = map[string]map[string]struct{}{}
	blockCacheKeysMu.Unlock()
}

func putBlockCache(block *Block) {
	putBlockCacheAtEpoch(block, 0, false)
}

func blockCacheQueryEpoch() uint64 {
	blockCacheStateMu.Lock()
	defer blockCacheStateMu.Unlock()
	return blockCacheEpoch
}

func putBlockCacheFromQuery(block *Block, queryEpoch uint64) {
	putBlockCacheAtEpoch(block, queryEpoch, true)
}

func putBlockCacheAtEpoch(block *Block, queryEpoch uint64, requireCurrentEpoch bool) {
	if block == nil {
		return
	}

	cloned := &Block{}
	if err := copier.Copy(cloned, block); err != nil {
		logging.LogErrorf("clone block failed: %v", err)
		return
	}
	cloned.Content = strings.ReplaceAll(cloned.Content, search.SearchMarkLeft, "")
	cloned.Content = strings.ReplaceAll(cloned.Content, search.SearchMarkRight, "")

	blockCacheStateMu.Lock()
	defer blockCacheStateMu.Unlock()
	if cacheDisabled || (requireCurrentEpoch && queryEpoch != blockCacheEpoch) {
		return
	}
	key := blockCacheKey(cloned.ID, cloned.Box)
	addBlockCacheKey(cloned.ID, key)
	if !blockCache.Set(key, &blockCacheEntry{key: key, block: cloned}, 1) {
		removeBlockCacheKey(cloned.ID, key)
	}
}

func getBlockCache(id string) (ret *Block) {
	return getBlockCacheInBox(id, "")
}

func getBlockCacheInBox(id, boxID string) (ret *Block) {
	blockCacheStateMu.Lock()
	defer blockCacheStateMu.Unlock()
	if cacheDisabled {
		return
	}

	b, _ := blockCache.Get(blockCacheKey(id, boxID))
	if nil != b {
		if entry, ok := b.(*blockCacheEntry); ok {
			ret = entry.block
		}
	}
	return
}

func removeBlockCache(id string) {
	blockCacheStateMu.Lock()
	defer blockCacheStateMu.Unlock()
	blockCacheEpoch++
	removeBlockCacheEntry(id)
}

func removeBlockCacheEntries(ids []string) {
	if len(ids) == 0 {
		return
	}
	blockCacheStateMu.Lock()
	defer blockCacheStateMu.Unlock()
	blockCacheEpoch++
	for _, id := range ids {
		removeBlockCacheEntry(id)
	}
}

func removeBlockCacheEntry(id string) {
	blockCacheKeysMu.Lock()
	keys := blockCacheKeys[id]
	delete(blockCacheKeys, id)
	blockCacheKeysMu.Unlock()
	for key := range keys {
		blockCache.Del(key)
	}
}

func addBlockCacheKey(id, key string) {
	blockCacheKeysMu.Lock()
	defer blockCacheKeysMu.Unlock()
	keys := blockCacheKeys[id]
	if keys == nil {
		keys = map[string]struct{}{}
		blockCacheKeys[id] = keys
	}
	keys[key] = struct{}{}
}

func removeBlockCacheKey(id, key string) {
	blockCacheKeysMu.Lock()
	defer blockCacheKeysMu.Unlock()
	if keys := blockCacheKeys[id]; keys != nil {
		delete(keys, key)
		if len(keys) == 0 {
			delete(blockCacheKeys, id)
		}
	}
}

var defIDRefsCache = gcache.New(30*time.Minute, 5*time.Minute)
var refCacheMu sync.Mutex
var refCacheEpoch uint64
var refCacheVersions = map[string]uint64{}

// refCacheAfterQueryHook 仅用于并发合同测试，在冷查询完成后、尝试写回缓存前暂停。
var refCacheAfterQueryHook func(key string)

func refCacheKey(defBlockID, boxID string) string {
	return contentStoreBoxID(boxID) + "\x00" + defBlockID
}

func GetRefsCacheByDefID(defID string) (ret []*Ref) {
	return GetRefsCacheByDefIDInBox(defID, "")
}

func GetRefsCacheByDefIDInBox(defID, boxID string) (ret []*Ref) {
	contentStore := contentStoreBoxID(boxID)
	key := refCacheKey(defID, contentStore)
	refCacheMu.Lock()
	if refs, ok := defIDRefsCache.Get(key); ok {
		for _, ref := range refs.(map[string]*Ref) {
			ret = append(ret, ref)
		}
		refCacheMu.Unlock()
		return
	}
	epoch, version := refCacheEpoch, refCacheVersions[key]
	refCacheMu.Unlock()

	ret = QueryRefsByDefIDInBox(defID, false, contentStore)
	if refCacheAfterQueryHook != nil {
		refCacheAfterQueryHook(key)
	}
	if len(ret) > 0 {
		refsByBlock := make(map[string]*Ref, len(ret))
		for _, ref := range ret {
			refsByBlock[ref.BlockID] = ref
		}
		refCacheMu.Lock()
		if refCacheEpoch == epoch && refCacheVersions[key] == version {
			defIDRefsCache.SetDefault(key, refsByBlock)
		}
		refCacheMu.Unlock()
	}
	return
}

func CacheRef(tree *parse.Tree, refNode *ast.Node) {
	ref := buildRef(tree, refNode)
	putRefCache(tree.Box, ref)
}

func putRefCache(boxID string, ref *Ref) {
	key := refCacheKey(ref.DefBlockID, boxID)
	refCacheMu.Lock()
	defer refCacheMu.Unlock()
	refCacheVersions[key]++
	defBlockRefs, ok := defIDRefsCache.Get(key)
	if !ok {
		defBlockRefs = map[string]*Ref{}
	}
	defBlockRefs.(map[string]*Ref)[ref.BlockID] = ref
	defIDRefsCache.SetDefault(key, defBlockRefs)
}

func removeRefCacheByDefIDInBox(defID, boxID string) {
	key := refCacheKey(defID, boxID)
	refCacheMu.Lock()
	refCacheVersions[key]++
	defIDRefsCache.Delete(key)
	refCacheMu.Unlock()
}

func clearRefCache() {
	refCacheMu.Lock()
	defer refCacheMu.Unlock()
	refCacheEpoch++
	refCacheVersions = map[string]uint64{}
	defIDRefsCache.Flush()
}
