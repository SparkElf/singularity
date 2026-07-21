package collab

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"unicode/utf8"
)

type State struct {
	Identity   DocumentIdentity
	Blocks     map[string]*Block
	AVCells    map[string]cellRecord
	Tombstones map[string]bool
	Conflicts  []ConflictRecord
	Version    VersionVector
	Operations map[string]OperationEnvelope
	serverSeq  uint64
	sequences  map[string]uint64
	inverses   map[string]Operation
	inserts    []textInsertion
	moves      map[string]moveRecord
	references map[string]OperationEnvelope
	embeds     map[string]OperationEnvelope
}

func NewState(identity DocumentIdentity) (*State, error) {
	if !identity.valid() {
		return nil, ErrMissingIdentity
	}
	return &State{
		Identity:   identity,
		Blocks:     make(map[string]*Block),
		AVCells:    make(map[string]cellRecord),
		Tombstones: make(map[string]bool),
		Version:    make(VersionVector),
		Operations: make(map[string]OperationEnvelope),
		sequences:  make(map[string]uint64),
		inverses:   make(map[string]Operation),
		moves:      make(map[string]moveRecord),
		references: make(map[string]OperationEnvelope),
		embeds:     make(map[string]OperationEnvelope),
	}, nil
}

// Apply 执行一条已通过协议边界解析的语义操作，并保留可重放历史所需的最小元数据。
func (state *State) Apply(envelope OperationEnvelope) Result {
	result := Result{Identity: envelope.Identity, OperationID: envelope.OperationID}
	if err := envelope.validate(); err != nil {
		result.Outcome = OutcomeRejected
		if errors.Is(err, ErrMissingIdentity) {
			result.Code = RejectMissingIdentity
		} else {
			result.Code = RejectInvalidOperation
		}
		return result
	}
	if !envelope.Identity.sameAs(state.Identity) {
		result.Outcome = OutcomeRejected
		result.Code = RejectMissingIdentity
		return result
	}
	if previous, exists := state.Operations[envelope.OperationID]; exists {
		if sameEnvelope(previous, envelope) {
			result.Outcome = OutcomeDuplicate
			result.ServerSequence = state.sequenceFor(envelope.OperationID)
			return result
		}
		result.Outcome = OutcomeRejected
		result.Code = RejectDuplicateOperation
		return result
	}
	if !state.causalContextAvailable(envelope.CausalContext) {
		result.Outcome = OutcomeRejected
		result.Code = RejectCausalContextExpired
		return result
	}

	inverse, code := state.applyOperation(envelope)
	if code != "" {
		result.Outcome = OutcomeRejected
		result.Code = code
		return result
	}
	state.serverSeq++
	state.Operations[envelope.OperationID] = envelope
	state.sequences[envelope.OperationID] = state.serverSeq
	state.Version[envelope.ClientID] = max(state.Version[envelope.ClientID], envelope.ClientSequence)
	state.inverses[envelope.OperationID] = inverse
	result.Outcome = OutcomeAccepted
	result.ServerSequence = state.serverSeq
	return result
}

func (state *State) applyOperation(envelope OperationEnvelope) (Operation, RejectionCode) {
	op := envelope.Operation
	switch op.Kind {
	case OperationTextInsert:
		block := state.Blocks[op.BlockID]
		if block == nil {
			return Operation{}, RejectInvalidOperation
		}
		inverse := Operation{Kind: OperationTextDelete, BlockID: op.BlockID, From: op.Position, To: op.Position + utf8.RuneCountInString(op.Text)}
		if block.Deleted {
			return inverse, ""
		}
		position := state.textInsertPosition(envelope)
		block.Content = insertRunes(block.Content, position, op.Text)
		state.inserts = append(state.inserts, textInsertion{OperationID: envelope.OperationID, BlockID: op.BlockID, Position: op.Position, Text: op.Text})
		return inverse, ""
	case OperationTextDelete:
		block := state.Blocks[op.BlockID]
		if block == nil {
			return Operation{}, RejectInvalidOperation
		}
		old := sliceRunes(block.Content, op.From, op.To)
		inverse := Operation{Kind: OperationTextInsert, BlockID: op.BlockID, Position: op.From, Text: old}
		if !block.Deleted {
			block.Content = deleteRunes(block.Content, op.From, op.To)
		}
		return inverse, ""
	case OperationBlockInsert:
		if op.BlockID == "" || state.Blocks[op.BlockID] != nil || state.Tombstones[op.BlockID] {
			return Operation{}, RejectStructureConflict
		}
		state.Blocks[op.BlockID] = &Block{ID: op.BlockID, ParentID: op.ParentBlockID, Index: op.Index, Type: op.BlockType, Content: op.Content}
		return Operation{Kind: OperationBlockDelete, BlockID: op.BlockID}, ""
	case OperationBlockMove:
		block := state.Blocks[op.BlockID]
		if block == nil || block.Deleted {
			return Operation{}, RejectInvalidOperation
		}
		if previous, ok := state.moves[op.BlockID]; ok && !happenedBefore(envelope, previous.Envelope) && !happenedBefore(previous.Envelope, envelope) && (previous.ParentID != op.ParentBlockID || previous.Index != op.Index) {
			state.Conflicts = append(state.Conflicts, ConflictRecord{Identity: state.Identity, BlockID: op.BlockID, OperationIDs: []string{previous.Envelope.OperationID, envelope.OperationID}, Code: RejectStructureConflict})
			return Operation{}, RejectStructureConflict
		}
		inverse := Operation{Kind: OperationBlockMove, BlockID: op.BlockID, ParentBlockID: block.ParentID, Index: block.Index}
		block.ParentID, block.Index = op.ParentBlockID, op.Index
		state.moves[op.BlockID] = moveRecord{Envelope: envelope, ParentID: op.ParentBlockID, Index: op.Index}
		return inverse, ""
	case OperationBlockDelete:
		block := state.Blocks[op.BlockID]
		if block == nil {
			return Operation{}, RejectInvalidOperation
		}
		inverse := Operation{Kind: OperationBlockInsert, BlockID: block.ID, ParentBlockID: block.ParentID, Index: block.Index, BlockType: block.Type, Content: block.Content}
		block.Deleted = true
		state.Tombstones[op.BlockID] = true
		return inverse, ""
	case OperationReferenceUpdate:
		block := state.Blocks[op.BlockID]
		if block == nil {
			return Operation{}, RejectInvalidOperation
		}
		if op.Target != nil && !op.Target.valid() {
			return Operation{}, RejectReferenceTargetMissing
		}
		if previous, ok := state.references[op.BlockID]; ok && block.Reference != nil && op.Target != nil && *block.Reference != *op.Target && !happenedBefore(envelope, previous) && !happenedBefore(previous, envelope) {
			state.Conflicts = append(state.Conflicts, ConflictRecord{Identity: state.Identity, BlockID: op.BlockID, OperationIDs: []string{envelope.OperationID}, Code: RejectReferenceTargetMissing})
			return Operation{}, RejectReferenceTargetMissing
		}
		inverse := Operation{Kind: OperationReferenceUpdate, BlockID: op.BlockID, Target: block.Reference}
		block.Reference = op.Target
		state.references[op.BlockID] = envelope
		return inverse, ""
	case OperationEmbedUpdate:
		block := state.Blocks[op.BlockID]
		if block == nil || op.EmbedType == "" {
			return Operation{}, RejectInvalidOperation
		}
		if op.Target != nil && !op.Target.valid() {
			return Operation{}, RejectReferenceTargetMissing
		}
		if previous, ok := state.embeds[op.BlockID]; ok && block.Embed != nil && block.Embed.Target != nil && op.Target != nil && *block.Embed.Target != *op.Target && !happenedBefore(envelope, previous) && !happenedBefore(previous, envelope) {
			state.Conflicts = append(state.Conflicts, ConflictRecord{Identity: state.Identity, BlockID: op.BlockID, OperationIDs: []string{previous.OperationID, envelope.OperationID}, Code: RejectReferenceTargetMissing})
			return Operation{}, RejectReferenceTargetMissing
		}
		var inverse Operation
		if block.Embed == nil {
			inverse = Operation{Kind: OperationEmbedUpdate, BlockID: op.BlockID, EmbedType: op.EmbedType, Target: nil}
		} else {
			inverse = Operation{Kind: OperationEmbedUpdate, BlockID: op.BlockID, EmbedType: block.Embed.Type, Target: block.Embed.Target}
		}
		block.Embed = &EmbedState{Type: op.EmbedType, Target: op.Target}
		state.embeds[op.BlockID] = envelope
		return inverse, ""
	case OperationAttributeCellSet:
		if op.AttributeViewID == "" || op.RowID == "" || op.ColumnID == "" {
			return Operation{}, RejectInvalidOperation
		}
		key := cellKey(op.AttributeViewID, op.RowID, op.ColumnID)
		if previous, ok := state.AVCells[key]; ok && !happenedBefore(envelope, previous.Envelope) && !happenedBefore(previous.Envelope, envelope) && !valuesEqual(previous.Value, op.Value) {
			state.Conflicts = append(state.Conflicts, ConflictRecord{Identity: state.Identity, AttributeViewID: op.AttributeViewID, RowID: op.RowID, ColumnID: op.ColumnID, OperationIDs: []string{previous.OperationID, envelope.OperationID}, Code: RejectAttributeViewConflict})
			return Operation{}, RejectAttributeViewConflict
		}
		inverse := Operation{Kind: OperationAttributeCellSet, AttributeViewID: op.AttributeViewID, RowID: op.RowID, ColumnID: op.ColumnID, Value: nil}
		if previous, ok := state.AVCells[key]; ok {
			inverse.Value = previous.Value
		}
		state.AVCells[key] = cellRecord{Envelope: envelope, Value: op.Value, OperationID: envelope.OperationID}
		return inverse, ""
	default:
		return Operation{}, RejectInvalidOperation
	}
}

// InverseOperation 生成当前客户端操作的逆操作；逆操作仍需经过 Apply 的因果和冲突规则。
func (state *State) InverseOperation(operationID string) (Operation, bool) {
	inverse, ok := state.inverses[operationID]
	return inverse, ok
}

func (state *State) ConflictsSnapshot() []ConflictRecord {
	return append([]ConflictRecord(nil), state.Conflicts...)
}

func (state *State) sequenceFor(operationID string) uint64 {
	if operation, ok := state.Operations[operationID]; ok {
		_ = operation
		return state.sequences[operationID]
	}
	return 0
}

func (state *State) causalContextAvailable(context VersionVector) bool {
	for clientID, sequence := range context {
		if sequence > state.Version[clientID] {
			return false
		}
	}
	return true
}

func (state *State) textInsertPosition(envelope OperationEnvelope) int {
	position := envelope.Operation.Position
	for _, insertion := range state.inserts {
		if insertion.BlockID != envelope.Operation.BlockID {
			continue
		}
		previous := state.Operations[insertion.OperationID]
		if happenedBefore(envelope, previous) || insertion.Position < envelope.Operation.Position || (insertion.Position == envelope.Operation.Position && insertion.OperationID < envelope.OperationID) {
			position += utf8.RuneCountInString(insertion.Text)
		}
	}
	return position
}

func happenedBefore(left, right OperationEnvelope) bool {
	if left.ClientID == right.ClientID && left.ClientSequence < right.ClientSequence {
		return true
	}
	return left.CausalContext[right.ClientID] >= right.ClientSequence
}

func sameEnvelope(left, right OperationEnvelope) bool {
	leftBytes, _ := json.Marshal(left)
	rightBytes, _ := json.Marshal(right)
	return string(leftBytes) == string(rightBytes)
}

func valuesEqual(left, right any) bool {
	leftBytes, _ := json.Marshal(left)
	rightBytes, _ := json.Marshal(right)
	return string(leftBytes) == string(rightBytes)
}

func cellKey(viewID, rowID, columnID string) string {
	return viewID + "\x00" + rowID + "\x00" + columnID
}

func max(left, right uint64) uint64 {
	if left > right {
		return left
	}
	return right
}

func insertRunes(source string, position int, value string) string {
	runes := []rune(source)
	if position < 0 {
		position = 0
	}
	if position > len(runes) {
		position = len(runes)
	}
	result := make([]rune, 0, len(runes)+utf8.RuneCountInString(value))
	result = append(result, runes[:position]...)
	result = append(result, []rune(value)...)
	result = append(result, runes[position:]...)
	return string(result)
}

func sliceRunes(source string, from, to int) string {
	runes := []rune(source)
	from = clamp(from, 0, len(runes))
	to = clamp(to, from, len(runes))
	return string(runes[from:to])
}

func deleteRunes(source string, from, to int) string {
	runes := []rune(source)
	from = clamp(from, 0, len(runes))
	to = clamp(to, from, len(runes))
	return string(append(runes[:from:from], runes[to:]...))
}

func clamp(value, lower, upper int) int {
	if value < lower {
		return lower
	}
	if value > upper {
		return upper
	}
	return value
}

// SortConflicts 返回稳定顺序的冲突视图，避免测试和诊断依赖 map 遍历顺序。
func (state *State) SortConflicts() []ConflictRecord {
	conflicts := state.ConflictsSnapshot()
	sort.Slice(conflicts, func(left, right int) bool {
		return fmt.Sprintf("%s:%s:%s:%s", conflicts[left].BlockID, conflicts[left].AttributeViewID, conflicts[left].RowID, conflicts[left].ColumnID) < fmt.Sprintf("%s:%s:%s:%s", conflicts[right].BlockID, conflicts[right].AttributeViewID, conflicts[right].RowID, conflicts[right].ColumnID)
	})
	return conflicts
}
