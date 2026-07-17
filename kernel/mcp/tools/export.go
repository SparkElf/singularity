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

package tools

import (
	"errors"
	"fmt"
	"strings"

	"github.com/siyuan-note/siyuan/kernel/model"
	"github.com/siyuan-note/siyuan/kernel/util"
)

var ExportTool = &Tool{
	Name:        "export",
	Description: "Export operations. Document actions accept an explicit notebook ID. Ordinary binary exports return an absolute local path when output is omitted; encrypted binary exports require output.",
	InputSchema: ToolSchema{
		Type: "object",
		Properties: map[string]Property{
			"action":   {Type: "string", Description: "Operation", Enum: []string{"md", "html", "preview", "docx", "sy", "md-zip", "data"}},
			"id":       {Type: "string", Description: "Document block ID (for md, html, preview, docx, sy, md-zip)"},
			"notebook": {Type: "string", Description: "Authoritative notebook ID for document actions; required for encrypted notebook content"},
			"output":   {Type: "string", Description: "Exact output file for md, html, preview, sy, md-zip, and data; required for encrypted binary exports and required as an output directory for docx"},
		},
		Required: []string{"action"},
	},
	Handler: exportHandler,
}

func init() {
	register(ExportTool)
}

func exportHandler(_ CallContext, args map[string]any) (CallToolResult, error) {
	action, _ := args["action"].(string)
	switch action {
	case "md", "html", "preview", "docx", "sy", "md-zip":
		if _, _, err := NotebookArg(args); err != nil {
			return CallToolResult{Content: []ContentItem{{Type: "text", Text: "export " + action + " failed: " + err.Error()}}, IsError: true}, nil
		}
	}
	switch action {
	case "md":
		return exportMd(args)
	case "html":
		return exportHtml(args)
	case "preview":
		return exportPreview(args)
	case "docx":
		return exportDocx(args)
	case "sy":
		return exportSy(args)
	case "md-zip":
		return exportMdZip(args)
	case "data":
		return exportData(args)
	}
	return CallToolResult{
		Content: []ContentItem{{Type: "text", Text: "unknown action '" + action + "', expected one of: [md, html, preview, docx, sy, md-zip, data]"}},
		IsError: true,
	}, nil
}

func exportMd(args map[string]any) (CallToolResult, error) {
	id, _ := args["id"].(string)
	notebook, _ := args["notebook"].(string)
	if id == "" {
		return CallToolResult{Content: []ContentItem{{Type: "text", Text: "id is required"}}, IsError: true}, nil
	}

	hPath, content, err := model.ExportMarkdownContentInBox(id, 4, 0, true, false, false, false, false, notebook)
	if err != nil {
		return CallToolResult{Content: []ContentItem{{Type: "text", Text: "export markdown failed: " + err.Error()}}, IsError: true}, nil
	}

	if output, _ := args["output"].(string); output != "" {
		return publishMCPTextExport(content, output, "markdown")
	}
	return CallToolResult{Content: []ContentItem{{Type: "text", Text: fmt.Sprintf("# %s\n\n%s", hPath, content)}}}, nil
}

func exportHtml(args map[string]any) (CallToolResult, error) {
	id, _ := args["id"].(string)
	notebook, _ := args["notebook"].(string)
	if id == "" {
		return CallToolResult{Content: []ContentItem{{Type: "text", Text: "id is required"}}, IsError: true}, nil
	}
	_, dom, _, err := model.ExportHTMLInBox(id, "", false, false, false, notebook)
	if err != nil {
		return CallToolResult{Content: []ContentItem{{Type: "text", Text: "export HTML failed: " + err.Error()}}, IsError: true}, nil
	}
	if output, _ := args["output"].(string); output != "" {
		return publishMCPTextExport(dom, output, "HTML")
	}
	return CallToolResult{Content: []ContentItem{{Type: "text", Text: dom}}}, nil
}

func exportPreview(args map[string]any) (CallToolResult, error) {
	id, _ := args["id"].(string)
	notebook, _ := args["notebook"].(string)
	if id == "" {
		return CallToolResult{Content: []ContentItem{{Type: "text", Text: "id is required"}}, IsError: true}, nil
	}
	html, err := model.ExportPreviewInBox(id, false, notebook)
	if err != nil {
		return CallToolResult{Content: []ContentItem{{Type: "text", Text: "export preview failed: " + err.Error()}}, IsError: true}, nil
	}
	if output, _ := args["output"].(string); output != "" {
		return publishMCPTextExport(html, output, "preview")
	}
	return CallToolResult{Content: []ContentItem{{Type: "text", Text: html}}}, nil
}

func exportDocx(args map[string]any) (CallToolResult, error) {
	id, _ := args["id"].(string)
	notebook, _ := args["notebook"].(string)
	output, _ := args["output"].(string)
	if id == "" {
		return CallToolResult{Content: []ContentItem{{Type: "text", Text: "id is required"}}, IsError: true}, nil
	}
	if output == "" {
		return CallToolResult{Content: []ContentItem{{Type: "text", Text: "output directory is required for docx"}}, IsError: true}, nil
	}
	output, err := model.ValidatePlaintextExportDestination(output)
	if err != nil {
		return CallToolResult{Content: []ContentItem{{Type: "text", Text: "export docx failed: " + err.Error()}}, IsError: true}, nil
	}
	fullPath, err := model.ExportDocxInBox(id, output, false, false, notebook)
	if err != nil {
		return CallToolResult{Content: []ContentItem{{Type: "text", Text: "export docx failed: " + err.Error()}}, IsError: true}, nil
	}
	return CallToolResult{Content: []ContentItem{{Type: "text", Text: fmt.Sprintf("exported docx to: %s", fullPath)}}}, nil
}

func exportSy(args map[string]any) (CallToolResult, error) {
	id, _ := args["id"].(string)
	notebook, _ := args["notebook"].(string)
	output, _ := args["output"].(string)
	if id == "" {
		return CallToolResult{Content: []ContentItem{{Type: "text", Text: "id is required"}}, IsError: true}, nil
	}
	zipPath, err := model.ExportSYsInBox([]string{id}, notebook)
	if err != nil {
		return CallToolResult{Content: []ContentItem{{Type: "text", Text: "export sy failed: " + err.Error()}}, IsError: true}, nil
	}
	return finishMCPExportFile(zipPath, output, "sy.zip")
}

func exportMdZip(args map[string]any) (CallToolResult, error) {
	id, _ := args["id"].(string)
	notebook, _ := args["notebook"].(string)
	output, _ := args["output"].(string)
	if id == "" {
		return CallToolResult{Content: []ContentItem{{Type: "text", Text: "id is required"}}, IsError: true}, nil
	}
	_, zipPath, err := model.ExportPandocConvertZipInBox([]string{id}, "", ".md", notebook)
	if err != nil {
		return CallToolResult{Content: []ContentItem{{Type: "text", Text: "export md-zip failed: " + err.Error()}}, IsError: true}, nil
	}
	return finishMCPExportFile(zipPath, output, "markdown zip")
}

func exportData(args map[string]any) (CallToolResult, error) {
	output, _ := args["output"].(string)
	zipPath, err := model.ExportData()
	if err != nil {
		return CallToolResult{Content: []ContentItem{{Type: "text", Text: "export data failed: " + err.Error()}}, IsError: true}, nil
	}
	return finishMCPExportFile(zipPath, output, "data backup")
}

func publishMCPTextExport(content, output, kind string) (CallToolResult, error) {
	destination, err := model.ValidatePlaintextExportDestination(output)
	if err == nil {
		err = util.PublishFile(strings.NewReader(content), 0644, destination)
	}
	if err != nil {
		return CallToolResult{Content: []ContentItem{{Type: "text", Text: "export " + kind + " failed: " + err.Error()}}, IsError: true}, nil
	}
	return CallToolResult{Content: []ContentItem{{Type: "text", Text: "exported " + kind + " to: " + destination}}}, nil
}

func finishMCPExportFile(downloadPath, output, kind string) (CallToolResult, error) {
	if strings.HasPrefix(downloadPath, "/export/managed/") {
		if output == "" {
			claim, claimErr := model.ClaimManagedEncryptedExport(strings.TrimPrefix(downloadPath, "/export/"))
			if claim != nil {
				claimErr = errors.Join(claimErr, claim.Close())
			}
			message := "export " + kind + " failed: output is required for encrypted notebook exports"
			if claimErr != nil {
				message += "; managed export cleanup failed: " + claimErr.Error()
			}
			return CallToolResult{Content: []ContentItem{{Type: "text", Text: message}}, IsError: true}, nil
		}
		destination, err := model.ValidatePlaintextExportDestination(output)
		if err != nil {
			claim, cleanupErr := model.ClaimManagedEncryptedExport(strings.TrimPrefix(downloadPath, "/export/"))
			if claim != nil {
				cleanupErr = errors.Join(cleanupErr, claim.Close())
			}
			err = errors.Join(err, cleanupErr)
			return CallToolResult{Content: []ContentItem{{Type: "text", Text: "export " + kind + " failed: " + err.Error()}}, IsError: true}, nil
		}
		claim, err := model.ClaimManagedEncryptedExport(strings.TrimPrefix(downloadPath, "/export/"))
		if err == nil {
			var dek []byte
			dek, err = model.GetDEKIfUnlocked(claim.BoxID)
			clear(dek)
		}
		if err == nil {
			err = util.PublishFile(claim.File, 0600, destination)
		}
		if claim != nil {
			err = errors.Join(err, claim.Close())
		}
		if err != nil {
			return CallToolResult{Content: []ContentItem{{Type: "text", Text: "export " + kind + " failed: " + err.Error()}}, IsError: true}, nil
		}
		return CallToolResult{Content: []ContentItem{{Type: "text", Text: "exported " + kind + " to: " + destination}}}, nil
	}

	destination := ""
	var err error
	if output != "" {
		destination, err = model.ValidatePlaintextExportDestination(output)
	}
	var opened *util.LocalExportFile
	if err == nil {
		opened, err = util.OpenLocalExportDownload(downloadPath)
	}
	if err == nil && output == "" {
		destination = opened.Path
	} else if err == nil {
		err = util.PublishFile(opened.File, opened.Info.Mode(), destination)
	}
	if opened != nil {
		err = errors.Join(err, opened.Close())
	}
	if err != nil {
		return CallToolResult{Content: []ContentItem{{Type: "text", Text: "export " + kind + " failed: " + err.Error()}}, IsError: true}, nil
	}
	return CallToolResult{Content: []ContentItem{{Type: "text", Text: "exported " + kind + " to: " + destination}}}, nil
}
