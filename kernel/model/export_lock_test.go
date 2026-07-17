package model

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/88250/lute/parse"
	"github.com/88250/lute/render"
	"github.com/siyuan-note/siyuan/kernel/av"
	"github.com/siyuan-note/siyuan/kernel/cache"
	kernelconf "github.com/siyuan-note/siyuan/kernel/conf"
	"github.com/siyuan-note/siyuan/kernel/filesys"
	"github.com/siyuan-note/siyuan/kernel/treenode"
	"github.com/siyuan-note/siyuan/kernel/util"
)

func TestExportReadContextRoutesNestedReadsWithoutReacquiringLifecycleLock(t *testing.T) {
	const (
		boxID    = "20260716060000-lockbox"
		parentID = "20260716060001-parentx"
		docID    = "20260716060002-docxxxx"
		avID     = "20260716060003-avxxxxx"
	)
	previousDataDir := util.DataDir
	previousConf := Conf
	previousFilesysProvider := filesys.DEKProvider
	previousFilesysAcquire := filesys.DEKLockAcquire
	previousFilesysRelease := filesys.DEKLockRelease
	previousAVProvider := av.AVDEKProvider
	previousAVAcquire := av.AVLockAcquire
	previousAVRelease := av.AVLockRelease
	util.DataDir = t.TempDir()
	Conf = NewAppConf()
	Conf.Export = kernelconf.NewExport()
	Conf.FileTree = kernelconf.NewFileTree()
	cache.ClearTreeCache()
	cache.ClearAVCache()
	t.Cleanup(func() {
		cache.ClearAVCache()
		cache.ClearTreeCache()
		cachedDEKsLock.Lock()
		if cached := cachedDEKs[boxID]; cached != nil {
			clear(cached)
			delete(cachedDEKs, boxID)
		}
		cachedDEKsLock.Unlock()
		Conf = previousConf
		util.DataDir = previousDataDir
		filesys.DEKProvider = previousFilesysProvider
		filesys.DEKLockAcquire = previousFilesysAcquire
		filesys.DEKLockRelease = previousFilesysRelease
		av.AVDEKProvider = previousAVProvider
		av.AVLockAcquire = previousAVAcquire
		av.AVLockRelease = previousAVRelease
	})

	dek, err := util.GenerateDEK()
	if err != nil {
		t.Fatalf("generate export fixture DEK: %v", err)
	}
	defer zeroAndClear(dek)
	boxConf := kernelconf.NewBoxConf()
	boxConf.Name = "Export Lock Contract"
	boxConf.Encrypted = true
	if err = (&Box{ID: boxID}).SaveConf(boxConf); err != nil {
		t.Fatalf("save encrypted notebook fixture: %v", err)
	}
	cachedDEKsLock.Lock()
	cachedDEKs[boxID] = append([]byte(nil), dek...)
	cachedDEKsLock.Unlock()
	provider := func(string) ([]byte, error) { return append([]byte(nil), dek...), nil }
	filesys.DEKProvider = provider
	av.AVDEKProvider = provider
	av.AVLockAcquire = nil
	av.AVLockRelease = nil

	parentPath := "/" + parentID + ".sy"
	parentTree := treenode.NewTree(boxID, parentPath, "/Parent", "Parent")
	writeEncryptedExportLockTree(t, parentTree, boxID, parentPath, dek)

	treePath := "/" + parentID + "/" + docID + ".sy"
	tree := treenode.NewTree(boxID, treePath, "/Export", "Export")
	writeEncryptedExportLockTree(t, tree, boxID, treePath, dek)

	attrView := &av.AttributeView{Spec: av.CurrentSpec, ID: avID, RenderedViewables: map[string]av.Viewable{}}
	if err = av.SaveAttributeViewInBox(attrView, boxID); err != nil {
		t.Fatalf("save encrypted export AV fixture: %v", err)
	}
	cache.ClearAVCache()

	// A queued lifecycle writer makes a recursive RLock block. These hooks model
	// that pending writer: the export contract must finish without invoking them.
	nestedAcquire := make(chan string, 1)
	writerReleased := make(chan struct{})
	filesys.DEKLockAcquire = func(string) {
		nestedAcquire <- "tree"
		<-writerReleased
	}
	filesys.DEKLockRelease = func(string) {}
	av.AVLockAcquire = func(string) {
		nestedAcquire <- "attribute-view"
		<-writerReleased
	}
	av.AVLockRelease = func(string) {}

	ctx, release, err := acquireExportReadContext(boxID)
	if err != nil {
		t.Fatalf("acquire export read context: %v", err)
	}
	defer release()
	completed := make(chan error, 1)
	go func() {
		if _, loadErr := ctx.loadTreePath(boxID, treePath, util.NewLute()); loadErr != nil {
			completed <- loadErr
			return
		}
		_, parseErr := ctx.parseAttributeView(avID, boxID)
		completed <- parseErr
	}()

	select {
	case err = <-completed:
		if err != nil {
			t.Fatalf("read export content under caller-owned lock: %v", err)
		}
	case source := <-nestedAcquire:
		close(writerReleased)
		<-completed
		t.Fatalf("export recursively acquired the %s lifecycle read lock while a writer was pending", source)
	case <-time.After(5 * time.Second):
		close(writerReleased)
		t.Fatal("export read under the caller-owned lifecycle lock did not complete")
	}
}

func writeEncryptedExportLockTree(t *testing.T, tree *parse.Tree, boxID, treePath string, dek []byte) {
	t.Helper()
	luteEngine := util.NewLute()
	treeData := render.NewJSONRenderer(tree, luteEngine.RenderOptions, luteEngine.ParseOptions).Render()
	fileKey := util.DeriveSubKey(dek, "siyuan/file")
	aad, err := filesys.SyAAD(boxID, treePath)
	if err != nil {
		zeroAndClear(fileKey)
		t.Fatalf("build export tree AAD: %v", err)
	}
	ciphertext, err := util.EncryptWithAAD(fileKey, treeData, []byte(aad))
	zeroAndClear(fileKey)
	if err != nil {
		t.Fatalf("encrypt export tree fixture: %v", err)
	}
	treeAbsPath := filepath.Join(util.DataDir, boxID, treePath)
	if err = os.MkdirAll(filepath.Dir(treeAbsPath), 0755); err != nil {
		t.Fatalf("create export tree directory: %v", err)
	}
	if err = os.WriteFile(treeAbsPath, ciphertext, 0644); err != nil {
		t.Fatalf("write export tree fixture: %v", err)
	}
}
