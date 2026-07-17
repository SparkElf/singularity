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
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"runtime/debug"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/88250/gulu"
	"github.com/88250/lute"
	"github.com/88250/lute/ast"
	"github.com/88250/lute/html"
	"github.com/88250/lute/parse"
	"github.com/siyuan-note/filelock"
	"github.com/siyuan-note/logging"
	"github.com/siyuan-note/siyuan/kernel/cache"
	"github.com/siyuan-note/siyuan/kernel/filesys"
	"github.com/siyuan-note/siyuan/kernel/sql"
	"github.com/siyuan-note/siyuan/kernel/task"
	"github.com/siyuan-note/siyuan/kernel/treenode"
	"github.com/siyuan-note/siyuan/kernel/util"
)

var (
	checkIndexOnce = sync.Once{}

	// fixIndexMu 保证 checkIndex 与 AutoFixIndex 互斥，不会并发跑同一套订正。
	fixIndexMu sync.Mutex
	// lastFixedAt 记录上次订正完成时间，用于 AutoFixIndex 的冷却期判断。
	lastFixedAt time.Time

	// indexRepairAfterResetHook 仅用于失败恢复测试，在重复树生成新身份后注入真实文件系统冲突。
	indexRepairAfterResetHook func(tree *parse.Tree)
)

const (
	// idleFixThreshold 为用户空闲超过该阈值后才允许触发空闲订正。
	idleFixThreshold = 7 * time.Minute
	// fixCooldown 为上次订正后至少间隔该时长才允许下一次空闲订正。
	fixCooldown = 120 * time.Minute
)

// checkIndex 自动校验数据库索引，仅在数据同步执行完成后执行一次。
// Index fixing should not be performed before data synchronization https://github.com/siyuan-note/siyuan/issues/10761
func checkIndex() {
	checkIndexOnce.Do(func() {
		if util.IsMobileContainer() {
			// 移动端不执行校验 https://ld246.com/article/1734939896061
			return
		}

		// 阻塞式获取锁：若 AutoFixIndex 正在跑则等其完成，确保唯一一次校验不会与之并发
		fixIndexMu.Lock()
		defer fixIndexMu.Unlock()

		if err := runFixIndexPipeline(); err != nil {
			logging.LogErrorf("fix index failed: %s", err)
		}
	})
}

// runFixIndexPipeline 执行索引订正流水线并完成收尾（清除脏标志、记录订正时间）。
// 调用方需持有 fixIndexMu。
func runFixIndexPipeline() error {
	databaseIndexOpMu.Lock()
	defer databaseIndexOpMu.Unlock()
	if err := fixIndexPipelineLocked(); err != nil {
		return err
	}
	// 收尾：清除脏标志并记录订正时间，避免在冷却期内被 AutoFixIndex 重复触发
	util.MarkIndexClean()
	lastFixedAt = time.Now()
	return nil
}

// fixIndexPipeline 执行索引订正流水线。
// 由 checkIndex（同步后一次性）与 AutoFixIndex（空闲触发）共用，调用方负责加 fixIndexMu 互斥锁。
func fixIndexPipelineLocked() error {
	logging.LogInfof("start fixing index...")

	removeDuplicateDatabaseIndex()
	if err := sql.FlushQueue(); err != nil {
		return fmt.Errorf("flush duplicate database index cleanup queue: %w", err)
	}

	resetDuplicateBlocksOnFileSys()
	if err := sql.FlushQueue(); err != nil {
		return fmt.Errorf("flush duplicate filesystem block cleanup queue: %w", err)
	}

	fixBlockTreeByFileSys()
	if err := sql.FlushQueue(); err != nil {
		return fmt.Errorf("flush blocktree repair queue: %w", err)
	}

	fixDatabaseIndexByBlockTree()
	if err := sql.FlushQueue(); err != nil {
		return fmt.Errorf("flush database index repair queue: %w", err)
	}

	removeDuplicateDatabaseRefs()

	// 后面要加任务的话记得修改推送任务栏的进度 util.PushStatusBar(fmt.Sprintf(Conf.Language(58), 1, 5))

	debug.FreeOSMemory()
	util.PushStatusBar(Conf.Language(185))
	logging.LogInfof("finish fixing index")
	return nil
}

// AutoFixIndex 在用户空闲且存在未订正变更时，自动订正索引。由 cron 每分钟调用。
// 触发需同时满足：空闲达 idleFixThreshold、存在未订正变更（dirty）、冷却期已过。
func AutoFixIndex() {
	defer logging.Recover()

	if util.IsMobileContainer() {
		return
	}
	if !util.IsIdle(idleFixThreshold) {
		return
	}
	if !util.IsIndexFixDirty() {
		return
	}
	if !lastFixedAt.IsZero() && time.Since(lastFixedAt) < fixCooldown {
		return
	}
	// TryLock 非阻塞：若 checkIndex 正在跑或上次还没跑完，直接跳过，不堆积 goroutine
	if !fixIndexMu.TryLock() {
		return
	}
	defer fixIndexMu.Unlock()

	// double-check：拿到锁后再确认一次确实空闲，避免在等待锁期间用户又开始操作
	if !util.IsIdle(idleFixThreshold) {
		return
	}

	logging.LogInfof("start auto fixing index on idle...")
	if err := runFixIndexPipeline(); err != nil {
		logging.LogErrorf("auto fix index failed: %s", err)
		return
	}
	logging.LogInfof("finish auto fixing index on idle")
}

// removeDuplicateDatabaseRefs 删除重复的数据库引用关系。
func removeDuplicateDatabaseRefs() {
	defer logging.Recover()

	util.PushStatusBar(fmt.Sprintf(Conf.Language(58), 5, 5))
	forEachOpenContentStore(removeDuplicateDatabaseRefsInBox)
}

func removeDuplicateDatabaseRefsInBox(boxID string) {
	duplicatedRootIDs := sql.GetRefDuplicatedDefRootIDsInBox(boxID)
	for _, rootID := range duplicatedRootIDs {
		refreshRefsByDefIDInBox(rootID, boxID)
	}

	for _, rootID := range duplicatedRootIDs {
		logging.LogWarnf("exist more than one ref duplicated [%s], reindex it", rootID)
	}
}

// removeDuplicateDatabaseIndex 删除重复的数据库索引。
func removeDuplicateDatabaseIndex() {
	defer logging.Recover()

	util.PushStatusBar(fmt.Sprintf(Conf.Language(58), 1, 5))
	forEachOpenContentStore(removeDuplicateDatabaseIndexInBox)
}

func removeDuplicateDatabaseIndexInBox(boxID string) {
	duplicatedRootIDs := sql.GetDuplicatedRootIDsInBox("blocks", boxID)
	if 1 > len(duplicatedRootIDs) {
		duplicatedRootIDs = sql.GetDuplicatedRootIDsInBox("blocks_fts", boxID)
	}

	roots := sql.GetBlocksInBox(duplicatedRootIDs, boxID)
	rootMap := map[string]*sql.Block{}
	for _, root := range roots {
		if nil == root {
			continue
		}
		rootMap[root.ID] = root
	}

	var toRemoveRootIDs []string
	var deletes int
	for _, rootID := range duplicatedRootIDs {
		root := rootMap[rootID]
		if nil == root {
			continue
		}
		deletes++
		toRemoveRootIDs = append(toRemoveRootIDs, rootID)
		if util.IsExiting.Load() {
			break
		}
	}
	toRemoveRootIDs = gulu.Str.RemoveDuplicatedElem(toRemoveRootIDs)
	if err := sql.BatchRemoveTreeQueueInBox(toRemoveRootIDs, boxID); err != nil {
		logging.LogErrorf("persist duplicate tree cleanup queue for box [%s] failed: %s", boxID, err)
		return
	}

	if 0 < deletes {
		logging.LogWarnf("exist more than one tree duplicated [%d], reindex it", deletes)
	}
}

// resetDuplicateBlocksOnFileSys 重置重复 ID 的块。 https://github.com/siyuan-note/siyuan/issues/7357
func resetDuplicateBlocksOnFileSys() {
	defer logging.Recover()

	util.PushStatusBar(fmt.Sprintf(Conf.Language(58), 2, 5))
	boxes := Conf.GetBoxes()
	luteEngine := lute.New()
	blockIDs := map[derivedObjectIdentity]bool{}
	needRefreshUI := false
	for _, box := range boxes {
		// 关闭的加密笔记本无法解密 .sy，跳过（避免密文被当损坏移走）
		if IsEncryptedBox(box.ID) && !IsBoxUnlocked(box.ID) {
			continue
		}
		// 校验索引阶段自动删除历史遗留的笔记本 history 文件夹
		legacyHistory := filepath.Join(util.DataDir, box.ID, ".siyuan", "history")
		if gulu.File.IsDir(legacyHistory) {
			if removeErr := os.RemoveAll(legacyHistory); nil != removeErr {
				logging.LogErrorf("remove legacy history failed: %s", removeErr)
			} else {
				logging.LogInfof("removed legacy history [%s]", legacyHistory)
			}
		}

		boxPath := filepath.Join(util.DataDir, box.ID)
		var duplicatedTrees []*parse.Tree
		filelock.Walk(boxPath, func(path string, d fs.DirEntry, err error) error {
			if err != nil || nil == d {
				return nil
			}

			if d.IsDir() {
				if boxPath == path {
					// 跳过笔记本文件夹
					return nil
				}

				if strings.HasPrefix(d.Name(), ".") {
					return filepath.SkipDir
				}

				if !ast.IsNodeIDPattern(d.Name()) {
					return nil
				}
				return nil
			}

			if filepath.Ext(path) != ".sy" || strings.Contains(filepath.ToSlash(path), "/assets/") {
				return nil
			}

			if !ast.IsNodeIDPattern(strings.TrimSuffix(d.Name(), ".sy")) {
				logging.LogWarnf("invalid .sy file name [%s]", path)
				box.moveCorruptedData(path)
				return nil
			}

			p := path[len(boxPath):]
			p = filepath.ToSlash(p)
			tree, loadErr := filesys.LoadTree(box.ID, p, luteEngine)
			if nil != loadErr {
				logging.LogErrorf("load tree [%s] failed: %s", p, loadErr)
				return nil
			}

			needOverwrite := false
			ast.Walk(tree.Root, func(n *ast.Node, entering bool) ast.WalkStatus {
				if !entering || !n.IsBlock() {
					return ast.WalkContinue
				}

				if "" == n.ID {
					needOverwrite = true
					treenode.ResetNodeID(n)
					return ast.WalkContinue
				}

				identity := derivedObjectIdentity{boxID: attributeViewStoreBoxID(box.ID), objectID: n.ID}
				if !blockIDs[identity] {
					blockIDs[identity] = true
					return ast.WalkContinue
				}

				// 存在重复的块 ID

				if ast.NodeDocument == n.Type {
					// 如果是文档根节点，则重置这颗树
					// 这里不能在迭代中重置，因为如果这个文档存在子文档的话，重置时会重命名子文档文件夹，后续迭代可能会导致子文档 ID 重复
					duplicatedTrees = append(duplicatedTrees, tree)
					return ast.WalkStop
				}

				// 其他情况，重置节点 ID
				needOverwrite = true
				treenode.ResetNodeID(n)
				needRefreshUI = true
				return ast.WalkContinue
			})

			if needOverwrite {
				logging.LogWarnf("exist more than one node with the same id in tree [%s], reset it", box.ID+p)
				if writeErr := writeTreeUpsertQueue(tree); writeErr != nil {
					logging.LogErrorf("write tree [%s] failed: %s", p, writeErr)
				}
			}
			return nil
		})

		for _, tree := range duplicatedTrees {
			absPath := filepath.Join(boxPath, tree.Path)
			logging.LogWarnf("exist more than one tree with the same id [%s], reset it", absPath)
			if err := recreateTree(tree, absPath); err != nil {
				logging.LogWarnf("recreate duplicate tree [%s] failed: %s", absPath, err)
			} else {
				needRefreshUI = true
			}
		}
	}

	if needRefreshUI {
		util.ReloadUI()
		task.AppendAsyncTaskWithDelay(task.PushMsg, 3*time.Second, util.PushMsg, Conf.Language(190), 5000)
	}
}

func recreateTree(tree *parse.Tree, absPath string) error {
	oldRootID := tree.ID
	oldPath := tree.Path
	resetTree(tree, "", true)
	if indexRepairAfterResetHook != nil {
		indexRepairAfterResetHook(tree)
	}

	token := acquireContentCommitToken(tree.Box)
	defer token.release()

	oldState, err := captureTreeContentState(tree.Box, oldRootID, oldPath)
	if err != nil {
		return fmt.Errorf("snapshot duplicate tree [%s/%s]: %w", tree.Box, oldPath, err)
	}
	oldRootIDs := []string{oldRootID}
	seenOldRoots := map[string]struct{}{oldRootID: {}}
	for _, blockTree := range treenode.GetBlockTreesByPathPrefix(tree.Box, strings.TrimSuffix(oldPath, ".sy")) {
		if _, seen := seenOldRoots[blockTree.RootID]; seen {
			continue
		}
		seenOldRoots[blockTree.RootID] = struct{}{}
		oldRootIDs = append(oldRootIDs, blockTree.RootID)
	}
	absPath = oldState.absPath
	newCommit, err := prepareTreeContentCommit(tree)
	if err != nil {
		return fmt.Errorf("prepare recreated tree [%s/%s]: %w", tree.Box, tree.Path, err)
	}

	childrenFrom := strings.TrimSuffix(absPath, ".sy")
	childrenTo := filepath.Join(filepath.Dir(absPath), tree.ID)
	renamedChildren := false
	tombstonePath := filepath.Join(filepath.Dir(absPath), "."+filepath.Base(absPath)+"."+tree.ID+".recreate-tombstone")
	tombstonedOldFile := false
	oldCachesRemoved := false
	var oldBlocktrees *treenode.BlockTreeBatchSnapshot
	rollback := func(cause error) error {
		var oldBlocktreeErr error
		if oldBlocktrees != nil {
			oldBlocktreeErr = oldBlocktrees.Restore()
		}

		var tombstoneErr error
		if tombstonedOldFile {
			tombstoneErr = filelock.RenameWithoutFatal(tombstonePath, absPath)
			if tombstoneErr != nil {
				tombstoneErr = errors.Join(tombstoneErr, oldState.restoreFile())
			}
		}
		var childrenErr error
		if renamedChildren {
			childrenErr = os.Rename(childrenTo, childrenFrom)
		}
		if oldCachesRemoved {
			oldState.restoreCaches()
		}
		return errors.Join(cause, oldBlocktreeErr, tombstoneErr, childrenErr, newCommit.rollback())
	}

	if gulu.File.IsDir(childrenFrom) {
		// 重命名子文档文件夹
		if renameErr := os.Rename(childrenFrom, childrenTo); nil != renameErr {
			return rollback(fmt.Errorf("rename duplicate tree children [%s] to [%s]: %w", childrenFrom, childrenTo, renameErr))
		}
		renamedChildren = true
	}

	if err = filelock.RenameWithoutFatal(absPath, tombstonePath); err != nil {
		return rollback(fmt.Errorf("tombstone duplicate tree [%s]: %w", absPath, err))
	}
	tombstonedOldFile = true
	oldBlocktrees, err = treenode.RemoveBlockTreeRoots(tree.Box, oldRootIDs)
	if err != nil {
		return rollback(fmt.Errorf("remove replaced blocktrees for tree [%s/%s]: %w", tree.Box, oldPath, err))
	}
	cache.RemoveTreeDataInBox(oldRootID, tree.Box)
	cache.RemoveDocIALInBox(oldPath, tree.Box)
	oldCachesRemoved = true

	runContentCommitBeforeEnqueueHook(tree)
	if err = token.queueAdmission.UpsertTreeQueue(tree); err != nil {
		return rollback(err)
	}
	if contentCommitAfterEnqueueHook != nil {
		contentCommitAfterEnqueueHook(tree)
	}
	if err = filelock.Remove(tombstonePath); err != nil && !os.IsNotExist(err) {
		logging.LogWarnf("remove committed duplicate tree tombstone [%s] failed: %s", tombstonePath, err)
	}
	refreshDocInfoWithSize(tree, newCommit.size)
	return nil
}

// fixBlockTreeByFileSys 通过文件系统订正块树。
func fixBlockTreeByFileSys() {
	defer logging.Recover()

	util.PushStatusBar(fmt.Sprintf(Conf.Language(58), 3, 5))
	boxes := Conf.GetOpenedBoxes()
	luteEngine := lute.New()
	for _, box := range boxes {
		boxPath := filepath.Join(util.DataDir, box.ID)
		var paths []string
		filelock.Walk(boxPath, func(path string, d fs.DirEntry, err error) error {
			if nil != err || nil == d {
				return nil
			}

			if boxPath == path {
				// 跳过根路径（笔记本文件夹）
				return nil
			}

			if d.IsDir() {
				if strings.HasPrefix(d.Name(), ".") {
					return filepath.SkipDir
				}
				return nil
			}

			if filepath.Ext(path) != ".sy" || strings.Contains(filepath.ToSlash(path), "/assets/") {
				return nil
			}

			p := path[len(boxPath):]
			p = filepath.ToSlash(p)
			paths = append(paths, p)
			return nil
		})

		size := len(paths)

		// 清理块树中的冗余数据
		if err := treenode.ClearRedundantBlockTrees(box.ID, paths); err != nil {
			logging.LogErrorf("clear redundant blocktrees for notebook [%s] failed: %s", box.ID, err)
			continue
		}

		// 重新索引缺失的块树
		missingPaths, err := treenode.GetNotExistPaths(box.ID, paths)
		if err != nil {
			logging.LogErrorf("list missing blocktrees for notebook [%s] failed: %s", box.ID, err)
			continue
		}
		for i, p := range missingPaths {
			id := path.Base(p)
			id = strings.TrimSuffix(id, ".sy")
			if !ast.IsNodeIDPattern(id) {
				continue
			}

			reindexTreeByPath(box.ID, p, i, size, luteEngine)
			if util.IsExiting.Load() {
				break
			}
		}

		if util.IsExiting.Load() {
			break
		}
	}

	// 清理已关闭的笔记本块树
	boxes = Conf.GetClosedBoxes()
	for _, box := range boxes {
		if _, err := treenode.RemoveBlockTreesByBoxID(box.ID); err != nil {
			logging.LogErrorf("remove closed notebook blocktrees [%s] failed: %s", box.ID, err)
		}
	}
}

// fixDatabaseIndexByBlockTree 通过块树订正数据库索引。
func fixDatabaseIndexByBlockTree() {
	defer logging.Recover()

	util.PushStatusBar(fmt.Sprintf(Conf.Language(58), 4, 5))
	forEachOpenContentStore(fixDatabaseIndexByBlockTreeInBox)
}

func fixDatabaseIndexByBlockTreeInBox(boxID string) {
	rootUpdatedMap := treenode.GetRootUpdatedInBox(boxID)
	dbRootUpdatedMap, err := sql.GetRootUpdatedInBox(boxID)
	if err == nil {
		reindexTreeByUpdated(rootUpdatedMap, dbRootUpdatedMap, boxID)
	}
}

func reindexTreeByUpdated(rootUpdatedMap, dbRootUpdatedMap map[string]string, boxID string) {
	i := -1
	size := len(rootUpdatedMap)
	luteEngine := util.NewLute()
	for rootID, updated := range rootUpdatedMap {
		i++

		if util.IsExiting.Load() {
			break
		}

		rootUpdated := dbRootUpdatedMap[rootID]
		if "" == rootUpdated {
			//logging.LogWarnf("not found tree [%s] in database, reindex it", rootID)
			reindexTreeInBox(rootID, boxID, i, size, luteEngine)
			continue
		}

		if "" == updated {
			// BlockTree 迁移，v2.6.3 之前没有 updated 字段
			reindexTreeInBox(rootID, boxID, i, size, luteEngine)
			continue
		}

		btUpdated, _ := time.Parse("20060102150405", updated)
		dbUpdated, _ := time.Parse("20060102150405", rootUpdated)
		if dbUpdated.Before(btUpdated.Add(-10 * time.Minute)) {
			logging.LogWarnf("tree [%s] is not up to date, reindex it", rootID)
			reindexTreeInBox(rootID, boxID, i, size, luteEngine)
			continue
		}

		if util.IsExiting.Load() {
			break
		}
	}

	var rootIDs []string
	for rootID := range dbRootUpdatedMap {
		if _, ok := rootUpdatedMap[rootID]; !ok {
			rootIDs = append(rootIDs, rootID)
		}

		if util.IsExiting.Load() {
			break
		}
	}
	rootIDs = gulu.Str.RemoveDuplicatedElem(rootIDs)
	roots := map[string]*sql.Block{}
	blocks := sql.GetBlocksInBox(rootIDs, boxID)
	for _, block := range blocks {
		roots[block.RootID] = block
	}
	var toRemoveRootIDs []string
	for id, root := range roots {
		if nil == root {
			continue
		}

		toRemoveRootIDs = append(toRemoveRootIDs, id)
		if util.IsExiting.Load() {
			break
		}
	}
	toRemoveRootIDs = gulu.Str.RemoveDuplicatedElem(toRemoveRootIDs)
	//logging.LogWarnf("tree [%s] is not in block tree, remove it from [%s]", id, root.Box)
	if err := sql.BatchRemoveTreeQueueInBox(toRemoveRootIDs, boxID); err != nil {
		logging.LogErrorf("persist stale tree cleanup queue for box [%s] failed: %s", boxID, err)
	}
}

func forEachOpenContentStore(action func(boxID string)) {
	action("")
	boxIDs := treenode.GetOpenedEncryptedBoxIDs()
	sort.Strings(boxIDs)
	for _, boxID := range boxIDs {
		func() {
			acquireBoxOperationLock(boxID)
			defer releaseBoxOperationLock(boxID)
			if IsBoxUnlocked(boxID) {
				action(boxID)
			}
		}()
	}
}

func reindexTreeByPath(box, p string, i, size int, luteEngine *lute.Lute) {
	commitToken := acquireContentCommitToken(box)
	tree, err := filesys.LoadTreeInBoxLocked(box, p, luteEngine)
	if err != nil {
		commitToken.release()
		return
	}

	refreshSize, refresh, reindexErr := reindexTree0(tree, i, size, commitToken)
	if refresh {
		refreshDocInfoWithSize(tree, refreshSize)
	}
	commitToken.release()
	if reindexErr != nil {
		logging.LogErrorf("persist reindex queue entry for tree [%s/%s] failed: %s", tree.Box, tree.Path, reindexErr)
	}
}

func reindexTreeInBox(rootID, boxID string, i, size int, luteEngine *lute.Lute) {
	root := treenode.GetBlockTreeInBox(rootID, boxID)
	if nil == root {
		logging.LogWarnf("root block [%s] not found", rootID)
		return
	}

	commitToken := acquireContentCommitToken(root.BoxID)
	tree, err := filesys.LoadTreeInBoxLocked(root.BoxID, root.Path, luteEngine)
	if err != nil {
		if os.IsNotExist(err) {
			// 文件系统上没有找到该 .sy 文件，则订正块树
			if removeErr := treenode.RemoveBlockTreesByRootID(root.BoxID, rootID); removeErr != nil {
				logging.LogErrorf("remove missing tree blocktree [%s/%s] failed: %s", root.BoxID, rootID, removeErr)
			}
		}
		commitToken.release()
		return
	}

	refreshSize, refresh, reindexErr := reindexTree0(tree, i, size, commitToken)
	if refresh {
		refreshDocInfoWithSize(tree, refreshSize)
	}
	commitToken.release()
	if reindexErr != nil {
		logging.LogErrorf("persist reindex queue entry for tree [%s/%s] failed: %s", tree.Box, tree.Path, reindexErr)
	}
}

func reindexTree0(tree *parse.Tree, i, size int, commitToken *contentCommitToken) (refreshSize uint64, refresh bool, err error) {
	updated := tree.Root.IALAttr("updated")
	if "" == updated {
		updated = util.TimeFromID(tree.Root.ID)
		tree.Root.SetIALAttr("updated", updated)
		refreshSize, err = indexWriteTreeUpsertQueueInCommit(tree, commitToken)
		refresh = err == nil
	} else {
		if err = treenode.UpsertBlockTree(tree); err != nil {
			return
		}
		runContentCommitBeforeEnqueueHook(tree)
		err = commitToken.queueAdmission.IndexTreeQueue(tree)
	}

	if 0 == i%64 {
		util.PushStatusBar(fmt.Sprintf(Conf.Language(183), i, size, html.EscapeString(path.Base(tree.HPath))))
	}
	return
}
