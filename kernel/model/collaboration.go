package model

import (
	"fmt"
	"html"
	"strings"
	"time"

	"github.com/88250/lute/ast"
	"github.com/siyuan-note/siyuan/kernel/treenode"
	"github.com/siyuan-note/siyuan/kernel/util"
)

// CollaborationOperationInput 是协作桥接层交给 Kernel 的最小语义输入，不携带 HTTP、ACL 或会话状态。
type CollaborationOperationInput struct {
	NotebookID          string
	DocumentID          string
	BlockID             string
	ParentBlockID       string
	Index               int
	Position            int
	From                int
	To                  int
	Text                string
	BlockType           string
	Content             string
	ReferenceBlockID    string
	ReferenceDocumentID string
	ReferenceNotebookID string
	EmbedType           string
	AttributeViewID     string
	RowID               string
	ColumnID            string
	Value               any
	OperationKind       string
}

// ApplyCollaborationOperation 把已通过协作协议和冲突预演的操作转换为真实 Kernel transaction。
// 只有 transaction 完整提交后才返回 nil；不支持安全转换的语义必须显式失败，不能修改正文后再伪造成功。
func ApplyCollaborationOperation(input CollaborationOperationInput) error {
	if input.NotebookID == "" || input.DocumentID == "" {
		return fmt.Errorf("collaboration content identity is incomplete")
	}
	storeBoxID := TransactionNotebookForBox(input.NotebookID)
	if input.OperationKind != "block.insert" && input.OperationKind != "attribute-view.cell-set" {
		if input.BlockID == "" {
			return fmt.Errorf("collaboration block identity is incomplete")
		}
		if err := ensureCollaborationBlock(input.DocumentID, input.BlockID, storeBoxID); err != nil {
			return err
		}
	}
	tx := &Transaction{Notebook: storeBoxID, Timestamp: time.Now().UnixMilli()}
	var operation *Operation
	switch input.OperationKind {
	case "block.insert":
		parentID := input.ParentBlockID
		if parentID == "" {
			parentID = input.DocumentID
		}
		if err := ensureCollaborationParent(input.DocumentID, parentID, storeBoxID); err != nil {
			return err
		}
		previousID, err := collaborationPreviousBlock(parentID, input.BlockID, input.Index, storeBoxID)
		if err != nil {
			return err
		}
		operation = &Operation{
			Action: "insert", ID: input.BlockID, ParentID: parentID, PreviousID: previousID,
			Data: collaborationBlockDOM(input.BlockID, input.BlockType, input.Content),
		}
		tx.UndoOperations = []*Operation{{Action: "delete", ID: input.BlockID}}
	case "block.delete":
		inverse, err := collaborationDeleteInverse(input.BlockID, storeBoxID)
		if err != nil {
			return err
		}
		operation = &Operation{Action: "delete", ID: input.BlockID}
		tx.UndoOperations = []*Operation{inverse}
	case "block.move":
		inverse, err := collaborationMoveInverse(input.BlockID, storeBoxID)
		if err != nil {
			return err
		}
		parentID := input.ParentBlockID
		if parentID == "" {
			parentID = input.DocumentID
		}
		if err := ensureCollaborationParent(input.DocumentID, parentID, storeBoxID); err != nil {
			return err
		}
		previousID, err := collaborationPreviousBlock(parentID, input.BlockID, input.Index, storeBoxID)
		if err != nil {
			return err
		}
		operation = &Operation{Action: "move", ID: input.BlockID, ParentID: parentID, PreviousID: previousID}
		tx.UndoOperations = []*Operation{inverse}
	case "text.insert", "text.delete":
		return applyCollaborationTextOperation(tx, input)
	case "reference.update":
		return applyCollaborationReferenceOperation(tx, input)
	case "embed.update":
		return applyCollaborationEmbedOperation(tx, input)
	case "attribute-view.cell-set":
		if input.AttributeViewID == "" || input.RowID == "" || input.ColumnID == "" {
			return fmt.Errorf("attribute-view cell identity is incomplete")
		}
		tx.DoOperations = []*Operation{{
			Action: "updateAttrViewCell", AvID: input.AttributeViewID,
			KeyID: input.ColumnID, RowID: input.RowID, Data: input.Value,
		}}
	default:
		return fmt.Errorf("unsupported collaboration operation kind %q", input.OperationKind)
	}
	if input.OperationKind == "attribute-view.cell-set" {
		if err := PerformTxSync(tx); err != nil {
			return fmt.Errorf("apply collaboration attribute-view transaction: %w", err)
		}
		return nil
	}
	tx.DoOperations = []*Operation{operation}
	if len(tx.UndoOperations) > 0 {
		tx.MarkFromAPI()
	}
	if err := PerformTxSync(tx); err != nil {
		return fmt.Errorf("apply collaboration transaction: %w", err)
	}
	return nil
}

func collaborationDeleteInverse(blockID, boxID string) (*Operation, error) {
	tree, err := LoadTreeByBlockIDInBox(blockID, boxID)
	if err != nil {
		return nil, err
	}
	node := treenode.GetNodeInTree(tree, blockID)
	if node == nil || node.Parent == nil {
		return nil, ErrBlockNotFound
	}
	previousID := ""
	for previous := node.Previous; previous != nil; previous = previous.Previous {
		if previous.IsBlock() {
			previousID = previous.ID
			break
		}
	}
	lute := util.NewLute()
	return &Operation{
		Action: "insert", ID: blockID, ParentID: node.Parent.ID, PreviousID: previousID,
		Data: lute.RenderNodeBlockDOM(node),
	}, nil
}

func collaborationMoveInverse(blockID, boxID string) (*Operation, error) {
	tree, err := LoadTreeByBlockIDInBox(blockID, boxID)
	if err != nil {
		return nil, err
	}
	node := treenode.GetNodeInTree(tree, blockID)
	if node == nil || node.Parent == nil {
		return nil, ErrBlockNotFound
	}
	previousID := ""
	for previous := node.Previous; previous != nil; previous = previous.Previous {
		if previous.IsBlock() {
			previousID = previous.ID
			break
		}
	}
	return &Operation{Action: "move", ID: blockID, ParentID: node.Parent.ID, PreviousID: previousID}, nil
}

// applyCollaborationReferenceOperation 只更新真实 AST 中已有的块引用标记，禁止用 HTML 字符串拼接伪造引用语义。
func applyCollaborationReferenceOperation(tx *Transaction, input CollaborationOperationInput) error {
	dom := GetBlockDOMInBox(input.BlockID, tx.Notebook)
	if dom == "" {
		return ErrBlockNotFound
	}
	tx.UndoOperations = []*Operation{{Action: "update", ID: input.BlockID, Data: dom}}
	lute := util.NewLute()
	tree := lute.BlockDOM2Tree(dom)
	if tree == nil || tree.Root == nil {
		return fmt.Errorf("collaboration reference block DOM is invalid")
	}
	node := treenode.GetNodeInTree(tree, input.BlockID)
	if node == nil {
		return ErrBlockNotFound
	}
	if input.ReferenceBlockID != "" {
		targetTree, err := LoadTreeByBlockIDInBox(input.ReferenceBlockID, TransactionNotebookForBox(input.ReferenceNotebookID))
		if err != nil || targetTree == nil || targetTree.Root == nil || targetTree.Root.ID != input.ReferenceDocumentID || treenode.GetNodeInTree(targetTree, input.ReferenceBlockID) == nil {
			return fmt.Errorf("collaboration reference target %s does not exist", input.ReferenceBlockID)
		}
		if input.ReferenceNotebookID != input.NotebookID && IsBlockRefCrossingBoundary(input.NotebookID, input.ReferenceBlockID) {
			return fmt.Errorf("collaboration reference crosses an encrypted boundary")
		}
	}
	updated := false
	ast.Walk(node, func(candidate *ast.Node, entering bool) ast.WalkStatus {
		if !entering || !treenode.IsBlockRef(candidate) {
			return ast.WalkContinue
		}
		candidate.TextMarkBlockRefID = input.ReferenceBlockID
		candidate.TextMarkBlockRefSubtype = "s"
		updated = true
		return ast.WalkContinue
	})
	if !updated {
		return fmt.Errorf("collaboration reference block has no reference mark")
	}
	tx.DoOperations = []*Operation{{Action: "update", ID: input.BlockID, Data: lute.RenderNodeBlockDOM(node)}}
	tx.MarkFromAPI()
	if err := PerformTxSync(tx); err != nil {
		return fmt.Errorf("apply collaboration reference transaction: %w", err)
	}
	return nil
}

// applyCollaborationEmbedOperation 更新嵌入查询脚本并复用 Kernel update transaction，查询目标始终来自显式 target。
func applyCollaborationEmbedOperation(tx *Transaction, input CollaborationOperationInput) error {
	dom := GetBlockDOMInBox(input.BlockID, tx.Notebook)
	if dom == "" {
		return ErrBlockNotFound
	}
	tx.UndoOperations = []*Operation{{Action: "update", ID: input.BlockID, Data: dom}}
	lute := util.NewLute()
	tree := lute.BlockDOM2Tree(dom)
	if tree == nil || tree.Root == nil {
		return fmt.Errorf("collaboration embed block DOM is invalid")
	}
	node := treenode.GetNodeInTree(tree, input.BlockID)
	if node == nil {
		return ErrBlockNotFound
	}
	var embedScript *ast.Node
	ast.Walk(node, func(candidate *ast.Node, entering bool) ast.WalkStatus {
		if entering && candidate.Type == ast.NodeBlockQueryEmbedScript && embedScript == nil {
			embedScript = candidate
			return ast.WalkStop
		}
		return ast.WalkContinue
	})
	if embedScript == nil {
		return fmt.Errorf("collaboration embed block has no query script")
	}
	if input.ReferenceBlockID == "" {
		embedScript.Tokens = nil
	} else {
		targetTree, err := LoadTreeByBlockIDInBox(input.ReferenceBlockID, TransactionNotebookForBox(input.ReferenceNotebookID))
		if err != nil || targetTree == nil || targetTree.Root == nil || targetTree.Root.ID != input.ReferenceDocumentID || treenode.GetNodeInTree(targetTree, input.ReferenceBlockID) == nil {
			return fmt.Errorf("collaboration embed target %s does not exist", input.ReferenceBlockID)
		}
		if input.ReferenceNotebookID != input.NotebookID && IsBlockRefCrossingBoundary(input.NotebookID, input.ReferenceBlockID) {
			return fmt.Errorf("collaboration embed crosses an encrypted boundary")
		}
		embedScript.Tokens = []byte("select * from blocks where id='" + strings.ReplaceAll(input.ReferenceBlockID, "'", "''") + "'")
	}
	tx.DoOperations = []*Operation{{Action: "update", ID: input.BlockID, Data: lute.RenderNodeBlockDOM(node)}}
	tx.MarkFromAPI()
	if err := PerformTxSync(tx); err != nil {
		return fmt.Errorf("apply collaboration embed transaction: %w", err)
	}
	return nil
}

// applyCollaborationTextOperation 只改写真实块 DOM，再复用 Kernel update transaction，保证正文仍由文件与索引链拥有。
func applyCollaborationTextOperation(tx *Transaction, input CollaborationOperationInput) error {
	dom := GetBlockDOMInBox(input.BlockID, tx.Notebook)
	if dom == "" {
		return ErrBlockNotFound
	}
	tx.UndoOperations = []*Operation{{Action: "update", ID: input.BlockID, Data: dom}}
	lute := util.NewLute()
	tree := lute.BlockDOM2Tree(dom)
	if tree == nil || tree.Root == nil {
		return fmt.Errorf("collaboration block DOM is invalid")
	}
	node := treenode.GetNodeInTree(tree, input.BlockID)
	if node == nil {
		return ErrBlockNotFound
	}
	content := []rune(node.Text())
	if input.OperationKind == "text.insert" {
		if input.Position < 0 || input.Position > len(content) {
			return fmt.Errorf("text insert position is outside the block")
		}
		content = append(content[:input.Position], append([]rune(input.Text), content[input.Position:]...)...)
	} else {
		if input.From < 0 || input.To <= input.From || input.To > len(content) {
			return fmt.Errorf("text delete range is outside the block")
		}
		content = append(content[:input.From], content[input.To:]...)
	}
	var textNodes []*ast.Node
	formatted := false
	ast.Walk(node, func(candidate *ast.Node, entering bool) ast.WalkStatus {
		if !entering || candidate == node {
			return ast.WalkContinue
		}
		if candidate.Type == ast.NodeText {
			textNodes = append(textNodes, candidate)
			return ast.WalkContinue
		}
		if candidate.Type != ast.NodeKramdownBlockIAL && candidate.TextLen() > 0 {
			formatted = true
		}
		return ast.WalkContinue
	})
	if formatted || len(textNodes) > 1 {
		return fmt.Errorf("formatted text collaboration operation is unsupported")
	}
	if len(textNodes) == 1 {
		textNodes[0].Tokens = []byte(string(content))
	} else if input.OperationKind == "text.insert" {
		node.PrependChild(&ast.Node{Type: ast.NodeText, Tokens: []byte(string(content))})
	} else {
		return fmt.Errorf("text delete target is empty")
	}
	data := lute.RenderNodeBlockDOM(node)
	tx.DoOperations = []*Operation{{Action: "update", ID: input.BlockID, Data: data}}
	tx.MarkFromAPI()
	if err := PerformTxSync(tx); err != nil {
		return fmt.Errorf("apply collaboration text transaction: %w", err)
	}
	return nil
}

func collaborationBlockDOM(id, blockType, content string) string {
	dataType, className := "NodeParagraph", "p"
	switch blockType {
	case "heading":
		dataType, className = "NodeHeading", "h1"
	case "list":
		dataType, className = "NodeList", "list"
	case "container":
		dataType, className = "NodeBlockquote", "bq"
	}
	return `<div data-node-id="` + html.EscapeString(id) + `" data-type="` + dataType + `" class="` + className + `"><div contenteditable="true" spellcheck="false">` + html.EscapeString(content) + `</div><div class="protyle-attr" contenteditable="false">` + "\u200b" + `</div></div>`
}

func collaborationPreviousBlock(parentID, blockID string, index int, boxID string) (string, error) {
	if index < 0 {
		return "", fmt.Errorf("collaboration block index is invalid")
	}
	tree, err := LoadTreeByBlockIDInBox(parentID, boxID)
	if err != nil {
		return "", err
	}
	parent := treenode.GetNodeInTree(tree, parentID)
	if parent == nil {
		return "", ErrBlockNotFound
	}
	position := 0
	for child := parent.FirstChild; child != nil; child = child.Next {
		if child.ID == blockID {
			continue
		}
		if child.IsBlock() {
			if position == index-1 {
				return child.ID, nil
			}
			position++
		}
	}
	return "", nil
}

func ensureCollaborationBlock(documentID, blockID, boxID string) error {
	tree, err := LoadTreeByBlockIDInBox(blockID, boxID)
	if err != nil {
		return err
	}
	if tree == nil || tree.Root == nil || tree.Root.ID != documentID {
		return fmt.Errorf("block %s does not belong to document %s", blockID, documentID)
	}
	return nil
}

// ensureCollaborationParent 保证插入或移动的父块仍属于当前文档，防止仅凭笔记本身份跨文档写入。
func ensureCollaborationParent(documentID, parentID, boxID string) error {
	if parentID == documentID {
		return nil
	}
	tree, err := LoadTreeByBlockIDInBox(parentID, boxID)
	if err != nil {
		return err
	}
	if tree == nil || tree.Root == nil || tree.Root.ID != documentID || treenode.GetNodeInTree(tree, parentID) == nil {
		return fmt.Errorf("collaboration parent %s does not belong to document %s", parentID, documentID)
	}
	return nil
}
