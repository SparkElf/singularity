// SiYuan - Refactor your thinking
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

package model

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/88250/lute/ast"
	"github.com/88250/lute/parse"
	"github.com/siyuan-note/siyuan/kernel/av"
	"github.com/siyuan-note/siyuan/kernel/cache"
	"github.com/siyuan-note/siyuan/kernel/conf"
	"github.com/siyuan-note/siyuan/kernel/filesys"
	kernelsql "github.com/siyuan-note/siyuan/kernel/sql"
	"github.com/siyuan-note/siyuan/kernel/treenode"
	"github.com/siyuan-note/siyuan/kernel/util"
)

type derivedContentStoreFixture struct {
	boxA       string
	boxB       string
	defID      string
	refRootID  string
	refBlockID string
	avID       string
	defTrees   map[string]*parse.Tree
}

func TestBlockRefDOMCarriesTargetContentIdentity(t *testing.T) {
	fixture := setupDerivedContentStoreFixture(t)
	dom := `<span data-type="block-ref" data-id="` + fixture.refBlockID + `" data-notebook-id="wrong" data-document-id="wrong">Reference</span>`

	got := FillBlockRefContentIdentities(dom, fixture.boxA)
	for _, attribute := range []string{
		`data-notebook-id="` + fixture.boxA + `"`,
		`data-document-id="` + fixture.refRootID + `"`,
	} {
		if !strings.Contains(got, attribute) {
			t.Fatalf("rendered block reference %q does not contain %q", got, attribute)
		}
	}
	if strings.Contains(got, `="wrong"`) {
		t.Fatalf("rendered block reference retained caller-provided identity: %q", got)
	}
}

func TestGetHPathByIDForNotebookReadsSelectedContentStore(t *testing.T) {
	fixture := setupDerivedContentStoreFixture(t)
	const (
		ordinaryA = "20990101120002-normala"
		ordinaryB = "20990101120003-normalb"
	)
	for boxID, title := range map[string]string{
		ordinaryA: "Ordinary A",
		ordinaryB: "Ordinary B",
	} {
		boxConf := conf.NewBoxConf()
		boxConf.Name = title
		if err := (&Box{ID: boxID}).SaveConf(boxConf); err != nil {
			t.Fatalf("save ordinary notebook config %s: %v", boxID, err)
		}
		writeDerivedDefinitionTree(t, boxID, fixture.defID, title)
	}

	for _, test := range []struct {
		notebook string
		want     string
	}{
		{notebook: ordinaryA, want: "/Ordinary A"},
		{notebook: ordinaryB, want: "/Ordinary B"},
		{notebook: fixture.boxA, want: "/Definition A"},
		{notebook: fixture.boxB, want: "/Definition B"},
	} {
		t.Run(test.notebook, func(t *testing.T) {
			got, err := GetHPathByIDForNotebook(fixture.defID, test.notebook)
			if err != nil {
				t.Fatalf("get HPath from %s: %v", test.notebook, err)
			}
			if got != test.want {
				t.Fatalf("HPath from %s = %q, want %q", test.notebook, got, test.want)
			}
		})
	}
}

func TestDelayedRefCountReadsSelectedContentStore(t *testing.T) {
	fixture := setupDerivedContentStoreFixture(t)

	countA := loadRefCountSnapshot(fixture.defID, fixture.boxA)
	countB := loadRefCountSnapshot(fixture.defID, fixture.boxB)
	if countA == nil || countA.boxID != fixture.boxA || countA.refCount != 1 || countA.rootRefCount != 1 {
		t.Fatalf("box A ref count crossed content stores: %#v", countA)
	}
	if countB == nil || countB.boxID != fixture.boxB || countB.refCount != 2 || countB.rootRefCount != 2 {
		t.Fatalf("box B ref count crossed content stores: %#v", countB)
	}
}

func TestDynamicAnchorsUpdateOnlySelectedContentStore(t *testing.T) {
	fixture := setupDerivedContentStoreFixture(t)
	for boxID, text := range map[string]string{fixture.boxA: "cached-a", fixture.boxB: "cached-b"} {
		ref := &ast.Node{
			Type:                    ast.NodeTextMark,
			TextMarkType:            "block-ref",
			TextMarkBlockRefID:      fixture.defID,
			TextMarkBlockRefSubtype: "d",
		}
		treenode.SetDynamicBlockRefTextInBox(ref, text, boxID)
	}
	if err := refreshDynamicRefText(fixture.defTrees[fixture.boxA].Root, fixture.defTrees[fixture.boxA]); err != nil {
		t.Fatalf("refresh dynamic reference text: %v", err)
	}
	if got := treenode.GetDynamicRefText(fixture.defID, fixture.boxA); got != "Definition A" {
		t.Fatalf("box A dynamic anchor cache = %q, want %q", got, "Definition A")
	}
	if got := treenode.GetDynamicRefText(fixture.defID, fixture.boxB); got != "cached-b" {
		t.Fatalf("box A refresh overwrote box B dynamic anchor cache: %q", got)
	}

	for _, boxID := range []string{fixture.boxA, fixture.boxB} {
		cache.RemoveTreeDataInBox(fixture.refRootID, boxID)
		refTree, err := loadTreeByBlockIDInBox(fixture.refRootID, boxID)
		if err != nil {
			t.Fatalf("load %s reference tree: %v", boxID, err)
		}
		got := ""
		ast.Walk(refTree.Root, func(node *ast.Node, entering bool) ast.WalkStatus {
			if entering && treenode.IsBlockRef(node) && node.TextMarkBlockRefID == fixture.defID {
				got = node.TextMarkTextContent
				return ast.WalkStop
			}
			return ast.WalkContinue
		})
		want := "old-b"
		if boxID == fixture.boxA {
			want = "Definition A"
		}
		if got != want {
			t.Fatalf("dynamic anchor in %s = %q, want %q", boxID, got, want)
		}
	}
}

func TestDerivedAttributeViewUpdatesOnlySelectedContentStore(t *testing.T) {
	fixture := setupDerivedContentStoreFixture(t)
	for boxID, content := range map[string]string{fixture.boxA: "stored-a", fixture.boxB: "stored-b"} {
		attrView := av.NewAttributeView(fixture.avID)
		blockValues := attrView.GetBlockKeyValues()
		blockValues.Values = []*av.Value{{
			ID:      "20990101120600-avvalue",
			KeyID:   blockValues.Key.ID,
			BlockID: fixture.defID,
			Type:    av.KeyTypeBlock,
			Block:   &av.ValueBlock{ID: fixture.defID, Content: content},
		}}
		if err := av.SaveAttributeViewInBox(attrView, boxID); err != nil {
			t.Fatalf("save %s attribute view: %v", boxID, err)
		}
	}

	defNodeA := fixture.defTrees[fixture.boxA].Root
	defNodeA.SetIALAttr(av.NodeAttrNameAvs, fixture.avID)
	updateAttributeViewBlockText(map[string]*ast.Node{fixture.defID: defNodeA})

	for _, boxID := range []string{fixture.boxA, fixture.boxB} {
		cache.RemoveAVDataInBox(fixture.avID, boxID)
		attrView, err := av.ParseAttributeViewInBox(fixture.avID, boxID)
		if err != nil {
			t.Fatalf("parse %s attribute view: %v", boxID, err)
		}
		got := attrView.GetBlockKeyValues().Values[0].Block.Content
		want := "stored-b"
		if boxID == fixture.boxA {
			want = "Definition A"
		}
		if got != want {
			t.Fatalf("attribute view content in %s = %q, want %q", boxID, got, want)
		}
	}
}

func TestRollbackPathUsesSelectedContentStore(t *testing.T) {
	fixture := setupDerivedContentStoreFixture(t)
	const restoredRootID = "20990101120700-restore"
	workingA := treenode.NewTree(fixture.boxA, "/"+fixture.defID+"/"+restoredRootID+".sy", "/Definition A/Restored", "Restored")
	workingA.ID = restoredRootID
	workingA.Root.ID = restoredRootID
	workingA.Root.Box = fixture.boxA
	workingA.Root.Path = workingA.Path
	workingB := treenode.NewTree(fixture.boxB, "/"+fixture.refRootID+"/"+restoredRootID+".sy", "/References/Restored", "Restored")
	workingB.ID = restoredRootID
	workingB.Root.ID = restoredRootID
	workingB.Root.Box = fixture.boxB
	workingB.Root.Path = workingB.Path
	if err := treenode.UpsertBlockTree(workingA); err != nil {
		t.Fatalf("index first rollback tree: %v", err)
	}
	if err := treenode.UpsertBlockTree(workingB); err != nil {
		t.Fatalf("index second rollback tree: %v", err)
	}
	snapshotPath := "/" + fixture.boxA + "/" + fixture.defID + "/" + restoredRootID + ".sy"

	destPath, parentHPath, err := resolveRepoSnapshotRollbackDestination(fixture.boxA, snapshotPath, false)
	if err != nil {
		t.Fatalf("resolve rollback destination: %v", err)
	}
	parent := treenode.GetBlockTreeInBox(fixture.defID, fixture.boxA)
	if parent == nil {
		t.Fatal("selected encrypted parent is missing")
	}
	wantDestPath := filepath.Join(util.DataDir, fixture.boxA, strings.TrimSuffix(parent.Path, ".sy"), restoredRootID+".sy")
	if destPath != wantDestPath || parentHPath != parent.HPath {
		t.Fatalf("rollback destination = %q, %q; want %q, %q", destPath, parentHPath, wantDestPath, parent.HPath)
	}
}

func TestSyncRemovalUsesNotebookFromMergedPath(t *testing.T) {
	fixture := setupDerivedContentStoreFixture(t)

	_, removed, err := incReindex(nil, []string{"/" + fixture.boxA + "/" + fixture.defID + ".sy"})
	if err != nil {
		t.Fatalf("remove synced tree index: %v", err)
	}
	if len(removed) != 1 || removed[0] != fixture.defID {
		t.Fatalf("removed roots = %#v, want [%s]", removed, fixture.defID)
	}
	if tree := treenode.GetBlockTreeInBox(fixture.defID, fixture.boxA); tree != nil {
		t.Fatalf("selected notebook tree remains indexed: %#v", tree)
	}
	if tree := treenode.GetBlockTreeInBox(fixture.defID, fixture.boxB); tree == nil {
		t.Fatal("sync removal crossed into the notebook with the same root ID")
	}
}

func TestSyncRemovalRejectsInvalidNotebookWithoutTouchingGlobalRoot(t *testing.T) {
	fixture := setupDerivedContentStoreFixture(t)
	globalTree := writeDerivedDefinitionTree(t, "", fixture.defID, "Global Definition")

	_, removed, err := incReindex(nil, []string{"/not-a-notebook/" + fixture.defID + ".sy"})
	if err == nil {
		t.Fatal("sync removal accepted an invalid notebook identity")
	}
	if len(removed) != 0 {
		t.Fatalf("invalid sync removal reported removed roots: %#v", removed)
	}
	blockTree := treenode.GetBlockTreeInBox(fixture.defID, "")
	if blockTree == nil || blockTree.HPath != globalTree.HPath {
		t.Fatalf("invalid sync removal changed the global root: %#v", blockTree)
	}
}

func TestSyncUpsertRejectsInvalidNotebookWithoutTouchingGlobalRoot(t *testing.T) {
	fixture := setupDerivedContentStoreFixture(t)
	globalTree := writeDerivedDefinitionTree(t, "", fixture.defID, "Global Definition")
	const unknownBox = "20990101120800-unknown"
	unknownTree := treenode.NewTree(unknownBox, "/"+fixture.defID+".sy", "/Unknown", "Unknown")
	unknownTree.ID = fixture.defID
	unknownTree.Root.ID = fixture.defID
	unknownTree.Root.Box = unknownBox
	unknownTree.Root.Path = unknownTree.Path
	unknownTree.Root.SetIALAttr("id", fixture.defID)
	if _, err := filesys.WriteTree(unknownTree); err != nil {
		t.Fatalf("write unknown-notebook sync tree: %v", err)
	}

	for _, mergedPath := range []string{
		"/not-a-notebook/" + fixture.defID + ".sy",
		"/" + unknownBox + unknownTree.Path,
	} {
		upserted, _, err := incReindex([]string{mergedPath}, nil)
		if err == nil {
			t.Fatalf("sync upsert accepted invalid notebook path %q", mergedPath)
		}
		if len(upserted) != 0 {
			t.Fatalf("invalid sync upsert reported indexed roots for %q: %#v", mergedPath, upserted)
		}
		blockTree := treenode.GetBlockTreeInBox(fixture.defID, "")
		if blockTree == nil || blockTree.HPath != globalTree.HPath {
			t.Fatalf("invalid sync upsert changed the global root for %q: %#v", mergedPath, blockTree)
		}
		if blockTree = treenode.GetBlockTreeInBox(fixture.defID, unknownBox); blockTree != nil {
			t.Fatalf("invalid sync upsert indexed unknown notebook %q: %#v", mergedPath, blockTree)
		}
	}
}

func TestSyncUpsertRejectsTreeWhoseRootDoesNotMatchItsPath(t *testing.T) {
	fixture := setupDerivedContentStoreFixture(t)
	const pathRootID = "20990101120810-pathrot"
	mismatched := treenode.NewTree(fixture.boxA, "/"+pathRootID+".sy", "/Mismatched", "Mismatched")
	mismatched.ID = fixture.defID
	mismatched.Root.ID = fixture.defID
	mismatched.Root.Box = fixture.boxA
	mismatched.Root.Path = mismatched.Path
	mismatched.Root.SetIALAttr("id", fixture.defID)
	if _, err := filesys.WriteTree(mismatched); err != nil {
		t.Fatalf("write mismatched sync tree: %v", err)
	}

	upserted, _, err := incReindex([]string{"/" + fixture.boxA + mismatched.Path}, nil)
	if err == nil {
		t.Fatal("sync upsert accepted a tree whose root does not match its path")
	}
	if len(upserted) != 0 {
		t.Fatalf("mismatched sync upsert reported indexed roots: %#v", upserted)
	}
	if blockTree := treenode.GetBlockTreeInBox(pathRootID, fixture.boxA); blockTree != nil {
		t.Fatalf("mismatched sync upsert published a blocktree: %#v", blockTree)
	}
}

func TestDuplicateBlockRepairKeepsEncryptedStoreIdentitiesIndependent(t *testing.T) {
	fixture := setupDerivedContentStoreFixture(t)
	before := map[string]map[string][]byte{}
	for _, boxID := range []string{fixture.boxA, fixture.boxB} {
		before[boxID] = map[string][]byte{}
		for _, treePath := range []string{fixture.defTrees[boxID].Path, "/" + fixture.refRootID + ".sy"} {
			filePath := filepath.Join(util.DataDir, boxID, strings.TrimPrefix(treePath, "/"))
			data, err := os.ReadFile(filePath)
			if err != nil {
				t.Fatalf("read %s tree before duplicate repair: %v", boxID, err)
			}
			before[boxID][treePath] = data
		}
	}

	resetDuplicateBlocksOnFileSys()

	for boxID, trees := range before {
		for treePath, want := range trees {
			filePath := filepath.Join(util.DataDir, boxID, strings.TrimPrefix(treePath, "/"))
			got, err := os.ReadFile(filePath)
			if err != nil {
				t.Fatalf("read %s tree after duplicate repair: %v", boxID, err)
			}
			if !bytes.Equal(got, want) {
				t.Fatalf("duplicate repair rewrote independent encrypted tree [%s%s]", boxID, treePath)
			}
		}
		if treenode.GetBlockTreeInBox(fixture.defID, boxID) == nil || treenode.GetBlockTreeInBox(fixture.refBlockID, boxID) == nil {
			t.Fatalf("duplicate repair removed independent blocktree identities from %s", boxID)
		}
	}
}

func TestSyncRemovalEnqueueFailureRestoresSelectedBlocktree(t *testing.T) {
	fixture := setupDerivedContentStoreFixture(t)
	want := treenode.GetBlockTreeInBox(fixture.defID, fixture.boxA)
	if want == nil {
		t.Fatal("selected notebook blocktree is missing before sync removal")
	}
	blockDurableIndexQueue(t)

	_, removed, err := incReindex(nil, []string{"/" + fixture.boxA + "/" + fixture.defID + ".sy"})
	if err == nil {
		t.Fatal("sync removal succeeded without a durable queue entry")
	}
	if len(removed) != 0 {
		t.Fatalf("rejected sync removal reported removed roots: %#v", removed)
	}
	got := treenode.GetBlockTreeInBox(fixture.defID, fixture.boxA)
	if got == nil || got.HPath != want.HPath || got.Path != want.Path {
		t.Fatalf("rejected sync removal changed selected blocktree: %#v", got)
	}
	if other := treenode.GetBlockTreeInBox(fixture.defID, fixture.boxB); other == nil {
		t.Fatal("rejected sync removal changed the other content store")
	}
}

func TestSyncUpsertEnqueueFailureRestoresPreviousBlocktree(t *testing.T) {
	fixture := setupDerivedContentStoreFixture(t)
	previous := treenode.GetBlockTreeInBox(fixture.defID, fixture.boxA)
	if previous == nil {
		t.Fatal("selected notebook blocktree is missing before sync upsert")
	}
	replacement := treenode.NewTree(fixture.boxA, fixture.defTrees[fixture.boxA].Path, "/Synced Replacement", "Synced Replacement")
	replacement.ID = fixture.defID
	replacement.Root.ID = fixture.defID
	replacement.Root.Box = fixture.boxA
	replacement.Root.Path = replacement.Path
	replacement.Root.SetIALAttr("id", fixture.defID)
	replacement.Root.SetIALAttr("title", "Synced Replacement")
	if _, err := filesys.WriteTree(replacement); err != nil {
		t.Fatalf("write synced replacement tree: %v", err)
	}
	blockDurableIndexQueue(t)

	upserted, _, err := incReindex([]string{"/" + fixture.boxA + replacement.Path}, nil)
	if err == nil {
		t.Fatal("sync upsert succeeded without a durable queue entry")
	}
	if len(upserted) != 0 {
		t.Fatalf("rejected sync upsert reported indexed roots: %#v", upserted)
	}
	got := treenode.GetBlockTreeInBox(fixture.defID, fixture.boxA)
	if got == nil || got.HPath != previous.HPath || got.Path != previous.Path {
		t.Fatalf("rejected sync upsert changed previous blocktree: %#v", got)
	}
	if other := treenode.GetBlockTreeInBox(fixture.defID, fixture.boxB); other == nil {
		t.Fatal("rejected sync upsert changed the other content store")
	}
}

func TestRepositoryRollbackEnqueueFailureRestoresCurrentTree(t *testing.T) {
	fixture := setupDerivedContentStoreFixture(t)
	current := fixture.defTrees[fixture.boxA]
	absPath := filepath.Join(util.DataDir, fixture.boxA, strings.TrimPrefix(current.Path, "/"))
	before, err := os.ReadFile(absPath)
	if err != nil {
		t.Fatalf("read current encrypted tree: %v", err)
	}

	restored := treenode.NewTree(fixture.boxA, current.Path, "/Restored", "Restored")
	restored.ID = fixture.defID
	restored.Root.ID = fixture.defID
	restored.Root.Box = fixture.boxA
	restored.Root.Path = current.Path
	restored.Root.SetIALAttr("id", fixture.defID)
	restored.Root.SetIALAttr("title", "Restored")

	queueDir := util.QueueDir
	blockedQueuePath := filepath.Join(t.TempDir(), "not-a-directory")
	if err = os.WriteFile(blockedQueuePath, []byte("blocked"), 0644); err != nil {
		t.Fatalf("create queue failure boundary: %v", err)
	}
	util.QueueDir = blockedQueuePath
	err = commitRepoSnapshotRollbackTree(restored)
	util.QueueDir = queueDir
	if err == nil {
		t.Fatal("repository rollback succeeded without a durable queue entry")
	}

	after, readErr := os.ReadFile(absPath)
	if readErr != nil {
		t.Fatalf("read current tree after rejected rollback: %v", readErr)
	}
	if !bytes.Equal(after, before) {
		t.Fatal("repository rollback enqueue failure changed the current tree file")
	}
	blockTree := treenode.GetBlockTreeInBox(fixture.defID, fixture.boxA)
	if blockTree == nil || blockTree.HPath != current.HPath {
		t.Fatalf("repository rollback enqueue failure changed the current block tree: %#v", blockTree)
	}
	if docIAL := cache.GetDocIALInBox(current.Path, fixture.boxA); docIAL != nil {
		t.Fatalf("repository rollback enqueue failure left restored document attributes cached: %#v", docIAL)
	}
	loaded, loadErr := loadTreeByBlockIDInBox(fixture.defID, fixture.boxA)
	if loadErr != nil {
		t.Fatalf("load current tree after rejected rollback: %v", loadErr)
	}
	if title := loaded.Root.IALAttr("title"); title != "Definition A" {
		t.Fatalf("current tree title after rejected rollback = %q, want Definition A", title)
	}
}

func TestRepositoryRollbackBlocktreeFailureRestoresFileIndexAndQueue(t *testing.T) {
	fixture := setupDerivedContentStoreFixture(t)
	current := fixture.defTrees[fixture.boxA]
	absPath := filepath.Join(util.DataDir, fixture.boxA, strings.TrimPrefix(current.Path, "/"))
	beforeFile, err := os.ReadFile(absPath)
	if err != nil {
		t.Fatalf("read current encrypted tree: %v", err)
	}
	queuePath := filepath.Join(util.QueueDir, "index.queue")
	beforeQueue, err := os.ReadFile(queuePath)
	if err != nil && !os.IsNotExist(err) {
		t.Fatalf("read durable index queue: %v", err)
	}

	restored := treenode.NewTree(fixture.boxA, current.Path, "/Restored", "Restored")
	restored.ID = ""
	restored.Root.ID = ""
	restored.Root.KramdownIAL = nil
	restored.Root.FirstChild.Unlink()
	restored.Root.AppendChild(&ast.Node{Type: ast.NodeText, Tokens: []byte("invalid rollback tree")})
	err = commitRepoSnapshotRollbackTree(restored)
	if err == nil || !strings.Contains(err.Error(), "blocktree path") {
		t.Fatalf("repository rollback error = %v, want blocktree persistence failure", err)
	}

	afterFile, readErr := os.ReadFile(absPath)
	if readErr != nil {
		t.Fatalf("read current tree after rejected rollback: %v", readErr)
	}
	if !bytes.Equal(afterFile, beforeFile) {
		t.Fatal("blocktree failure changed the current tree file")
	}
	blockTree := treenode.GetBlockTreeInBox(fixture.defID, fixture.boxA)
	if blockTree == nil || blockTree.HPath != current.HPath {
		t.Fatalf("blocktree failure changed the current blocktree: %#v", blockTree)
	}
	afterQueue, readErr := os.ReadFile(queuePath)
	if readErr != nil && !os.IsNotExist(readErr) {
		t.Fatalf("read durable queue after rejected rollback: %v", readErr)
	}
	if !bytes.Equal(afterQueue, beforeQueue) {
		t.Fatal("blocktree failure left a durable repository rollback operation")
	}
}

func setupDerivedContentStoreFixture(t *testing.T) derivedContentStoreFixture {
	t.Helper()
	fixture := derivedContentStoreFixture{
		boxA:       "20990101120000-encboxa",
		boxB:       "20990101120001-encboxb",
		defID:      "20990101120100-defsame",
		refRootID:  "20990101120200-refsame",
		refBlockID: "20990101120300-refnode",
		avID:       "20990101120400-avsame1",
		defTrees:   map[string]*parse.Tree{},
	}

	originalDataDir := util.DataDir
	originalTempDir := util.TempDir
	originalQueueDir := util.QueueDir
	originalConfDir := util.ConfDir
	originalBlockTreeDBPath := util.BlockTreeDBPath
	originalLang := util.Lang
	originalAttrViewLang, hadOriginalAttrViewLang := util.AttrViewLangs["derived-identity-test"]
	originalConf := Conf
	originalIsExiting := util.IsExiting.Load()
	tempRoot := t.TempDir()
	util.DataDir = filepath.Join(tempRoot, "data")
	util.TempDir = filepath.Join(tempRoot, "temp")
	util.QueueDir = filepath.Join(util.TempDir, "queue")
	util.ConfDir = filepath.Join(tempRoot, "conf")
	util.BlockTreeDBPath = filepath.Join(util.TempDir, "blocktree.db")
	for _, dir := range []string{util.DataDir, util.TempDir, util.QueueDir, util.ConfDir} {
		if err := os.MkdirAll(dir, 0755); err != nil {
			t.Fatalf("create test directory %s: %v", dir, err)
		}
	}
	Conf = NewAppConf()
	Conf.System = conf.NewSystem()
	Conf.Editor = conf.NewEditor()
	Conf.FileTree = conf.NewFileTree()
	Conf.Search = conf.NewSearch()
	Conf.Lang = "derived-identity-test"
	util.Lang = Conf.Lang
	util.AttrViewLangs[Conf.Lang] = map[string]any{
		"table": "Table", "key": "Key", "select": "Select",
	}
	util.TimeLangs[Conf.Lang] = map[string]any{
		"now": "now", "1s": "1 second", "xs": "%d seconds", "1m": "1 minute",
		"xh": "%d minutes", "1h": "1 hour", "1d": "1 day", "xd": "%d days",
		"1w": "1 week", "xw": "%d weeks", "1M": "1 month", "xM": "%d months",
		"1y": "1 year", "2y": "2 years", "xy": "%d years", "max": "a long time",
		"albl": "ago", "blbl": "from now",
	}
	util.IsExiting.Store(false)
	cache.ClearTreeCache()
	cache.ClearAVCache()
	kernelsql.ClearCache()
	if err := kernelsql.ClearQueue(); err != nil {
		t.Fatalf("clear derived identity queue: %v", err)
	}
	treenode.InitBlockTree(true)
	t.Cleanup(func() {
		if err := kernelsql.ClearQueue(); err != nil {
			t.Errorf("clear derived identity queue during cleanup: %v", err)
		}
		kernelsql.ClearCache()
		for _, boxID := range []string{fixture.boxA, fixture.boxB} {
			kernelsql.CloseEncryptedDB(boxID)
			treenode.CloseEncryptedBlockTreeDB(boxID)
			treenode.RemoveDynamicRefTexts(boxID)
			cachedDEKsLock.Lock()
			if dek := cachedDEKs[boxID]; dek != nil {
				clear(dek)
			}
			delete(cachedDEKs, boxID)
			cachedDEKsLock.Unlock()
		}
		treenode.CloseDatabase()
		cache.ClearAVCache()
		cache.ClearTreeCache()
		delete(util.TimeLangs, "derived-identity-test")
		if hadOriginalAttrViewLang {
			util.AttrViewLangs["derived-identity-test"] = originalAttrViewLang
		} else {
			delete(util.AttrViewLangs, "derived-identity-test")
		}
		util.Lang = originalLang
		Conf = originalConf
		util.IsExiting.Store(originalIsExiting)
		util.BlockTreeDBPath = originalBlockTreeDBPath
		util.ConfDir = originalConfDir
		util.QueueDir = originalQueueDir
		util.TempDir = originalTempDir
		util.DataDir = originalDataDir
	})

	for _, boxID := range []string{fixture.boxA, fixture.boxB} {
		boxConf := conf.NewBoxConf()
		boxConf.Name = boxID
		boxConf.Encrypted = true
		if err := (&Box{ID: boxID}).SaveConf(boxConf); err != nil {
			t.Fatalf("save encrypted notebook config %s: %v", boxID, err)
		}
		dek, err := util.GenerateDEK()
		if err != nil {
			t.Fatalf("generate %s key: %v", boxID, err)
		}
		if err = kernelsql.OpenEncryptedDB(boxID, dek); err != nil {
			t.Fatalf("open %s content database: %v", boxID, err)
		}
		if err = treenode.OpenEncryptedBlockTreeDB(boxID, dek); err != nil {
			t.Fatalf("open %s blocktree database: %v", boxID, err)
		}
		cachedDEKsLock.Lock()
		cachedDEKs[boxID] = append([]byte(nil), dek...)
		cachedDEKsLock.Unlock()
		clear(dek)
	}

	fixture.defTrees[fixture.boxA] = writeDerivedDefinitionTree(t, fixture.boxA, fixture.defID, "Definition A")
	fixture.defTrees[fixture.boxB] = writeDerivedDefinitionTree(t, fixture.boxB, fixture.defID, "Definition B")
	refTreeA := writeDerivedReferenceTree(t, fixture.boxA, fixture.refRootID, fixture.refBlockID, fixture.defID, "old-a", 1)
	refTreeB := writeDerivedReferenceTree(t, fixture.boxB, fixture.refRootID, fixture.refBlockID, fixture.defID, "old-b", 2)
	if err := kernelsql.UpdateRefsTreeQueue(refTreeA); err != nil {
		t.Fatalf("enqueue first reference tree: %v", err)
	}
	if err := kernelsql.UpdateRefsTreeQueue(refTreeB); err != nil {
		t.Fatalf("enqueue second reference tree: %v", err)
	}
	if err := kernelsql.FlushQueue(); err != nil {
		t.Fatalf("flush reference fixture queue: %v", err)
	}
	kernelsql.ClearCache()
	return fixture
}

func writeDerivedDefinitionTree(t *testing.T, boxID, rootID, title string) *parse.Tree {
	t.Helper()
	path := "/" + rootID + ".sy"
	tree := treenode.NewTree(boxID, path, "/"+title, title)
	tree.Root.FirstChild.Unlink()
	tree.ID = rootID
	tree.Root.ID = rootID
	tree.Root.Box = boxID
	tree.Root.Path = path
	tree.Root.SetIALAttr("id", rootID)
	tree.Root.SetIALAttr("title", title)
	if _, err := filesys.WriteTree(tree); err != nil {
		t.Fatalf("write %s definition tree: %v", boxID, err)
	}
	if err := treenode.UpsertBlockTree(tree); err != nil {
		t.Fatalf("index %s definition blocktree: %v", boxID, err)
	}
	return tree
}

func writeDerivedReferenceTree(t *testing.T, boxID, rootID, blockID, defID, anchor string, count int) *parse.Tree {
	t.Helper()
	path := "/" + rootID + ".sy"
	tree := treenode.NewTree(boxID, path, "/References", "References")
	tree.Root.FirstChild.Unlink()
	tree.ID = rootID
	tree.Root.ID = rootID
	tree.Root.Box = boxID
	tree.Root.Path = path
	tree.Root.SetIALAttr("id", rootID)
	for i := 0; i < count; i++ {
		id := blockID
		if i > 0 {
			id = "20990101120500-refmore"
		}
		paragraph := &ast.Node{Type: ast.NodeParagraph, ID: id, Box: boxID, Path: path}
		paragraph.SetIALAttr("id", id)
		paragraph.AppendChild(&ast.Node{
			Type:                    ast.NodeTextMark,
			Box:                     boxID,
			Path:                    path,
			TextMarkType:            "block-ref",
			TextMarkTextContent:     anchor,
			TextMarkBlockRefID:      defID,
			TextMarkBlockRefSubtype: "d",
		})
		tree.Root.AppendChild(paragraph)
	}
	if _, err := filesys.WriteTree(tree); err != nil {
		t.Fatalf("write %s reference tree: %v", boxID, err)
	}
	if err := treenode.UpsertBlockTree(tree); err != nil {
		t.Fatalf("index %s reference blocktree: %v", boxID, err)
	}
	return tree
}
