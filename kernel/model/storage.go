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
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/88250/gulu"
	"github.com/88250/lute/ast"
	"github.com/88250/lute/parse"
	"github.com/siyuan-note/filelock"
	"github.com/siyuan-note/logging"
	"github.com/siyuan-note/siyuan/kernel/sql"
	"github.com/siyuan-note/siyuan/kernel/treenode"
	"github.com/siyuan-note/siyuan/kernel/util"
)

var localStorageLock = sync.Mutex{}

func GetLocalStorage() (ret map[string]any) {
	localStorageLock.Lock()
	defer localStorageLock.Unlock()
	return getLocalStorage()
}

func SetLocalStorage(val map[string]any) (err error) {
	localStorageLock.Lock()
	defer localStorageLock.Unlock()
	return setLocalStorage(val)
}

func SetLocalStorageVals(keyVals map[string]any) (setKeyVals map[string]any, err error) {
	localStorageLock.Lock()
	defer localStorageLock.Unlock()

	setKeyVals = make(map[string]any, len(keyVals))
	localStorage := getLocalStorage()
	for k, v := range keyVals {
		if v == nil {
			err = fmt.Errorf("local storage value for key [%s] must not be empty", k)
			return
		}
		localStorage[k] = v
		setKeyVals[k] = v
	}
	err = setLocalStorage(localStorage)
	return
}

func RemoveLocalStorageVals(keys []string) (err error) {
	localStorageLock.Lock()
	defer localStorageLock.Unlock()

	localStorage := getLocalStorage()
	for _, key := range keys {
		delete(localStorage, key)
	}
	return setLocalStorage(localStorage)
}

func getLocalStorage() (ret map[string]any) {
	// When local.json is corrupted, clear the file to avoid being unable to enter the main interface https://github.com/siyuan-note/siyuan/issues/7911
	ret = map[string]any{}
	lsPath := filepath.Join(util.DataDir, "storage/local.json")
	if !filelock.IsExist(lsPath) {
		return
	}

	data, err := filelock.ReadFile(lsPath)
	if err != nil {
		logging.LogErrorf("read storage [local] failed: %s", err)
		return
	}

	if err = gulu.JSON.UnmarshalJSON(data, &ret); err != nil {
		logging.LogErrorf("unmarshal storage [local] failed: %s", err)
		return
	}
	return
}

func setLocalStorage(val map[string]any) (err error) {
	dirPath := filepath.Join(util.DataDir, "storage")
	if err = os.MkdirAll(dirPath, 0755); err != nil {
		logging.LogErrorf("create storage [local] dir failed: %s", err)
		return
	}

	data, err := gulu.JSON.MarshalIndentJSON(val, "", "  ")
	if err != nil {
		logging.LogErrorf("marshal storage [local] failed: %s", err)
		return
	}

	lsPath := filepath.Join(dirPath, "local.json")
	err = filelock.WriteFile(lsPath, data)
	if err != nil {
		logging.LogErrorf("write storage [local] failed: %s", err)
		return
	}
	return
}

type Criterion struct {
	Name         string                 `json:"name"`
	Sort         int                    `json:"sort"`       // 0：按块类型（默认），1：按创建时间升序，2：按创建时间降序，3：按更新时间升序，4：按更新时间降序，5：按内容顺序（仅在按文档分组时）
	Group        int                    `json:"group"`      // 0：不分组，1：按文档分组
	HasReplace   bool                   `json:"hasReplace"` // 是否有替换
	Method       int                    `json:"method"`     // 0：文本，1：查询语法，2：SQL，3：正则表达式
	HPath        string                 `json:"hPath"`
	IDPath       []string               `json:"idPath"`
	K            string                 `json:"k"`            // 搜索关键字
	R            string                 `json:"r"`            // 替换关键字
	Types        *CriterionTypes        `json:"types"`        // 类型过滤选项
	ReplaceTypes *CriterionReplaceTypes `json:"replaceTypes"` // 替换类型过滤选项
}

type CriterionTypes struct {
	MathBlock     bool `json:"mathBlock"`
	Table         bool `json:"table"`
	Blockquote    bool `json:"blockquote"`
	SuperBlock    bool `json:"superBlock"`
	Paragraph     bool `json:"paragraph"`
	Document      bool `json:"document"`
	Heading       bool `json:"heading"`
	List          bool `json:"list"`
	ListItem      bool `json:"listItem"`
	CodeBlock     bool `json:"codeBlock"`
	HtmlBlock     bool `json:"htmlBlock"`
	EmbedBlock    bool `json:"embedBlock"`
	DatabaseBlock bool `json:"databaseBlock"`
	AudioBlock    bool `json:"audioBlock"`
	VideoBlock    bool `json:"videoBlock"`
	IFrameBlock   bool `json:"iframeBlock"`
	WidgetBlock   bool `json:"widgetBlock"`
	Callout       bool `json:"callout"`
}

type CriterionReplaceTypes struct {
	Text              bool `json:"text"`
	ImgText           bool `json:"imgText"`
	ImgTitle          bool `json:"imgTitle"`
	ImgSrc            bool `json:"imgSrc"`
	AText             bool `json:"aText"`
	ATitle            bool `json:"aTitle"`
	AHref             bool `json:"aHref"`
	Code              bool `json:"code"`
	Em                bool `json:"em"`
	Strong            bool `json:"strong"`
	InlineMath        bool `json:"inlineMath"`
	InlineMemo        bool `json:"inlineMemo"`
	BlockRef          bool `json:"blockRef"`
	FileAnnotationRef bool `json:"fileAnnotationRef"`
	Kbd               bool `json:"kbd"`
	Mark              bool `json:"mark"`
	S                 bool `json:"s"`
	Sub               bool `json:"sub"`
	Sup               bool `json:"sup"`
	Tag               bool `json:"tag"`
	U                 bool `json:"u"`
	DocTitle          bool `json:"docTitle"`
	CodeBlock         bool `json:"codeBlock"`
	MathBlock         bool `json:"mathBlock"`
	HtmlBlock         bool `json:"htmlBlock"`
}

var criteriaLock = sync.Mutex{}

func GetCriteria() (ret []*Criterion) {
	criteriaLock.Lock()
	defer criteriaLock.Unlock()
	ret, _ = getCriteria()
	return
}

func SetCriterion(criterion *Criterion) (err error) {
	if "" == criterion.Name {
		return errors.New(Conf.Language(142))
	}

	criteriaLock.Lock()
	defer criteriaLock.Unlock()

	criteria, err := getCriteria()
	if err != nil {
		return
	}

	update := false
	for i, c := range criteria {
		if c.Name == criterion.Name {
			criteria[i] = criterion
			update = true
			break
		}
	}
	if !update {
		criteria = append(criteria, criterion)
	}

	err = setCriteria(criteria)
	return
}

func RemoveCriterion(name string) (err error) {
	criteriaLock.Lock()
	defer criteriaLock.Unlock()

	criteria, err := getCriteria()
	if err != nil {
		return
	}

	for i, c := range criteria {
		if c.Name == name {
			criteria = append(criteria[:i], criteria[i+1:]...)
			break
		}
	}

	err = setCriteria(criteria)
	return
}

func getCriteria() (ret []*Criterion, err error) {
	ret = []*Criterion{}
	dataPath := filepath.Join(util.DataDir, "storage/criteria.json")
	if !filelock.IsExist(dataPath) {
		return
	}

	data, err := filelock.ReadFile(dataPath)
	if err != nil {
		logging.LogErrorf("read storage [criteria] failed: %s", err)
		return
	}

	if err = gulu.JSON.UnmarshalJSON(data, &ret); err != nil {
		logging.LogErrorf("unmarshal storage [criteria] failed: %s", err)
		return
	}
	return
}

func setCriteria(criteria []*Criterion) (err error) {
	dirPath := filepath.Join(util.DataDir, "storage")
	if err = os.MkdirAll(dirPath, 0755); err != nil {
		logging.LogErrorf("create storage [criteria] dir failed: %s", err)
		return
	}

	data, err := gulu.JSON.MarshalIndentJSON(criteria, "", "  ")
	if err != nil {
		logging.LogErrorf("marshal storage [criteria] failed: %s", err)
		return
	}

	lsPath := filepath.Join(dirPath, "criteria.json")
	err = filelock.WriteFile(lsPath, data)
	if err != nil {
		logging.LogErrorf("write storage [criteria] failed: %s", err)
		return
	}
	return
}

type RecentDoc struct {
	RootID     string `json:"rootID"`
	NotebookID string `json:"notebookId,omitempty"`
	Icon       string `json:"icon,omitempty"`
	Title      string `json:"title,omitempty"`
	ViewedAt   int64  `json:"viewedAt,omitempty"` // 浏览时间字段
	ClosedAt   int64  `json:"closedAt,omitempty"` // 关闭时间字段
	OpenAt     int64  `json:"openAt,omitempty"`   // 文档第一次从文档树加载到页签的时间
}

type RecentDocIdentity struct {
	RootID     string `json:"rootID"`
	NotebookID string `json:"notebookId"`
}

// recentDocRecord 是全局存储格式，不包含运行时派生的标题和图标明文。
type recentDocRecord struct {
	RootID     string `json:"rootID"`
	NotebookID string `json:"notebookId,omitempty"`
	ViewedAt   int64  `json:"viewedAt,omitempty"`
	ClosedAt   int64  `json:"closedAt,omitempty"`
	OpenAt     int64  `json:"openAt,omitempty"`
}

func recentDocIdentityKey(rootID, notebookID string) string {
	return notebookID + "\x00" + rootID
}

func resolveRecentDocIdentity(rootID, notebookID string) (identity RecentDocIdentity, bt *treenode.BlockTree, err error) {
	if !ast.IsNodeIDPattern(rootID) || !ast.IsNodeIDPattern(notebookID) {
		return identity, nil, ErrInvalidID
	}
	contentStore := ""
	if IsEncryptedBox(notebookID) {
		contentStore = notebookID
	}
	bt = treenode.GetBlockTreeInBox(rootID, contentStore)
	if bt == nil || bt.BoxID != notebookID {
		return identity, nil, fmt.Errorf("%w: recent document [%s] in notebook [%s]", ErrBlockNotFound, rootID, notebookID)
	}
	identity = RecentDocIdentity{RootID: bt.RootID, NotebookID: notebookID}
	return
}

// recentDocMigrationStores 只有在所有加密 blocktree 均可检查时才允许旧身份迁移。
func recentDocMigrationStores() (openedBoxIDs []string, allEncryptedStoresOpened bool) {
	openedBoxIDs = treenode.GetOpenedEncryptedBoxIDs()
	openedBoxes := make(map[string]bool, len(openedBoxIDs))
	for _, boxID := range openedBoxIDs {
		openedBoxes[boxID] = true
	}
	allEncryptedStoresOpened = true
	for _, boxID := range ListAllEncryptedBoxIDs() {
		if !openedBoxes[boxID] {
			allEncryptedStoresOpened = false
			break
		}
	}
	return openedBoxIDs, allEncryptedStoresOpened
}

func resolveLegacyRecentDocIdentity(rootID string, openedBoxIDs []string, allEncryptedStoresOpened bool) (identity RecentDocIdentity, bt *treenode.BlockTree, ok bool) {
	if !allEncryptedStoresOpened || !ast.IsNodeIDPattern(rootID) {
		return
	}

	candidates := make([]*treenode.BlockTree, 0, 2)
	if ordinary := treenode.GetBlockTreeInBox(rootID, ""); ordinary != nil && !IsEncryptedBox(ordinary.BoxID) {
		candidates = append(candidates, ordinary)
	}
	for _, boxID := range openedBoxIDs {
		if encrypted := treenode.GetBlockTreeInBox(rootID, boxID); encrypted != nil && encrypted.BoxID == boxID {
			candidates = append(candidates, encrypted)
			if len(candidates) > 1 {
				return RecentDocIdentity{}, nil, false
			}
		}
	}
	if len(candidates) != 1 || !ast.IsNodeIDPattern(candidates[0].BoxID) {
		return RecentDocIdentity{}, nil, false
	}
	bt = candidates[0]
	identity = RecentDocIdentity{RootID: bt.RootID, NotebookID: bt.BoxID}
	return identity, bt, true
}

var recentDocLock = sync.Mutex{}

func GetRecentDocs(sortBy string) (ret []*RecentDoc, err error) {
	recentDocLock.Lock()
	defer recentDocLock.Unlock()
	return getRecentDocs(sortBy)
}

// UpdateRecentDocOpenTime 更新文档打开时间（只在第一次从文档树加载到页签时调用）
func UpdateRecentDocOpenTime(rootID, notebookID string) (err error) {
	identity, _, err := resolveRecentDocIdentity(rootID, notebookID)
	if err != nil {
		return err
	}
	recentDocLock.Lock()
	defer recentDocLock.Unlock()

	recentDocs, err := loadRecentDocsRaw()
	if err != nil {
		return
	}

	timeNow := time.Now().Unix()
	// 查找文档并更新打开时间和浏览时间
	found := false
	for _, doc := range recentDocs {
		if recentDocIdentityKey(doc.RootID, doc.NotebookID) == recentDocIdentityKey(identity.RootID, identity.NotebookID) {
			doc.OpenAt = timeNow
			doc.ViewedAt = timeNow
			doc.ClosedAt = 0
			found = true
			break
		}
	}

	// 如果文档不存在，创建新记录
	if !found {
		recentDoc := &RecentDoc{
			RootID:     identity.RootID,
			NotebookID: identity.NotebookID,
			OpenAt:     timeNow,
			ViewedAt:   timeNow,
		}
		recentDocs = append([]*RecentDoc{recentDoc}, recentDocs...)
	}

	err = setRecentDocs(recentDocs)
	return
}

// UpdateRecentDocViewTime 更新文档浏览时间
func UpdateRecentDocViewTime(rootID, notebookID string) (err error) {
	identity, _, err := resolveRecentDocIdentity(rootID, notebookID)
	if err != nil {
		return err
	}
	recentDocLock.Lock()
	defer recentDocLock.Unlock()

	recentDocs, err := loadRecentDocsRaw()
	if err != nil {
		return
	}

	timeNow := time.Now().Unix()
	// 查找文档并更新浏览时间，保留原来的打开时间
	found := false
	for _, doc := range recentDocs {
		if recentDocIdentityKey(doc.RootID, doc.NotebookID) == recentDocIdentityKey(identity.RootID, identity.NotebookID) {
			// OpenAt 保持不变，保留原来的打开时间
			doc.ViewedAt = timeNow
			doc.ClosedAt = 0
			found = true
			break
		}
	}

	// 如果文档不存在，创建新记录
	if !found {
		recentDoc := &RecentDoc{
			RootID:     identity.RootID,
			NotebookID: identity.NotebookID,
			// 新创建的记录不设置 OpenAt，因为这是浏览而不是打开
			ViewedAt: timeNow,
		}
		recentDocs = append([]*RecentDoc{recentDoc}, recentDocs...)
	}

	err = setRecentDocs(recentDocs)
	return
}

// UpdateRecentDocCloseTime 更新文档关闭时间
func UpdateRecentDocCloseTime(rootID, notebookID string) (err error) {
	return BatchUpdateRecentDocCloseTime([]RecentDocIdentity{{RootID: rootID, NotebookID: notebookID}})
}

// BatchUpdateRecentDocCloseTime 批量更新文档关闭时间
func BatchUpdateRecentDocCloseTime(docs []RecentDocIdentity) (err error) {
	if len(docs) == 0 {
		return
	}
	identities := make(map[string]RecentDocIdentity, len(docs))
	for _, doc := range docs {
		identity, _, resolveErr := resolveRecentDocIdentity(doc.RootID, doc.NotebookID)
		if resolveErr != nil {
			return resolveErr
		}
		identities[recentDocIdentityKey(identity.RootID, identity.NotebookID)] = identity
	}

	recentDocLock.Lock()
	defer recentDocLock.Unlock()

	recentDocs, err := loadRecentDocsRaw()
	if err != nil {
		return
	}

	closeTime := time.Now().Unix()

	// 更新已存在的文档
	updated := false
	for _, doc := range recentDocs {
		key := recentDocIdentityKey(doc.RootID, doc.NotebookID)
		if _, ok := identities[key]; ok {
			doc.ClosedAt = closeTime
			updated = true
			delete(identities, key)
		}
	}

	// 为不存在的文档创建新记录
	for _, identity := range identities {
		recentDoc := &RecentDoc{
			RootID:     identity.RootID,
			NotebookID: identity.NotebookID,
			ClosedAt:   closeTime,
		}

		recentDocs = append([]*RecentDoc{recentDoc}, recentDocs...)
		updated = true
	}

	if updated {
		err = setRecentDocs(recentDocs)
	}
	return
}

func loadRecentDocsRaw() (ret []*RecentDoc, err error) {
	dataPath := filepath.Join(util.DataDir, "storage/recent-doc.json")
	if !filelock.IsExist(dataPath) {
		return
	}

	data, err := filelock.ReadFile(dataPath)
	if err != nil {
		logging.LogErrorf("read storage [recent-doc] failed: %s", err)
		return
	}

	if err = gulu.JSON.UnmarshalJSON(data, &ret); err != nil {
		logging.LogErrorf("unmarshal storage [recent-doc] failed: %s", err)
		if err = setRecentDocs([]*RecentDoc{}); err != nil {
			logging.LogErrorf("reset storage [recent-doc] failed: %s", err)
		}
		ret = []*RecentDoc{}
		return
	}
	return
}

func getRecentDocs(sortBy string) (ret []*RecentDoc, err error) {
	ret = []*RecentDoc{} // 初始化为空切片，确保 API 始终返回非 nil
	recentDocs, err := loadRecentDocsRaw()
	if err != nil {
		return
	}
	openedEncryptedBoxIDs, allEncryptedStoresOpened := recentDocMigrationStores()

	mergedDocs := make(map[string]*RecentDoc, len(recentDocs))
	ordinaryRootIDs := make([]string, 0, len(recentDocs))
	preservedEncryptedDocs := make([]*RecentDoc, 0)
	preservedLegacyDocs := make([]*RecentDoc, 0)
	changed := false

	for _, doc := range recentDocs {
		if doc == nil {
			changed = true
			continue
		}
		if doc.Title != "" || doc.Icon != "" {
			doc.Title = ""
			doc.Icon = ""
			changed = true
		}

		var identity RecentDocIdentity
		var bt *treenode.BlockTree
		if doc.NotebookID == "" {
			var migrated bool
			identity, bt, migrated = resolveLegacyRecentDocIdentity(doc.RootID, openedEncryptedBoxIDs, allEncryptedStoresOpened)
			if !migrated {
				preservedLegacyDocs = append(preservedLegacyDocs, doc)
				continue
			}
			doc.NotebookID = identity.NotebookID
			changed = true
		} else {
			if !ast.IsNodeIDPattern(doc.RootID) || !ast.IsNodeIDPattern(doc.NotebookID) {
				changed = true
				continue
			}
			if IsEncryptedBox(doc.NotebookID) && !IsBoxUnlocked(doc.NotebookID) {
				preservedEncryptedDocs = append(preservedEncryptedDocs, doc)
				continue
			}
			var resolveErr error
			identity, bt, resolveErr = resolveRecentDocIdentity(doc.RootID, doc.NotebookID)
			if resolveErr != nil {
				if IsEncryptedBox(doc.NotebookID) {
					preservedEncryptedDocs = append(preservedEncryptedDocs, doc)
					continue
				}
				changed = true
				continue
			}
		}

		// 文档块可能已经转换成标题块 https://github.com/siyuan-note/siyuan/pull/16727#issuecomment-3810081850
		if doc.RootID != identity.RootID {
			changed = true
			doc.RootID = identity.RootID
		}

		key := recentDocIdentityKey(identity.RootID, identity.NotebookID)
		if merged, ok := mergedDocs[key]; !ok {
			doc.Title = path.Base(bt.HPath) // Recent docs not updated after renaming https://github.com/siyuan-note/siyuan/issues/7827
			mergedDocs[key] = doc
			if !IsEncryptedBox(identity.NotebookID) {
				ordinaryRootIDs = append(ordinaryRootIDs, identity.RootID)
			}
		} else {
			// 合并重复记录
			changed = true
			if doc.ViewedAt > merged.ViewedAt {
				merged.ViewedAt = doc.ViewedAt
			}
			if doc.OpenAt > merged.OpenAt {
				merged.OpenAt = doc.OpenAt
			}
			if doc.ClosedAt > merged.ClosedAt {
				merged.ClosedAt = doc.ClosedAt
			}
		}
	}

	attrs := sql.BatchGetBlockAttrs(ordinaryRootIDs)
	for _, doc := range mergedDocs {
		if IsEncryptedBox(doc.NotebookID) {
			tree, loadErr := loadTreeByBlockIDInBox(doc.RootID, doc.NotebookID)
			if loadErr == nil && tree != nil {
				doc.Icon = tree.Root.IALAttr("icon")
			}
		} else if ial, ok := attrs[doc.RootID]; ok {
			if icon, ok := ial["icon"]; ok && icon != "" {
				doc.Icon = icon
			}
		}
		ret = append(ret, doc)
	}

	if changed {
		persisted := make([]*RecentDoc, 0, len(ret)+len(preservedEncryptedDocs)+len(preservedLegacyDocs))
		persisted = append(persisted, ret...)
		persisted = append(persisted, preservedEncryptedDocs...)
		persisted = append(persisted, preservedLegacyDocs...)
		if errSet := setRecentDocs(persisted); errSet != nil {
			logging.LogErrorf("update storage [recent-doc] failed in getRecentDocs: %s", errSet)
		}
	}

	// 根据排序参数进行排序
	switch sortBy {
	case "updated": // 按更新时间排序
		ret = recentDocsByUpdated(openedEncryptedBoxIDs)
	case "closedAt": // 按关闭时间排序
		filtered := make([]*RecentDoc, 0, len(ret))
		for _, doc := range ret {
			if doc.ClosedAt > 0 {
				filtered = append(filtered, doc)
			}
		}
		ret = filtered
		if 0 < len(ret) {
			sort.Slice(ret, func(i, j int) bool {
				return ret[i].ClosedAt > ret[j].ClosedAt
			})
		}
	case "openAt": // 按打开时间排序
		filtered := make([]*RecentDoc, 0, len(ret))
		for _, doc := range ret {
			if doc.OpenAt > 0 {
				filtered = append(filtered, doc)
			}
		}
		ret = filtered
		if 0 < len(ret) {
			sort.Slice(ret, func(i, j int) bool {
				return ret[i].OpenAt > ret[j].OpenAt
			})
		}
	case "viewedAt": // 按浏览时间排序
		fallthrough
	default:
		filtered := make([]*RecentDoc, 0, len(ret))
		for _, doc := range ret {
			if doc.ViewedAt > 0 {
				filtered = append(filtered, doc)
			}
		}
		ret = filtered
		if 0 < len(ret) {
			sort.Slice(ret, func(i, j int) bool {
				return ret[i].ViewedAt > ret[j].ViewedAt
			})
		}
	}
	return
}

type updatedRecentDoc struct {
	doc     *RecentDoc
	updated string
}

func recentDocsByUpdated(openedEncryptedBoxIDs []string) []*RecentDoc {
	limit := Conf.FileTree.RecentDocsMaxListCount
	stores := make([]string, 0, len(openedEncryptedBoxIDs)+1)
	stores = append(stores, "")
	stores = append(stores, openedEncryptedBoxIDs...)

	candidates := make([]updatedRecentDoc, 0, len(stores)*limit)
	seen := make(map[string]bool, len(stores)*limit)
	for _, contentStore := range stores {
		blocks := sql.SelectBlocksRawStmtInBox("SELECT * FROM blocks WHERE type = 'd' ORDER BY updated DESC", 1, limit, contentStore)
		for _, block := range blocks {
			bt := treenode.GetBlockTreeInBox(block.ID, contentStore)
			if bt == nil || bt.BoxID != block.Box || (contentStore != "" && bt.BoxID != contentStore) || (contentStore == "" && IsEncryptedBox(bt.BoxID)) {
				continue
			}
			key := recentDocIdentityKey(block.ID, bt.BoxID)
			if seen[key] {
				continue
			}
			seen[key] = true
			icon := ""
			if block.IAL != "" {
				ialStr := strings.TrimSuffix(strings.TrimPrefix(block.IAL, "{:"), "}")
				for _, kv := range parse.Tokens2IAL([]byte(ialStr)) {
					if kv[0] == "icon" {
						icon = kv[1]
						break
					}
				}
			}
			candidates = append(candidates, updatedRecentDoc{
				doc: &RecentDoc{
					RootID:     block.ID,
					NotebookID: bt.BoxID,
					Icon:       icon,
					Title:      path.Base(bt.HPath),
				},
				updated: block.Updated,
			})
		}
	}

	sort.Slice(candidates, func(i, j int) bool {
		if candidates[i].updated != candidates[j].updated {
			return candidates[i].updated > candidates[j].updated
		}
		if candidates[i].doc.NotebookID != candidates[j].doc.NotebookID {
			return candidates[i].doc.NotebookID < candidates[j].doc.NotebookID
		}
		return candidates[i].doc.RootID < candidates[j].doc.RootID
	})
	if len(candidates) > limit {
		candidates = candidates[:limit]
	}
	ret := make([]*RecentDoc, 0, len(candidates))
	for _, candidate := range candidates {
		ret = append(ret, candidate.doc)
	}
	return ret
}

// normalizeRecentDocs 规范化最近文档列表：去重并按类型截取配置的最大数量记录。
func normalizeRecentDocs(recentDocs []*RecentDoc) []*RecentDoc {
	maxCount := Conf.FileTree.RecentDocsMaxListCount

	// 去重
	seen := make(map[string]struct{}, len(recentDocs))
	deduplicated := make([]*RecentDoc, 0, len(recentDocs))
	legacyDocs := make([]*RecentDoc, 0)
	for _, doc := range recentDocs {
		if doc == nil {
			continue
		}
		if doc.NotebookID == "" {
			key := recentDocIdentityKey(doc.RootID, "")
			if _, ok := seen[key]; !ok {
				seen[key] = struct{}{}
				deduplicated = append(deduplicated, doc)
				legacyDocs = append(legacyDocs, doc)
			}
			continue
		}
		if !ast.IsNodeIDPattern(doc.RootID) || !ast.IsNodeIDPattern(doc.NotebookID) {
			continue
		}
		key := recentDocIdentityKey(doc.RootID, doc.NotebookID)
		if _, ok := seen[key]; !ok {
			seen[key] = struct{}{}
			deduplicated = append(deduplicated, doc)
		}
	}

	if len(deduplicated) <= maxCount {
		return deduplicated
	}

	// 分别统计三种类型的记录
	var viewedDocs []*RecentDoc
	var openedDocs []*RecentDoc
	var closedDocs []*RecentDoc

	for _, doc := range deduplicated {
		if doc.NotebookID == "" {
			continue
		}
		if doc.ViewedAt > 0 {
			viewedDocs = append(viewedDocs, doc)
		}
		if doc.OpenAt > 0 {
			openedDocs = append(openedDocs, doc)
		}
		if doc.ClosedAt > 0 {
			closedDocs = append(closedDocs, doc)
		}
	}

	// 分别按时间排序并截取配置的最大数量记录
	if len(viewedDocs) > maxCount {
		sort.Slice(viewedDocs, func(i, j int) bool {
			return viewedDocs[i].ViewedAt > viewedDocs[j].ViewedAt
		})
		viewedDocs = viewedDocs[:maxCount]
	}
	if len(openedDocs) > maxCount {
		sort.Slice(openedDocs, func(i, j int) bool {
			return openedDocs[i].OpenAt > openedDocs[j].OpenAt
		})
		openedDocs = openedDocs[:maxCount]
	}
	if len(closedDocs) > maxCount {
		sort.Slice(closedDocs, func(i, j int) bool {
			return closedDocs[i].ClosedAt > closedDocs[j].ClosedAt
		})
		closedDocs = closedDocs[:maxCount]
	}

	// 合并三类记录
	docMap := make(map[string]*RecentDoc, maxCount*2)
	for _, doc := range viewedDocs {
		docMap[recentDocIdentityKey(doc.RootID, doc.NotebookID)] = doc
	}
	for _, doc := range openedDocs {
		key := recentDocIdentityKey(doc.RootID, doc.NotebookID)
		if _, ok := docMap[key]; !ok {
			docMap[key] = doc
		}
	}
	for _, doc := range closedDocs {
		key := recentDocIdentityKey(doc.RootID, doc.NotebookID)
		if _, ok := docMap[key]; !ok {
			docMap[key] = doc
		}
	}

	result := make([]*RecentDoc, 0, len(docMap))
	for _, doc := range docMap {
		result = append(result, doc)
	}
	result = append(result, legacyDocs...)

	return result
}

func setRecentDocs(recentDocs []*RecentDoc) (err error) {
	recentDocs = normalizeRecentDocs(recentDocs)

	dirPath := filepath.Join(util.DataDir, "storage")
	if err = os.MkdirAll(dirPath, 0755); err != nil {
		logging.LogErrorf("create storage [recent-doc] dir failed: %s", err)
		return
	}

	records := make([]recentDocRecord, 0, len(recentDocs))
	for _, doc := range recentDocs {
		records = append(records, recentDocRecord{
			RootID:     doc.RootID,
			NotebookID: doc.NotebookID,
			ViewedAt:   doc.ViewedAt,
			ClosedAt:   doc.ClosedAt,
			OpenAt:     doc.OpenAt,
		})
	}
	data, err := gulu.JSON.MarshalIndentJSON(records, "", "  ")
	if err != nil {
		logging.LogErrorf("marshal storage [recent-doc] failed: %s", err)
		return
	}

	lsPath := filepath.Join(dirPath, "recent-doc.json")
	err = filelock.WriteFile(lsPath, data)
	if err != nil {
		logging.LogErrorf("write storage [recent-doc] failed: %s", err)
		return
	}
	return
}

var refUsedLock = sync.Mutex{}

// refUsedMaxCount 限制最近引用记录的最大条数，超出时淘汰最旧的记录，防止文件无限膨胀。
const refUsedMaxCount = 512

// TouchRefUsed 在用户真实插入引用时刷新目标块的最近引用时间。该时间独立于 refs 表的重建机制，
// 仅在事务处理（真实编辑）时写入，用于稳定块引"最近引用"排序。
func TouchRefUsed(defBlockIDs []string) {
	if 1 > len(defBlockIDs) {
		return
	}

	refUsedLock.Lock()
	defer refUsedLock.Unlock()

	used := loadRefUsed()
	now := time.Now().Unix()
	for _, defBlockID := range defBlockIDs {
		used[defBlockID] = now
	}
	if refUsedMaxCount < len(used) {
		// 超出上限时按时间戳淘汰最旧的记录
		type entry struct {
			id string
			ts int64
		}
		entries := make([]entry, 0, len(used))
		for id, ts := range used {
			entries = append(entries, entry{id, ts})
		}
		sort.Slice(entries, func(i, j int) bool {
			return entries[i].ts > entries[j].ts
		})
		used = map[string]int64{}
		for i := 0; i < refUsedMaxCount && i < len(entries); i++ {
			used[entries[i].id] = entries[i].ts
		}
	}
	setRefUsed(used)
}

// GetRefUsed 返回目标块→最近引用时间戳映射，供块引排序使用。
func GetRefUsed() (ret map[string]int64) {
	refUsedLock.Lock()
	defer refUsedLock.Unlock()
	ret = loadRefUsed()
	return
}

func loadRefUsed() (ret map[string]int64) {
	ret = map[string]int64{}
	dataPath := filepath.Join(util.DataDir, "storage/ref-used.json")
	if !filelock.IsExist(dataPath) {
		return
	}

	data, err := filelock.ReadFile(dataPath)
	if err != nil {
		logging.LogErrorf("read storage [ref-used] failed: %s", err)
		return
	}

	if err = gulu.JSON.UnmarshalJSON(data, &ret); err != nil {
		logging.LogErrorf("unmarshal storage [ref-used] failed: %s", err)
		ret = map[string]int64{}
		return
	}
	return
}

func setRefUsed(used map[string]int64) (err error) {
	dirPath := filepath.Join(util.DataDir, "storage")
	if err = os.MkdirAll(dirPath, 0755); err != nil {
		logging.LogErrorf("create storage [ref-used] dir failed: %s", err)
		return
	}

	data, err := gulu.JSON.MarshalIndentJSON(used, "", "  ")
	if err != nil {
		logging.LogErrorf("marshal storage [ref-used] failed: %s", err)
		return
	}

	dataPath := filepath.Join(dirPath, "ref-used.json")
	err = filelock.WriteFile(dataPath, data)
	if err != nil {
		logging.LogErrorf("write storage [ref-used] failed: %s", err)
		return
	}
	return
}

type OutlineDoc struct {
	DocID string         `json:"docID"`
	Data  map[string]any `json:"data"`
}

var outlineStorageLock = sync.Mutex{}

func GetOutlineStorage(docID string) (ret map[string]any, err error) {
	outlineStorageLock.Lock()
	defer outlineStorageLock.Unlock()

	ret = map[string]any{}
	outlineDocs, err := getOutlineDocs()
	if err != nil {
		return
	}

	for _, doc := range outlineDocs {
		if doc.DocID == docID {
			ret = doc.Data
			break
		}
	}
	return
}

func SetOutlineStorage(docID string, val map[string]any) (err error) {
	outlineStorageLock.Lock()
	defer outlineStorageLock.Unlock()

	outlineDoc := &OutlineDoc{
		DocID: docID,
		Data:  val,
	}

	outlineDocs, err := getOutlineDocs()
	if err != nil {
		return
	}

	// 如果文档已存在，先移除旧的
	for i, doc := range outlineDocs {
		if doc.DocID == docID {
			outlineDocs = append(outlineDocs[:i], outlineDocs[i+1:]...)
			break
		}
	}

	// 将新的文档信息添加到最前面
	outlineDocs = append([]*OutlineDoc{outlineDoc}, outlineDocs...)

	// 限制为2000个文档
	if 2000 < len(outlineDocs) {
		outlineDocs = outlineDocs[:2000]
	}

	err = setOutlineDocs(outlineDocs)
	return
}

func RemoveOutlineStorage(docID string) (err error) {
	outlineStorageLock.Lock()
	defer outlineStorageLock.Unlock()

	outlineDocs, err := getOutlineDocs()
	if err != nil {
		return
	}

	for i, doc := range outlineDocs {
		if doc.DocID == docID {
			outlineDocs = append(outlineDocs[:i], outlineDocs[i+1:]...)
			break
		}
	}

	err = setOutlineDocs(outlineDocs)
	return
}

func setOutlineDocs(outlineDocs []*OutlineDoc) (err error) {
	dirPath := filepath.Join(util.DataDir, "storage")
	if err = os.MkdirAll(dirPath, 0755); err != nil {
		logging.LogErrorf("create storage [outline] dir failed: %s", err)
		return
	}

	data, err := gulu.JSON.MarshalJSON(outlineDocs)
	if err != nil {
		logging.LogErrorf("marshal storage [outline] failed: %s", err)
		return
	}

	lsPath := filepath.Join(dirPath, "outline.json")
	err = filelock.WriteFile(lsPath, data)
	if err != nil {
		logging.LogErrorf("write storage [outline] failed: %s", err)
		return
	}
	return
}

func getOutlineDocs() (ret []*OutlineDoc, err error) {
	ret = []*OutlineDoc{}
	dataPath := filepath.Join(util.DataDir, "storage/outline.json")
	if !filelock.IsExist(dataPath) {
		return
	}

	data, err := filelock.ReadFile(dataPath)
	if err != nil {
		logging.LogErrorf("read storage [outline] failed: %s", err)
		return
	}

	if err = gulu.JSON.UnmarshalJSON(data, &ret); err != nil {
		logging.LogErrorf("unmarshal storage [outline] failed: %s", err)
		return
	}
	return
}
