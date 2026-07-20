// SiYuan - Refactor your thinking
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

package model

import (
	"sort"

	"github.com/siyuan-note/siyuan/kernel/sql"
)

// UnlockedEncryptedContentStoreIDs 返回当前已打开且仍解锁的加密内容库。调用方需要先固定加密笔记本成员和响应读门，
// 才能把该快照用于跨库明文响应。
// UnlockedEncryptedContentStoreIDs 返回当前进程已解锁且可参与空间发现的加密库身份。
func UnlockedEncryptedContentStoreIDs() (ret []string) {
	for _, boxID := range sql.GetEncryptedBoxIDs() {
		if IsBoxUnlocked(boxID) {
			ret = append(ret, boxID)
		}
	}
	sort.Strings(ret)
	return
}

// SearchEnterpriseDiscoveryBlocks 聚合普通内容库与调用方已固定的加密内容库。各库内部保留原搜索顺序，
// 跨库按稳定轮询合并，使第一页不会被单一内容库完全占满。
// SearchEnterpriseDiscoveryBlocks 在授权空间内执行有界搜索，并保留每个结果的源库与文档身份。
func SearchEnterpriseDiscoveryBlocks(query string, encryptedContentStores []string, pageSize int) (ret []*Block, matchedBlockCount, pageCount int) {
	ret = []*Block{}
	if pageSize < 1 || query == "" {
		return
	}

	stores := enterpriseDiscoveryContentStores(encryptedContentStores)
	batches := make([][]*Block, 0, len(stores))
	for _, store := range stores {
		blocks, storeMatchedBlockCount, _, _, _ := FullTextSearchBlockInBox(
			query,
			nil,
			nil,
			nil,
			nil,
			0,
			7,
			0,
			1,
			pageSize,
			store,
		)
		matchedBlockCount += storeMatchedBlockCount
		batches = append(batches, blocks)
	}
	pageCount = (matchedBlockCount + pageSize - 1) / pageSize

	for index := 0; len(ret) < pageSize; index++ {
		appended := false
		for _, batch := range batches {
			if index < len(batch) {
				ret = append(ret, batch[index])
				appended = true
				if len(ret) == pageSize {
					break
				}
			}
		}
		if !appended {
			break
		}
	}
	return
}

// BuildEnterpriseDiscoveryGraph 聚合普通内容库与调用方已固定的加密内容库。每个内容库获得稳定份额，
// 内容库之间不建立推断链接，返回规模由调用方的公开合同统一限制。
// BuildEnterpriseDiscoveryGraph 构造受节点和边预算约束的空间图谱，不从路径或首节点推断文档身份。
func BuildEnterpriseDiscoveryGraph(query string, encryptedContentStores []string, maximumNodes, maximumLinks int) (nodes []*GraphNode, links []*GraphLink) {
	nodes = []*GraphNode{}
	links = []*GraphLink{}
	if maximumNodes < 1 {
		return
	}

	stores := enterpriseDiscoveryContentStores(encryptedContentStores)
	selectedNodeIDs := make(map[string]struct{}, maximumNodes)
	for storeIndex, store := range stores {
		_, storeNodes, storeLinks := BuildGraphInBox(query, store)
		remainingStores := len(stores) - storeIndex
		nodeQuota := (maximumNodes - len(nodes) + remainingStores - 1) / remainingStores
		storeNodeIDs := make(map[string]struct{}, nodeQuota)
		if nodeQuota > 0 {
			for _, node := range storeNodes {
				if node == nil || node.ID == "" || node.DocumentID == "" || node.Box == "" {
					continue
				}
				if _, exists := selectedNodeIDs[node.ID]; exists {
					continue
				}
				nodes = append(nodes, node)
				selectedNodeIDs[node.ID] = struct{}{}
				storeNodeIDs[node.ID] = struct{}{}
				if len(storeNodeIDs) == nodeQuota {
					break
				}
			}
		}

		if maximumLinks < 1 || len(links) == maximumLinks {
			continue
		}
		linkQuota := (maximumLinks - len(links) + remainingStores - 1) / remainingStores
		if linkQuota < 1 {
			continue
		}
		storeLinkCount := 0
		for _, link := range storeLinks {
			if link == nil {
				continue
			}
			if _, exists := storeNodeIDs[link.From]; !exists {
				continue
			}
			if _, exists := storeNodeIDs[link.To]; !exists {
				continue
			}
			links = append(links, link)
			storeLinkCount++
			if storeLinkCount == linkQuota {
				break
			}
		}
	}
	return
}

func enterpriseDiscoveryContentStores(encryptedContentStores []string) []string {
	stores := append([]string(nil), encryptedContentStores...)
	sort.Strings(stores)
	ret := []string{""}
	for _, store := range stores {
		if store == "" || ret[len(ret)-1] == store {
			continue
		}
		ret = append(ret, store)
	}
	return ret
}
