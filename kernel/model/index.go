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
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"strings"
	"sync"
	"time"

	"github.com/88250/go-humanize"
	"github.com/88250/gulu"
	"github.com/88250/lute/ast"
	"github.com/88250/lute/editor"
	"github.com/88250/lute/html"
	"github.com/88250/lute/parse"
	"github.com/panjf2000/ants/v2"
	"github.com/siyuan-note/eventbus"
	"github.com/siyuan-note/filelock"
	"github.com/siyuan-note/logging"
	"github.com/siyuan-note/siyuan/kernel/av"
	"github.com/siyuan-note/siyuan/kernel/cache"
	"github.com/siyuan-note/siyuan/kernel/filesys"
	"github.com/siyuan-note/siyuan/kernel/sql"
	"github.com/siyuan-note/siyuan/kernel/task"
	"github.com/siyuan-note/siyuan/kernel/treenode"
	"github.com/siyuan-note/siyuan/kernel/util"
)

func UpsertIndexes(paths []string) error {
	databaseIndexOpMu.Lock()
	defer databaseIndexOpMu.Unlock()

	var syFiles []string
	for _, p := range paths {
		if strings.HasSuffix(p, "/") {
			listed, err := listSyFiles(p)
			if err != nil {
				return err
			}
			syFiles = append(syFiles, listed...)
			continue
		}

		if strings.HasSuffix(p, ".sy") {
			syFiles = append(syFiles, p)
		}
	}

	syFiles = gulu.Str.RemoveDuplicatedElem(syFiles)
	_, err := upsertIndexesLocked(syFiles)
	return err
}

func RemoveIndexes(paths []string) error {
	databaseIndexOpMu.Lock()
	defer databaseIndexOpMu.Unlock()

	var syFiles []string
	for _, p := range paths {
		if strings.HasSuffix(p, "/") {
			listed, err := listSyFiles(p)
			if err != nil {
				return err
			}
			syFiles = append(syFiles, listed...)
			continue
		}

		if strings.HasSuffix(p, ".sy") {
			syFiles = append(syFiles, p)
		}
	}

	syFiles = gulu.Str.RemoveDuplicatedElem(syFiles)
	_, err := removeIndexesLocked(syFiles)
	return err
}

func listSyFiles(dir string) (ret []string, err error) {
	dirPath := filepath.Join(util.DataDir, dir)
	err = filelock.Walk(dirPath, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}

		if d.IsDir() {
			return nil
		}

		if strings.HasSuffix(path, ".sy") {
			p := filepath.ToSlash(strings.TrimPrefix(path, util.DataDir))
			ret = append(ret, p)
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("walk notebook index directory [%s]: %w", dirPath, err)
	}
	return ret, nil
}

var databaseIndexOpMu sync.Mutex

func (box *Box) Unindex() error {
	databaseIndexOpMu.Lock()
	defer databaseIndexOpMu.Unlock()

	if err := unindexLocked(box.ID); err != nil {
		return err
	}
	if err := sql.FlushQueue(); err != nil {
		return fmt.Errorf("flush notebook unindex queue [%s]: %w", box.ID, err)
	}
	ResetVirtualBlockRefCache()
	return nil
}

func unindexLocked(boxID string) error {
	token := acquireContentCommitToken(boxID)
	defer token.release()
	blocktreeSnapshot, err := treenode.RemoveBlockTreeBox(boxID)
	if err != nil {
		return fmt.Errorf("remove notebook blocktrees [%s]: %w", boxID, err)
	}
	if err := token.queueAdmission.DeleteBoxQueue(boxID); err != nil {
		return errors.Join(fmt.Errorf("persist notebook unindex queue [%s]: %w", boxID, err), blocktreeSnapshot.Restore())
	}
	return nil
}

func (box *Box) Index() error {
	databaseIndexOpMu.Lock()
	defer databaseIndexOpMu.Unlock()
	openedBoxes, err := listOpenedBoxesStrict()
	if err != nil {
		return fmt.Errorf("list opened notebooks before indexing [%s]: %w", box.ID, err)
	}
	var openedBox *Box
	for _, candidate := range openedBoxes {
		if candidate.ID == box.ID {
			openedBox = candidate
			break
		}
	}
	if openedBox == nil {
		return fmt.Errorf("index notebook [%s]: %w", box.ID, ErrBoxUnindexed)
	}

	if err = indexBoxLocked(openedBox, len(openedBoxes)); err != nil {
		return err
	}
	if err = indexRefsWithResetLocked([]*Box{openedBox}, openedBox.ID); err != nil {
		return err
	}
	if err = sql.FlushQueue(); err != nil {
		return fmt.Errorf("flush notebook index queue [%s]: %w", openedBox.ID, err)
	}
	openedBox.UpdateHistoryGenerated()
	ResetVirtualBlockRefCache()
	return nil
}

func indexBoxLocked(box *Box, openedBoxCount int) error {
	return indexBoxWithQueueBatchLocked(box, openedBoxCount, nil)
}

func indexBoxWithQueueBatchLocked(box *Box, openedBoxCount int, queueBatch *sql.QueueBatch) error {
	if nil == box {
		return fmt.Errorf("index notebook: %w", ErrBoxNotFound)
	}

	util.SetBootDetails(Conf.Language(303))
	files, err := listFilesForIndex(box)
	if err != nil {
		return fmt.Errorf("list notebook [%s] files for indexing: %w", box.ID, err)
	}
	boxLen := max(1, openedBoxCount)
	var bootProgressPart int32
	if len(files) > 0 {
		bootProgressPart = int32(30.0 / float64(boxLen) / float64(len(files)))
	}

	start := time.Now()
	luteEngine := util.NewLute()
	var treeCount int
	var treeSize int64
	lock := sync.Mutex{}
	var indexErr error
	recordIndexError := func(err error) {
		lock.Lock()
		if indexErr == nil {
			indexErr = err
		}
		lock.Unlock()
	}
	util.PushStatusBar(fmt.Sprintf("["+html.EscapeString(box.Name)+"] "+Conf.Language(64), len(files)))

	poolSize := min(runtime.NumCPU(), 4)
	waitGroup := &sync.WaitGroup{}
	var avNodes []*ast.Node
	p, poolErr := ants.NewPoolWithFunc(poolSize, func(arg any) {
		defer waitGroup.Done()

		file := arg.(*FileInfo)
		lock.Lock()
		treeSize += file.size
		treeCount++
		i := treeCount
		lock.Unlock()
		commitToken := acquireIndexContentCommitToken(box.ID, queueBatch)
		defer commitToken.release()
		tree, err := filesys.LoadTreeInBoxLocked(box.ID, file.path, luteEngine)
		if err != nil {
			recordIndexError(fmt.Errorf("read box [%s] tree [%s]: %w", box.ID, file.path, err))
			logging.LogErrorf("read box [%s] tree [%s] failed: %s", box.ID, file.path, err)
			return
		}

		previousBlockTree := treenode.GetBlockTreeInBox(tree.ID, tree.Box)
		var previousData []byte
		treeRewritten := false
		docIAL := parse.IAL2Map(tree.Root.KramdownIAL)
		if "" == docIAL["updated"] { // 早期的数据可能没有 updated 属性，这里进行订正
			absPath := filepath.Join(util.DataDir, tree.Box, filepath.FromSlash(strings.TrimPrefix(tree.Path, "/")))
			previousData, err = filelock.ReadFile(absPath)
			if err != nil {
				recordIndexError(fmt.Errorf("read tree before index repair [%s/%s]: %w", tree.Box, tree.Path, err))
				return
			}
			updated := util.TimeFromID(tree.Root.ID)
			tree.Root.SetIALAttr("updated", updated)
			docIAL["updated"] = updated
			if _, writeErr := filesys.WriteTreeInBoxLocked(tree); nil != writeErr {
				recordIndexError(fmt.Errorf("write tree [%s/%s]: %w", tree.Box, tree.Path, writeErr))
				logging.LogErrorf("write tree [%s] failed: %s", tree.Path, writeErr)
				return
			}
			treeRewritten = true
		}

		restorePrevious := func(cause error) error {
			var restoreFileErr error
			if treeRewritten {
				absPath := filepath.Join(util.DataDir, tree.Box, filepath.FromSlash(strings.TrimPrefix(tree.Path, "/")))
				restoreFileErr = filelock.WriteFile(absPath, previousData)
				cache.RemoveTreeDataInBox(tree.ID, tree.Box)
			}

			var restoreBlockTreeErr error
			if previousBlockTree == nil {
				restoreBlockTreeErr = treenode.RemoveBlockTreesByRootID(tree.Box, tree.ID)
			} else {
				previousTree, loadErr := filesys.LoadTreeInBoxLocked(previousBlockTree.BoxID, previousBlockTree.Path, util.NewLute())
				if loadErr != nil {
					restoreBlockTreeErr = loadErr
				} else {
					restoreBlockTreeErr = treenode.SetBlockTreePath(previousTree)
				}
			}
			if restoreFileErr != nil {
				restoreFileErr = fmt.Errorf("restore tree file after rejected index: %w", restoreFileErr)
			}
			if restoreBlockTreeErr != nil {
				restoreBlockTreeErr = fmt.Errorf("restore blocktree after rejected index: %w", restoreBlockTreeErr)
			}
			return errors.Join(cause, restoreFileErr, restoreBlockTreeErr)
		}

		if treeErr := treenode.SetBlockTreePath(tree); treeErr != nil {
			treeErr = restorePrevious(fmt.Errorf("persist blocktree index for tree [%s/%s]: %w", tree.Box, tree.Path, treeErr))
			recordIndexError(treeErr)
			logging.LogErrorf("persist blocktree index for tree [%s/%s] failed: %s", tree.Box, tree.Path, treeErr)
			return
		}
		runContentCommitBeforeEnqueueHook(tree)
		if queueErr := commitToken.queueAdmission.IndexTreeQueue(tree); queueErr != nil {
			queueErr = restorePrevious(fmt.Errorf("persist index queue entry for tree [%s/%s]: %w", tree.Box, tree.Path, queueErr))
			recordIndexError(queueErr)
			logging.LogErrorf("persist index queue entry for tree [%s/%s] failed: %s", tree.Box, tree.Path, queueErr)
			return
		}
		if contentCommitAfterEnqueueHook != nil {
			contentCommitAfterEnqueueHook(tree)
		}
		lock.Lock()
		avNodes = append(avNodes, tree.Root.ChildrenByType(ast.NodeAttributeView)...)
		lock.Unlock()
		cache.PutDocIALInBox(file.path, tree.Box, docIAL)
		util.IncBootProgress(bootProgressPart, fmt.Sprintf(Conf.Language(92), util.ShortPathForBootingDisplay(tree.Path)))
		if 1 < i && 0 == i%64 {
			util.PushStatusBar(fmt.Sprintf(Conf.Language(88), i, (len(files))-i))
		}
	})
	if poolErr != nil {
		return fmt.Errorf("create notebook index worker pool [%s]: %w", box.ID, poolErr)
	}
	for _, file := range files {
		if file.isdir || !strings.HasSuffix(file.name, ".sy") {
			continue
		}

		if !ast.IsNodeIDPattern(strings.TrimSuffix(file.name, ".sy")) {
			// 不以块 ID 命名的 .sy 文件不应该被加载到思源中 https://github.com/siyuan-note/siyuan/issues/16089
			continue
		}

		waitGroup.Add(1)
		invokeErr := p.Invoke(file)
		if nil != invokeErr {
			waitGroup.Done()
			recordIndexError(fmt.Errorf("invoke notebook index worker for [%s/%s]: %w", box.ID, file.path, invokeErr))
			logging.LogErrorf("invoke [%s] failed: %s", file.path, invokeErr)
			continue
		}
	}
	waitGroup.Wait()
	p.Release()
	lock.Lock()
	err = indexErr
	lock.Unlock()
	if err != nil {
		return fmt.Errorf("rebuild database for notebook [%s]: %w", box.ID, err)
	}

	// 关联数据库和块
	if err = av.ReplaceBlockRelsInBox(avNodes, attributeViewStoreBoxID(box.ID)); err != nil {
		return fmt.Errorf("persist attribute view mirror index for notebook [%s]: %w", box.ID, err)
	}

	end := time.Now()
	elapsed := end.Sub(start).Seconds()
	logging.LogInfof("rebuilt database for notebook [%s] in [%.2fs], tree [count=%d, size=%s]", box.ID, elapsed, treeCount, humanize.BytesCustomCeil(uint64(treeSize), 2))
	debug.FreeOSMemory()
	return nil
}

type indexContentCommitToken struct {
	queueAdmission *sql.QueueAdmissionLease
	releaseFunc    func()
}

func (token *indexContentCommitToken) release() {
	token.releaseFunc()
}

func acquireIndexContentCommitToken(boxID string, queueBatch *sql.QueueBatch) *indexContentCommitToken {
	if queueBatch == nil || !queueBatch.OwnsExclusiveAdmission() {
		commitToken := acquireContentCommitToken(boxID)
		return &indexContentCommitToken{
			queueAdmission: commitToken.queueAdmission,
			releaseFunc:    commitToken.release,
		}
	}
	queueAdmission := queueBatch.AcquireQueueAdmissionLease()
	if contentCommitAcceptedHook != nil {
		contentCommitAcceptedHook(boxID)
	}
	return &indexContentCommitToken{
		queueAdmission: queueAdmission,
		releaseFunc:    queueAdmission.Release,
	}
}

func listFilesForIndex(box *Box) (ret []*FileInfo, err error) {
	files, _, err := box.Ls("/")
	if err != nil {
		return nil, err
	}
	var walk func([]*FileInfo) error
	walk = func(entries []*FileInfo) error {
		for _, entry := range entries {
			if entry.isdir {
				children, _, listErr := box.Ls(entry.path)
				if listErr != nil {
					return listErr
				}
				if walkErr := walk(children); walkErr != nil {
					return walkErr
				}
			}
			ret = append(ret, entry)
		}
		return nil
	}
	if err = walk(files); err != nil {
		return nil, err
	}
	return ret, nil
}

func IndexRefs() error {
	databaseIndexOpMu.Lock()
	defer databaseIndexOpMu.Unlock()
	openedBoxes, err := listOpenedBoxesStrict()
	if err != nil {
		return fmt.Errorf("list opened notebooks before indexing references: %w", err)
	}
	if err = indexRefsLocked(openedBoxes); err != nil {
		return err
	}
	if err = sql.FlushQueue(); err != nil {
		return fmt.Errorf("flush reference index queue: %w", err)
	}
	ResetVirtualBlockRefCache()
	return nil
}

func indexRefsLocked(boxes []*Box) error {
	return indexRefsWithResetLocked(boxes, "")
}

func indexRefsWithResetLocked(boxes []*Box, resetBoxID string) error {
	start := time.Now()
	util.SetBootDetails(Conf.Language(304))
	util.PushStatusBar(Conf.Language(54))
	util.SetBootDetails(Conf.Language(305))

	var defTrees []derivedObjectIdentity
	seenDefTrees := map[derivedObjectIdentity]struct{}{}
	luteEngine := util.NewLute()
	var resetToken *contentCommitToken
	if resetBoxID != "" {
		resetToken = acquireContentCommitToken(resetBoxID)
		defer resetToken.release()
	}
	for _, box := range boxes {
		if resetToken != nil && box.ID != resetBoxID {
			return fmt.Errorf("reference reset for notebook [%s] cannot scan notebook [%s]", resetBoxID, box.ID)
		}
		encryptedBox := IsEncryptedBox(box.ID)
		contentStore := attributeViewStoreBoxID(box.ID)
		files, listErr := listFilesForIndex(box)
		if listErr != nil {
			return fmt.Errorf("list notebook [%s] files for reference indexing: %w", box.ID, listErr)
		}
		for _, file := range files {
			if file.isdir || !strings.HasSuffix(file.name, ".sy") {
				continue
			}
			p := filepath.ToSlash(file.path)
			treeAbsPath := filepath.Join(util.DataDir, box.ID, filepath.FromSlash(strings.TrimPrefix(p, "/")))
			if scanErr := func() error {
				if resetToken == nil {
					token := acquireContentCommitToken(box.ID)
					defer token.release()
				}

				// 加密笔记本的 .sy 是密文，必须走透明解密；无法用 bytes.Contains 预检。
				var tree *parse.Tree
				if encryptedBox {
					loadTree, loadErr := filesys.LoadTreeInBoxLocked(box.ID, p, luteEngine)
					if nil != loadErr {
						return fmt.Errorf("load encrypted box [%s] tree [%s]: %w", box.ID, treeAbsPath, loadErr)
					}
					tree = loadTree
				} else {
					data, readErr := filelock.ReadFile(treeAbsPath)
					if nil != readErr {
						return fmt.Errorf("read reference tree [%s]: %w", treeAbsPath, readErr)
					}
					if !bytes.Contains(data, []byte("TextMarkBlockRefID")) && !bytes.Contains(data, []byte("TextMarkFileAnnotationRefID")) {
						return nil
					}
					parseTree, parseErr := filesys.LoadTreeByData(data, box.ID, p, luteEngine)
					if nil != parseErr {
						return fmt.Errorf("parse reference tree [%s]: %w", treeAbsPath, parseErr)
					}
					tree = parseTree
				}

				ast.Walk(tree.Root, func(n *ast.Node, entering bool) ast.WalkStatus {
					if !entering {
						return ast.WalkContinue
					}
					if treenode.IsBlockRef(n) || treenode.IsFileAnnotationRef(n) {
						identity := derivedObjectIdentity{boxID: contentStore, objectID: tree.Root.ID}
						if _, seen := seenDefTrees[identity]; !seen {
							seenDefTrees[identity] = struct{}{}
							defTrees = append(defTrees, identity)
						}
					}
					return ast.WalkContinue
				})
				return nil
			}(); scanErr != nil {
				return scanErr
			}
		}
	}

	i := 0
	size := len(defTrees)
	var replacementTrees []*parse.Tree
	if 0 < size {
		bootProgressPart := int32(10.0 / float64(size))

		for _, identity := range defTrees {
			var token *contentCommitToken
			if resetToken == nil {
				token = acquireContentCommitToken(identity.boxID)
			}
			blockTree := treenode.GetBlockTreeInBox(identity.objectID, identity.boxID)
			if blockTree == nil {
				if token != nil {
					token.release()
				}
				return fmt.Errorf("load reference tree [%s/%s]: %w", identity.boxID, identity.objectID, ErrTreeNotFound)
			}
			defTree, loadErr := filesys.LoadTreeInBoxLocked(blockTree.BoxID, blockTree.Path, luteEngine)
			if nil != loadErr {
				if token != nil {
					token.release()
				}
				return fmt.Errorf("load reference tree [%s/%s]: %w", identity.boxID, identity.objectID, loadErr)
			}

			util.IncBootProgress(bootProgressPart, fmt.Sprintf(Conf.Language(306), defTree.ID))
			if resetToken != nil {
				replacementTrees = append(replacementTrees, defTree)
				i++
				continue
			}
			runContentCommitBeforeEnqueueHook(defTree)
			if queueErr := token.queueAdmission.UpdateRefsTreeQueue(defTree); queueErr != nil {
				token.release()
				return fmt.Errorf("persist reference update queue for tree [%s/%s]: %w", defTree.Box, defTree.Path, queueErr)
			}
			if contentCommitAfterEnqueueHook != nil {
				contentCommitAfterEnqueueHook(defTree)
			}
			token.release()
			if 1 < i && 0 == i%64 {
				util.PushStatusBar(fmt.Sprintf(Conf.Language(55), i))
			}
			i++
		}
	}
	if resetToken != nil {
		for _, tree := range replacementTrees {
			runContentCommitBeforeEnqueueHook(tree)
		}
		if queueErr := resetToken.queueAdmission.ReplaceBoxRefsQueue(resetBoxID, replacementTrees); queueErr != nil {
			return fmt.Errorf("replace notebook reference queue [%s]: %w", resetBoxID, queueErr)
		}
		if contentCommitAfterEnqueueHook != nil {
			for _, tree := range replacementTrees {
				contentCommitAfterEnqueueHook(tree)
			}
		}
	}
	logging.LogInfof("resolved refs [%d] in [%dms]", size, time.Since(start).Milliseconds())
	util.PushStatusBar(fmt.Sprintf(Conf.Language(55), i))
	return nil
}

var indexEmbedBlockLock = sync.Mutex{}

// IndexEmbedBlockJob 嵌入块支持搜索 https://github.com/siyuan-note/siyuan/issues/7112
func IndexEmbedBlockJob() {
	task.AppendTaskWithTimeout(task.DatabaseIndexEmbedBlock, 30*time.Second, autoIndexEmbedBlock)
}

func autoIndexEmbedBlock() {
	indexEmbedBlockLock.Lock()
	defer indexEmbedBlockLock.Unlock()

	embedBlocks := sql.QueryEmptyContentEmbedBlocks()
	for i, embedBlock := range embedBlocks {
		markdown := strings.TrimSpace(embedBlock.Markdown)
		markdown = strings.TrimPrefix(markdown, "{{")
		stmt := strings.TrimSuffix(markdown, "}}")

		// 嵌入块的 Markdown 内容需要反转义
		stmt = html.UnescapeString(stmt)
		stmt = strings.ReplaceAll(stmt, editor.IALValEscNewLine, "\n")

		// 需要移除首尾的空白字符以判断是否具有 //!js 标记
		stmt = strings.TrimSpace(stmt)
		if strings.HasPrefix(stmt, "//!js") {
			// https://github.com/siyuan-note/siyuan/issues/9648
			// js 嵌入块不支持自动索引，由前端主动调用 /api/search/updateEmbedBlock 接口更新内容 https://github.com/siyuan-note/siyuan/issues/9736
			continue
		}

		if !strings.Contains(strings.ToLower(stmt), "select") {
			continue
		}

		queryResultBlocks := sql.SelectBlocksRawStmtNoParse(stmt, 102400)
		for _, block := range queryResultBlocks {
			embedBlock.Content += block.Content
		}
		if "" == embedBlock.Content {
			embedBlock.Content = "no query result"
		}
		sql.UpdateBlockContentTransientQueue(embedBlock)

		if 63 <= i { // 一次任务中最多处理 64 个嵌入块，防止卡顿
			break
		}
	}
}

func updateEmbedBlockContent(embedBlockID string, queryResultBlocks []*EmbedBlock) {
	embedBlock := sql.GetBlock(embedBlockID)
	if nil == embedBlock {
		return
	}

	embedBlock.Content = "" // 嵌入块每查询一次多一个结果 https://github.com/siyuan-note/siyuan/issues/7196
	for _, block := range queryResultBlocks {
		embedBlock.Content += block.Block.Markdown
	}
	if "" == embedBlock.Content {
		embedBlock.Content = "no query result"
	}
	sql.UpdateBlockContentTransientQueue(embedBlock)
}

func init() {
	subscribeSQLEvents()
}

var (
	pushSQLInsertBlocksFTSMsg bool
	pushSQLDeleteBlocksMsg    bool
)

func subscribeSQLEvents() {
	// 使用下面的 EvtSQLInsertBlocksFTS 就可以了
	//eventbus.Subscribe(eventbus.EvtSQLInsertBlocks, func(context map[string]any, current, total, blockCount int, hash string) {
	//
	//	msg := fmt.Sprintf(Conf.Language(89), current, total, blockCount, hash)
	//	util.SetBootDetails(msg)
	//	util.ContextPushMsg(context, msg)
	//})
	eventbus.Subscribe(eventbus.EvtSQLInsertBlocksFTS, func(context map[string]any, blockCount int, hash string) {
		if !pushSQLInsertBlocksFTSMsg {
			return
		}

		if nil == context["current"] || nil == context["total"] {
			logging.LogWarnf("EvtSQLInsertBlocksFTS handler missing key [current] or [total] in context")
			return
		}
		current := context["current"].(int)
		total := context["total"]
		msg := fmt.Sprintf(Conf.Language(90), current, total, blockCount, hash)
		util.SetBootDetails(msg)
		util.ContextPushMsg(context, msg)
	})
	eventbus.Subscribe(eventbus.EvtSQLDeleteBlocks, func(context map[string]any, rootID string) {
		if !pushSQLDeleteBlocksMsg {
			return
		}

		if nil == context["current"] || nil == context["total"] {
			logging.LogWarnf("EvtSQLDeleteBlocks handler missing key [current] or [total] in context")
			return
		}
		current := context["current"].(int)
		total := context["total"]
		msg := fmt.Sprintf(Conf.Language(93), current, total, rootID)
		util.SetBootDetails(msg)
		util.ContextPushMsg(context, msg)
	})
	eventbus.Subscribe(eventbus.EvtSQLUpdateBlocksHPaths, func(context map[string]any, blockCount int, hash string) {
		if util.IsMobileContainer() {
			return
		}

		if nil == context["current"] || nil == context["total"] {
			logging.LogWarnf("EvtSQLUpdateBlocksHPaths handler missing key [current] or [total] in context")
			return
		}
		current := context["current"].(int)
		total := context["total"]
		msg := fmt.Sprintf(Conf.Language(234), current, total, blockCount, hash)
		util.SetBootDetails(msg)
		util.ContextPushMsg(context, msg)
	})

	eventbus.Subscribe(eventbus.EvtSQLInsertHistory, func(context map[string]any) {
		if util.IsMobileContainer() {
			return
		}

		if nil == context["current"] || nil == context["total"] {
			logging.LogWarnf("EvtSQLInsertHistory handler missing key [current] or [total] in context")
			return
		}
		current := context["current"].(int)
		total := context["total"]
		msg := fmt.Sprintf(Conf.Language(191), current, total)
		util.SetBootDetails(msg)
		util.ContextPushMsg(context, msg)
	})

	eventbus.Subscribe(eventbus.EvtSQLInsertAssetContent, func(context map[string]any) {
		if util.IsMobileContainer() {
			return
		}

		if nil == context["current"] || nil == context["total"] {
			logging.LogWarnf("EvtSQLInsertAssetContent handler missing key [current] or [total] in context")
			return
		}
		current := context["current"].(int)
		total := context["total"]
		msg := fmt.Sprintf(Conf.Language(217), current, total)
		util.SetBootDetails(msg)
		util.ContextPushMsg(context, msg)
	})

	eventbus.Subscribe(eventbus.EvtSQLIndexChanged, func() {
		Conf.DataIndexState = 1
		Conf.Save()
	})

	eventbus.Subscribe(eventbus.EvtSQLIndexFlushed, func() {
		Conf.DataIndexState = 0
		Conf.Save()
	})
}
