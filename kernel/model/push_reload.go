// SiYuan - Refactor your thinking
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

package model

import (
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/88250/go-humanize"
	"github.com/88250/gulu"
	"github.com/88250/lute"
	"github.com/88250/lute/ast"
	"github.com/88250/lute/parse"
	"github.com/88250/lute/render"
	"github.com/emirpasic/gods/sets/hashset"
	"github.com/siyuan-note/logging"
	"github.com/siyuan-note/siyuan/kernel/av"
	"github.com/siyuan-note/siyuan/kernel/conf"
	"github.com/siyuan-note/siyuan/kernel/filesys"
	"github.com/siyuan-note/siyuan/kernel/sql"
	"github.com/siyuan-note/siyuan/kernel/task"
	"github.com/siyuan-note/siyuan/kernel/treenode"
	"github.com/siyuan-note/siyuan/kernel/util"
)

func PushReloadSnippet(snippet *conf.Snpt) {
	util.BroadcastByType("main", "setSnippet", 0, "", snippet)
}

func PushReloadPlugin(uninstallPluginNameSet, unloadPluginNameSet, reloadPluginSet, dataChangePluginSet *hashset.Set, excludeApp string) {
	// 按优先级从高到低排列，同一插件只保留在优先级最高的集合中
	orderedSets := []*hashset.Set{uninstallPluginNameSet, unloadPluginNameSet, reloadPluginSet, dataChangePluginSet}
	slices := make([][]string, len(orderedSets))
	// 按顺序遍历所有集合
	for i, set := range orderedSets {
		if nil != set {
			// 遍历当前集合的所有插件名称
			for _, n := range set.Values() {
				name := n.(string)
				// 将该插件从所有后续集合中移除
				for _, lowerSet := range orderedSets[i+1:] {
					if nil != lowerSet {
						lowerSet.Remove(name)
					}
				}
			}
		}

		// 将当前集合转换为字符串切片
		if nil == set {
			slices[i] = []string{}
		} else {
			strs := make([]string, 0, set.Size())
			for _, n := range set.Values() {
				strs = append(strs, n.(string))
			}
			slices[i] = strs
		}
	}

	logging.LogInfof("reload plugins, uninstalls=%v, unloads=%v, reloads=%v, dataChanges=%v", slices[0], slices[1], slices[2], slices[3])
	payload := map[string]any{
		"uninstallPlugins":  slices[0], // 插件卸载
		"unloadPlugins":     slices[1], // 插件禁用
		"reloadPlugins":     slices[2], // 插件启用，或插件代码变更
		"dataChangePlugins": slices[3], // 插件存储数据变更
	}

	if "" == excludeApp {
		util.BroadcastByType("main", "reloadPlugin", 0, "", payload)
		return
	}
	util.BroadcastByTypeAndExcludeApp(excludeApp, "main", "reloadPlugin", 0, "", payload)
}

func refreshDocInfo(tree *parse.Tree) {
	if nil == tree {
		return
	}

	refreshDocInfoWithSize(tree, filesys.TreeSize(tree))
}

func refreshDocInfoWithSize(tree *parse.Tree, size uint64) {
	if nil == tree {
		return
	}

	refreshDocInfo0(tree, size)
	boxID, treePath := tree.Box, tree.Path
	parentDir := path.Dir(treePath)
	if parentDir == "/" || parentDir == filepath.Join(util.DataDir, boxID) {
		return
	}
	go func(boxID, treePath string) {
		time.Sleep(128 * time.Millisecond)
		refreshParentDocInfo(boxID, treePath)
	}(boxID, treePath)
}

func refreshParentDocInfo(boxID, treePath string) {
	parentTree := loadParentTree(boxID, treePath)
	if nil == parentTree {
		return
	}

	luteEngine := lute.New()
	renderer := render.NewJSONRenderer(parentTree, luteEngine.RenderOptions, luteEngine.ParseOptions)
	data := renderer.Render()
	refreshDocInfo0(parentTree, uint64(len(data)))
}

func refreshDocInfo0(tree *parse.Tree, size uint64) {
	cTime, _ := time.ParseInLocation("20060102150405", tree.ID[:14], time.Local)
	mTime := cTime
	if updated := tree.Root.IALAttr("updated"); "" != updated {
		if updatedTime, err := time.ParseInLocation("20060102150405", updated, time.Local); err == nil {
			mTime = updatedTime
		}
	}

	subFileCount := 0
	if "true" != tree.Root.IALAttr(DocHiddenAttr) {
		subDir := filepath.Join(util.DataDir, tree.Box, strings.TrimSuffix(tree.Path, ".sy"))
		subFiles, err := os.ReadDir(subDir)
		if err == nil {
			for _, subFile := range subFiles {
				if !strings.HasSuffix(subFile.Name(), ".sy") {
					continue
				}

				subDocIAL := filesys.DocIAL(filepath.Join(subDir, subFile.Name()))
				if "true" == subDocIAL[DocHiddenAttr] {
					continue
				}
				subFileCount++
			}
		}
	}

	docInfo := map[string]any{
		"box":          tree.Box,
		"rootID":       tree.ID,
		"name":         tree.Root.IALAttr("title"),
		"alias":        tree.Root.IALAttr("alias"),
		"name1":        tree.Root.IALAttr("name"),
		"memo":         tree.Root.IALAttr("memo"),
		"bookmark":     tree.Root.IALAttr("bookmark"),
		"size":         size,
		"hSize":        humanize.BytesCustomCeil(size, 2),
		"mtime":        mTime.Unix(),
		"ctime":        cTime.Unix(),
		"hMtime":       mTime.Format("2006-01-02 15:04:05") + ", " + util.HumanizeTime(mTime, Conf.Lang),
		"hCtime":       cTime.Format("2006-01-02 15:04:05") + ", " + util.HumanizeTime(cTime, Conf.Lang),
		"subFileCount": subFileCount,
	}

	task.AppendAsyncTaskWithDelay(task.ReloadProtyle, 500*time.Millisecond, util.PushReloadDocInfo, docInfo)
}

func ReloadFiletree() {
	task.AppendAsyncTaskWithDelay(task.ReloadFiletree, 200*time.Millisecond, util.PushReloadFiletree)
}

func ReloadTag() {
	task.AppendAsyncTaskWithDelay(task.ReloadTag, 200*time.Millisecond, util.PushReloadTag)
}

func ReloadProtyle(rootID, notebook string) {
	// 刷新关联的引用
	defTree, _ := loadTreeByBlockIDInBox(rootID, notebook)
	if nil != defTree {
		var defIDs []string
		for _, ref := range sql.QueryRefsByDefIDInBox(rootID, true, notebook) {
			defIDs = append(defIDs, ref.DefBlockID)
		}
		defIDs = gulu.Str.RemoveDuplicatedElem(defIDs)

		var defNodes []*ast.Node
		ast.Walk(defTree.Root, func(n *ast.Node, entering bool) ast.WalkStatus {
			if !entering || !n.IsBlock() {
				return ast.WalkContinue
			}

			if gulu.Str.Contains(n.ID, defIDs) {
				defNodes = append(defNodes, n)
			}
			return ast.WalkContinue
		})

		for _, def := range defNodes {
			if err := refreshDynamicRefText(def, defTree); err != nil {
				logging.LogErrorf("refresh dynamic reference text for tree [%s/%s] failed: %s", defTree.Box, defTree.Path, err)
				return
			}
		}
	}

	// 刷新关联的嵌入块
	refIDs := sql.QueryRefIDsByDefIDInBox(rootID, true, notebook)
	var rootIDs []string
	bts := treenode.GetBlockTreesInBox(refIDs, notebook)
	for _, bt := range bts {
		rootIDs = append(rootIDs, bt.RootID)
	}
	rootIDs = gulu.Str.RemoveDuplicatedElem(rootIDs)
	for _, id := range rootIDs {
		task.AppendAsyncTaskWithDelay(task.ReloadProtyle, 200*time.Millisecond, util.PushReloadProtyle, id, notebook)
	}

	task.AppendAsyncTaskWithDelay(task.ReloadProtyle, 200*time.Millisecond, util.PushReloadProtyle, rootID, notebook)
}

// refreshRefCount 用于刷新定义块处的引用计数。
func refreshRefCount(blockID, boxID string) {
	if err := sql.FlushQueue(); err != nil {
		logging.LogErrorf("flush database queue before refreshing reference count [box=%s, block=%s] failed: %s", boxID, blockID, err)
		return
	}
	refCount := loadRefCountSnapshot(blockID, boxID)
	if refCount == nil {
		return
	}
	util.PushSetDefRefCount(refCount.rootID, blockID, refCount.defIDs, refCount.refCount, refCount.rootRefCount, refCount.boxID)
}

type refCountSnapshot struct {
	boxID        string
	rootID       string
	defIDs       []string
	refCount     int
	rootRefCount int
}

func loadRefCountSnapshot(blockID, boxID string) *refCountSnapshot {
	boxID = attributeViewStoreBoxID(boxID)
	bt := treenode.GetBlockTreeInBox(blockID, boxID)
	if nil == bt {
		return nil
	}

	isDoc := bt.ID == bt.RootID
	var refIDs, rootRefIDs, defIDs []string
	if boxID == "" {
		refIDs = sql.QueryRefIDsByDefID(bt.ID, isDoc)
		if isDoc {
			rootRefIDs = refIDs
			defIDs = sql.QueryChildDefIDsByRootDefID(bt.ID)
		} else {
			rootRefIDs = sql.QueryRefIDsByDefID(bt.RootID, true)
			defIDs = append(defIDs, bt.ID)
		}
	} else {
		refIDs = sql.QueryRefIDsByDefIDInBox(bt.ID, isDoc, boxID)
		rootRefIDs = refIDs
		if isDoc {
			for _, ref := range sql.QueryRefsByDefIDInBox(bt.ID, true, boxID) {
				defIDs = append(defIDs, ref.DefBlockID)
			}
			defIDs = gulu.Str.RemoveDuplicatedElem(defIDs)
		} else {
			rootRefIDs = sql.QueryRefIDsByDefIDInBox(bt.RootID, true, boxID)
			defIDs = append(defIDs, bt.ID)
		}
	}

	return &refCountSnapshot{
		boxID:        boxID,
		rootID:       bt.RootID,
		defIDs:       defIDs,
		refCount:     len(refIDs),
		rootRefCount: len(rootRefIDs),
	}
}

type derivedObjectIdentity struct {
	boxID    string
	objectID string
}

func newDerivedObjectIdentity(boxID, objectID string) derivedObjectIdentity {
	return derivedObjectIdentity{boxID: attributeViewStoreBoxID(boxID), objectID: objectID}
}

// refreshDynamicRefText 用于刷新块引用的动态锚文本。
// 该实现依赖了数据库缓存，导致外部调用时可能需要阻塞等待数据库写入后才能获取到 refs
func refreshDynamicRefText(updatedDefNode *ast.Node, updatedTree *parse.Tree) error {
	changedDefs := map[string]*ast.Node{updatedDefNode.ID: updatedDefNode}
	changedTrees := map[string]*parse.Tree{updatedTree.ID: updatedTree}
	_, err := refreshDynamicRefTexts(changedDefs, changedTrees, updatedTree.Box)
	return err
}

// refreshDynamicRefTexts 用于批量刷新块引用的动态锚文本。
// 该实现依赖了数据库缓存，导致外部调用时可能需要阻塞等待数据库写入后才能获取到 refs
func refreshDynamicRefTexts(updatedDefNodes map[string]*ast.Node, updatedTrees map[string]*parse.Tree, boxID string) (changedRootIDs []string, err error) {
	changedRootIDs, changedTrees, err := collectDynamicRefTextChanges(updatedDefNodes, updatedTrees, boxID)
	if err != nil {
		return nil, err
	}
	for _, tree := range changedTrees {
		if err = indexWriteTreeUpsertQueue(tree); err != nil {
			return nil, err
		}
	}
	return changedRootIDs, nil
}

// collectDynamicRefTextChanges mutates the affected trees in memory without
// publishing files, blocktrees, or SQL queue entries. Transaction commit uses
// this boundary to publish primary and derived tree changes as one batch.
func collectDynamicRefTextChanges(updatedDefNodes map[string]*ast.Node, updatedTrees map[string]*parse.Tree, boxID string) (changedRootIDs []string, changedTrees map[derivedObjectIdentity]*parse.Tree, err error) {
	contentStore := attributeViewStoreBoxID(boxID)
	derivedDefNodes := make(map[derivedObjectIdentity]*ast.Node, len(updatedDefNodes))
	for id, node := range updatedDefNodes {
		derivedDefNodes[derivedObjectIdentity{boxID: contentStore, objectID: id}] = node
	}
	derivedTrees := make(map[derivedObjectIdentity]*parse.Tree, len(updatedTrees))
	for id, tree := range updatedTrees {
		identity := derivedObjectIdentity{boxID: contentStore, objectID: id}
		derivedTrees[identity] = tree
		changedRootIDs = append(changedRootIDs, identity.objectID)
	}
	changedTrees = map[derivedObjectIdentity]*parse.Tree{}

	for range 7 {
		updatedRefNodes, updatedRefTrees, refreshErr := refreshDynamicRefTexts0(derivedDefNodes, derivedTrees)
		if refreshErr != nil {
			return nil, nil, refreshErr
		}
		if 1 > len(updatedRefNodes) {
			break
		}
		derivedDefNodes, derivedTrees = updatedRefNodes, updatedRefTrees

		for identity, tree := range derivedTrees {
			changedRootIDs = append(changedRootIDs, identity.objectID)
			changedTrees[identity] = tree
		}
	}

	changedRootIDs = gulu.Str.RemoveDuplicatedElem(changedRootIDs)
	return
}

func refreshDynamicRefTexts0(updatedDefNodes map[derivedObjectIdentity]*ast.Node, updatedTrees map[derivedObjectIdentity]*parse.Tree) (updatedRefNodes map[derivedObjectIdentity]*ast.Node, updatedRefTrees map[derivedObjectIdentity]*parse.Tree, err error) {
	updatedRefNodes = map[derivedObjectIdentity]*ast.Node{}
	updatedRefTrees = map[derivedObjectIdentity]*parse.Tree{}

	// 1. 更新引用的动态锚文本
	treeRefNodeIDs := map[derivedObjectIdentity]*hashset.Set{}
	changedDefNodes := map[derivedObjectIdentity]*ast.Node{}
	for identity, updateNode := range updatedDefNodes {
		refs, changedNodes := getRefsCacheByDefNodeInBox(updateNode, identity.boxID)
		for _, ref := range refs {
			refTreeIdentity := derivedObjectIdentity{boxID: identity.boxID, objectID: ref.RootID}
			if refIDs, ok := treeRefNodeIDs[refTreeIdentity]; !ok {
				refIDs = hashset.New()
				refIDs.Add(ref.BlockID)
				treeRefNodeIDs[refTreeIdentity] = refIDs
			} else {
				refIDs.Add(ref.BlockID)
			}
		}
		for _, node := range changedNodes {
			changedDefNodes[derivedObjectIdentity{boxID: identity.boxID, objectID: node.ID}] = node
		}
	}
	for identity, node := range changedDefNodes {
		updatedDefNodes[identity] = node
	}

	for refTreeIdentity, refNodeIDs := range treeRefNodeIDs {
		refTree, ok := updatedTrees[refTreeIdentity]
		if !ok {
			var err error
			refTree, err = loadTreeByBlockIDInBox(refTreeIdentity.objectID, refTreeIdentity.boxID)
			if err != nil {
				continue
			}
		}

		var refTreeChanged bool
		ast.Walk(refTree.Root, func(n *ast.Node, entering bool) ast.WalkStatus {
			if !entering {
				return ast.WalkContinue
			}

			if n.IsBlock() && refNodeIDs.Contains(n.ID) {
				changed, changedDefNodes := updateRefText(n, updatedDefNodes, refTreeIdentity.boxID)
				if !refTreeChanged && changed {
					refTreeChanged = true
					updatedRefNodes[derivedObjectIdentity{boxID: refTreeIdentity.boxID, objectID: n.ID}] = n
					updatedRefTrees[refTreeIdentity] = refTree
				}

				// 推送动态锚文本节点刷新
				for _, defNode := range changedDefNodes {
					switch defNode.refType {
					case "ref-d":
						task.AppendAsyncTaskWithDelay(task.SetRefDynamicText, 200*time.Millisecond, util.PushSetRefDynamicText, refTreeIdentity.objectID, n.ID, defNode.id, defNode.refText, refTreeIdentity.boxID)
					}
				}
				return ast.WalkContinue
			}
			return ast.WalkContinue
		})

		if refTreeChanged {
			updatedRefTrees[refTreeIdentity] = refTree
		}
	}

	// 2. 更新属性视图主键内容
	updateAttributeViewBlockTextByIdentity(updatedDefNodes)

	return
}

func updateAttributeViewBlockText(updatedDefNodes map[string]*ast.Node) {
	derivedDefNodes := make(map[derivedObjectIdentity]*ast.Node, len(updatedDefNodes))
	for id, node := range updatedDefNodes {
		derivedDefNodes[newDerivedObjectIdentity(node.Box, id)] = node
	}
	updateAttributeViewBlockTextByIdentity(derivedDefNodes)
}

func updateAttributeViewBlockTextByIdentity(updatedDefNodes map[derivedObjectIdentity]*ast.Node) {
	parents := map[derivedObjectIdentity]*ast.Node{}
	for identity, updatedDefNode := range updatedDefNodes {
		for parent := updatedDefNode.Parent; nil != parent && ast.NodeDocument != parent.Type; parent = parent.Parent {
			parents[derivedObjectIdentity{boxID: identity.boxID, objectID: parent.ID}] = parent
		}
	}
	for identity, parent := range parents {
		updatedDefNodes[identity] = parent
	}

	for identity, updatedDefNode := range updatedDefNodes {
		avs := updatedDefNode.IALAttr(av.NodeAttrNameAvs)
		if "" == avs {
			continue
		}

		avIDs := strings.SplitSeq(avs, ",")
		for avID := range avIDs {
			attrView, parseErr := av.ParseAttributeViewInBox(avID, identity.boxID)
			if nil != parseErr {
				continue
			}

			changedAv := false
			blockValues := attrView.GetBlockKeyValues()
			if nil == blockValues {
				continue
			}

			for _, blockValue := range blockValues.Values {
				if blockValue.Block.ID == updatedDefNode.ID {
					newIcon, newContent := getNodeAvBlockText(updatedDefNode, avID)
					if newIcon != blockValue.Block.Icon {
						blockValue.Block.Icon = newIcon
						changedAv = true
					}
					if newContent != blockValue.Block.Content {
						blockValue.Block.Content = util.UnescapeHTML(newContent)
						changedAv = true
					}
					break
				}
			}
			if changedAv {
				av.SaveAttributeViewInBox(attrView, identity.boxID)
				ReloadAttrViewInBox(avID, identity.boxID)

				refreshRelatedSrcAvs(avID, nil, identity.boxID)
			}
		}
	}
}

// ReloadAttrView 用于重新加载属性视图。
func ReloadAttrView(avID string) {
	ReloadAttrViewInBox(avID, "")
}

// ReloadAttrViewInBox 将属性视图重载限定在指定内容库。
func ReloadAttrViewInBox(avID, boxID string) {
	boxID = attributeViewStoreBoxID(boxID)
	task.AppendAsyncTaskWithDelay(task.ReloadAttributeView, 200*time.Millisecond, pushReloadAttrView, avID, boxID)
}

func pushReloadAttrView(avID, boxID string) {
	util.ExecuteContentStoreBroadcast(boxID, func() {
		util.BroadcastByType("protyle", "refreshAttributeView", 0, "", map[string]any{"id": avID, "boxID": boxID})
	})
}

func PushCreate(box *Box, p string, arg map[string]any) {
	evt := util.NewCmdResult("create", 0, util.PushModeBroadcast)
	listDocTree := false
	if nil == arg {
		arg = map[string]any{
			"listDocTree": true,
		}
	}

	listDocTreeArg := arg["listDocTree"]
	if nil != listDocTreeArg {
		listDocTree = listDocTreeArg.(bool)
	}

	evt.Data = map[string]any{
		"box":         box,
		"path":        p,
		"listDocTree": listDocTree,
	}
	util.PushEvent(evt)
}
