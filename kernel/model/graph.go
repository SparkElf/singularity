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
	"bytes"
	"math"
	"strings"
	"unicode/utf8"

	"github.com/88250/gulu"
	"github.com/88250/lute/ast"
	"github.com/88250/lute/html"
	"github.com/88250/lute/parse"
	"github.com/siyuan-note/logging"
	"github.com/siyuan-note/siyuan/kernel/conf"
	"github.com/siyuan-note/siyuan/kernel/sql"
	"github.com/siyuan-note/siyuan/kernel/treenode"
	"github.com/siyuan-note/siyuan/kernel/util"
)

type GraphNode struct {
	ID         string  `json:"id"`
	Box        string  `json:"box"`
	DocumentID string  `json:"documentId,omitempty"`
	Path       string  `json:"path"`
	Size       float64 `json:"size"`
	Title      string  `json:"title,omitempty"`
	Label      string  `json:"label"`
	Type       string  `json:"type"`
	Refs       int     `json:"refs"`
	Defs       int     `json:"defs"`
}

type GraphLink struct {
	From   string       `json:"from"`
	To     string       `json:"to"`
	Ref    bool         `json:"ref"`
	Arrows *GraphArrows `json:"arrows"`
}

type GraphArrows struct {
	To *GraphArrowsTo `json:"to"`
}

type GraphArrowsTo struct {
	Enabled bool `json:"enabled"`
}

func BuildTreeGraph(id, query string) (boxID string, nodes []*GraphNode, links []*GraphLink) {
	return buildTreeGraphInBox(id, query, "", Conf.Graph.Local)
}

// BuildTreeGraphInBox从显式选择的内容库解析图谱根节点；每个可导航节点仍携带自身源Box和DocumentID，
// 不把根节点身份复制到关联节点。
func BuildTreeGraphInBox(id, query, notebookID string) (boxID string, nodes []*GraphNode, links []*GraphLink) {
	return buildTreeGraphInBox(id, query, notebookID, Conf.Graph.Local)
}

// BuildTreeGraphInBoxWithConfig使用调用方本次请求的局部图配置，不读写共享配置。
func BuildTreeGraphInBoxWithConfig(id, query, notebookID string, local *conf.LocalGraph) (boxID string, nodes []*GraphNode, links []*GraphLink) {
	return buildTreeGraphInBox(id, query, notebookID, local)
}

func buildTreeGraphInBox(id, query, notebookID string, local *conf.LocalGraph) (boxID string, nodes []*GraphNode, links []*GraphLink) {
	nodes = []*GraphNode{}
	links = []*GraphLink{}

	tree, err := LoadTreeByBlockIDInBox(id, notebookID)
	if err != nil {
		return
	}
	node := treenode.GetNodeInTree(tree, id)
	if nil == node {
		return
	}
	sqlBlock := sql.BuildBlockFromNode(node, tree)
	boxID = sqlBlock.Box
	block := fromSQLBlock(sqlBlock, "", 0)

	stmt := query2Stmt(query)
	stmt += graphTypeFilter(local.TypeFilter)
	stmt += graphDailyNoteFilter(local.DailyNote)
	stmt = strings.ReplaceAll(stmt, "content", "ref.content")
	forwardlinks, backlinks := buildFullLinks(stmt)

	var sqlBlocks []*sql.Block
	var rootID string
	if ast.NodeDocument == node.Type {
		sqlBlocks = sql.GetAllChildBlocks([]string{block.ID}, stmt, Conf.Graph.MaxBlocks)
		rootID = block.ID
	} else {
		sqlBlocks = sql.GetChildBlocks(block.ID, stmt, Conf.Graph.MaxBlocks)
	}
	blocks := fromSQLBlocks(&sqlBlocks, "", 0)
	if "" != rootID {
		// 局部关系图中添加文档链接关系 https://github.com/siyuan-note/siyuan/issues/4996
		rootBlock := getBlockIn(blocks, rootID)
		if nil != rootBlock {
			// 按引用处理
			sqlRootDefs := sql.QueryDefRootBlocksByRefRootID(rootID)
			rootDefBlocks := fromSQLBlocks(&sqlRootDefs, "", 0)
			var rootIDs []string
			for _, rootDef := range rootDefBlocks {
				blocks = append(blocks, rootDef)
				rootIDs = append(rootIDs, rootDef.ID)
			}

			sqlRefBlocks := sql.QueryRefRootBlocksByDefRootIDs(rootIDs)
			for defRootID, sqlRefBs := range sqlRefBlocks {
				rootB := getBlockIn(rootDefBlocks, defRootID)
				if nil == rootB {
					continue
				}

				blocks = append(blocks, rootB)
				refBlocks := fromSQLBlocks(&sqlRefBs, "", 0)
				rootB.Refs = append(rootB.Refs, refBlocks...)
				blocks = append(blocks, refBlocks...)
			}

			// 按定义处理
			blocks = append(blocks, rootBlock)
			sqlRefBlocks = sql.QueryRefRootBlocksByDefRootIDs([]string{rootID})

			// 关系图日记过滤失效 https://github.com/siyuan-note/siyuan/issues/7547
			dailyNotesPaths := dailyNotePaths(local.DailyNote)
			for _, sqlRefBs := range sqlRefBlocks {
				refBlocks := fromSQLBlocks(&sqlRefBs, "", 0)

				if 0 < len(dailyNotesPaths) {
					isDailyNote := false
					var tmp []*Block
					for _, refBlock := range refBlocks {
						for _, dailyNotePath := range dailyNotesPaths {
							if strings.HasPrefix(refBlock.HPath, dailyNotePath) {
								isDailyNote = true
								break
							}
						}

						if !isDailyNote {
							tmp = append(tmp, refBlock)
						}
					}
					refBlocks = tmp
				}

				rootBlock.Refs = append(rootBlock.Refs, refBlocks...)
				blocks = append(blocks, refBlocks...)
			}
		}
	}

	blocks = filterDailyNote(blocks, local.DailyNote)
	genTreeNodes(blocks, &nodes, &links, local.NodeSize)
	growTreeGraph(&forwardlinks, &backlinks, &nodes, local.NodeSize)
	blocks = append(blocks, forwardlinks...)
	blocks = append(blocks, backlinks...)
	buildLinks(&blocks, &links, local.Arrow)
	if local.Tag {
		p := sqlBlock.Path
		linkTagBlocks(&blocks, &nodes, &links, p, local.NodeSize)
	}
	markLinkedNodes(&nodes, &links, local.NodeSize)
	nodes = removeDuplicatedUnescape(nodes)
	return
}

func BuildGraph(query string) (boxID string, nodes []*GraphNode, links []*GraphLink) {
	nodes = []*GraphNode{}
	links = []*GraphLink{}

	stmt := query2Stmt(query)
	stmt = strings.TrimPrefix(stmt, "select * from blocks where")
	stmt += graphTypeFilter(Conf.Graph.Global.TypeFilter)
	stmt += graphDailyNoteFilter(Conf.Graph.Global.DailyNote)
	stmt = strings.ReplaceAll(stmt, "content", "ref.content")
	forwardlinks, backlinks := buildFullLinks(stmt)

	var blocks []*Block
	roots := sql.GetAllRootBlocks()
	if 0 < len(roots) {
		boxID = roots[0].Box
	}
	var rootIDs []string
	for _, root := range roots {
		rootIDs = append(rootIDs, root.ID)
	}
	rootIDs = gulu.Str.RemoveDuplicatedElem(rootIDs)

	sqlBlocks := sql.GetAllChildBlocks(rootIDs, stmt, Conf.Graph.MaxBlocks)
	treeBlocks := fromSQLBlocks(&sqlBlocks, "", 0)
	treeBlocks = filterDailyNote(treeBlocks, Conf.Graph.Global.DailyNote)
	genTreeNodes(treeBlocks, &nodes, &links, Conf.Graph.Global.NodeSize)
	blocks = append(blocks, treeBlocks...)

	// 文档块关联
	sqlRootRefBlocks := sql.QueryRefRootBlocksByDefRootIDs(rootIDs)
	for defRootID, sqlRefBlocks := range sqlRootRefBlocks {
		rootBlock := getBlockIn(treeBlocks, defRootID)
		if nil == rootBlock {
			continue
		}

		refBlocks := fromSQLBlocks(&sqlRefBlocks, "", 0)
		rootBlock.Refs = append(rootBlock.Refs, refBlocks...)
	}

	growTreeGraph(&forwardlinks, &backlinks, &nodes, Conf.Graph.Global.NodeSize)
	blocks = append(blocks, forwardlinks...)
	blocks = append(blocks, backlinks...)
	buildLinks(&blocks, &links, Conf.Graph.Global.Arrow)
	if Conf.Graph.Global.Tag {
		linkTagBlocks(&blocks, &nodes, &links, "", Conf.Graph.Global.NodeSize)
	}
	markLinkedNodes(&nodes, &links, Conf.Graph.Global.NodeSize)
	pruneUnref(&nodes, &links)
	nodes = removeDuplicatedUnescape(nodes)
	return
}

func linkTagBlocks(blocks *[]*Block, nodes *[]*GraphNode, links *[]*GraphLink, p string, nodeSize float64) {
	tagSpans := sql.QueryTagSpans(p)
	if 1 > len(tagSpans) {
		return
	}

	isGlobal := "" == p

	// 构造标签节点
	var tagNodes []*GraphNode
	for _, tagSpan := range tagSpans {
		if nil == tagNodeIn(tagNodes, tagSpan.Content) {
			node := &GraphNode{
				ID:    tagSpan.Content,
				Label: tagSpan.Content,
				Size:  nodeSize,
				Type:  tagSpan.Type,
			}
			*nodes = append(*nodes, node)
			tagNodes = append(tagNodes, node)
		}
	}

	// 连接标签和块
	for _, block := range *blocks {
		for _, tagSpan := range tagSpans {
			if isGlobal { // 全局关系图将标签链接到文档块上
				if block.RootID == tagSpan.RootID { // 局部关系图将标签链接到子块上
					*links = append(*links, &GraphLink{
						From: tagSpan.Content,
						To:   block.RootID,
					})
				}
			} else {
				if block.ID == tagSpan.BlockID { // 局部关系图将标签链接到子块上
					*links = append(*links, &GraphLink{
						From: tagSpan.Content,
						To:   block.ID,
					})
				}
			}
		}
	}

	// 连接层级标签
	for _, tagNode := range tagNodes {
		ids := strings.Split(tagNode.ID, "/")
		if 2 > len(ids) {
			continue
		}

		for _, targetID := range ids[:len(ids)-1] {
			if targetTag := tagNodeIn(tagNodes, targetID); nil != targetTag {

				*links = append(*links, &GraphLink{
					From: tagNode.ID,
					To:   targetID,
				})
			}
		}
	}
}

func tagNodeIn(tagNodes []*GraphNode, content string) *GraphNode {
	for _, tagNode := range tagNodes {
		if tagNode.Label == content {
			return tagNode
		}
	}
	return nil
}

func growTreeGraph(forwardlinks, backlinks *[]*Block, nodes *[]*GraphNode, nodeSize float64) {
	forwardDepth, backDepth := 0, 0
	growLinkedNodes(forwardlinks, backlinks, nodes, nodes, &forwardDepth, &backDepth, nodeSize)
}

func growLinkedNodes(forwardlinks, backlinks *[]*Block, nodes, all *[]*GraphNode, forwardDepth, backDepth *int, nodeSize float64) {
	if 1 > len(*nodes) {
		return
	}

	forwardGeneration := &[]*GraphNode{}
	if 16 > *forwardDepth {
		for _, ref := range *forwardlinks {
			for _, node := range *nodes {
				if node.ID == ref.ID {
					var defs []*Block
					for _, refDef := range ref.Defs {
						if existNodes(all, refDef.ID) || existNodes(forwardGeneration, refDef.ID) || existNodes(nodes, refDef.ID) {
							continue
						}
						defs = append(defs, refDef)
					}

					for _, refDef := range defs {
						defNode := &GraphNode{
							ID:         refDef.ID,
							Box:        refDef.Box,
							DocumentID: refDef.RootID,
							Path:       refDef.Path,
							Size:       nodeSize,
							Type:       refDef.Type,
						}
						nodeTitleLabel(defNode, nodeContentByBlock(refDef))
						*forwardGeneration = append(*forwardGeneration, defNode)
					}
				}
			}
		}
	}

	backGeneration := &[]*GraphNode{}
	if 16 > *backDepth {
		for _, def := range *backlinks {
			for _, node := range *nodes {
				if node.ID == def.ID {
					for _, ref := range def.Refs {
						if existNodes(all, ref.ID) || existNodes(backGeneration, ref.ID) || existNodes(nodes, ref.ID) {
							continue
						}

						refNode := &GraphNode{
							ID:         ref.ID,
							Box:        ref.Box,
							DocumentID: ref.RootID,
							Path:       ref.Path,
							Size:       nodeSize,
							Type:       ref.Type,
						}
						nodeTitleLabel(refNode, nodeContentByBlock(ref))
						*backGeneration = append(*backGeneration, refNode)
					}
				}
			}
		}
	}

	generation := &[]*GraphNode{}
	*generation = append(*generation, *forwardGeneration...)
	*generation = append(*generation, *backGeneration...)
	*forwardDepth++
	*backDepth++
	growLinkedNodes(forwardlinks, backlinks, generation, nodes, forwardDepth, backDepth, nodeSize)
	*nodes = append(*nodes, *generation...)
}

func existNodes(nodes *[]*GraphNode, id string) bool {
	for _, node := range *nodes {
		if node.ID == id {
			return true
		}
	}
	return false
}

func buildLinks(defs *[]*Block, links *[]*GraphLink, arrow bool) {
	for _, def := range *defs {
		for _, ref := range def.Refs {
			link := &GraphLink{
				From: ref.ID,
				To:   def.ID,
				Ref:  true,
			}
			if arrow {
				link.Arrows = &GraphArrows{To: &GraphArrowsTo{Enabled: true}}
			}
			*links = append(*links, link)
		}
	}
}

func genTreeNodes(blocks []*Block, nodes *[]*GraphNode, links *[]*GraphLink, nodeSize float64) {
	for _, block := range blocks {
		node := &GraphNode{
			ID:         block.ID,
			Box:        block.Box,
			DocumentID: block.RootID,
			Path:       block.Path,
			Type:       block.Type,
			Size:       nodeSize,
		}
		nodeTitleLabel(node, nodeContentByBlock(block))
		*nodes = append(*nodes, node)

		*links = append(*links, &GraphLink{
			From: block.ParentID,
			To:   block.ID,
			Ref:  false,
		})
	}
}

func markLinkedNodes(nodes *[]*GraphNode, links *[]*GraphLink, nodeSize float64) {
	tmpLinks := (*links)[:0]
	for _, link := range *links {
		var sourceFound, targetFound bool
		for _, node := range *nodes {
			if link.To == node.ID {
				if link.Ref {
					size := nodeSize
					node.Defs++
					size = math.Log2(float64(node.Defs))*nodeSize + nodeSize
					node.Size = size
				}
				targetFound = true
			} else if link.From == node.ID {
				node.Refs++
				sourceFound = true
			}
			if targetFound && sourceFound {
				break
			}
		}
		if sourceFound && targetFound {
			tmpLinks = append(tmpLinks, link)
		}
	}
	*links = tmpLinks
}

func removeDuplicatedUnescape(nodes []*GraphNode) (ret []*GraphNode) {
	m := map[string]*GraphNode{}
	for _, n := range nodes {
		if nil == m[n.ID] {
			n.Title = html.UnescapeString(n.Title)
			n.Label = html.UnescapeString(n.Label)
			ret = append(ret, n)
			m[n.ID] = n
		}
	}
	return ret
}

func pruneUnref(nodes *[]*GraphNode, links *[]*GraphLink) {
	maxBlocks := Conf.Graph.MaxBlocks
	tmpNodes := (*nodes)[:0]
	for _, node := range *nodes {
		if 0 == Conf.Graph.Global.MinRefs {
			tmpNodes = append(tmpNodes, node)
		} else {
			if Conf.Graph.Global.MinRefs <= node.Refs {
				tmpNodes = append(tmpNodes, node)
				continue
			}

			if Conf.Graph.Global.MinRefs <= node.Defs {
				tmpNodes = append(tmpNodes, node)
				continue
			}
		}

		if maxBlocks < len(tmpNodes) {
			logging.LogWarnf("exceeded the maximum number of render nodes [%d]", maxBlocks)
			break
		}
	}
	*nodes = tmpNodes

	tmpLinks := (*links)[:0]
	for _, link := range *links {
		var sourceFound, targetFound bool
		for _, node := range *nodes {
			if link.To == node.ID {
				targetFound = true
			} else if link.From == node.ID {
				sourceFound = true
			}
		}
		if sourceFound && targetFound {
			tmpLinks = append(tmpLinks, link)
		}
	}
	*links = tmpLinks
}

func nodeContentByBlock(block *Block) (ret string) {
	if ret = block.Name; "" != ret {
		return
	}
	ret = block.Content
	if maxLen := 48; maxLen < utf8.RuneCountInString(ret) {
		ret = gulu.Str.SubStr(ret, maxLen) + "..."
	}
	return
}

func graphTypeFilter(typeFilter *conf.TypeFilter) string {
	var inList []string

	if typeFilter.Paragraph {
		inList = append(inList, "'p'")
	}

	if typeFilter.Heading {
		inList = append(inList, "'h'")
	}

	if typeFilter.Math {
		inList = append(inList, "'m'")
	}

	if typeFilter.Code {
		inList = append(inList, "'c'")
	}

	if typeFilter.Table {
		inList = append(inList, "'t'")
	}

	if typeFilter.List {
		inList = append(inList, "'l'")
	}

	if typeFilter.ListItem {
		inList = append(inList, "'i'")
	}

	if typeFilter.Blockquote {
		inList = append(inList, "'b'")
	}

	if typeFilter.Super {
		inList = append(inList, "'s'")
	}

	if typeFilter.Callout {
		inList = append(inList, "'callout'")
	}

	inList = append(inList, "'d'")
	return " AND ref.type IN (" + strings.Join(inList, ",") + ")"
}

func filterDailyNote(blocks []*Block, includeDailyNote bool) (ret []*Block) {
	// Graph dailynote filtering not working https://github.com/siyuan-note/siyuan/issues/16463

	if includeDailyNote {
		ret = blocks
		return
	}

	for _, block := range blocks {
		isDailyNote := false
		for k := range block.IAL {
			isDailyNote = strings.HasPrefix(k, DailyNoteAttrPrefix)
			if isDailyNote {
				break
			}
		}
		if !isDailyNote {
			ret = append(ret, block)
		}
	}
	return
}

func graphDailyNoteFilter(includeDailyNote bool) string {
	dailyNotesPaths := dailyNotePaths(includeDailyNote)
	if 1 > len(dailyNotesPaths) {
		return ""
	}

	buf := bytes.Buffer{}
	for _, p := range dailyNotesPaths {
		buf.WriteString(" AND ref.hpath NOT LIKE '" + p + "%'")
	}
	return buf.String()
}

func dailyNotePaths(includeDailyNote bool) (ret []string) {
	if includeDailyNote {
		return
	}

	for _, box := range Conf.GetOpenedBoxes() {
		boxConf := box.GetConf()
		if 1 < strings.Count(boxConf.DailyNoteSavePath, "/") {
			dailyNoteSaveDir := strings.Split(boxConf.DailyNoteSavePath, "/")[1]
			ret = append(ret, "/"+dailyNoteSaveDir)
		}
	}
	ret = gulu.Str.RemoveDuplicatedElem(ret)
	return
}

func nodeTitleLabel(node *GraphNode, blockContent string) {
	if "NodeDocument" != node.Type && "NodeHeading" != node.Type {
		node.Title = blockContent
	} else {
		node.Label = blockContent
	}
}

func query2Stmt(queryStr string) (ret string) {
	buf := bytes.Buffer{}
	if ast.IsNodeIDPattern(queryStr) {
		buf.WriteString("id = '" + queryStr + "'")
	} else {
		var tags []string
		luteEngine := util.NewLute()
		t := parse.Inline("", []byte(queryStr), luteEngine.ParseOptions)
		ast.Walk(t.Root, func(n *ast.Node, entering bool) ast.WalkStatus {
			if !entering {
				return ast.WalkContinue
			}
			if n.IsTextMarkType("tag") {
				tags = append(tags, n.Text())
			}
			return ast.WalkContinue
		})

		for _, tag := range tags {
			queryStr = strings.ReplaceAll(queryStr, "#"+tag+"#", "")
		}
		parts := strings.Fields(queryStr)

		for i, part := range parts {
			part = strings.ReplaceAll(part, "'", "''")
			buf.WriteString("(content LIKE '%" + part + "%'")
			buf.WriteString(Conf.Search.NAMFilter(part))
			buf.WriteString(")")
			if i < len(parts)-1 {
				buf.WriteString(" AND ")
			}
		}

		if 0 < len(tags) {
			escapedTags := make([]string, len(tags))
			for i, tag := range tags {
				escapedTags[i] = strings.ReplaceAll(tag, "'", "''")
			}
			if 0 < buf.Len() {
				buf.WriteString(" OR ")
			}
			for i, tag := range escapedTags {
				buf.WriteString("(content LIKE '%#" + tag + "#%')")
				if i < len(escapedTags)-1 {
					buf.WriteString(" AND ")
				}
			}
			buf.WriteString(" OR ")
			for i, tag := range escapedTags {
				buf.WriteString("ial LIKE '%tags=\"%" + tag + "%\"%'")
				if i < len(escapedTags)-1 {
					buf.WriteString(" AND ")
				}
			}
		}
	}
	if 1 > buf.Len() {
		buf.WriteString("1=1")
	}
	ret = buf.String()
	return
}
