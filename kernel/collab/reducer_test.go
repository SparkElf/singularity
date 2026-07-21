package collab

import "testing"

func testIdentity() DocumentIdentity {
	return DocumentIdentity{OrganizationID: "org", SpaceID: "space", NotebookID: "book", DocumentID: "doc"}
}

func envelope(identity DocumentIdentity, operationID, clientID string, sequence uint64, context VersionVector, operation Operation) OperationEnvelope {
	return OperationEnvelope{Identity: identity, OperationID: operationID, ClientID: clientID, ClientSequence: sequence, CausalContext: context, Operation: operation}
}

func TestConcurrentTextInsertConverges(t *testing.T) {
	identity := testIdentity()
	left, _ := NewBridge(identity)
	right, _ := NewBridge(identity)
	insertBlock := envelope(identity, "block", "seed", 1, VersionVector{}, Operation{Kind: OperationBlockInsert, BlockID: "block", BlockType: "paragraph", Content: "x"})
	left.Apply(insertBlock)
	right.Apply(insertBlock)
	a := envelope(identity, "op-z", "client-z", 1, VersionVector{}, Operation{Kind: OperationTextInsert, BlockID: "block", Position: 0, Text: "A"})
	b := envelope(identity, "op-a", "client-a", 1, VersionVector{}, Operation{Kind: OperationTextInsert, BlockID: "block", Position: 0, Text: "B"})
	left.Apply(a)
	left.Apply(b)
	right.Apply(b)
	right.Apply(a)
	if left.State().Blocks["block"].Content != right.State().Blocks["block"].Content {
		t.Fatalf("concurrent text diverged: %q != %q", left.State().Blocks["block"].Content, right.State().Blocks["block"].Content)
	}
	if left.State().Blocks["block"].Content != "BAx" {
		t.Fatalf("unexpected merged text: %q", left.State().Blocks["block"].Content)
	}
}

func TestDuplicateAndCausalRejection(t *testing.T) {
	identity := testIdentity()
	state, _ := NewState(identity)
	block := envelope(identity, "block", "client", 1, VersionVector{}, Operation{Kind: OperationBlockInsert, BlockID: "block", BlockType: "paragraph"})
	if state.Apply(block).Outcome != OutcomeAccepted {
		t.Fatal("block insert was not accepted")
	}
	if state.Apply(block).Outcome != OutcomeDuplicate {
		t.Fatal("replayed operation was not idempotent")
	}
	missing := envelope(identity, "future", "client-2", 1, VersionVector{"client-3": 4}, Operation{Kind: OperationTextInsert, BlockID: "block", Position: 0, Text: "x"})
	if result := state.Apply(missing); result.Code != RejectCausalContextExpired {
		t.Fatalf("causal rejection = %#v", result)
	}
}

func TestDeleteKeepsTombstoneAndInverse(t *testing.T) {
	identity := testIdentity()
	state, _ := NewState(identity)
	insert := envelope(identity, "block", "client", 1, VersionVector{}, Operation{Kind: OperationBlockInsert, BlockID: "block", BlockType: "paragraph", Content: "text"})
	delete := envelope(identity, "delete", "client", 2, VersionVector{"client": 1}, Operation{Kind: OperationBlockDelete, BlockID: "block"})
	state.Apply(insert)
	if state.Apply(delete).Outcome != OutcomeAccepted {
		t.Fatal("delete was not accepted")
	}
	if !state.Tombstones["block"] || !state.Blocks["block"].Deleted {
		t.Fatal("delete did not preserve tombstone")
	}
	inverse, ok := state.InverseOperation("delete")
	if !ok || inverse.Kind != OperationBlockInsert {
		t.Fatalf("inverse = %#v, ok=%v", inverse, ok)
	}
}

func TestTextDeleteRetainsInverseContent(t *testing.T) {
	identity := testIdentity()
	state, _ := NewState(identity)
	state.Apply(envelope(identity, "block", "client", 1, VersionVector{}, Operation{Kind: OperationBlockInsert, BlockID: "block", BlockType: "paragraph", Content: "text"}))
	if state.Apply(envelope(identity, "delete-text", "client", 2, VersionVector{"client": 1}, Operation{Kind: OperationTextDelete, BlockID: "block", From: 1, To: 3})).Outcome != OutcomeAccepted {
		t.Fatal("text delete was not accepted")
	}
	if state.Blocks["block"].Content != "tt" {
		t.Fatalf("deleted text = %q", state.Blocks["block"].Content)
	}
	inverse, ok := state.InverseOperation("delete-text")
	if !ok || inverse.Kind != OperationTextInsert || inverse.Text != "ex" {
		t.Fatalf("text inverse = %#v, ok=%v", inverse, ok)
	}
}

func TestConcurrentMovesAndCellsProduceExplicitConflicts(t *testing.T) {
	identity := testIdentity()
	state, _ := NewState(identity)
	state.Apply(envelope(identity, "parent-a", "seed", 1, VersionVector{}, Operation{Kind: OperationBlockInsert, BlockID: "a", BlockType: "container"}))
	state.Apply(envelope(identity, "parent-b", "seed", 2, VersionVector{"seed": 1}, Operation{Kind: OperationBlockInsert, BlockID: "b", BlockType: "container"}))
	state.Apply(envelope(identity, "block", "seed", 3, VersionVector{"seed": 2}, Operation{Kind: OperationBlockInsert, BlockID: "child", ParentBlockID: "a", BlockType: "paragraph"}))
	moveA := envelope(identity, "move-a", "client-a", 1, VersionVector{"seed": 3}, Operation{Kind: OperationBlockMove, BlockID: "child", ParentBlockID: "a", Index: 1})
	moveB := envelope(identity, "move-b", "client-b", 1, VersionVector{"seed": 3}, Operation{Kind: OperationBlockMove, BlockID: "child", ParentBlockID: "b", Index: 0})
	state.Apply(moveA)
	if result := state.Apply(moveB); result.Code != RejectStructureConflict {
		t.Fatalf("move conflict = %#v", result)
	}
	cellA := envelope(identity, "cell-a", "client-a", 2, VersionVector{"seed": 3, "client-a": 1}, Operation{Kind: OperationAttributeCellSet, AttributeViewID: "view", RowID: "row", ColumnID: "column", Value: "A"})
	cellB := envelope(identity, "cell-b", "client-b", 2, VersionVector{"seed": 3}, Operation{Kind: OperationAttributeCellSet, AttributeViewID: "view", RowID: "row", ColumnID: "column", Value: "B"})
	state.Apply(cellA)
	if result := state.Apply(cellB); result.Code != RejectAttributeViewConflict {
		t.Fatalf("cell conflict = %#v", result)
	}
	if len(state.Conflicts) != 2 {
		t.Fatalf("conflict count = %d", len(state.Conflicts))
	}
}

func TestReferencesEmbedsAndHistoryReplay(t *testing.T) {
	identity := testIdentity()
	bridge, _ := NewBridge(identity)
	block := envelope(identity, "block", "seed", 1, VersionVector{}, Operation{Kind: OperationBlockInsert, BlockID: "block", BlockType: "paragraph", Content: "source"})
	if bridge.Apply(block).Outcome != OutcomeAccepted {
		t.Fatal("block insert was not accepted")
	}
	target := &TargetIdentity{NotebookID: "book-target", DocumentID: "doc-target", BlockID: "target"}
	if bridge.Apply(envelope(identity, "ref", "client", 1, VersionVector{"seed": 1}, Operation{Kind: OperationReferenceUpdate, BlockID: "block", Target: target})).Outcome != OutcomeAccepted {
		t.Fatal("reference update was not accepted")
	}
	if bridge.Apply(envelope(identity, "embed", "client", 2, VersionVector{"seed": 1, "client": 1}, Operation{Kind: OperationEmbedUpdate, BlockID: "block", EmbedType: "transclusion", Target: target})).Outcome != OutcomeAccepted {
		t.Fatal("embed update was not accepted")
	}
	replayed, err := bridge.Replay()
	if err != nil {
		t.Fatal(err)
	}
	if replayed.State().Blocks["block"].Reference == nil || replayed.State().Blocks["block"].Reference.BlockID != "target" {
		t.Fatal("reference identity was not replayed")
	}
	if replayed.State().Blocks["block"].Embed == nil || replayed.State().Blocks["block"].Embed.Target.BlockID != "target" {
		t.Fatal("embed identity was not replayed")
	}
}
