//go:build releasecert

package collab

import (
	"errors"
	"os"
	"testing"

	"github.com/siyuan-note/siyuan/kernel/util"
)

// 认证受限加密准入必须在 Kernel 无解锁密钥时失败，不能由控制面或测试层降级为明文。
func TestReleaseCertificationRejectsUnavailableEncryptedAdmission(t *testing.T) {
	coordinator := NewProductionCoordinator()
	_, err := coordinator.Admit(
		DocumentIdentity{
			DocumentID:     "20260723090001-release",
			NotebookID:     "20260723090000-release",
			OrganizationID: "org-release",
			SpaceID:        "space-release",
		},
		FeatureModeRestrictedEncrypted,
		true,
		false,
	)
	if !errors.Is(err, ErrEncryptedCollaborationUnavailable) {
		t.Fatalf("encrypted admission error = %v, want unavailable", err)
	}
}

// 认证重启后必须更换会话代次；旧客户端的操作不能借新 Kernel 进程继续写入。
func TestReleaseCertificationRejectsStaleSessionGenerationAfterRestart(t *testing.T) {
	identity := testProductionEnvelope().Identity
	first := NewProductionCoordinator()
	admission, err := first.Admit(identity, FeatureModeStandard, false, false)
	if err != nil {
		t.Fatalf("first admission: %v", err)
	}

	restarted := NewProductionCoordinator()
	restarted.sessionGeneration = admission.SessionGeneration + 1
	envelope := testProductionEnvelope()
	envelope.SessionGeneration = admission.SessionGeneration
	result, err := restarted.Apply(envelope, FeatureModeStandard, false, false)
	if err != nil {
		t.Fatalf("stale generation apply: %v", err)
	}
	if result.Result.Outcome != OutcomeRejected || result.Result.Code != RejectSessionGenerationMismatch {
		t.Fatalf("stale generation result = %#v, want session-generation-mismatch", result.Result)
	}
}

// 认证 Kernel 重启恢复时只接受 committed WAL，prepared WAL 必须 fail closed。
func TestReleaseCertificationRecoversCommittedHistoryAndBlocksPreparedJournal(t *testing.T) {
	originalDataDir := util.DataDir
	util.DataDir = t.TempDir()
	t.Cleanup(func() { util.DataDir = originalDataDir })

	committed := testProductionEnvelope()
	if err := persistJournal(committed.Identity, false, collaborationJournal{
		Entry: committed, Phase: journalPhaseCommitted, Version: 1,
	}); err != nil {
		t.Fatalf("persist committed journal: %v", err)
	}
	restarted := NewProductionCoordinator()
	history, err := restarted.Replay(committed.Identity)
	if err != nil {
		t.Fatalf("replay committed journal: %v", err)
	}
	if len(history) != 1 || history[0].Envelope.OperationID != committed.OperationID {
		t.Fatalf("recovered history = %#v, want operation %q", history, committed.OperationID)
	}
	if _, err := os.Stat(journalPath(committed.Identity, false)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("committed journal still exists: %v", err)
	}

	prepared := testProductionEnvelope()
	prepared.Identity.DocumentID = "20260722090000-prepared"
	if err := persistJournal(prepared.Identity, false, collaborationJournal{
		Entry: prepared, Phase: journalPhasePrepared, Version: 1,
	}); err != nil {
		t.Fatalf("persist prepared journal: %v", err)
	}
	if _, err := restarted.Admit(prepared.Identity, FeatureModeStandard, false, false); !errors.Is(err, ErrCollaborationRecoveryRequired) {
		t.Fatalf("prepared journal admission error = %v, want recovery required", err)
	}
}
