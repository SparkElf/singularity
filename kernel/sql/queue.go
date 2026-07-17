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
	"database/sql"
	"errors"
	"fmt"
	"math"
	"path"
	"runtime/debug"
	"sync"
	"sync/atomic"
	"time"

	"github.com/88250/lute"
	"github.com/88250/lute/parse"
	"github.com/siyuan-note/eventbus"
	"github.com/siyuan-note/logging"
	"github.com/siyuan-note/siyuan/kernel/task"
	"github.com/siyuan-note/siyuan/kernel/treenode"
	"github.com/siyuan-note/siyuan/kernel/util"
)

var (
	operationQueue         []*dbQueueOperation
	dbQueueLock            = sync.Mutex{}
	dbQueueCond            = sync.NewCond(&dbQueueLock)
	queueAdmission         = newQueueAdmissionGate()
	indexQueueRecoveryErr  error
	indexQueueRecoveryErrs = map[string]error{}
	queueBatchSequence     atomic.Uint64
)

// ordinaryFlushAfterSnapshotHook is a deterministic test boundary after a
// regular flush releases admission and before it executes the captured work.
var ordinaryFlushAfterSnapshotHook func()

// queueAfterDurableCommitHook is a deterministic test boundary after a
// committed operation has been removed from the durable snapshot.
var queueAfterDurableCommitHook func(committed int)

type queueAdmissionGate struct {
	mu      sync.Mutex
	cond    *sync.Cond
	closed  bool
	readers int
}

// QueueAdmissionOwner owns the existing SQL queue admission gate exclusively.
// It is used by multi-step maintenance that must keep ordinary writers out while
// still publishing and flushing its own durable queue operations.
type QueueAdmissionOwner struct {
	gate                *queueAdmissionGate
	releaseInitDatabase bool
	releaseOnce         sync.Once
}

func newQueueAdmissionGate() *queueAdmissionGate {
	ret := &queueAdmissionGate{}
	ret.cond = sync.NewCond(&ret.mu)
	return ret
}

func (gate *queueAdmissionGate) acquire(onBlocked func()) *QueueAdmissionLease {
	gate.mu.Lock()
	notified := false
	for gate.closed {
		if !notified && onBlocked != nil {
			gate.mu.Unlock()
			onBlocked()
			gate.mu.Lock()
			notified = true
			continue
		}
		gate.cond.Wait()
	}
	gate.readers++
	gate.mu.Unlock()
	return &QueueAdmissionLease{gate: gate}
}

func (gate *queueAdmissionGate) acquireExclusive(onBlocked func()) *QueueAdmissionOwner {
	gate.mu.Lock()
	for gate.closed {
		gate.cond.Wait()
	}
	gate.closed = true
	notified := false
	for gate.readers > 0 {
		if !notified && onBlocked != nil {
			gate.mu.Unlock()
			onBlocked()
			gate.mu.Lock()
			notified = true
			continue
		}
		gate.cond.Wait()
	}
	gate.mu.Unlock()
	return &QueueAdmissionOwner{gate: gate}
}

func (gate *queueAdmissionGate) close(onBlocked func()) func() {
	return gate.acquireExclusive(onBlocked).Release
}

// Release reopens ordinary SQL queue admission after exclusive maintenance has
// completed. It is safe to defer immediately after acquisition.
func (owner *QueueAdmissionOwner) Release() {
	owner.releaseOnce.Do(func() {
		owner.gate.mu.Lock()
		owner.gate.closed = false
		owner.gate.cond.Broadcast()
		owner.gate.mu.Unlock()
		if owner.releaseInitDatabase {
			initDatabaseLock.Unlock()
		}
	})
}

func (gate *queueAdmissionGate) release() {
	gate.mu.Lock()
	gate.readers--
	if gate.readers == 0 {
		gate.cond.Broadcast()
	}
	gate.mu.Unlock()
}

type dbQueueOperation struct {
	inQueueTime                   time.Time
	action                        string      // upsert/delete/delete_id/rename/move/delete_box/delete_box_refs/index/delete_ids/update_block_content/delete_assets/index_node
	indexTree                     *parse.Tree // index/rename/move
	upsertTree                    *parse.Tree // upsert/update_refs/delete_refs
	removeTreeBox, removeTreePath string      // delete/delete_id/delete_ids
	removeTreeID                  string      // delete_id
	removeTreeIDs                 []string    // delete_ids
	box                           string      // delete_box/delete_box_refs/index/index_node
	block                         *Block      // update_block_content
	id                            string      // index_node
	removeAssetHashes             []string    // delete_assets
	batchID                       string      // rebuild batch generation; persisted in index.queue
}

// boxID 从 op 提取目标 boxID，供 beginTxForBox 路由到加密 db 或全局 db。
// delete_assets 无 box 上下文，返回空串 → 走全局 db。
func (op *dbQueueOperation) boxID() string {
	switch op.action {
	case "index", "rename", "move":
		if op.indexTree != nil {
			return op.indexTree.Box
		}
	case "upsert", "update_refs", "delete_refs":
		if op.upsertTree != nil {
			return op.upsertTree.Box
		}
	case "delete", "delete_id", "delete_ids":
		return op.removeTreeBox
	case "delete_box", "delete_box_refs", "index_node":
		return op.box
	case "update_block_content":
		if op.block != nil {
			return op.block.Box
		}
	}
	return ""
}

func FlushTxJob() {
	task.AppendTask(task.DatabaseIndexCommit, FlushQueue)
}

func WaitFlushTx() {
	dbQueueLock.Lock()
	defer dbQueueLock.Unlock()

	for len(operationQueue) > 0 || flushingTx {
		dbQueueCond.Wait()
	}
}

func ClearQueue() error {
	releaseAdmission := queueAdmission.close(nil)
	defer releaseAdmission()
	return clearQueueAdmissionOwned()
}

func clearQueueAdmissionOwned() error {
	dbQueueLock.Lock()
	defer dbQueueLock.Unlock()
	if err := clearIndexQueueEntries(); err != nil {
		logging.LogErrorf("clear index queue failed: %s", err)
		dbQueueCond.Broadcast()
		return err
	}
	operationQueue = nil
	indexQueueRecoveryErr = nil
	clear(indexQueueRecoveryErrs)
	dbQueueCond.Broadcast()
	return nil
}

var flushingTx bool

func FlushQueue() (retErr error) {
	initDatabaseLock.Lock()
	defer initDatabaseLock.Unlock()

	releaseAdmission := queueAdmission.close(nil)
	ops, diskEntries, deferredEntries, indexSnapshot, retErr := snapshotQueueForFlush()
	releaseAdmission()
	if ordinaryFlushAfterSnapshotHook != nil {
		ordinaryFlushAfterSnapshotHook()
	}
	if retErr == nil {
		retErr = flushQueue(ops, diskEntries, deferredEntries, indexSnapshot)
	}
	if retErr != nil {
		logging.LogErrorf("flush database queue failed: %s", retErr)
	}
	return
}

// AcquireExclusiveQueueAdmission closes the existing SQL admission gate and
// keeps the database queue coordinator reserved until Release. Owner methods do
// not recursively close admission, so rebuild workers can enqueue and flush
// while every ordinary writer remains blocked.
func AcquireExclusiveQueueAdmission(onBlocked func()) *QueueAdmissionOwner {
	initDatabaseLock.Lock()
	owner := queueAdmission.acquireExclusive(onBlocked)
	owner.releaseInitDatabase = true
	return owner
}

// FlushQueue flushes all currently accepted work without reopening admission.
func (owner *QueueAdmissionOwner) FlushQueue() (retErr error) {
	ops, diskEntries, deferredEntries, indexSnapshot, retErr := snapshotQueueForFlush()
	if retErr == nil {
		retErr = flushQueue(ops, diskEntries, deferredEntries, indexSnapshot)
	}
	if retErr != nil {
		logging.LogErrorf("flush database queue under exclusive admission failed: %s", retErr)
	}
	return
}

// DrainQueueForBox closes SQL queue admission, flushes all work accepted
// before the close, and keeps admission closed until the returned release
// function is called. The global gate is intentional: the durable queue is
// shared even though each operation routes to its own content database.
func DrainQueueForBox(boxID string, onBlocked func()) (release func(), err error) {
	initDatabaseLock.Lock()
	releaseAdmission := queueAdmission.close(onBlocked)
	ops, diskEntries, deferredEntries, indexSnapshot, snapshotErr := snapshotQueueForFlush()
	if snapshotErr == nil {
		err = flushQueue(ops, diskEntries, deferredEntries, indexSnapshot)
		if err == nil && hasDeferredIndexEntryForBox(deferredEntries, boxID) {
			err = fmt.Errorf("encrypted database for box [%s] is unavailable with deferred durable queue operations", boxID)
		}
	} else {
		err = snapshotErr
	}
	initDatabaseLock.Unlock()
	if err != nil {
		releaseAdmission()
		return nil, fmt.Errorf("drain SQL queue for box [%s] failed: %w", boxID, err)
	}
	return releaseAdmission, nil
}

func hasDeferredIndexEntryForBox(entries []indexEntry, boxID string) bool {
	for _, entry := range entries {
		if entry.Box == boxID {
			return true
		}
	}
	return false
}

func snapshotQueueForFlush() (ops []*dbQueueOperation, diskEntries, deferredEntries []indexEntry, indexSnapshot int64, err error) {
	if recoveryErr := currentIndexQueueRecoveryError(); recoveryErr != nil {
		return nil, nil, nil, 0, fmt.Errorf("durable index queue recovery is pending: %w", recoveryErr)
	}
	entries, indexSnapshot, err := loadIndexQueue()
	if err != nil {
		return nil, nil, nil, 0, err
	}
	readyEntries, deferredEntries := partitionRecoverableIndexEntries(coalesceIndexEntries(entries))
	ops = getOperations()
	if len(ops) == 0 {
		diskEntries = readyEntries
	}
	return
}

func currentIndexQueueRecoveryError() error {
	dbQueueLock.Lock()
	defer dbQueueLock.Unlock()
	return indexQueueRecoveryErr
}

func flushQueue(ops []*dbQueueOperation, diskEntries, deferredEntries []indexEntry, indexSnapshot int64) (retErr error) {
	next := 0
	durableSnapshot := indexSnapshot
	defer func() {
		dbQueueLock.Lock()
		flushingTx = false
		dbQueueCond.Broadcast()
		dbQueueLock.Unlock()
	}()
	defer func() {
		if retErr == nil || len(ops) == 0 {
			return
		}
		pending := ops[next:]
		if _, queueErr := replaceIndexQueueSnapshotWithEntriesAndOps(durableSnapshot, deferredEntries, pending); queueErr != nil {
			retErr = errors.Join(retErr, fmt.Errorf("persist uncommitted SQL queue suffix: %w", queueErr))
		}
		dbQueueLock.Lock()
		operationQueue = append(pending, operationQueue...)
		dbQueueCond.Broadcast()
		dbQueueLock.Unlock()
	}()
	total := len(ops)
	if 1 > total {
		return processDiskQueue(diskEntries, deferredEntries, indexSnapshot)
	}

	start := time.Now()

	// logging.LogInfof("flushing database queue, total operations [%d]", total)

	// 如果有重命名树的操作，则统计各路径前缀的块树数量，数量较大的话阻塞整个队列，以便尽可能合并重命名树的操作 RenameTreeQueue(tree)
	var renameTreeOp *dbQueueOperation
	for _, op := range ops {
		if "rename" == op.action {
			renameTreeOp = op
			break
		}
	}
	if nil != renameTreeOp {
		childCount := treenode.CountBlockTreesByPathPrefix(renameTreeOp.indexTree.Box, path.Dir(renameTreeOp.indexTree.Path))
		if 512 < childCount {
			scale := math.Log(float64(childCount)/512.0+1.0) / math.Log(2.0)
			secs := 1.0 * scale
			if secs < 1.0 {
				secs = 1.0
			}
			if secs > 12.0 {
				secs = 12.0
			}
			logging.LogInfof("rename tree [%s] with large child count [%d], sleep [%.2fs] to wait for more operations", renameTreeOp.indexTree.Path, childCount, secs)
			time.Sleep(time.Duration(secs * float64(time.Second)))
		}
	}

	context := map[string]any{eventbus.CtxPushMsg: eventbus.CtxPushMsgToStatusBar}
	if 512 < len(ops) {
		disableCache()
		defer enableCache()
	}

	groupOpsTotal := map[string]int{}
	for _, op := range ops {
		groupOpsTotal[op.action]++
	}

	groupOpsCurrent := map[string]int{}
	for i, op := range ops {
		if util.IsExiting.Load() {
			return errors.New("database queue drain interrupted by shutdown")
		}

		supportsBlockEmbeddings := GetEncryptedDB(op.boxID()) == nil
		tx, err := beginTxForBox(op.boxID())
		if err != nil {
			return fmt.Errorf("begin queue operation [%s] for box [%s]: %w", op.action, op.boxID(), err)
		}

		groupOpsCurrent[op.action]++
		context["current"] = groupOpsCurrent[op.action]
		context["total"] = groupOpsTotal[op.action]
		if err = execOp(op, tx, context, supportsBlockEmbeddings); err != nil {
			opErr := fmt.Errorf("queue operation [%s] for box [%s]: %w", op.action, op.boxID(), err)
			if rollbackErr := rollbackTx(tx); rollbackErr != nil {
				opErr = errors.Join(opErr, fmt.Errorf("rollback queue operation [%s] for box [%s]: %w", op.action, op.boxID(), rollbackErr))
			}
			logging.LogErrorf("queue operation [%s] failed: %s", op.action, opErr)
			return opErr
		}

		if err = commitTx(tx); err != nil {
			logging.LogErrorf("commit tx failed: %s", err)
			return fmt.Errorf("commit queue operation [%s] for box [%s]: %w", op.action, op.boxID(), err)
		}
		next = i + 1
		durableSnapshot, err = replaceIndexQueueSnapshotWithEntriesAndOps(durableSnapshot, deferredEntries, ops[next:])
		if err != nil {
			return fmt.Errorf("remove committed SQL queue prefix through operation [%d]: %w", next, err)
		}
		if queueAfterDurableCommitHook != nil {
			queueAfterDurableCommitHook(next)
		}

		switch op.action {
		case "index":
			eventbus.Publish(eventbus.EvtEmbeddingDirty, op.indexTree.ID)
		case "upsert":
			eventbus.Publish(eventbus.EvtEmbeddingDirty, op.upsertTree.ID)
		case "update_block_content":
			eventbus.Publish(eventbus.EvtEmbeddingDirty, op.block.ID)
		case "index_node":
			eventbus.Publish(eventbus.EvtEmbeddingDirty, op.id)
		}

		if 16 < i && 0 == i%128 {
			debug.FreeOSMemory()
		}
	}

	if 128 < total {
		debug.FreeOSMemory()
	}

	elapsed := time.Since(start).Milliseconds()
	if 7000 < elapsed {
		logging.LogInfof("database op tx [%dms]", elapsed)
	}

	// Push database index commit event https://github.com/siyuan-note/siyuan/issues/8814
	util.BroadcastByType("main", "databaseIndexCommit", 0, "", nil)

	eventbus.Publish(eventbus.EvtSQLIndexFlushed)

	return nil
}

func execOp(op *dbQueueOperation, tx *sql.Tx, context map[string]any, supportsBlockEmbeddings bool) (err error) {
	switch op.action {
	case "index":
		err = indexTree(tx, op.indexTree, context)
	case "upsert":
		err = upsertTree(tx, op.upsertTree, context)
	case "delete":
		err = batchDeleteByPathPrefix(tx, op.removeTreeBox, op.removeTreePath)
		if nil == err {
			err = execBlockEmbeddings(tx, supportsBlockEmbeddings, "DELETE FROM block_embeddings WHERE box = ? AND path LIKE ?", op.removeTreeBox, op.removeTreePath+"%")
		}
	case "delete_id":
		err = deleteByRootID(tx, op.removeTreeID, context)
		if nil == err {
			err = execBlockEmbeddings(tx, supportsBlockEmbeddings, "DELETE FROM block_embeddings WHERE root_id = ?", op.removeTreeID)
		}
	case "delete_ids":
		err = batchDeleteByRootIDs(tx, op.removeTreeIDs, context)
		if nil == err {
			for _, rootID := range op.removeTreeIDs {
				if err = execBlockEmbeddings(tx, supportsBlockEmbeddings, "DELETE FROM block_embeddings WHERE root_id = ?", rootID); err != nil {
					break
				}
			}
		}
	case "rename":
		err = batchUpdateHPath(tx, op.indexTree, context)
		if err != nil {
			break
		}

		err = updateRootContent(tx, path.Base(op.indexTree.HPath), op.indexTree.Root.IALAttr("updated"), treenode.IALStr(op.indexTree.Root), op.indexTree.ID)
		if nil == err {
			err = execBlockEmbeddings(tx, supportsBlockEmbeddings, "UPDATE block_embeddings SET box = ?, path = ? WHERE root_id = ?", op.indexTree.Box, op.indexTree.Path, op.indexTree.ID)
		}
	case "move":
		err = batchUpdatePath(tx, op.indexTree, context)
		if nil == err {
			err = execBlockEmbeddings(tx, supportsBlockEmbeddings, "UPDATE block_embeddings SET box = ?, path = ? WHERE root_id = ?", op.indexTree.Box, op.indexTree.Path, op.indexTree.ID)
		}
	case "delete_box":
		// 清理 box 的内容索引。事务由 beginTxForBox(op.boxID()) 按所属库路由：
		// 普通 box 落到全局 siyuan.db，加密笔记本落到其独立 content db，删除均生效。
		// 注意加密笔记本关闭时必须清空 content db 数据，否则下次 Mount 的全量 Index
		// 会用纯 INSERT 在无主键的 blocks 表上叠加重复行，导致搜索结果翻倍。
		err = deleteByBoxTx(tx, op.box)
		if nil == err {
			err = execBlockEmbeddings(tx, supportsBlockEmbeddings, "DELETE FROM block_embeddings WHERE box = ?", op.box)
		}
	case "delete_box_refs":
		err = deleteRefsByBoxTx(tx, op.box)
	case "update_refs":
		err = upsertRefs(tx, op.upsertTree)
	case "delete_refs":
		err = deleteRefs(tx, op.upsertTree)
	case "update_block_content":
		err = updateBlockContent(tx, op.block)
	case "delete_assets":
		err = deleteAssetsByHashes(tx, op.removeAssetHashes)
	case "index_node":
		err = indexNode(tx, op.id, op.box)
	default:
		msg := fmt.Sprintf("unknown operation [%s]", op.action)
		logging.LogErrorf("%s", msg)
		err = errors.New(msg)
	}
	return
}

func execBlockEmbeddings(tx *sql.Tx, supported bool, stmt string, args ...any) error {
	if !supported {
		return nil
	}
	_, err := tx.Exec(stmt, args...)
	return err
}

func holdQueueAdmission() func() {
	lease := queueAdmission.acquire(nil)
	return lease.Release
}

// QueueAdmissionLease 表示调用方持有 SQL 队列 admission 读锁，可在多资源提交期间直接执行内层入队。
type QueueAdmissionLease struct {
	gate    *queueAdmissionGate
	batchID string
}

// AcquireQueueAdmissionLease 获取 SQL 队列 admission 读锁。调用方必须在完成持久入队后调用 Release。
func AcquireQueueAdmissionLease() *QueueAdmissionLease {
	return queueAdmission.acquire(nil)
}

// Release 释放 SQL 队列 admission 读锁。
func (lease *QueueAdmissionLease) Release() {
	if lease.gate != nil {
		lease.gate.release()
	}
}

// QueueBatch identifies the durable operations produced by one rebuild so a
// failed rebuild can remove only its own uncommitted work.
type QueueBatch struct {
	id    string
	owner *QueueAdmissionOwner
}

func BeginQueueBatch() *QueueBatch {
	return &QueueBatch{id: fmt.Sprintf("%d-%d", time.Now().UnixNano(), queueBatchSequence.Add(1))}
}

// BeginQueueBatch creates a batch whose worker leases are owned by this
// exclusive admission scope and therefore do not wait on the closed gate.
func (owner *QueueAdmissionOwner) BeginQueueBatch() *QueueBatch {
	batch := BeginQueueBatch()
	batch.owner = owner
	return batch
}

// OwnsExclusiveAdmission reports whether this batch belongs to a scope that
// already owns queue admission, so workers must not acquire ordinary readers.
func (batch *QueueBatch) OwnsExclusiveAdmission() bool {
	return batch.owner != nil
}

// AcquireQueueAdmissionLease admits one content commit owned by this batch.
// The caller must release the lease after its durable enqueue is complete.
func (batch *QueueBatch) AcquireQueueAdmissionLease() *QueueAdmissionLease {
	if batch.owner != nil {
		return &QueueAdmissionLease{batchID: batch.id}
	}
	lease := queueAdmission.acquire(nil)
	lease.batchID = batch.id
	return lease
}

func IndexNodeQueue(id, boxID string) error {
	releaseAdmission := holdQueueAdmission()
	defer releaseAdmission()

	dbQueueLock.Lock()
	defer dbQueueLock.Unlock()

	newOp := &dbQueueOperation{id: id, box: boxID, inQueueTime: time.Now(), action: "index_node"}
	for i, op := range operationQueue {
		if "index_node" == op.action && op.box == boxID && op.id == id {
			return replaceOperation(i, newOp)
		}
	}
	return appendOperation(newOp)
}

func BatchRemoveAssetsQueue(hashes []string) error {
	if 1 > len(hashes) {
		return nil
	}
	releaseAdmission := holdQueueAdmission()
	defer releaseAdmission()

	dbQueueLock.Lock()
	defer dbQueueLock.Unlock()

	newOp := &dbQueueOperation{removeAssetHashes: hashes, inQueueTime: time.Now(), action: "delete_assets"}
	return appendOperation(newOp)
}

// UpdateBlockContentTransientQueue queues recomputable embed-block content in
// memory. The derived plaintext is intentionally excluded from index.queue,
// including for encrypted notebooks.
func UpdateBlockContentTransientQueue(block *Block) {
	releaseAdmission := holdQueueAdmission()
	defer releaseAdmission()

	dbQueueLock.Lock()
	defer dbQueueLock.Unlock()

	newOp := &dbQueueOperation{block: block, inQueueTime: time.Now(), action: "update_block_content"}
	for i, op := range operationQueue {
		if "update_block_content" == op.action && op.block.Box == block.Box && op.block.ID == block.ID {
			operationQueue[i] = newOp
			return
		}
	}
	appendTransientOperation(newOp)
}

func DeleteRefsTreeQueue(tree *parse.Tree) error {
	releaseAdmission := holdQueueAdmission()
	defer releaseAdmission()

	dbQueueLock.Lock()
	defer dbQueueLock.Unlock()

	newOp := &dbQueueOperation{upsertTree: tree, inQueueTime: time.Now(), action: "delete_refs"}
	for i, op := range operationQueue {
		if "delete_refs" == op.action && op.upsertTree.Box == tree.Box && op.upsertTree.ID == tree.ID {
			return replaceOperation(i, newOp)
		}
	}
	return appendOperation(newOp)
}

func UpdateRefsTreeQueue(tree *parse.Tree) error {
	lease := AcquireQueueAdmissionLease()
	defer lease.Release()
	return lease.UpdateRefsTreeQueue(tree)
}

// UpdateRefsTreeQueue queues reference updates while the caller owns admission.
func (lease *QueueAdmissionLease) UpdateRefsTreeQueue(tree *parse.Tree) error {
	dbQueueLock.Lock()
	defer dbQueueLock.Unlock()

	newOp := &dbQueueOperation{upsertTree: tree, inQueueTime: time.Now(), action: "update_refs", batchID: lease.batchID}
	for i, op := range operationQueue {
		if "update_refs" == op.action && op.upsertTree.Box == tree.Box && op.upsertTree.ID == tree.ID {
			return replaceOperation(i, newOp)
		}
	}
	return appendOperation(newOp)
}

// ReplaceBoxRefsQueue atomically publishes one notebook's reference reset and
// the complete set of replacement reference trees.
func (lease *QueueAdmissionLease) ReplaceBoxRefsQueue(boxID string, trees []*parse.Tree) error {
	dbQueueLock.Lock()
	defer dbQueueLock.Unlock()
	ops := make([]*dbQueueOperation, 0, len(trees)+1)
	ops = append(ops, &dbQueueOperation{box: boxID, inQueueTime: time.Now(), action: "delete_box_refs", batchID: lease.batchID})
	for _, tree := range trees {
		ops = append(ops, &dbQueueOperation{upsertTree: tree, inQueueTime: time.Now(), action: "update_refs", batchID: lease.batchID})
	}
	if err := persistOperations(ops); err != nil {
		return err
	}
	admitPersistedOperations(ops)
	return nil
}

func DeleteBoxRefsQueue(boxID string) error {
	lease := AcquireQueueAdmissionLease()
	defer lease.Release()
	return lease.DeleteBoxRefsQueue(boxID)
}

// DeleteBoxRefsQueue queues reference deletion while the caller owns admission.
func (lease *QueueAdmissionLease) DeleteBoxRefsQueue(boxID string) error {
	dbQueueLock.Lock()
	defer dbQueueLock.Unlock()

	newOp := &dbQueueOperation{box: boxID, inQueueTime: time.Now(), action: "delete_box_refs", batchID: lease.batchID}
	for i, op := range operationQueue {
		if "delete_box_refs" == op.action && op.box == boxID {
			return replaceOperation(i, newOp)
		}
	}
	return appendOperation(newOp)
}

func DeleteBoxQueue(boxID string) error {
	lease := AcquireQueueAdmissionLease()
	defer lease.Release()
	return lease.DeleteBoxQueue(boxID)
}

// DeleteBoxQueue queues content-store deletion while the caller owns admission.
func (lease *QueueAdmissionLease) DeleteBoxQueue(boxID string) error {
	dbQueueLock.Lock()
	defer dbQueueLock.Unlock()

	newOp := &dbQueueOperation{box: boxID, inQueueTime: time.Now(), action: "delete_box", batchID: lease.batchID}
	for i, op := range operationQueue {
		if "delete_box" == op.action && op.box == boxID {
			return replaceOperation(i, newOp)
		}
	}
	return appendOperation(newOp)
}

func IndexTreeQueue(tree *parse.Tree) error {
	lease := AcquireQueueAdmissionLease()
	defer lease.Release()
	return lease.IndexTreeQueue(tree)
}

// IndexTreeQueue 在调用方持有 admission lease 时将树加入全量索引队列。
func (lease *QueueAdmissionLease) IndexTreeQueue(tree *parse.Tree) error {
	dbQueueLock.Lock()
	defer dbQueueLock.Unlock()

	newOp := &dbQueueOperation{indexTree: tree, inQueueTime: time.Now(), action: "index", batchID: lease.batchID}
	for i, op := range operationQueue {
		if "index" == op.action && op.indexTree.Box == tree.Box && op.indexTree.ID == tree.ID { // 相同内容库中的同一棵树则覆盖
			return replaceOperation(i, newOp)
		}
	}
	return appendOperation(newOp)
}

func UpsertTreeQueue(tree *parse.Tree) error {
	return UpsertTreesQueue([]*parse.Tree{tree})
}

// UpsertTreesQueue atomically persists a tree batch before admitting it to memory.
func UpsertTreesQueue(trees []*parse.Tree) error {
	if len(trees) == 0 {
		return nil
	}
	lease := AcquireQueueAdmissionLease()
	defer lease.Release()
	return lease.UpsertTreesQueue(trees)
}

// UpsertTreeQueue 在调用方持有 admission lease 时将树加入增量索引队列。
func (lease *QueueAdmissionLease) UpsertTreeQueue(tree *parse.Tree) error {
	return lease.UpsertTreesQueue([]*parse.Tree{tree})
}

// UpsertTreesQueue atomically persists a tree batch while the caller owns admission.
func (lease *QueueAdmissionLease) UpsertTreesQueue(trees []*parse.Tree) error {
	if len(trees) == 0 {
		return nil
	}
	dbQueueLock.Lock()
	defer dbQueueLock.Unlock()

	now := time.Now()
	newOps := make([]*dbQueueOperation, 0, len(trees))
	for _, tree := range trees {
		newOps = append(newOps, &dbQueueOperation{upsertTree: tree, inQueueTime: now, action: "upsert", batchID: lease.batchID})
	}
	if err := persistOperations(newOps); err != nil {
		return err
	}

	admitPersistedOperations(newOps)
	return nil
}

func RenameTreeQueue(tree *parse.Tree) error {
	lease := AcquireQueueAdmissionLease()
	defer lease.Release()
	return lease.RenameTreeQueue(tree)
}

// RenameTreeQueue 在调用方持有 admission lease 时将树加入重命名索引队列。
func (lease *QueueAdmissionLease) RenameTreeQueue(tree *parse.Tree) error {
	dbQueueLock.Lock()
	defer dbQueueLock.Unlock()

	newOp := &dbQueueOperation{
		indexTree:   tree,
		inQueueTime: time.Now(),
		action:      "rename",
		batchID:     lease.batchID,
	}
	for i, op := range operationQueue {
		if "rename" == op.action && op.indexTree.Box == tree.Box && op.indexTree.ID == tree.ID { // 相同内容库中的同一棵树则覆盖
			return replaceOperation(i, newOp)
		}
	}
	return appendOperation(newOp)
}

func MoveTreeQueue(tree *parse.Tree) error {
	releaseAdmission := holdQueueAdmission()
	defer releaseAdmission()

	dbQueueLock.Lock()
	defer dbQueueLock.Unlock()

	newOp := &dbQueueOperation{
		indexTree:   tree,
		inQueueTime: time.Now(),
		action:      "move",
	}
	for i, op := range operationQueue {
		if "move" == op.action && op.indexTree.Box == tree.Box && op.indexTree.ID == tree.ID { // 相同内容库中的同一棵树则覆盖
			return replaceOperation(i, newOp)
		}
	}
	return appendOperation(newOp)
}

func RemoveTreeQueue(boxID, rootID string) error {
	lease := AcquireQueueAdmissionLease()
	defer lease.Release()
	return lease.RemoveTreeQueue(boxID, rootID)
}

// RemoveTreeQueue queues root deletion while the caller owns admission.
func (lease *QueueAdmissionLease) RemoveTreeQueue(boxID, rootID string) error {
	dbQueueLock.Lock()
	defer dbQueueLock.Unlock()

	newOp := &dbQueueOperation{removeTreeBox: boxID, removeTreeID: rootID, inQueueTime: time.Now(), action: "delete_id", batchID: lease.batchID}
	for i, op := range operationQueue {
		if "delete_id" == op.action && op.removeTreeBox == boxID && op.removeTreeID == rootID {
			return replaceOperation(i, newOp)
		}
	}
	return appendOperation(newOp)
}

func BatchRemoveTreeQueue(rootIDs []string) error {
	return BatchRemoveTreeQueueInBox(rootIDs, "")
}

// BatchRemoveTreeQueueInBox queues root deletion in one content store.
func BatchRemoveTreeQueueInBox(rootIDs []string, boxID string) error {
	lease := AcquireQueueAdmissionLease()
	defer lease.Release()
	return lease.BatchRemoveTreeQueueInBox(rootIDs, boxID)
}

// BatchRemoveTreeQueueInBox queues root deletions while the caller owns admission.
func (lease *QueueAdmissionLease) BatchRemoveTreeQueueInBox(rootIDs []string, boxID string) error {
	if 1 > len(rootIDs) {
		return nil
	}

	dbQueueLock.Lock()
	defer dbQueueLock.Unlock()

	newOp := &dbQueueOperation{removeTreeBox: boxID, removeTreeIDs: rootIDs, inQueueTime: time.Now(), action: "delete_ids", batchID: lease.batchID}
	return appendOperation(newOp)
}

func RemoveTreePathQueue(treeBox, treePathPrefix string) error {
	releaseAdmission := holdQueueAdmission()
	defer releaseAdmission()

	dbQueueLock.Lock()
	defer dbQueueLock.Unlock()

	newOp := &dbQueueOperation{removeTreeBox: treeBox, removeTreePath: treePathPrefix, inQueueTime: time.Now(), action: "delete"}
	for i, op := range operationQueue {
		if "delete" == op.action && (op.removeTreeBox == treeBox && op.removeTreePath == treePathPrefix) {
			return replaceOperation(i, newOp)
		}
	}
	return appendOperation(newOp)
}

func getOperations() (ops []*dbQueueOperation) {
	dbQueueLock.Lock()
	defer dbQueueLock.Unlock()

	flushingTx = true
	ops = operationQueue
	operationQueue = nil
	return
}

func persistOperation(op *dbQueueOperation) error {
	return persistOperations([]*dbQueueOperation{op})
}

func persistOperations(ops []*dbQueueOperation) error {
	if indexQueueRecoveryErr != nil {
		return fmt.Errorf("durable index queue recovery is pending: %w", indexQueueRecoveryErr)
	}
	if err := appendOpsToIndexQueue(ops); err != nil {
		logging.LogErrorf("persist database queue operation batch [count=%d] failed: %s", len(ops), err)
		return err
	}
	return nil
}

func replaceOperation(index int, op *dbQueueOperation) error {
	if err := persistOperation(op); err != nil {
		return err
	}
	removeOperationAt(index)
	operationQueue = append(operationQueue, op)
	return nil
}

func removeOperationAt(index int) {
	copy(operationQueue[index:], operationQueue[index+1:])
	operationQueue[len(operationQueue)-1] = nil
	operationQueue = operationQueue[:len(operationQueue)-1]
}

func admitPersistedOperations(ops []*dbQueueOperation) {
	for _, newOp := range ops {
		newEntry := dbOpToIndexEntry(newOp)
		newKey, coalescible := indexEntryKey(*newEntry)
		if coalescible {
			for i := len(operationQueue) - 1; i >= 0; i-- {
				oldEntry := dbOpToIndexEntry(operationQueue[i])
				if oldEntry == nil {
					continue
				}
				oldKey, oldCoalescible := indexEntryKey(*oldEntry)
				if oldCoalescible && oldKey == newKey {
					removeOperationAt(i)
				}
			}
		}
		operationQueue = append(operationQueue, newOp)
	}
	if len(ops) > 0 {
		eventbus.Publish(eventbus.EvtSQLIndexChanged)
	}
}

func appendOperation(op *dbQueueOperation) error {
	if err := persistOperation(op); err != nil {
		return err
	}
	operationQueue = append(operationQueue, op)
	eventbus.Publish(eventbus.EvtSQLIndexChanged)
	return nil
}

func appendTransientOperation(op *dbQueueOperation) {
	operationQueue = append(operationQueue, op)
	eventbus.Publish(eventbus.EvtSQLIndexChanged)
}

func processDiskQueue(entries, deferredEntries []indexEntry, indexSnapshot int64) (retErr error) {
	if 1 > len(entries) {
		return nil
	}

	logging.LogInfof("flushing [%d] disk index queue operations", len(entries))

	luteEngine := lute.New()
	context := map[string]any{eventbus.CtxPushMsg: eventbus.CtxPushMsgToStatusBar}
	groupOpsCurrent := map[string]int{}
	next := 0
	durableSnapshot := indexSnapshot
	defer func() {
		if retErr == nil {
			return
		}
		pending := appendIndexEntries(deferredEntries, entries[next:])
		if _, queueErr := replaceIndexQueueSnapshot(durableSnapshot, pending); queueErr != nil {
			retErr = errors.Join(retErr, fmt.Errorf("persist uncommitted disk queue suffix: %w", queueErr))
		}
	}()
	for i, e := range entries {
		op, err := indexEntryToOp(e, luteEngine)
		if err != nil {
			recoveryErr := fmt.Errorf("restore disk queue operation [%s] for box [%s]: %w", e.Action, e.Box, err)
			recordIndexQueueRecoveryError(indexQueueRecoverySourceForBox(e.Box), recoveryErr)
			return recoveryErr
		}
		supportsBlockEmbeddings := GetEncryptedDB(op.boxID()) == nil
		tx, err := beginTxForBox(op.boxID())
		if err != nil {
			return fmt.Errorf("begin disk queue operation [%s] for box [%s]: %w", op.action, op.boxID(), err)
		}
		groupOpsCurrent[op.action]++
		context["current"] = groupOpsCurrent[op.action]
		context["total"] = len(entries)
		if err = execOp(op, tx, context, supportsBlockEmbeddings); err != nil {
			opErr := fmt.Errorf("disk queue operation [%s] for box [%s]: %w", op.action, op.boxID(), err)
			if rollbackErr := rollbackTx(tx); rollbackErr != nil {
				opErr = errors.Join(opErr, fmt.Errorf("rollback disk queue operation [%s] for box [%s]: %w", op.action, op.boxID(), rollbackErr))
			}
			logging.LogErrorf("queue operation [%s] failed: %s", op.action, opErr)
			return opErr
		}
		if err = commitTx(tx); err != nil {
			logging.LogErrorf("commit tx failed: %s", err)
			return fmt.Errorf("commit disk queue operation [%s] for box [%s]: %w", op.action, op.boxID(), err)
		}
		next = i + 1
		pending := appendIndexEntries(deferredEntries, entries[next:])
		durableSnapshot, err = replaceIndexQueueSnapshot(durableSnapshot, pending)
		if err != nil {
			return fmt.Errorf("remove committed disk queue prefix through operation [%d]: %w", next, err)
		}
		if queueAfterDurableCommitHook != nil {
			queueAfterDurableCommitHook(next)
		}
	}

	return nil
}
