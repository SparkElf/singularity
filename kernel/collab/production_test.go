package collab

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/siyuan-note/siyuan/kernel/util"
)

func testProductionEnvelope() OperationEnvelope {
	return OperationEnvelope{
		CausalContext:  VersionVector{},
		ClientID:       "client-1",
		ClientSequence: 1,
		Identity: DocumentIdentity{
			DocumentID:     "20260722090000-docabcd",
			NotebookID:     "20260722090001-bookabc",
			OrganizationID: "org-1",
			SpaceID:        "space-1",
		},
		Operation: Operation{
			BlockID: "20260722090002-block01",
			Kind:    OperationBlockDelete,
		},
		OperationID:       "operation-1",
		SessionGeneration: 1,
	}
}

func TestLoadHistoryRecoversCommittedJournal(t *testing.T) {
	originalDataDir := util.DataDir
	util.DataDir = t.TempDir()
	t.Cleanup(func() { util.DataDir = originalDataDir })

	envelope := testProductionEnvelope()
	if err := persistJournal(envelope.Identity, false, collaborationJournal{
		Entry:   envelope,
		Phase:   journalPhaseCommitted,
		Version: 1,
	}); err != nil {
		t.Fatalf("persist committed journal: %v", err)
	}

	history, err := loadHistory(envelope.Identity, false, false)
	if err != nil {
		t.Fatalf("load recovered history: %v", err)
	}
	if len(history) != 1 || history[0].OperationID != envelope.OperationID {
		t.Fatalf("recovered history = %#v, want operation %q", history, envelope.OperationID)
	}
	if _, err := os.Stat(journalPath(envelope.Identity, false)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("recovery journal still exists: %v", err)
	}
	data, err := os.ReadFile(historyPath(envelope.Identity, false))
	if err != nil {
		t.Fatalf("read recovered history: %v", err)
	}
	if len(data) == 0 {
		t.Fatal("recovered history is empty")
	}
}

func TestLoadHistoryBlocksPreparedJournal(t *testing.T) {
	originalDataDir := util.DataDir
	util.DataDir = filepath.Clean(t.TempDir())
	t.Cleanup(func() { util.DataDir = originalDataDir })

	envelope := testProductionEnvelope()
	if err := persistJournal(envelope.Identity, false, collaborationJournal{
		Entry:   envelope,
		Phase:   journalPhasePrepared,
		Version: 1,
	}); err != nil {
		t.Fatalf("persist prepared journal: %v", err)
	}
	if _, err := loadHistory(envelope.Identity, false, false); !errors.Is(err, ErrCollaborationRecoveryRequired) {
		t.Fatalf("load prepared journal error = %v, want recovery required", err)
	}
}
