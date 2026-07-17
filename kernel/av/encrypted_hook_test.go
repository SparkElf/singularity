package av

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/siyuan-note/siyuan/kernel/cache"
	"github.com/siyuan-note/siyuan/kernel/util"
)

func useTemporaryAVStore(t *testing.T) {
	t.Helper()
	originalDataDir := util.DataDir
	originalDEKProvider := AVDEKProvider
	originalLockAcquire := AVLockAcquire
	originalLockRelease := AVLockRelease
	util.DataDir = t.TempDir()
	AVDEKProvider = nil
	AVLockAcquire = nil
	AVLockRelease = nil
	cache.ClearAVCache()
	t.Cleanup(func() {
		cache.ClearAVCache()
		util.DataDir = originalDataDir
		AVDEKProvider = originalDEKProvider
		AVLockAcquire = originalLockAcquire
		AVLockRelease = originalLockRelease
	})
}

func newTestAttributeView(id, name string) *AttributeView {
	return &AttributeView{Spec: CurrentSpec, ID: id, Name: name, RenderedViewables: map[string]Viewable{}}
}

func TestGlobalAttributeViewLookupDoesNotReadBoxStore(t *testing.T) {
	useTemporaryAVStore(t)

	const avID = "20260716010101-abcdefg"
	boxView := newTestAttributeView(avID, "box-only")
	if err := SaveAttributeViewInBox(boxView, "box-a"); err != nil {
		t.Fatalf("save box AV: %v", err)
	}

	if path, _ := FindAttributeViewPath(avID); path != "" {
		t.Fatalf("global lookup returned box path %q", path)
	}
	if _, err := ParseAttributeView(avID); !errors.Is(err, ErrViewNotFound) {
		t.Fatalf("global parse error = %v, want ErrViewNotFound", err)
	}
	if name, err := GetAttributeViewName(avID); err != nil || name != "" {
		t.Fatalf("global name = %q, %v; want empty", name, err)
	}
}

func TestAttributeViewInBoxSelectsOnlyTargetStore(t *testing.T) {
	useTemporaryAVStore(t)

	const avID = "20260716010102-abcdefg"
	for boxID, name := range map[string]string{"box-a": "alpha", "box-b": "beta"} {
		view := newTestAttributeView(avID, name)
		if err := SaveAttributeViewInBox(view, boxID); err != nil {
			t.Fatalf("save %s AV: %v", boxID, err)
		}
	}

	for boxID, want := range map[string]string{"box-a": "alpha", "box-b": "beta"} {
		view, err := ParseAttributeViewInBox(avID, boxID)
		if err != nil {
			t.Fatalf("parse %s AV: %v", boxID, err)
		}
		if view.Name != want {
			t.Fatalf("parse %s name = %q, want %q", boxID, view.Name, want)
		}
	}
}

func TestSaveAttributeViewRecreatesMissingFile(t *testing.T) {
	useTemporaryAVStore(t)

	const avID = "20260716010112-abcdefg"
	attrView := newTestAttributeView(avID, "cached")
	if err := SaveAttributeViewInBox(attrView, "box-a"); err != nil {
		t.Fatalf("save AV: %v", err)
	}
	path := attributeViewDataPathByBox(avID, "box-a")
	if err := os.Remove(path); err != nil {
		t.Fatalf("remove AV file: %v", err)
	}

	if err := SaveAttributeViewInBox(attrView, "box-a"); err != nil {
		t.Fatalf("recreate AV: %v", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("recreated AV file missing: %v", err)
	}
}

func TestGlobalParseRejectsCiphertextWithoutNotebook(t *testing.T) {
	useTemporaryAVStore(t)

	const avID = "20260716010105-abcdefg"
	AVDEKProvider = func(string) ([]byte, error) {
		return bytes.Repeat([]byte{0x31}, 32), nil
	}
	data := []byte(`{"spec":5,"id":"` + avID + `","name":"encrypted"}`)
	ciphertext, err := EncryptAVData("box-a", avID, data)
	if err != nil {
		t.Fatalf("encrypt AV: %v", err)
	}
	path := attributeViewDataPathByBox(avID, "")
	if err = os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatalf("create global AV dir: %v", err)
	}
	if err = os.WriteFile(path, ciphertext, 0644); err != nil {
		t.Fatalf("write ciphertext to global store: %v", err)
	}

	if _, err = ParseAttributeView(avID); !errors.Is(err, ErrAttributeViewIdentityRequired) {
		t.Fatalf("global parse error = %v, want ErrAttributeViewIdentityRequired", err)
	}
}

func TestAVCryptographyClearsProviderDEKCopy(t *testing.T) {
	useTemporaryAVStore(t)

	var provided []byte
	AVDEKProvider = func(string) ([]byte, error) {
		provided = bytes.Repeat([]byte{0x42}, 32)
		return provided, nil
	}
	plain := []byte("attribute-view")
	ciphertext, err := EncryptAVData("box-a", "20260716010106-abcdefg", plain)
	if err != nil {
		t.Fatalf("encrypt AV: %v", err)
	}
	if !bytes.Equal(provided, make([]byte, len(provided))) {
		t.Fatalf("encrypt retained the provider DEK copy: %x", provided)
	}

	decrypted, err := DecryptAVData("box-a", "20260716010106-abcdefg", ciphertext)
	if err != nil {
		t.Fatalf("decrypt AV: %v", err)
	}
	if !bytes.Equal(decrypted, plain) {
		t.Fatalf("decrypted AV = %q, want %q", decrypted, plain)
	}
	if !bytes.Equal(provided, make([]byte, len(provided))) {
		t.Fatalf("decrypt retained the provider DEK copy: %x", provided)
	}
}

func TestParseAttributeViewInBoxOwnsOneLifecycleReadLock(t *testing.T) {
	useTemporaryAVStore(t)

	const avID = "20260716010110-abcdefg"
	if err := SaveAttributeViewInBox(newTestAttributeView(avID, "locked"), "box-a"); err != nil {
		t.Fatalf("save AV: %v", err)
	}
	acquires, releases, depth := 0, 0, 0
	AVLockAcquire = func(string) {
		acquires++
		depth++
	}
	AVLockRelease = func(string) {
		releases++
		depth--
	}

	if _, err := ParseAttributeViewInBox(avID, "box-a"); err != nil {
		t.Fatalf("parse AV: %v", err)
	}
	if acquires != 1 || releases != 1 || depth != 0 {
		t.Fatalf("lifecycle lock calls = acquire:%d release:%d depth:%d, want 1/1/0", acquires, releases, depth)
	}
}

func TestParseAttributeViewInBoxLockedDoesNotReacquireLifecycleLock(t *testing.T) {
	useTemporaryAVStore(t)

	const avID = "20260716010111-abcdefg"
	if err := SaveAttributeViewInBox(newTestAttributeView(avID, "locked"), "box-a"); err != nil {
		t.Fatalf("save AV: %v", err)
	}
	acquires := 0
	AVLockAcquire = func(string) { acquires++ }
	AVLockRelease = func(string) {}

	if _, err := ParseAttributeViewInBoxLocked(avID, "box-a"); err != nil {
		t.Fatalf("parse locked AV: %v", err)
	}
	if acquires != 0 {
		t.Fatalf("locked parse reacquired lifecycle lock %d times", acquires)
	}
}

func TestMirrorAndRelationWritesRequireTargetStoreDefinitions(t *testing.T) {
	useTemporaryAVStore(t)

	const srcID = "20260716010103-abcdefg"
	const destID = "20260716010104-abcdefg"
	for _, boxID := range []string{"box-a", "box-b"} {
		if err := SaveAttributeViewInBox(newTestAttributeView(srcID, "source"), boxID); err != nil {
			t.Fatalf("save source AV in %s: %v", boxID, err)
		}
		if err := SaveAttributeViewInBox(newTestAttributeView(destID, "destination"), boxID); err != nil {
			t.Fatalf("save destination AV in %s: %v", boxID, err)
		}
	}

	UpsertBlockRelInBox(srcID, "block-a", "box-a")
	UpsertBlockRelInBox(srcID, "block-b", "box-b")
	if err := UpsertAvBackRelInBox(srcID, destID, "box-a"); err != nil {
		t.Fatalf("upsert box-a relation: %v", err)
	}
	if err := UpsertAvBackRelInBox(srcID, destID, "box-b"); err != nil {
		t.Fatalf("upsert box-b relation: %v", err)
	}

	if got := GetBlockRelsInBox("box-a")[srcID]; len(got) != 1 || got[0] != "block-a" {
		t.Fatalf("box-a mirror = %v", got)
	}
	if got := GetBlockRelsInBox("box-b")[srcID]; len(got) != 1 || got[0] != "block-b" {
		t.Fatalf("box-b mirror = %v", got)
	}
	if got := GetSrcAvIDsInBox(destID, "box-a"); len(got) != 1 || got[0] != srcID {
		t.Fatalf("box-a relation = %v", got)
	}
	if got := GetSrcAvIDsInBox(destID, "box-b"); len(got) != 1 || got[0] != srcID {
		t.Fatalf("box-b relation = %v", got)
	}

	UpsertBlockRel(srcID, "block-without-store")
	if err := UpsertAvBackRel(srcID, destID); err != nil {
		t.Fatalf("identity-less relation: %v", err)
	}
	if _, err := os.Stat(mirrorBlocksPath("")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("identity-less mirror created global file: %v", err)
	}
	if _, err := os.Stat(relationsPath("")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("identity-less relation created global file: %v", err)
	}
}

func TestMirrorUpsertPreservesCorruptIndex(t *testing.T) {
	useTemporaryAVStore(t)

	const avID = "20260716010107-abcdefg"
	if err := SaveAttributeViewInBox(newTestAttributeView(avID, "source"), "box-a"); err != nil {
		t.Fatalf("save AV: %v", err)
	}
	path := mirrorBlocksPath("box-a")
	corrupt := []byte("not-msgpack")
	if err := os.WriteFile(path, corrupt, 0644); err != nil {
		t.Fatalf("write corrupt mirror: %v", err)
	}

	UpsertBlockRelInBox(avID, "block-a", "box-a")
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read mirror: %v", err)
	}
	if !bytes.Equal(got, corrupt) {
		t.Fatalf("corrupt mirror was overwritten: %q", got)
	}
}

func TestRelationUpsertPreservesCorruptIndex(t *testing.T) {
	useTemporaryAVStore(t)

	const srcID = "20260716010108-abcdefg"
	const destID = "20260716010109-abcdefg"
	for _, id := range []string{srcID, destID} {
		if err := SaveAttributeViewInBox(newTestAttributeView(id, id), "box-a"); err != nil {
			t.Fatalf("save AV %s: %v", id, err)
		}
	}
	path := relationsPath("box-a")
	corrupt := []byte("not-msgpack")
	if err := os.WriteFile(path, corrupt, 0644); err != nil {
		t.Fatalf("write corrupt relations: %v", err)
	}

	if err := UpsertAvBackRelInBox(srcID, destID, "box-a"); err == nil {
		t.Fatal("corrupt relation index upsert succeeded")
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read relations: %v", err)
	}
	if !bytes.Equal(got, corrupt) {
		t.Fatalf("corrupt relations were overwritten: %q", got)
	}
}

func TestRelationWriteFailureIsReturned(t *testing.T) {
	useTemporaryAVStore(t)

	blockedParent := filepath.Join(util.DataDir, "box-a", "storage")
	if err := os.MkdirAll(filepath.Dir(blockedParent), 0755); err != nil {
		t.Fatalf("create blocked relation parent: %v", err)
	}
	if err := os.WriteFile(blockedParent, []byte("not-a-directory"), 0644); err != nil {
		t.Fatalf("write blocked relation parent: %v", err)
	}

	err := writeRelations("box-a", map[string][]string{"destination": {"source"}})
	if err == nil {
		t.Fatal("relation write through a non-directory parent succeeded")
	}
}
