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

package cmd

import (
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/siyuan-note/siyuan/kernel/model"
	"github.com/siyuan-note/siyuan/kernel/util"

	"github.com/spf13/cobra"
)

var exportCmd = &cobra.Command{
	Use:   "export",
	Short: "Export documents",
}

func finishExportFile(downloadPath, output string, stdout io.Writer) error {
	if output != "" {
		var err error
		output, err = model.ValidatePlaintextExportDestination(output)
		if err != nil {
			return err
		}
	}
	opened, err := util.OpenLocalExportDownload(downloadPath)
	if err != nil {
		return err
	}
	if output == "" {
		closeErr := opened.Close()
		if closeErr != nil {
			return closeErr
		}
		_, err = fmt.Fprintln(stdout, opened.Path)
		return err
	}
	err = util.PublishFile(opened.File, opened.Info.Mode(), output)
	err = errors.Join(err, opened.Close())
	if err != nil {
		return fmt.Errorf("copy export from %q to %q: %w", opened.Path, output, err)
	}
	return nil
}

var exportMdCmd = &cobra.Command{
	Use:   "md --id <id>",
	Short: "Export as Markdown",
	RunE: func(cmd *cobra.Command, args []string) error {
		id, _ := cmd.Flags().GetString("id")
		if id == "" {
			return fmt.Errorf("--id is required")
		}

		output, _ := cmd.Flags().GetString("output")
		if output != "" {
			var err error
			output, err = model.ValidatePlaintextExportDestination(output)
			if err != nil {
				return err
			}
		}
		if dryRun && output != "" {
			fmt.Printf("[dry-run] Would export markdown for document %s to %s\n", id, output)
			return nil
		}

		_, content, err := model.ExportMarkdownContentInBox(id, 4, 0, true, false, false, false, false, "")
		if err != nil {
			return err
		}
		if output != "" {
			return util.PublishFile(strings.NewReader(content), 0644, output)
		}
		fmt.Print(content)
		return nil
	},
}

var exportHTMLCmd = &cobra.Command{
	Use:   "html --id <id>",
	Short: "Export as HTML",
	RunE: func(cmd *cobra.Command, args []string) error {
		id, _ := cmd.Flags().GetString("id")
		if id == "" {
			return fmt.Errorf("--id is required")
		}

		output, _ := cmd.Flags().GetString("output")
		if output != "" {
			var err error
			output, err = model.ValidatePlaintextExportDestination(output)
			if err != nil {
				return err
			}
		}
		if dryRun && output != "" {
			fmt.Printf("[dry-run] Would export HTML for document %s to %s\n", id, output)
			return nil
		}

		_, dom, _, err := model.ExportHTMLInBox(id, "", false, false, false, "")
		if err != nil {
			return err
		}
		if output != "" {
			return util.PublishFile(strings.NewReader(dom), 0644, output)
		}
		fmt.Print(dom)
		return nil
	},
}

var exportPreviewCmd = &cobra.Command{
	Use:   "preview --id <id>",
	Short: "Export as preview HTML",
	RunE: func(cmd *cobra.Command, args []string) error {
		id, _ := cmd.Flags().GetString("id")
		if id == "" {
			return fmt.Errorf("--id is required")
		}

		output, _ := cmd.Flags().GetString("output")
		if output != "" {
			var err error
			output, err = model.ValidatePlaintextExportDestination(output)
			if err != nil {
				return err
			}
		}
		if dryRun && output != "" {
			fmt.Printf("[dry-run] Would export preview HTML for document %s to %s\n", id, output)
			return nil
		}

		html, err := model.ExportPreviewInBox(id, false, "")
		if err != nil {
			return err
		}
		if output != "" {
			return util.PublishFile(strings.NewReader(html), 0644, output)
		}
		fmt.Print(html)
		return nil
	},
}

var exportDocxCmd = &cobra.Command{
	Use:   "docx --id <id> --output <dir>",
	Short: "Export as Word (.docx)",
	RunE: func(cmd *cobra.Command, args []string) error {
		id, _ := cmd.Flags().GetString("id")
		output, _ := cmd.Flags().GetString("output")
		if id == "" {
			return fmt.Errorf("--id is required")
		}
		if output == "" {
			return fmt.Errorf("--output is required for docx")
		}
		output, err := model.ValidatePlaintextExportDestination(output)
		if err != nil {
			return err
		}

		if dryRun {
			fmt.Printf("[dry-run] Would export docx for document %s to %s\n", id, output)
			return nil
		}

		fullPath, err := model.ExportDocxInBox(id, output, false, false, "")
		if err != nil {
			return err
		}
		fmt.Println(fullPath)
		return nil
	},
}

var exportSYCmd = &cobra.Command{
	Use:   "sy --id <id> [--output <file>]",
	Short: "Export as .sy.zip",
	RunE: func(cmd *cobra.Command, args []string) error {
		id, _ := cmd.Flags().GetString("id")
		if id == "" {
			return fmt.Errorf("--id is required")
		}

		output, _ := cmd.Flags().GetString("output")
		if dryRun {
			if output != "" {
				fmt.Printf("[dry-run] Would export .sy.zip for document %s to %s\n", id, output)
			} else {
				fmt.Printf("[dry-run] Would export .sy.zip for document %s to temp path\n", id)
			}
			return nil
		}

		zipPath, err := model.ExportSYsInBox([]string{id}, "")
		if err != nil {
			return err
		}
		return finishExportFile(zipPath, output, cmd.OutOrStdout())
	},
}

var exportMdZipCmd = &cobra.Command{
	Use:   "md-zip --id <id> [--output <file>]",
	Short: "Export as Markdown zip",
	RunE: func(cmd *cobra.Command, args []string) error {
		id, _ := cmd.Flags().GetString("id")
		if id == "" {
			return fmt.Errorf("--id is required")
		}

		output, _ := cmd.Flags().GetString("output")
		if dryRun {
			if output != "" {
				fmt.Printf("[dry-run] Would export markdown zip for document %s to %s\n", id, output)
			} else {
				fmt.Printf("[dry-run] Would export markdown zip for document %s to temp path\n", id)
			}
			return nil
		}

		_, zipPath, err := model.ExportPandocConvertZipInBox([]string{id}, "", ".md", "")
		if err != nil {
			return err
		}
		return finishExportFile(zipPath, output, cmd.OutOrStdout())
	},
}

var exportDataCmd = &cobra.Command{
	Use:   "data [--output <file>]",
	Short: "Export full workspace data backup",
	RunE: func(cmd *cobra.Command, args []string) error {
		output, _ := cmd.Flags().GetString("output")
		if dryRun {
			if output != "" {
				fmt.Printf("[dry-run] Would export full data backup to %s\n", output)
			} else {
				fmt.Println("[dry-run] Would export full data backup to temp path")
			}
			return nil
		}

		zipPath, err := model.ExportData()
		if err != nil {
			return err
		}
		return finishExportFile(zipPath, output, cmd.OutOrStdout())
	},
}

func init() {
	exportMdCmd.Flags().String("id", "", "block ID")
	exportMdCmd.Flags().String("output", "", "output file path (default: stdout)")

	exportHTMLCmd.Flags().String("id", "", "block ID")
	exportHTMLCmd.Flags().String("output", "", "output file path (default: stdout)")

	exportPreviewCmd.Flags().String("id", "", "block ID")
	exportPreviewCmd.Flags().String("output", "", "output file path (default: stdout)")

	exportDocxCmd.Flags().String("id", "", "block ID")
	exportDocxCmd.Flags().String("output", "", "output directory (required)")

	exportSYCmd.Flags().String("id", "", "block ID")
	exportSYCmd.Flags().String("output", "", "output file path (default: print temp path)")

	exportMdZipCmd.Flags().String("id", "", "block ID")
	exportMdZipCmd.Flags().String("output", "", "output file path (default: print temp path)")

	exportDataCmd.Flags().String("output", "", "output file path (default: print temp path)")

	rootCmd.AddCommand(exportCmd)
	exportCmd.AddCommand(exportMdCmd)
	exportCmd.AddCommand(exportHTMLCmd)
	exportCmd.AddCommand(exportPreviewCmd)
	exportCmd.AddCommand(exportDocxCmd)
	exportCmd.AddCommand(exportSYCmd)
	exportCmd.AddCommand(exportMdZipCmd)
	exportCmd.AddCommand(exportDataCmd)
}
