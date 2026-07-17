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
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/88250/gulu"
	"github.com/88250/lute"
	"github.com/gofrs/flock"
	"github.com/siyuan-note/logging"
	"github.com/siyuan-note/siyuan/kernel/filesys"
	"github.com/siyuan-note/siyuan/kernel/util"
)

var (
	indexMu                    sync.Mutex
	indexQueueSize             atomic.Int64
	indexFlock                 *flock.Flock
	deferredIndexRecoveryBoxes = &sync.Map{}
)

type indexEntry struct {
	Action string   `json:"action"`
	ID     string   `json:"id,omitempty"`
	IDs    []string `json:"ids,omitempty"`
	Box    string   `json:"box,omitempty"`
	Path   string   `json:"path,omitempty"`
	Hashes []string `json:"hashes,omitempty"`
	Batch  string   `json:"batch,omitempty"`
}

func initIndexQueue() {
	indexQueuePath := filepath.Join(util.QueueDir, "index.queue")
	os.MkdirAll(util.QueueDir, 0755)
	indexFlock = flock.New(indexQueuePath + ".lock")
	fi, err := os.Stat(indexQueuePath)
	if err != nil {
		if !os.IsNotExist(err) {
			logging.LogErrorf("stat index queue file [%s] failed: %s", indexQueuePath, err)
		}
		return
	}
	indexQueueSize.Store(fi.Size())
}

func closeIndexQueue() {
	os.Remove(filepath.Join(util.QueueDir, "index.queue.lock"))
}

func currentIndexQueueFlock(indexQueuePath string) *flock.Flock {
	lockPath := indexQueuePath + ".lock"
	if indexFlock == nil || indexFlock.Path() != lockPath {
		return flock.New(lockPath)
	}
	return indexFlock
}

func appendToIndexQueue(op *dbQueueOperation) (retErr error) {
	return appendOpsToIndexQueue([]*dbQueueOperation{op})
}

func appendOpsToIndexQueue(ops []*dbQueueOperation) (retErr error) {
	var data bytes.Buffer
	for _, op := range ops {
		entry := dbOpToIndexEntry(op)
		if nil == entry {
			if op.action == "update_block_content" {
				continue
			}
			return fmt.Errorf("unsupported durable index queue action [%s]", op.action)
		}
		encoded, err := json.Marshal(entry)
		if err != nil {
			return fmt.Errorf("marshal index queue entry: %w", err)
		}
		data.Write(encoded)
		data.WriteByte('\n')
	}
	if data.Len() == 0 {
		return nil
	}

	queueFlock := currentIndexQueueFlock(filepath.Join(util.QueueDir, "index.queue"))
	if err := queueFlock.Lock(); err != nil {
		return fmt.Errorf("lock index queue: %w", err)
	}
	defer func() {
		if unlockErr := queueFlock.Unlock(); unlockErr != nil {
			retErr = errors.Join(retErr, fmt.Errorf("unlock index queue: %w", unlockErr))
		}
	}()

	indexMu.Lock()
	defer indexMu.Unlock()

	indexQueuePath := filepath.Join(util.QueueDir, "index.queue")
	f, err := os.OpenFile(indexQueuePath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return fmt.Errorf("open index queue for append: %w", err)
	}
	fi, statErr := f.Stat()
	if statErr != nil {
		return fmt.Errorf("stat index queue before append: %w", errors.Join(statErr, f.Close()))
	}
	previousSize := fi.Size()
	n, writeErr := f.Write(data.Bytes())
	if writeErr == nil && n != data.Len() {
		writeErr = io.ErrShortWrite
	}
	syncErr := f.Sync()
	if persistErr := errors.Join(writeErr, syncErr); persistErr != nil {
		truncateErr := f.Truncate(previousSize)
		rollbackSyncErr := f.Sync()
		closeErr := f.Close()
		if truncateErr == nil && rollbackSyncErr == nil {
			indexQueueSize.Store(previousSize)
		}
		return fmt.Errorf("persist index queue entry: %w", errors.Join(persistErr, truncateErr, rollbackSyncErr, closeErr))
	}
	if closeErr := f.Close(); closeErr != nil {
		rollbackFile, openErr := os.OpenFile(indexQueuePath, os.O_WRONLY, 0644)
		if openErr != nil {
			return fmt.Errorf("close index queue after append: %w", errors.Join(closeErr, openErr))
		}
		truncateErr := rollbackFile.Truncate(previousSize)
		rollbackSyncErr := rollbackFile.Sync()
		rollbackCloseErr := rollbackFile.Close()
		if truncateErr == nil && rollbackSyncErr == nil && rollbackCloseErr == nil {
			indexQueueSize.Store(previousSize)
		}
		return fmt.Errorf("close index queue after append: %w", errors.Join(closeErr, truncateErr, rollbackSyncErr, rollbackCloseErr))
	}
	indexQueueSize.Store(previousSize + int64(n))
	return nil
}

func dbOpToIndexEntry(op *dbQueueOperation) (ret *indexEntry) {
	switch op.action {
	case "upsert":
		ret = &indexEntry{Action: "upsert", ID: op.upsertTree.ID, Box: op.upsertTree.Box, Path: op.upsertTree.Path}
	case "index":
		ret = &indexEntry{Action: "index", ID: op.indexTree.ID, Box: op.indexTree.Box, Path: op.indexTree.Path}
	case "rename":
		ret = &indexEntry{Action: "rename", ID: op.indexTree.ID, Box: op.indexTree.Box, Path: op.indexTree.Path}
	case "move":
		ret = &indexEntry{Action: "move", ID: op.indexTree.ID, Box: op.indexTree.Box, Path: op.indexTree.Path}
	case "update_refs":
		ret = &indexEntry{Action: "update_refs", ID: op.upsertTree.ID, Box: op.upsertTree.Box, Path: op.upsertTree.Path}
	case "delete_refs":
		ret = &indexEntry{Action: "delete_refs", ID: op.upsertTree.ID, Box: op.upsertTree.Box, Path: op.upsertTree.Path}
	case "delete":
		ret = &indexEntry{Action: "delete", Box: op.removeTreeBox, Path: op.removeTreePath}
	case "delete_id":
		ret = &indexEntry{Action: "delete_id", ID: op.removeTreeID, Box: op.removeTreeBox}
	case "delete_ids":
		ret = &indexEntry{Action: "delete_ids", IDs: op.removeTreeIDs, Box: op.removeTreeBox}
	case "delete_box":
		ret = &indexEntry{Action: "delete_box", Box: op.box}
	case "delete_box_refs":
		ret = &indexEntry{Action: "delete_box_refs", Box: op.box}
	case "delete_assets":
		ret = &indexEntry{Action: "delete_assets", Hashes: op.removeAssetHashes}
	case "index_node":
		ret = &indexEntry{Action: "index_node", ID: op.id, Box: op.box}
	}
	if ret != nil {
		ret.Batch = op.batchID
	}
	return
}

func replaceIndexQueueSnapshot(snapshotSize int64, replacement []indexEntry) (newSnapshotSize int64, retErr error) {
	indexQueuePath := filepath.Join(util.QueueDir, "index.queue")
	queueFlock := currentIndexQueueFlock(indexQueuePath)
	if err := queueFlock.Lock(); err != nil {
		return 0, err
	}
	defer func() {
		if unlockErr := queueFlock.Unlock(); unlockErr != nil {
			retErr = errors.Join(retErr, fmt.Errorf("unlock index queue: %w", unlockErr))
		}
	}()

	indexMu.Lock()
	defer indexMu.Unlock()

	var preserved []byte
	fi, err := os.Stat(indexQueuePath)
	if err == nil && fi.Size() > snapshotSize {
		f, openErr := os.Open(indexQueuePath)
		if openErr != nil {
			return 0, openErr
		}
		if _, seekErr := f.Seek(snapshotSize, 0); seekErr != nil {
			return 0, errors.Join(seekErr, f.Close())
		}
		preserved, err = io.ReadAll(f)
		if closeErr := f.Close(); err != nil || closeErr != nil {
			return 0, errors.Join(err, closeErr)
		}
	} else if err != nil && !os.IsNotExist(err) {
		return 0, err
	}

	var data bytes.Buffer
	for _, entry := range replacement {
		encoded, marshalErr := json.Marshal(entry)
		if marshalErr != nil {
			return 0, marshalErr
		}
		data.Write(encoded)
		data.WriteByte('\n')
	}
	newSnapshotSize = int64(data.Len())
	data.Write(preserved)
	if err = gulu.File.WriteFileSafer(indexQueuePath, data.Bytes(), 0644); err != nil {
		return 0, err
	}
	indexQueueSize.Store(int64(data.Len()))
	return newSnapshotSize, nil
}

func snapshotIndexQueueSize() int64 {
	indexMu.Lock()
	defer indexMu.Unlock()

	fi, err := os.Stat(filepath.Join(util.QueueDir, "index.queue"))
	if err != nil {
		return indexQueueSize.Load()
	}
	indexQueueSize.Store(fi.Size())
	return fi.Size()
}

func replaceIndexQueueSnapshotWithEntriesAndOps(snapshotSize int64, entries []indexEntry, ops []*dbQueueOperation) (int64, error) {
	replacement := append([]indexEntry(nil), entries...)
	for _, op := range ops {
		if entry := dbOpToIndexEntry(op); entry != nil {
			replacement = append(replacement, *entry)
		} else if op.action != "update_block_content" {
			return 0, fmt.Errorf("unsupported durable index queue action [%s]", op.action)
		}
	}
	return replaceIndexQueueSnapshot(snapshotSize, replacement)
}

func appendIndexEntries(groups ...[]indexEntry) []indexEntry {
	size := 0
	for _, group := range groups {
		size += len(group)
	}
	ret := make([]indexEntry, 0, size)
	for _, group := range groups {
		ret = append(ret, group...)
	}
	return ret
}

func clearIndexQueue(snapshotSize int64) error {
	_, err := replaceIndexQueueSnapshot(snapshotSize, nil)
	return err
}

func clearIndexQueueEntries() (retErr error) {
	indexQueuePath := filepath.Join(util.QueueDir, "index.queue")
	queueFlock := currentIndexQueueFlock(indexQueuePath)
	if err := queueFlock.Lock(); err != nil {
		return fmt.Errorf("lock index queue for clearing: %w", err)
	}
	defer func() {
		if unlockErr := queueFlock.Unlock(); unlockErr != nil {
			retErr = errors.Join(retErr, fmt.Errorf("unlock index queue after clearing: %w", unlockErr))
		}
	}()

	indexMu.Lock()
	defer indexMu.Unlock()

	f, err := os.OpenFile(indexQueuePath, os.O_WRONLY, 0644)
	if err != nil {
		if os.IsNotExist(err) {
			indexQueueSize.Store(0)
			return nil
		}
		return fmt.Errorf("open index queue for clearing: %w", err)
	}
	truncateErr := f.Truncate(0)
	syncErr := f.Sync()
	closeErr := f.Close()
	if err = errors.Join(truncateErr, syncErr, closeErr); err != nil {
		return fmt.Errorf("clear index queue: %w", err)
	}
	indexQueueSize.Store(0)
	return nil
}

func loadIndexQueue() (entries []indexEntry, snapshotSize int64, retErr error) {
	indexQueuePath := filepath.Join(util.QueueDir, "index.queue")
	queueFlock := currentIndexQueueFlock(indexQueuePath)
	if err := queueFlock.Lock(); err != nil {
		return nil, 0, fmt.Errorf("lock index queue for reading: %w", err)
	}
	defer func() {
		if unlockErr := queueFlock.Unlock(); unlockErr != nil {
			retErr = errors.Join(retErr, fmt.Errorf("unlock index queue after reading: %w", unlockErr))
		}
	}()

	indexMu.Lock()
	defer indexMu.Unlock()

	f, err := os.Open(indexQueuePath)
	if err != nil {
		if os.IsNotExist(err) {
			indexQueueSize.Store(0)
			return nil, 0, nil
		}
		return nil, 0, fmt.Errorf("open index queue for reading: %w", err)
	}
	defer func() {
		if closeErr := f.Close(); closeErr != nil {
			retErr = errors.Join(retErr, fmt.Errorf("close index queue after reading: %w", closeErr))
		}
	}()

	fi, err := f.Stat()
	if err != nil {
		return nil, 0, fmt.Errorf("stat index queue for reading: %w", err)
	}
	snapshotSize = fi.Size()

	decoder := json.NewDecoder(f)
	for {
		var entry indexEntry
		if err = decoder.Decode(&entry); errors.Is(err, io.EOF) {
			break
		} else if err != nil {
			return nil, snapshotSize, fmt.Errorf("decode index queue at byte [%d]: %w", decoder.InputOffset(), err)
		}
		entries = append(entries, entry)
	}
	indexQueueSize.Store(snapshotSize)
	return
}

type indexEntryCoalesceKey struct {
	action   string
	box      string
	identity string
}

func coalesceIndexEntries(entries []indexEntry) []indexEntry {
	ret := make([]indexEntry, 0, len(entries))
	seen := make(map[indexEntryCoalesceKey]struct{}, len(entries))
	for i := len(entries) - 1; i >= 0; i-- {
		entry := entries[i]
		key, coalescible := indexEntryKey(entry)
		if coalescible {
			if _, ok := seen[key]; ok {
				continue
			}
			seen[key] = struct{}{}
		}
		ret = append(ret, entry)
	}
	for i, j := 0, len(ret)-1; i < j; i, j = i+1, j-1 {
		ret[i], ret[j] = ret[j], ret[i]
	}
	return ret
}

func indexEntryKey(entry indexEntry) (indexEntryCoalesceKey, bool) {
	key := indexEntryCoalesceKey{action: entry.Action, box: entry.Box}
	switch entry.Action {
	case "upsert", "index", "rename", "move", "update_refs", "delete_refs", "delete_id", "index_node":
		key.identity = entry.ID
	case "delete":
		key.identity = entry.Path
	case "delete_box", "delete_box_refs":
	default:
		return indexEntryCoalesceKey{}, false
	}
	return key, true
}

func recoverIndexQueue() {
	setIndexQueueRecoveryError(startupIndexQueueRecoverySource, errors.New("durable index queue recovery is in progress"), false)

	entries, _, err := loadIndexQueue()
	if err != nil {
		recordIndexQueueRecoveryError(startupIndexQueueRecoverySource, err)
		return
	}
	entries = coalesceIndexEntries(entries)
	refreshDeferredIndexRecoveryBoxes(entries)
	ready, deferred := partitionRecoverableIndexEntries(entries)
	ops, err := restoreIndexEntries(ready)
	if err != nil {
		recordIndexQueueRecoveryError(startupIndexQueueRecoverySource, err)
		return
	}
	dbQueueLock.Lock()
	clearIndexQueueRecoveryErrorLocked(startupIndexQueueRecoverySource)
	admitRecoveredOperations(ops)
	dbQueueLock.Unlock()

	if len(ops) > 0 {
		logging.LogInfof("recovered [%d] index queue operations, will be flushed soon", len(ops))
	}
	if len(deferred) > 0 {
		logging.LogInfof("deferred [%d] encrypted index queue operations until their notebooks are unlocked", len(deferred))
	}
}

// EncryptedIndexQueueRecovery keeps one encrypted notebook's durable entries
// deferred while UnlockBox opens its databases and publishes the DEK.
type EncryptedIndexQueueRecovery struct {
	boxID string
}

// BeginEncryptedIndexQueueRecovery must run before opening the encrypted
// content database. The marker is independent from connection state, so a
// background flush cannot attempt decryption in the DB-open/DEK-pending gap.
func BeginEncryptedIndexQueueRecovery(boxID string) *EncryptedIndexQueueRecovery {
	deferredIndexRecoveryBoxes.Store(boxID, struct{}{})
	return &EncryptedIndexQueueRecovery{boxID: boxID}
}

// Recover restores this notebook's deferred durable operations after its
// content database and DEK are both readable. Success clears the marker. A
// failure keeps it set and leaves index.queue untouched for an explicit retry.
func (recovery *EncryptedIndexQueueRecovery) Recover() error {
	boxID := recovery.boxID
	recoverySource := encryptedIndexQueueRecoverySource(boxID)
	initDatabaseLock.Lock()
	defer initDatabaseLock.Unlock()
	releaseAdmission := queueAdmission.close(nil)
	defer releaseAdmission()

	if IsEncryptedBoxFn == nil || !IsEncryptedBoxFn(boxID) {
		return fmt.Errorf("box [%s] is not an encrypted content store", boxID)
	}
	if GetEncryptedDB(boxID) == nil {
		return fmt.Errorf("encrypted database for box [%s] is not open", boxID)
	}
	entries, _, err := loadIndexQueue()
	if err != nil {
		recordIndexQueueRecoveryError(recoverySource, err)
		return err
	}
	selected := make([]indexEntry, 0)
	for _, entry := range coalesceIndexEntries(entries) {
		if entry.Box == boxID {
			selected = append(selected, entry)
		}
	}
	ops, err := restoreIndexEntries(selected)
	if err != nil {
		return err
	}
	deferredIndexRecoveryBoxes.Delete(boxID)
	dbQueueLock.Lock()
	admitRecoveredOperations(ops)
	clearIndexQueueRecoveryErrorLocked(recoverySource)
	dbQueueLock.Unlock()
	if len(ops) > 0 {
		logging.LogInfof("recovered [%d] deferred index queue operations for box [%s]", len(ops), boxID)
	}
	return nil
}

// Cancel clears the explicit unlock marker after the caller has closed the
// failed encrypted database and revoked its DEK. With the DB closed, ordinary
// queue processing still recognizes the durable entries as deferred.
func (recovery *EncryptedIndexQueueRecovery) Cancel() {
	deferredIndexRecoveryBoxes.Delete(recovery.boxID)
}

// Rollback removes only this batch's still-durable operations. Other batches,
// ordinary operations, locked encrypted entries and transient derived work are
// retained. Rebuilding the in-memory queue from the filtered durable log also
// restores an older operation that this batch may have coalesced in memory.
func (batch *QueueBatch) Rollback() error {
	if batch.owner != nil {
		return batch.rollbackAdmissionOwned()
	}
	initDatabaseLock.Lock()
	defer initDatabaseLock.Unlock()
	releaseAdmission := queueAdmission.close(nil)
	defer releaseAdmission()
	return batch.rollbackAdmissionOwned()
}

func (batch *QueueBatch) rollbackAdmissionOwned() error {
	entries, snapshotSize, err := loadIndexQueue()
	if err != nil {
		return fmt.Errorf("load durable queue for batch rollback [%s]: %w", batch.id, err)
	}
	retained := make([]indexEntry, 0, len(entries))
	for _, entry := range entries {
		if entry.Batch != batch.id {
			retained = append(retained, entry)
		}
	}
	ready, _ := partitionRecoverableIndexEntries(coalesceIndexEntries(retained))
	ops, err := restoreIndexEntries(ready)
	if err != nil {
		return fmt.Errorf("restore retained durable queue during batch rollback [%s]: %w", batch.id, err)
	}

	dbQueueLock.Lock()
	transient := make([]*dbQueueOperation, 0)
	for _, op := range operationQueue {
		if op.batchID != batch.id && dbOpToIndexEntry(op) == nil {
			transient = append(transient, op)
		}
	}
	dbQueueLock.Unlock()

	if _, err = replaceIndexQueueSnapshot(snapshotSize, retained); err != nil {
		return fmt.Errorf("persist durable queue batch rollback [%s]: %w", batch.id, err)
	}
	dbQueueLock.Lock()
	operationQueue = nil
	admitRecoveredOperations(ops)
	operationQueue = append(operationQueue, transient...)
	dbQueueCond.Broadcast()
	dbQueueLock.Unlock()
	return nil
}

func partitionRecoverableIndexEntries(entries []indexEntry) (ready, deferred []indexEntry) {
	for _, entry := range entries {
		if isLockedEncryptedIndexEntry(entry) {
			deferred = append(deferred, entry)
		} else {
			ready = append(ready, entry)
		}
	}
	return
}

func isLockedEncryptedIndexEntry(entry indexEntry) bool {
	if entry.Box == "" || IsEncryptedBoxFn == nil || !IsEncryptedBoxFn(entry.Box) {
		return false
	}
	if _, deferred := deferredIndexRecoveryBoxes.Load(entry.Box); deferred {
		return true
	}
	return GetEncryptedDB(entry.Box) == nil
}

func refreshDeferredIndexRecoveryBoxes(entries []indexEntry) {
	deferredIndexRecoveryBoxes.Range(func(key, _ any) bool {
		deferredIndexRecoveryBoxes.Delete(key)
		return true
	})
	if IsEncryptedBoxFn == nil {
		return
	}
	for _, entry := range entries {
		if entry.Box != "" && IsEncryptedBoxFn(entry.Box) && GetEncryptedDB(entry.Box) == nil {
			deferredIndexRecoveryBoxes.Store(entry.Box, struct{}{})
		}
	}
}

func restoreIndexEntries(entries []indexEntry) ([]*dbQueueOperation, error) {
	luteEngine := lute.New()
	ops := make([]*dbQueueOperation, 0, len(entries))
	for _, entry := range entries {
		op, err := indexEntryToOp(entry, luteEngine)
		if err != nil {
			return nil, fmt.Errorf("restore operation [%s] for box [%s]: %w", entry.Action, entry.Box, err)
		}
		ops = append(ops, op)
	}
	return ops, nil
}

// admitRecoveredOperations is idempotent for an unchanged durable snapshot.
// Coalescible operations still use their logical key; exact non-coalescible
// records are not appended twice when recovery is explicitly retried.
func admitRecoveredOperations(ops []*dbQueueOperation) {
	existing := map[string]struct{}{}
	for _, op := range operationQueue {
		if entry := dbOpToIndexEntry(op); entry != nil {
			data, _ := json.Marshal(entry)
			existing[string(data)] = struct{}{}
		}
	}
	unique := make([]*dbQueueOperation, 0, len(ops))
	for _, op := range ops {
		entry := dbOpToIndexEntry(op)
		data, _ := json.Marshal(entry)
		key := string(data)
		if _, found := existing[key]; found {
			continue
		}
		existing[key] = struct{}{}
		unique = append(unique, op)
	}
	admitPersistedOperations(unique)
}

const startupIndexQueueRecoverySource = "startup"

func encryptedIndexQueueRecoverySource(boxID string) string {
	return "encrypted:" + boxID
}

func indexQueueRecoverySourceForBox(boxID string) string {
	if boxID != "" && IsEncryptedBoxFn != nil && IsEncryptedBoxFn(boxID) {
		return encryptedIndexQueueRecoverySource(boxID)
	}
	return startupIndexQueueRecoverySource
}

func recordIndexQueueRecoveryError(source string, err error) {
	setIndexQueueRecoveryError(source, err, true)
}

func setIndexQueueRecoveryError(source string, err error, logFailure bool) {
	dbQueueLock.Lock()
	indexQueueRecoveryErrs[source] = err
	rebuildIndexQueueRecoveryErrorLocked()
	dbQueueLock.Unlock()
	if logFailure {
		logging.LogErrorf("recover index queue from [%s] failed: %s", source, err)
	}
}

func clearIndexQueueRecoveryErrorLocked(source string) {
	delete(indexQueueRecoveryErrs, source)
	rebuildIndexQueueRecoveryErrorLocked()
}

func rebuildIndexQueueRecoveryErrorLocked() {
	sources := make([]string, 0, len(indexQueueRecoveryErrs))
	for source := range indexQueueRecoveryErrs {
		sources = append(sources, source)
	}
	sort.Strings(sources)
	errs := make([]error, 0, len(sources))
	for _, source := range sources {
		errs = append(errs, fmt.Errorf("%s: %w", source, indexQueueRecoveryErrs[source]))
	}
	indexQueueRecoveryErr = errors.Join(errs...)
}

func indexEntryToOp(e indexEntry, luteEngine *lute.Lute) (*dbQueueOperation, error) {
	switch e.Action {
	case "upsert":
		tree, err := filesys.LoadTree(e.Box, e.Path, luteEngine)
		if err != nil {
			return nil, fmt.Errorf("load upsert tree [%s/%s]: %w", e.Box, e.Path, err)
		}
		return &dbQueueOperation{upsertTree: tree, inQueueTime: time.Now(), action: "upsert", batchID: e.Batch}, nil
	case "index":
		tree, err := filesys.LoadTree(e.Box, e.Path, luteEngine)
		if err != nil {
			return nil, fmt.Errorf("load index tree [%s/%s]: %w", e.Box, e.Path, err)
		}
		return &dbQueueOperation{indexTree: tree, inQueueTime: time.Now(), action: "index", batchID: e.Batch}, nil
	case "rename":
		tree, err := filesys.LoadTree(e.Box, e.Path, luteEngine)
		if err != nil {
			return nil, fmt.Errorf("load rename tree [%s/%s]: %w", e.Box, e.Path, err)
		}
		return &dbQueueOperation{indexTree: tree, inQueueTime: time.Now(), action: "rename", batchID: e.Batch}, nil
	case "move":
		tree, err := filesys.LoadTree(e.Box, e.Path, luteEngine)
		if err != nil {
			return nil, fmt.Errorf("load move tree [%s/%s]: %w", e.Box, e.Path, err)
		}
		return &dbQueueOperation{indexTree: tree, inQueueTime: time.Now(), action: "move", batchID: e.Batch}, nil
	case "update_refs":
		tree, err := filesys.LoadTree(e.Box, e.Path, luteEngine)
		if err != nil {
			return nil, fmt.Errorf("load update refs tree [%s/%s]: %w", e.Box, e.Path, err)
		}
		return &dbQueueOperation{upsertTree: tree, inQueueTime: time.Now(), action: "update_refs", batchID: e.Batch}, nil
	case "delete_refs":
		tree, err := filesys.LoadTree(e.Box, e.Path, luteEngine)
		if err != nil {
			return nil, fmt.Errorf("load delete refs tree [%s/%s]: %w", e.Box, e.Path, err)
		}
		return &dbQueueOperation{upsertTree: tree, inQueueTime: time.Now(), action: "delete_refs", batchID: e.Batch}, nil
	case "delete":
		return &dbQueueOperation{removeTreeBox: e.Box, removeTreePath: e.Path, inQueueTime: time.Now(), action: "delete", batchID: e.Batch}, nil
	case "delete_id":
		return &dbQueueOperation{removeTreeBox: e.Box, removeTreeID: e.ID, inQueueTime: time.Now(), action: "delete_id", batchID: e.Batch}, nil
	case "delete_ids":
		return &dbQueueOperation{removeTreeBox: e.Box, removeTreeIDs: e.IDs, inQueueTime: time.Now(), action: "delete_ids", batchID: e.Batch}, nil
	case "delete_box":
		return &dbQueueOperation{box: e.Box, inQueueTime: time.Now(), action: "delete_box", batchID: e.Batch}, nil
	case "delete_box_refs":
		return &dbQueueOperation{box: e.Box, inQueueTime: time.Now(), action: "delete_box_refs", batchID: e.Batch}, nil
	case "delete_assets":
		return &dbQueueOperation{removeAssetHashes: e.Hashes, inQueueTime: time.Now(), action: "delete_assets", batchID: e.Batch}, nil
	case "index_node":
		return &dbQueueOperation{id: e.ID, box: e.Box, inQueueTime: time.Now(), action: "index_node", batchID: e.Batch}, nil
	}
	return nil, fmt.Errorf("unknown durable index queue action [%s]", e.Action)
}
