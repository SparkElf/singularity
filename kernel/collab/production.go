package collab

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/88250/gulu"
	"github.com/siyuan-note/siyuan/kernel/model"
	"github.com/siyuan-note/siyuan/kernel/util"
)

var ErrEncryptedCollaborationUnavailable = errors.New("encrypted collaboration is unavailable")

// ErrCollaborationRecoveryRequired 表示提交日志停留在无法安全判断正文状态的阶段。
// Kernel 必须阻断新的协作请求，避免把一次可能重复的操作静默重放到正文。
var ErrCollaborationRecoveryRequired = errors.New("collaboration recovery requires operator intervention")

type FeatureMode string

const (
	FeatureModeStandard            FeatureMode = "standard"
	FeatureModeRestrictedEncrypted FeatureMode = "restricted-encrypted"
)

type Admission struct {
	SessionGeneration uint64        `json:"sessionGeneration"`
	Version           VersionVector `json:"version"`
}

type ApplyResult struct {
	Broadcast *HistoryEntry `json:"broadcast,omitempty"`
	Result    Result        `json:"result"`
}

// productionDocument 只保留协作元数据和 canonical operation log，不复制正文、块树或 AV 内容。
type productionDocument struct {
	identity   DocumentIdentity
	history    []OperationEnvelope
	operations map[string]OperationEnvelope
	version    VersionVector
	sequences  map[string]uint64
	serverSeq  uint64
	moves      map[string]moveRecord
	references map[string]OperationEnvelope
	avCells    map[string]cellRecord
}

type ProductionCoordinator struct {
	mu                sync.Mutex
	documents         map[DocumentIdentity]*productionDocument
	sessionGeneration uint64
}

func NewProductionCoordinator() *ProductionCoordinator {
	// 使用毫秒级进程代次，满足前端安全整数范围，同时让 Kernel 重启后拒绝旧会话。
	return &ProductionCoordinator{
		documents:         make(map[DocumentIdentity]*productionDocument),
		sessionGeneration: uint64(time.Now().UnixMilli()),
	}
}

// Admit 将协作会话绑定到 Kernel 内容身份；加密库只允许在现有解锁状态下进入受限模式。
func (coordinator *ProductionCoordinator) Admit(identity DocumentIdentity, mode FeatureMode, encrypted bool, unlocked bool) (Admission, error) {
	coordinator.mu.Lock()
	defer coordinator.mu.Unlock()
	if encrypted && (mode != FeatureModeRestrictedEncrypted || !unlocked) {
		return Admission{}, ErrEncryptedCollaborationUnavailable
	}
	document, err := coordinator.document(identity, encrypted, unlocked)
	if err != nil {
		return Admission{}, err
	}
	return Admission{SessionGeneration: coordinator.sessionGeneration, Version: document.version.clone()}, nil
}

// Apply 先做无正文副作用的因果/冲突预演，再以提交日志包住真实 Kernel transaction。
func (coordinator *ProductionCoordinator) Apply(envelope OperationEnvelope, mode FeatureMode, encrypted bool, unlocked bool) (ApplyResult, error) {
	coordinator.mu.Lock()
	defer coordinator.mu.Unlock()
	if encrypted && (mode != FeatureModeRestrictedEncrypted || !unlocked) {
		return ApplyResult{}, ErrEncryptedCollaborationUnavailable
	}
	if envelope.SessionGeneration != coordinator.sessionGeneration {
		return ApplyResult{Result: Result{
			Outcome: OutcomeRejected, Identity: envelope.Identity, OperationID: envelope.OperationID,
			SessionGeneration: envelope.SessionGeneration, Code: RejectSessionGenerationMismatch,
		}}, nil
	}
	document, err := coordinator.document(envelope.Identity, encrypted, unlocked)
	if err != nil {
		return ApplyResult{}, err
	}
	result := document.preflight(envelope)
	if result.Outcome != OutcomeAccepted {
		if result.Outcome == OutcomeDuplicate {
			// 重复请求可能是在 history 落盘失败后到达；先补写完整 history，再清理已提交 WAL。
			if _, statErr := os.Stat(journalPath(envelope.Identity, encrypted)); statErr == nil {
				if historyErr := persistHistory(envelope.Identity, encrypted, document.history); historyErr != nil {
					return ApplyResult{}, historyErr
				}
				if clearErr := clearJournal(envelope.Identity, encrypted); clearErr != nil {
					return ApplyResult{}, clearErr
				}
			} else if !os.IsNotExist(statErr) {
				return ApplyResult{}, statErr
			}
		}
		return ApplyResult{Result: result}, nil
	}
	// 提交日志先落盘，进程在正文事务之后退出时可由启动恢复 canonical history。
	if err := persistJournal(envelope.Identity, encrypted, collaborationJournal{Version: 1, Phase: journalPhasePrepared, Entry: envelope}); err != nil {
		return ApplyResult{}, err
	}
	if err := model.ApplyCollaborationOperation(model.CollaborationOperationInput{
		NotebookID: envelope.Identity.NotebookID, DocumentID: envelope.Identity.DocumentID,
		BlockID: envelope.Operation.BlockID, ParentBlockID: envelope.Operation.ParentBlockID,
		Index: envelope.Operation.Index, Position: envelope.Operation.Position,
		From: envelope.Operation.From, To: envelope.Operation.To, Text: envelope.Operation.Text,
		BlockType: string(envelope.Operation.BlockType), Content: envelope.Operation.Content,
		ReferenceBlockID: func() string {
			if envelope.Operation.Target == nil {
				return ""
			}
			return envelope.Operation.Target.BlockID
		}(),
		ReferenceDocumentID: func() string {
			if envelope.Operation.Target == nil {
				return ""
			}
			return envelope.Operation.Target.DocumentID
		}(),
		ReferenceNotebookID: func() string {
			if envelope.Operation.Target == nil {
				return ""
			}
			return envelope.Operation.Target.NotebookID
		}(),
		EmbedType:       string(envelope.Operation.EmbedType),
		AttributeViewID: envelope.Operation.AttributeViewID,
		RowID:           envelope.Operation.RowID,
		ColumnID:        envelope.Operation.ColumnID,
		Value:           envelope.Operation.Value,
		OperationKind:   string(envelope.Operation.Kind),
	}); err != nil {
		if clearErr := clearJournal(envelope.Identity, encrypted); clearErr != nil {
			return ApplyResult{}, errors.Join(err, clearErr)
		}
		return ApplyResult{Result: Result{
			Outcome: OutcomeRejected, Identity: envelope.Identity, OperationID: envelope.OperationID,
			SessionGeneration: envelope.SessionGeneration, Code: RejectInvalidOperation,
		}}, nil
	}
	result = document.accept(envelope)
	// 正文事务已完整提交后先写 committed 标记，再更新 canonical history；两者都失败时保留日志供恢复。
	if err := persistJournal(envelope.Identity, encrypted, collaborationJournal{Version: 1, Phase: journalPhaseCommitted, Entry: envelope}); err != nil {
		return ApplyResult{}, err
	}
	if err := persistHistory(envelope.Identity, encrypted, document.history); err != nil {
		return ApplyResult{}, err
	}
	if err := clearJournal(envelope.Identity, encrypted); err != nil {
		return ApplyResult{}, err
	}
	entries := document.historyEntries()
	return ApplyResult{Broadcast: &entries[len(entries)-1], Result: result}, nil
}

// Replay 返回当前内容身份的 canonical history，调用方依据 causalContext 裁剪消息缺口。
func (coordinator *ProductionCoordinator) Replay(identity DocumentIdentity) ([]HistoryEntry, error) {
	coordinator.mu.Lock()
	defer coordinator.mu.Unlock()
	encrypted := model.IsEncryptedBox(identity.NotebookID)
	unlocked := model.IsBoxUnlocked(identity.NotebookID)
	if encrypted && !unlocked {
		return nil, ErrEncryptedCollaborationUnavailable
	}
	document, err := coordinator.document(identity, encrypted, unlocked)
	if err != nil {
		return nil, err
	}
	return document.historyEntries(), nil
}

func (coordinator *ProductionCoordinator) document(identity DocumentIdentity, encrypted, unlocked bool) (*productionDocument, error) {
	if document := coordinator.documents[identity]; document != nil {
		return document, nil
	}
	history, err := loadHistory(identity, encrypted, unlocked)
	if err != nil {
		return nil, err
	}
	document, err := newProductionDocument(identity, history, coordinator.sessionGeneration)
	if err != nil {
		return nil, err
	}
	coordinator.documents[identity] = document
	return document, nil
}

func newProductionDocument(identity DocumentIdentity, history []OperationEnvelope, sessionGeneration uint64) (*productionDocument, error) {
	document := &productionDocument{
		identity: identity, history: make([]OperationEnvelope, 0, len(history)),
		operations: make(map[string]OperationEnvelope), version: make(VersionVector),
		sequences: make(map[string]uint64), moves: make(map[string]moveRecord),
		references: make(map[string]OperationEnvelope), avCells: make(map[string]cellRecord),
	}
	for _, envelope := range history {
		envelope.SessionGeneration = sessionGeneration
		if result := document.preflight(envelope); result.Outcome != OutcomeAccepted {
			return nil, fmt.Errorf("invalid collaboration history operation %s", envelope.OperationID)
		}
		document.accept(envelope)
	}
	return document, nil
}

func (document *productionDocument) preflight(envelope OperationEnvelope) Result {
	result := Result{Identity: envelope.Identity, OperationID: envelope.OperationID, SessionGeneration: envelope.SessionGeneration}
	if err := ValidateOperationEnvelope(envelope); err != nil {
		result.Outcome = OutcomeRejected
		if errors.Is(err, ErrMissingIdentity) {
			result.Code = RejectMissingIdentity
		} else {
			result.Code = RejectInvalidOperation
		}
		return result
	}
	if !envelope.Identity.sameAs(document.identity) {
		result.Outcome, result.Code = OutcomeRejected, RejectMissingIdentity
		return result
	}
	if previous, exists := document.operations[envelope.OperationID]; exists {
		if sameEnvelope(previous, envelope) {
			result.Outcome, result.ServerSequence = OutcomeDuplicate, document.sequences[envelope.OperationID]
			return result
		}
		result.Outcome, result.Code = OutcomeRejected, RejectDuplicateOperation
		return result
	}
	for clientID, sequence := range envelope.CausalContext {
		if sequence > document.version[clientID] {
			result.Outcome, result.Code = OutcomeRejected, RejectCausalContextExpired
			return result
		}
	}
	if conflict := document.conflict(envelope); conflict != nil {
		result.Outcome, result.Conflict = OutcomeConflict, conflict
		return result
	}
	result.Outcome = OutcomeAccepted
	return result
}

func (document *productionDocument) conflict(envelope OperationEnvelope) *ConflictRecord {
	op := envelope.Operation
	switch op.Kind {
	case OperationBlockMove:
		previous, exists := document.moves[op.BlockID]
		if exists && concurrent(envelope, previous.Envelope) && (previous.ParentID != op.ParentBlockID || previous.Index != op.Index) {
			return &ConflictRecord{ConflictID: envelope.OperationID, Identity: document.identity, Kind: "block-move", BlockID: op.BlockID, OperationIDs: []string{previous.Envelope.OperationID, envelope.OperationID}, Code: RejectStructureConflict}
		}
	case OperationReferenceUpdate:
		previous, exists := document.references[op.BlockID]
		if exists && concurrent(envelope, previous) && !sameTarget(previous.Operation.Target, op.Target) {
			return &ConflictRecord{ConflictID: envelope.OperationID, Identity: document.identity, Kind: "reference-target", BlockID: op.BlockID, OperationIDs: []string{previous.OperationID, envelope.OperationID}, Code: RejectReferenceTargetMissing}
		}
	case OperationAttributeCellSet:
		key := cellKey(op.AttributeViewID, op.RowID, op.ColumnID)
		previous, exists := document.avCells[key]
		if exists && concurrent(envelope, previous.Envelope) && !valuesEqual(previous.Value, op.Value) {
			return &ConflictRecord{ConflictID: envelope.OperationID, Identity: document.identity, Kind: "attribute-view-cell", AttributeViewID: op.AttributeViewID, RowID: op.RowID, ColumnID: op.ColumnID, OperationIDs: []string{previous.OperationID, envelope.OperationID}, Code: RejectAttributeViewConflict}
		}
	}
	return nil
}

func (document *productionDocument) accept(envelope OperationEnvelope) Result {
	document.serverSeq++
	document.history = append(document.history, envelope)
	document.operations[envelope.OperationID] = envelope
	document.sequences[envelope.OperationID] = document.serverSeq
	document.version[envelope.ClientID] = max(document.version[envelope.ClientID], envelope.ClientSequence)
	switch envelope.Operation.Kind {
	case OperationBlockMove:
		document.moves[envelope.Operation.BlockID] = moveRecord{Envelope: envelope, ParentID: envelope.Operation.ParentBlockID, Index: envelope.Operation.Index}
	case OperationReferenceUpdate:
		document.references[envelope.Operation.BlockID] = envelope
	case OperationAttributeCellSet:
		op := envelope.Operation
		document.avCells[cellKey(op.AttributeViewID, op.RowID, op.ColumnID)] = cellRecord{Envelope: envelope, Value: op.Value, OperationID: envelope.OperationID}
	}
	return Result{Outcome: OutcomeAccepted, Identity: envelope.Identity, OperationID: envelope.OperationID, ServerSequence: document.serverSeq, SessionGeneration: envelope.SessionGeneration}
}

func concurrent(left, right OperationEnvelope) bool {
	return !happenedBefore(left, right) && !happenedBefore(right, left)
}

func sameTarget(left, right *TargetIdentity) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func (document *productionDocument) historyEntries() []HistoryEntry {
	entries := make([]HistoryEntry, 0, len(document.history))
	for _, envelope := range document.history {
		entries = append(entries, HistoryEntry{Envelope: envelope, ServerSequence: document.sequences[envelope.OperationID]})
	}
	return entries
}

type persistedHistory struct {
	Version int                 `json:"version"`
	Entries []OperationEnvelope `json:"entries"`
}

type collaborationJournal struct {
	Version int               `json:"version"`
	Phase   string            `json:"phase"`
	Entry   OperationEnvelope `json:"entry"`
}

const (
	journalPhasePrepared  = "prepared"
	journalPhaseCommitted = "committed"
)

func historyPath(identity DocumentIdentity, encrypted bool) string {
	if encrypted {
		return filepath.Join(util.DataDir, identity.NotebookID, ".siyuan", "collaboration", identity.OrganizationID, identity.SpaceID, identity.DocumentID+".sy")
	}
	return filepath.Join(util.DataDir, ".siyuan", "collaboration", identity.OrganizationID, identity.SpaceID, identity.NotebookID, identity.DocumentID+".json")
}

func journalPath(identity DocumentIdentity, encrypted bool) string {
	if encrypted {
		return filepath.Join(util.DataDir, identity.NotebookID, ".siyuan", "collaboration", identity.OrganizationID, identity.SpaceID, identity.DocumentID+".wal")
	}
	return filepath.Join(util.DataDir, ".siyuan", "collaboration", identity.OrganizationID, identity.SpaceID, identity.NotebookID, identity.DocumentID+".wal")
}

func collaborationLogicalPath(identity DocumentIdentity, encrypted bool, suffix string) string {
	if encrypted {
		return "/collaboration/" + identity.OrganizationID + "/" + identity.SpaceID + "/" + identity.DocumentID + suffix
	}
	return ""
}

// readCollaborationPayload 只在 Kernel 内容边界解密协作元数据，明文不会离开本包。
func readCollaborationPayload(identity DocumentIdentity, encrypted, unlocked bool, path, suffix string) ([]byte, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if !encrypted {
		return data, nil
	}
	if !unlocked {
		return nil, ErrEncryptedCollaborationUnavailable
	}
	dek, dekErr := model.GetDEKIfUnlocked(identity.NotebookID)
	if dekErr != nil {
		return nil, ErrEncryptedCollaborationUnavailable
	}
	decrypted, decryptErr := model.DecryptFile(identity.NotebookID, collaborationLogicalPath(identity, encrypted, suffix), dek, data)
	for i := range dek {
		dek[i] = 0
	}
	if decryptErr != nil {
		return nil, fmt.Errorf("decrypt collaboration metadata: %w", decryptErr)
	}
	return decrypted, nil
}

// writeCollaborationPayload 以安全替换写入协作历史或提交日志，并在加密内容库内使用当前 DEK。
func writeCollaborationPayload(identity DocumentIdentity, encrypted bool, path, suffix string, data []byte) error {
	var err error
	if encrypted {
		dek, dekErr := model.GetDEKIfUnlocked(identity.NotebookID)
		if dekErr != nil {
			return ErrEncryptedCollaborationUnavailable
		}
		data, err = model.EncryptFile(identity.NotebookID, collaborationLogicalPath(identity, encrypted, suffix), dek, data)
		for i := range dek {
			dek[i] = 0
		}
		if err != nil {
			return fmt.Errorf("encrypt collaboration metadata: %w", err)
		}
	}
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return fmt.Errorf("create collaboration metadata directory: %w", err)
	}
	if err := gulu.File.WriteFileSafer(path, data, 0600); err != nil {
		return fmt.Errorf("write collaboration metadata: %w", err)
	}
	return nil
}

func loadHistory(identity DocumentIdentity, encrypted, unlocked bool) ([]OperationEnvelope, error) {
	path := historyPath(identity, encrypted)
	data, err := readCollaborationPayload(identity, encrypted, unlocked, path, ".sy")
	var entries []OperationEnvelope
	if os.IsNotExist(err) {
		entries = nil
	} else {
		if err != nil {
			return nil, fmt.Errorf("read collaboration history: %w", err)
		}
		var persisted persistedHistory
		if err := json.Unmarshal(data, &persisted); err != nil {
			return nil, fmt.Errorf("parse collaboration history: %w", err)
		}
		if persisted.Version != 1 {
			return nil, fmt.Errorf("unsupported collaboration history version %d", persisted.Version)
		}
		entries = persisted.Entries
	}

	journalData, journalErr := readCollaborationPayload(identity, encrypted, unlocked, journalPath(identity, encrypted), ".wal")
	if os.IsNotExist(journalErr) {
		return entries, nil
	}
	if journalErr != nil {
		return nil, fmt.Errorf("read collaboration journal: %w", journalErr)
	}
	var journal collaborationJournal
	if err := json.Unmarshal(journalData, &journal); err != nil {
		return nil, fmt.Errorf("parse collaboration journal: %w", err)
	}
	if journal.Version != 1 || journal.Phase != journalPhaseCommitted {
		return nil, ErrCollaborationRecoveryRequired
	}
	if !historyContains(entries, journal.Entry.OperationID) {
		entries = append(entries, journal.Entry)
	}
	if err := persistHistory(identity, encrypted, entries); err != nil {
		return nil, fmt.Errorf("recover collaboration history: %w", err)
	}
	if err := clearJournal(identity, encrypted); err != nil {
		return nil, fmt.Errorf("clear recovered collaboration journal: %w", err)
	}
	return entries, nil
}

func persistHistory(identity DocumentIdentity, encrypted bool, history []OperationEnvelope) error {
	data, err := json.Marshal(persistedHistory{Version: 1, Entries: history})
	if err != nil {
		return fmt.Errorf("encode collaboration history: %w", err)
	}
	return writeCollaborationPayload(identity, encrypted, historyPath(identity, encrypted), ".sy", data)
}

func persistJournal(identity DocumentIdentity, encrypted bool, journal collaborationJournal) error {
	data, err := json.Marshal(journal)
	if err != nil {
		return fmt.Errorf("encode collaboration journal: %w", err)
	}
	return writeCollaborationPayload(identity, encrypted, journalPath(identity, encrypted), ".wal", data)
}

func clearJournal(identity DocumentIdentity, encrypted bool) error {
	if err := os.Remove(journalPath(identity, encrypted)); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove collaboration journal: %w", err)
	}
	return nil
}

func historyContains(history []OperationEnvelope, operationID string) bool {
	for _, entry := range history {
		if entry.OperationID == operationID {
			return true
		}
	}
	return false
}
