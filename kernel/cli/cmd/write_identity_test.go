// SiYuan - Refactor your thinking
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

package cmd

import (
	"strings"
	"testing"

	"github.com/siyuan-note/siyuan/kernel/conf"
	"github.com/siyuan-note/siyuan/kernel/model"
	"github.com/siyuan-note/siyuan/kernel/util"
	"github.com/spf13/cobra"
)

func TestCLIWriteCommandsRejectEncryptedNotebookBeforeModelMutation(t *testing.T) {
	const encryptedBox = "20990717160000-cliwrit"
	originalDataDir := util.DataDir
	originalConf := model.Conf
	originalDryRun := dryRun
	util.DataDir = t.TempDir()
	model.Conf = model.NewAppConf()
	dryRun = false
	t.Cleanup(func() {
		dryRun = originalDryRun
		model.Conf = originalConf
		util.DataDir = originalDataDir
	})

	boxConf := conf.NewBoxConf()
	boxConf.Name = encryptedBox
	boxConf.Encrypted = true
	if err := (&model.Box{ID: encryptedBox}).SaveConf(boxConf); err != nil {
		t.Fatalf("save encrypted notebook fixture: %v", err)
	}

	commands := []struct {
		name string
		cmd  *cobra.Command
	}{
		{name: "daily note create", cmd: dailynoteCreateCmd},
		{name: "daily note append", cmd: dailynoteAppendCmd},
		{name: "daily note prepend", cmd: dailynotePrependCmd},
		{name: "document create", cmd: documentCreateCmd},
		{name: "inbox convert", cmd: inboxConvertCmd},
	}
	for _, test := range commands {
		t.Run(test.name, func(t *testing.T) {
			flag := test.cmd.Flags().Lookup("notebook")
			originalValue, originalChanged := flag.Value.String(), flag.Changed
			t.Cleanup(func() {
				_ = test.cmd.Flags().Set("notebook", originalValue)
				flag.Changed = originalChanged
			})
			if err := test.cmd.Flags().Set("notebook", encryptedBox); err != nil {
				t.Fatal(err)
			}
			err := test.cmd.RunE(test.cmd, nil)
			if err == nil || !strings.Contains(err.Error(), "CLI does not support encrypted notebook") {
				t.Fatalf("command error = %v, want explicit encrypted-notebook rejection", err)
			}
		})
	}
}
