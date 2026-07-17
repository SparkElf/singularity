// SiYuan - Refactor your thinking
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

package treenode

import (
	"testing"

	"github.com/88250/lute"
)

func TestNodeHashDoesNotReorderSourceAttributes(t *testing.T) {
	tree := NewTree("box", "/20990716090000-nodehash.sy", "/Hash", "Hash")
	tree.Root.KramdownIAL = [][]string{{"z", "last"}, {"a", "first"}}

	_ = NodeHash(tree.Root, tree, lute.New())

	if tree.Root.KramdownIAL[0][0] != "z" || tree.Root.KramdownIAL[1][0] != "a" {
		t.Fatalf("NodeHash reordered source attributes: %#v", tree.Root.KramdownIAL)
	}
}
