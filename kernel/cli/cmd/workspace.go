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
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/siyuan-note/siyuan/kernel/model"
	"github.com/siyuan-note/siyuan/kernel/util"

	"github.com/spf13/cobra"
)

var workspaceCmd = &cobra.Command{
	Use:   "workspace",
	Short: "Manage SiYuan workspaces",
}

var workspaceListCmd = &cobra.Command{
	Use:   "list",
	Short: "List registered workspaces",
	RunE: func(cmd *cobra.Command, args []string) error {
		paths, err := util.ReadWorkspacePaths()
		if err != nil {
			return err
		}
		switch outputFormat {
		case "json":
			var items []map[string]any
			seen := map[string]bool{}
			for _, p := range paths {
				key := strings.ToLower(p)
				if seen[key] {
					continue
				}
				seen[key] = true
				items = append(items, map[string]any{
					"path": p,
					"name": filepath.Base(p),
				})
			}
			data, _ := json.MarshalIndent(items, "", "  ")
			fmt.Println(string(data))
		default:
			seen := map[string]bool{}
			for _, p := range paths {
				key := strings.ToLower(p)
				if seen[key] {
					continue
				}
				seen[key] = true
				fmt.Println(p)
			}
		}
		return nil
	},
}

var workspaceInfoCmd = &cobra.Command{
	Use:   "info",
	Short: "Show current workspace info",
	RunE: func(cmd *cobra.Command, args []string) error {
		dir := workspacePath
		if dir == "" {
			dir = resolveDefaultWorkspace()
		}
		switch outputFormat {
		case "json":
			data, _ := json.MarshalIndent(map[string]any{
				"path":    dir,
				"version": util.Ver,
				"valid":   util.IsWorkspaceDir(dir),
			}, "", "  ")
			fmt.Println(string(data))
		default:
			fmt.Printf("Path:       %s\n", dir)
			fmt.Printf("Version:    %s\n", util.Ver)
			fmt.Printf("IsValid:    %v\n", util.IsWorkspaceDir(dir))
		}
		return nil
	},
}

var (
	restoreArchivePath           string
	restoreArchiveDestination    string
	restoreArchiveExpectedSHA256 string
	restoreArchiveMaximumBytes   int64
	restoreArchiveMaximumEntry   int64
	restoreArchiveMaximumFiles   int64
	restoreArchiveMaximumTotal   int64
	restoreArchiveOutput         string
)

var restoreArchiveCmd = &cobra.Command{
	Use:   "restore-archive --archive <path> --destination <path> --expected-sha256 <sha256>",
	Short: "Extract and verify an enterprise backup archive",
	Args:  cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		if restoreArchivePath == "" || restoreArchiveDestination == "" || restoreArchiveExpectedSHA256 == "" {
			return fmt.Errorf("archive, destination and expected sha256 are required")
		}
		if restoreArchiveMaximumBytes < 1 || restoreArchiveMaximumEntry < 1 || restoreArchiveMaximumFiles < 1 || restoreArchiveMaximumTotal < 1 {
			return fmt.Errorf("restore limits must be positive")
		}
		if restoreArchiveOutput != "json" {
			return fmt.Errorf("restore output must be json")
		}
		destination, err := filepath.Abs(restoreArchiveDestination)
		if err != nil {
			return err
		}
		// 恢复工具没有当前工作空间，使用目标目录旁的哨兵路径作为隔离比较根。
		util.WorkspaceDir = filepath.Join(
			filepath.Dir(destination),
			".singularity-restore-current-"+strconv.Itoa(os.Getpid()),
		)
		manifest, err := model.ExtractEnterpriseBackupArchive(
			restoreArchivePath,
			destination,
			restoreArchiveExpectedSHA256,
			model.EnterpriseRestoreLimits{
				MaximumArchiveBytes: restoreArchiveMaximumBytes,
				MaximumEntryBytes:   restoreArchiveMaximumEntry,
				MaximumFiles:        restoreArchiveMaximumFiles,
				MaximumTotalBytes:   restoreArchiveMaximumTotal,
			},
		)
		if err != nil {
			return err
		}
		return json.NewEncoder(cmd.OutOrStdout()).Encode(struct {
			FileCount      int64  `json:"fileCount"`
			FormatVersion  int    `json:"formatVersion"`
			KernelVersion  string `json:"kernelVersion"`
			SourceSpaceID  string `json:"sourceSpaceId"`
			TotalSizeBytes int64  `json:"totalSizeBytes"`
		}{
			FileCount:      manifest.FileCount,
			FormatVersion:  manifest.FormatVersion,
			KernelVersion:  manifest.KernelVersion,
			SourceSpaceID:  manifest.SourceSpaceID,
			TotalSizeBytes: manifest.TotalSizeBytes,
		})
	},
}

func resolveDefaultWorkspace() string {
	if p := os.Getenv("SIYUAN_WORKSPACE_PATH"); p != "" {
		return p
	}
	paths, _ := util.ReadWorkspacePaths()
	if len(paths) > 0 {
		return paths[len(paths)-1]
	}
	return filepath.Join(util.HomeDir, "SiYuan")
}

func init() {
	rootCmd.AddCommand(workspaceCmd)
	workspaceCmd.AddCommand(workspaceListCmd)
	workspaceCmd.AddCommand(workspaceInfoCmd)
	workspaceCmd.AddCommand(restoreArchiveCmd)
	restoreArchiveCmd.Flags().StringVar(&restoreArchivePath, "archive", "", "verified backup archive path")
	restoreArchiveCmd.Flags().StringVar(&restoreArchiveDestination, "destination", "", "isolated restore workspace path")
	restoreArchiveCmd.Flags().StringVar(&restoreArchiveExpectedSHA256, "expected-sha256", "", "expected archive SHA-256")
	restoreArchiveCmd.Flags().Int64Var(&restoreArchiveMaximumBytes, "maximum-archive-bytes", 0, "maximum archive bytes")
	restoreArchiveCmd.Flags().Int64Var(&restoreArchiveMaximumEntry, "maximum-entry-bytes", 0, "maximum extracted entry bytes")
	restoreArchiveCmd.Flags().Int64Var(&restoreArchiveMaximumFiles, "maximum-files", 0, "maximum extracted file count")
	restoreArchiveCmd.Flags().Int64Var(&restoreArchiveMaximumTotal, "maximum-total-bytes", 0, "maximum extracted total bytes")
	restoreArchiveCmd.Flags().StringVar(&restoreArchiveOutput, "output", "json", "restore output format: json")
}
