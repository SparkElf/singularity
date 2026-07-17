// SiYuan - Refactor your thinking
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

package tools

import (
	"fmt"

	"github.com/88250/lute/ast"
	"github.com/siyuan-note/siyuan/kernel/model"
)

func NotebookArg(args map[string]any) (notebook string, provided bool, err error) {
	value, provided := args["notebook"]
	if !provided {
		return "", false, nil
	}
	notebook, ok := value.(string)
	if !ok || !ast.IsNodeIDPattern(notebook) {
		return "", true, fmt.Errorf("%w: notebook", model.ErrInvalidID)
	}
	if model.Conf.GetBox(notebook) == nil {
		return "", true, fmt.Errorf("%w: %s", model.ErrBoxNotFound, notebook)
	}
	return notebook, true, nil
}

func HistoricalNotebookArg(args map[string]any, allowGlobal bool) (string, error) {
	value, provided := args["notebook"]
	if !provided {
		return "", fmt.Errorf("notebook is required")
	}
	notebook, ok := value.(string)
	if !ok || (notebook == "" && !allowGlobal) || (notebook != "" && !ast.IsNodeIDPattern(notebook)) {
		return "", fmt.Errorf("%w: notebook", model.ErrInvalidID)
	}
	return notebook, nil
}
