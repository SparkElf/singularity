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

	"github.com/siyuan-note/siyuan/kernel/treenode"
	"github.com/siyuan-note/siyuan/kernel/util"
)

const (
	EnterpriseDirectoryPageSize  = 128
	EnterpriseDirectoryMaxOffset = 1_000_000
)

var (
	ErrEnterpriseDirectoryNotebookMissing = errors.New("enterprise directory notebook is unavailable")
	ErrEnterpriseDirectoryParentMissing   = errors.New("enterprise directory parent is unavailable")
)

type EnterpriseDirectoryNotebook struct {
	Icon       string `json:"icon"`
	Locked     bool   `json:"locked"`
	Name       string `json:"name"`
	NotebookID string `json:"notebookId"`
}

type EnterpriseDirectoryDocument struct {
	DocumentID  string `json:"documentId"`
	HasChildren bool   `json:"hasChildren"`
	Icon        string `json:"icon"`
	NotebookID  string `json:"notebookId"`
	Title       string `json:"title"`
}

type EnterpriseDirectoryPage struct {
	Documents  []EnterpriseDirectoryDocument `json:"documents"`
	Locked     bool                          `json:"locked"`
	NextOffset *int                          `json:"nextOffset"`
}

func ListEnterpriseDirectoryNotebooks() ([]EnterpriseDirectoryNotebook, error) {
	boxes, err := ListNotebooks()
	if err != nil {
		return nil, err
	}
	notebooks := make([]EnterpriseDirectoryNotebook, 0, len(boxes))
	for _, box := range boxes {
		if box.Closed {
			continue
		}
		notebooks = append(notebooks, EnterpriseDirectoryNotebook{
			Icon:       box.Icon,
			Locked:     box.Encrypted && !box.Unlocked,
			Name:       box.Name,
			NotebookID: box.ID,
		})
	}
	return notebooks, nil
}

func ListEnterpriseDirectoryDocuments(notebookID, parentDocumentID string, offset int) (*EnterpriseDirectoryPage, error) {
	box, err := enterpriseDirectoryNotebook(notebookID)
	if err != nil {
		return nil, err
	}
	if box.Encrypted && !box.Unlocked {
		return &EnterpriseDirectoryPage{Documents: []EnterpriseDirectoryDocument{}, Locked: true}, nil
	}

	listPath := "/"
	if parentDocumentID != "" {
		contentStore := TransactionNotebookForBox(notebookID)
		parent := treenode.GetBlockTreeInBox(parentDocumentID, contentStore)
		if parent == nil || parent.ID != parentDocumentID || parent.BoxID != notebookID {
			return nil, ErrEnterpriseDirectoryParentMissing
		}
		listPath = parent.Path
	}

	maxListCount := offset + EnterpriseDirectoryPageSize + 1
	files, total, err := ListDocTree(
		notebookID,
		listPath,
		util.SortModeUnassigned,
		false,
		false,
		maxListCount,
	)
	if err != nil {
		return nil, fmt.Errorf("list enterprise directory documents: %w", err)
	}
	if offset >= len(files) {
		return &EnterpriseDirectoryPage{Documents: []EnterpriseDirectoryDocument{}, Locked: false}, nil
	}

	end := min(offset+EnterpriseDirectoryPageSize, len(files))
	documents := make([]EnterpriseDirectoryDocument, 0, end-offset)
	for _, file := range files[offset:end] {
		documents = append(documents, EnterpriseDirectoryDocument{
			DocumentID:  file.ID,
			HasChildren: file.SubFileCount > 0,
			Icon:        file.Icon,
			NotebookID:  notebookID,
			Title:       file.Name,
		})
	}

	page := &EnterpriseDirectoryPage{Documents: documents, Locked: false}
	if end < total {
		nextOffset := end
		page.NextOffset = &nextOffset
	}
	return page, nil
}

func enterpriseDirectoryNotebook(notebookID string) (*Box, error) {
	boxes, err := ListNotebooks()
	if err != nil {
		return nil, err
	}
	for _, box := range boxes {
		if box.ID == notebookID && !box.Closed {
			return box, nil
		}
	}
	return nil, ErrEnterpriseDirectoryNotebookMissing
}
