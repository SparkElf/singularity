// Package collab 提供与生产 HTTP/WebSocket 隔离的实时协作语义原型。
package collab

import "fmt"

type OperationKind string

const (
	OperationTextInsert       OperationKind = "text.insert"
	OperationTextDelete       OperationKind = "text.delete"
	OperationBlockInsert      OperationKind = "block.insert"
	OperationBlockMove        OperationKind = "block.move"
	OperationBlockDelete      OperationKind = "block.delete"
	OperationReferenceUpdate  OperationKind = "reference.update"
	OperationEmbedUpdate      OperationKind = "embed.update"
	OperationAttributeCellSet OperationKind = "attribute-view.cell-set"
)

type RejectionCode string

const (
	RejectInvalidOperation       RejectionCode = "invalid-operation"
	RejectMissingIdentity        RejectionCode = "missing-identity"
	RejectPermissionRevoked      RejectionCode = "permission-revoked"
	RejectCausalContextExpired   RejectionCode = "causal-context-expired"
	RejectDuplicateOperation     RejectionCode = "duplicate-operation-conflict"
	RejectStructureConflict      RejectionCode = "structure-conflict"
	RejectReferenceTargetMissing RejectionCode = "reference-target-missing"
	RejectAttributeViewConflict  RejectionCode = "attribute-view-conflict"
	RejectSessionNotReady        RejectionCode = "session-not-ready"
)

type DocumentIdentity struct {
	OrganizationID string `json:"organizationId"`
	SpaceID        string `json:"spaceId"`
	NotebookID     string `json:"notebookId"`
	DocumentID     string `json:"documentId"`
}

func (identity DocumentIdentity) valid() bool {
	return identity.OrganizationID != "" && identity.SpaceID != "" && identity.NotebookID != "" && identity.DocumentID != ""
}

func (identity DocumentIdentity) sameAs(other DocumentIdentity) bool {
	return identity == other
}

type VersionVector map[string]uint64

func (vector VersionVector) clone() VersionVector {
	result := make(VersionVector, len(vector))
	for key, value := range vector {
		result[key] = value
	}
	return result
}

type TargetIdentity struct {
	BlockID    string `json:"blockId"`
	DocumentID string `json:"documentId"`
	NotebookID string `json:"notebookId"`
}

func (target TargetIdentity) valid() bool {
	return target.BlockID != "" && target.DocumentID != "" && target.NotebookID != ""
}

// Operation 使用显式字段承载联合操作，避免用 payload any 绕过语义类型。
type Operation struct {
	Kind            OperationKind   `json:"kind"`
	BlockID         string          `json:"blockId,omitempty"`
	ParentBlockID   string          `json:"parentBlockId,omitempty"`
	Index           int             `json:"index,omitempty"`
	Position        int             `json:"position,omitempty"`
	From            int             `json:"from,omitempty"`
	To              int             `json:"to,omitempty"`
	Text            string          `json:"text,omitempty"`
	BlockType       string          `json:"blockType,omitempty"`
	Content         string          `json:"content,omitempty"`
	Target          *TargetIdentity `json:"target,omitempty"`
	EmbedType       string          `json:"embedType,omitempty"`
	AttributeViewID string          `json:"attributeViewId,omitempty"`
	RowID           string          `json:"rowId,omitempty"`
	ColumnID        string          `json:"columnId,omitempty"`
	Value           any             `json:"value,omitempty"`
}

type OperationEnvelope struct {
	Identity       DocumentIdentity `json:"identity"`
	OperationID    string           `json:"operationId"`
	ClientID       string           `json:"clientId"`
	ClientSequence uint64           `json:"clientSequence"`
	CausalContext  VersionVector    `json:"causalContext"`
	Operation      Operation        `json:"operation"`
}

func (envelope OperationEnvelope) validate() error {
	if !envelope.Identity.valid() {
		return fmt.Errorf("%w: document identity is incomplete", ErrMissingIdentity)
	}
	if envelope.OperationID == "" || envelope.ClientID == "" || envelope.ClientSequence == 0 {
		return fmt.Errorf("%w: operation identity is incomplete", ErrInvalidOperation)
	}
	op := envelope.Operation
	valid := op.BlockID != ""
	switch op.Kind {
	case OperationTextInsert:
		valid = valid && op.Position >= 0 && op.Text != ""
	case OperationTextDelete:
		valid = valid && op.From >= 0 && op.To > op.From
	case OperationBlockInsert:
		valid = valid && op.Index >= 0 && op.BlockType != ""
	case OperationBlockMove:
		valid = valid && op.Index >= 0
	case OperationBlockDelete:
		valid = valid
	case OperationReferenceUpdate:
		valid = valid && (op.Target == nil || op.Target.valid())
	case OperationEmbedUpdate:
		valid = valid && op.EmbedType != "" && (op.Target == nil || op.Target.valid())
	case OperationAttributeCellSet:
		valid = op.AttributeViewID != "" && op.RowID != "" && op.ColumnID != ""
	default:
		valid = false
	}
	if !valid {
		return fmt.Errorf("%w: operation fields are incomplete", ErrInvalidOperation)
	}
	return nil
}

type Outcome string

const (
	OutcomeAccepted  Outcome = "accepted"
	OutcomeDuplicate Outcome = "duplicate"
	OutcomeRejected  Outcome = "rejected"
)

type Result struct {
	Outcome        Outcome          `json:"outcome"`
	Identity       DocumentIdentity `json:"identity"`
	OperationID    string           `json:"operationId"`
	ServerSequence uint64           `json:"serverSequence,omitempty"`
	Code           RejectionCode    `json:"code,omitempty"`
}

type ConflictRecord struct {
	Identity        DocumentIdentity `json:"identity"`
	BlockID         string           `json:"blockId,omitempty"`
	AttributeViewID string           `json:"attributeViewId,omitempty"`
	RowID           string           `json:"rowId,omitempty"`
	ColumnID        string           `json:"columnId,omitempty"`
	OperationIDs    []string         `json:"operationIds"`
	Code            RejectionCode    `json:"code"`
}

type Block struct {
	ID        string          `json:"id"`
	ParentID  string          `json:"parentId"`
	Index     int             `json:"index"`
	Type      string          `json:"type"`
	Content   string          `json:"content"`
	Deleted   bool            `json:"deleted"`
	Reference *TargetIdentity `json:"reference,omitempty"`
	Embed     *EmbedState     `json:"embed,omitempty"`
}

type EmbedState struct {
	Type   string          `json:"type"`
	Target *TargetIdentity `json:"target,omitempty"`
}

type textInsertion struct {
	OperationID string
	BlockID     string
	Position    int
	Text        string
}

type moveRecord struct {
	Envelope OperationEnvelope
	ParentID string
	Index    int
}

type cellRecord struct {
	Envelope    OperationEnvelope
	Value       any
	OperationID string
}

var (
	ErrMissingIdentity  = fmt.Errorf("missing identity")
	ErrInvalidOperation = fmt.Errorf("invalid operation")
)
