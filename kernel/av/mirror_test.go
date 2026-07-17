package av

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/88250/lute/ast"
)

func TestBatchUpsertBlockRelInBoxReturnsMirrorReadError(t *testing.T) {
	useTemporaryAVStore(t)

	const avID = "20260717010101-abcdefg"
	const boxID = "box-a"
	if err := SaveAttributeViewInBox(newTestAttributeView(avID, "source"), boxID); err != nil {
		t.Fatalf("save AV: %v", err)
	}
	path := mirrorBlocksPath(boxID)
	corrupt := []byte("not-msgpack")
	if err := os.WriteFile(path, corrupt, 0644); err != nil {
		t.Fatalf("write corrupt mirror: %v", err)
	}

	err := BatchUpsertBlockRelInBox([]*ast.Node{{
		Type:            ast.NodeAttributeView,
		ID:              "block-a",
		AttributeViewID: avID,
	}}, boxID)
	if !errors.Is(err, ErrAttributeViewMirrorUnavailable) {
		t.Fatalf("batch mirror error = %v, want ErrAttributeViewMirrorUnavailable", err)
	}
	got, readErr := os.ReadFile(path)
	if readErr != nil {
		t.Fatalf("read mirror: %v", readErr)
	}
	if !bytes.Equal(got, corrupt) {
		t.Fatalf("corrupt mirror was overwritten: %q", got)
	}
}

func TestBatchUpsertBlockRelInBoxPreservesMirrorDecryptError(t *testing.T) {
	useTemporaryAVStore(t)

	const boxID = "box-a"
	path := mirrorBlocksPath(boxID)
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatalf("create mirror directory: %v", err)
	}
	if err := os.WriteFile(path, []byte("ciphertext"), 0644); err != nil {
		t.Fatalf("write encrypted mirror: %v", err)
	}
	wantErr := errors.New("DEK unavailable")
	AVDEKProvider = func(string) ([]byte, error) {
		return nil, wantErr
	}

	err := BatchUpsertBlockRelInBox(nil, boxID)
	if !errors.Is(err, ErrAttributeViewMirrorUnavailable) {
		t.Fatalf("batch mirror error = %v, want ErrAttributeViewMirrorUnavailable", err)
	}
	if !errors.Is(err, wantErr) {
		t.Fatalf("batch mirror error = %v, want underlying %v", err, wantErr)
	}
}

func TestBatchUpsertBlockRelInBoxReturnsMirrorWriteError(t *testing.T) {
	useTemporaryAVStore(t)

	const avID = "20260717010102-abcdefg"
	const boxID = "box-a"
	if err := SaveAttributeViewInBox(newTestAttributeView(avID, "source"), boxID); err != nil {
		t.Fatalf("save AV: %v", err)
	}
	wantErr := errors.New("DEK unavailable")
	AVDEKProvider = func(string) ([]byte, error) {
		return nil, wantErr
	}

	err := BatchUpsertBlockRelInBox([]*ast.Node{{
		Type:            ast.NodeAttributeView,
		ID:              "block-a",
		AttributeViewID: avID,
	}}, boxID)
	if !errors.Is(err, wantErr) {
		t.Fatalf("batch mirror error = %v, want %v", err, wantErr)
	}
	if _, statErr := os.Stat(mirrorBlocksPath(boxID)); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("failed mirror write left an index file: %v", statErr)
	}
}

func TestMirrorSnapshotRestoresStateAfterCompleteReplacement(t *testing.T) {
	useTemporaryAVStore(t)

	const (
		boxID      = "box-a"
		otherBoxID = "box-b"
		avA        = "20260717030500-mirrora"
		avB        = "20260717030501-mirrorb"
		avC        = "20260717030502-mirrorc"
	)
	for _, targetBox := range []string{boxID, otherBoxID} {
		for _, avID := range []string{avA, avB, avC} {
			if err := SaveAttributeViewInBox(newTestAttributeView(avID, avID), targetBox); err != nil {
				t.Fatalf("save AV %s/%s: %v", targetBox, avID, err)
			}
		}
	}
	for _, relation := range []struct {
		avID    string
		blockID string
	}{
		{avID: avA, blockID: "old-a-1"},
		{avID: avA, blockID: "old-a-2"},
		{avID: avB, blockID: "old-b-1"},
	} {
		if _, err := UpsertBlockRelInBox(relation.avID, relation.blockID, boxID); err != nil {
			t.Fatalf("seed mirror relation %s/%s: %v", relation.avID, relation.blockID, err)
		}
	}
	if _, err := UpsertBlockRelInBox(avA, "other-box-block", otherBoxID); err != nil {
		t.Fatalf("seed other notebook mirror: %v", err)
	}

	snapshot, err := CaptureMirrorBlocks(boxID)
	if err != nil {
		t.Fatalf("capture mirror snapshot: %v", err)
	}
	if err = ReplaceBlockRelsInBox([]*ast.Node{
		{Type: ast.NodeAttributeView, ID: "new-a-1", AttributeViewID: avA},
		{Type: ast.NodeAttributeView, ID: "new-a-1", AttributeViewID: avA},
		{Type: ast.NodeAttributeView, ID: "new-c-1", AttributeViewID: avC},
		{Type: ast.NodeParagraph, ID: "ignored", AttributeViewID: avB},
	}, boxID); err != nil {
		t.Fatalf("replace mirror state: %v", err)
	}
	assertMirrorStateForTest(t, boxID, map[string][]string{
		avA: {"new-a-1"},
		avC: {"new-c-1"},
	})
	assertMirrorStateForTest(t, otherBoxID, map[string][]string{avA: {"other-box-block"}})

	if err = snapshot.Restore(); err != nil {
		t.Fatalf("restore mirror snapshot: %v", err)
	}
	assertMirrorStateForTest(t, boxID, map[string][]string{
		avA: {"old-a-1", "old-a-2"},
		avB: {"old-b-1"},
	})
	assertMirrorStateForTest(t, otherBoxID, map[string][]string{avA: {"other-box-block"}})
}

func TestMirrorSnapshotRestoresMissingIndexAsMissing(t *testing.T) {
	useTemporaryAVStore(t)

	const (
		boxID = "box-a"
		avID  = "20260717030600-mirrord"
	)
	if err := SaveAttributeViewInBox(newTestAttributeView(avID, avID), boxID); err != nil {
		t.Fatalf("save AV: %v", err)
	}
	snapshot, err := CaptureMirrorBlocks(boxID)
	if err != nil {
		t.Fatalf("capture absent mirror snapshot: %v", err)
	}
	if err = ReplaceBlockRelsInBox([]*ast.Node{{
		Type:            ast.NodeAttributeView,
		ID:              "replacement-block",
		AttributeViewID: avID,
	}}, boxID); err != nil {
		t.Fatalf("write replacement mirror: %v", err)
	}
	assertMirrorStateForTest(t, boxID, map[string][]string{avID: {"replacement-block"}})

	if err = snapshot.Restore(); err != nil {
		t.Fatalf("restore absent mirror snapshot: %v", err)
	}
	assertMirrorStateForTest(t, boxID, map[string][]string{})
	if _, err = os.Stat(mirrorBlocksPath(boxID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("restored absent mirror left an index file: %v", err)
	}
}

func TestEncryptedMirrorSnapshotRestoresDecryptedState(t *testing.T) {
	useTemporaryAVStore(t)

	const (
		boxID = "encrypted-box"
		avID  = "20260717030700-mirrore"
	)
	AVDEKProvider = func(string) ([]byte, error) {
		return bytes.Repeat([]byte{0x5a}, 32), nil
	}
	if err := SaveAttributeViewInBox(newTestAttributeView(avID, avID), boxID); err != nil {
		t.Fatalf("save encrypted AV: %v", err)
	}
	if err := ReplaceBlockRelsInBox([]*ast.Node{{
		Type:            ast.NodeAttributeView,
		ID:              "encrypted-old-block",
		AttributeViewID: avID,
	}}, boxID); err != nil {
		t.Fatalf("seed encrypted mirror: %v", err)
	}
	snapshot, err := CaptureMirrorBlocks(boxID)
	if err != nil {
		t.Fatalf("capture encrypted mirror snapshot: %v", err)
	}
	originalCiphertext, err := os.ReadFile(mirrorBlocksPath(boxID))
	if err != nil {
		t.Fatalf("read encrypted mirror: %v", err)
	}
	if bytes.Contains(originalCiphertext, []byte("encrypted-old-block")) {
		t.Fatal("encrypted mirror persisted its block ID as plaintext")
	}

	if err = ReplaceBlockRelsInBox([]*ast.Node{{
		Type:            ast.NodeAttributeView,
		ID:              "encrypted-new-block",
		AttributeViewID: avID,
	}}, boxID); err != nil {
		t.Fatalf("replace encrypted mirror: %v", err)
	}
	assertMirrorStateForTest(t, boxID, map[string][]string{avID: {"encrypted-new-block"}})
	if err = snapshot.Restore(); err != nil {
		t.Fatalf("restore encrypted mirror: %v", err)
	}
	assertMirrorStateForTest(t, boxID, map[string][]string{avID: {"encrypted-old-block"}})
	restoredCiphertext, err := os.ReadFile(mirrorBlocksPath(boxID))
	if err != nil {
		t.Fatalf("read restored encrypted mirror: %v", err)
	}
	if bytes.Contains(restoredCiphertext, []byte("encrypted-old-block")) {
		t.Fatal("restored encrypted mirror persisted its block ID as plaintext")
	}
}

func assertMirrorStateForTest(t *testing.T, boxID string, want map[string][]string) {
	t.Helper()
	got, err := GetBlockRelsInBoxStrict(boxID)
	if err != nil {
		t.Fatalf("read mirror state for %s: %v", boxID, err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("mirror state for %s = %#v, want %#v", boxID, got, want)
	}
}
