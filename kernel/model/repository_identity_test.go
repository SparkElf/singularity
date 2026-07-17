// SiYuan - Refactor your thinking
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

package model

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestRepositoryFileMetadataCarriesNotebookOwner(t *testing.T) {
	const notebook = "20990717180700-repobox"
	for _, test := range []struct {
		name         string
		path         string
		wantNotebook string
		wantErr      bool
	}{
		{name: "notebook document", path: "/" + notebook + "/20990717180701-repodoc.sy", wantNotebook: notebook},
		{name: "notebook asset", path: "/" + notebook + "/assets/image.png", wantNotebook: notebook},
		{name: "workspace global", path: "/storage/petal/package.json"},
		{name: "ownerless document", path: "/storage/20990717180701-repodoc.sy", wantErr: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			notebook, err := repoFileNotebook(test.path)
			if (err != nil) != test.wantErr {
				t.Fatalf("repository path %q error = %v, wantErr %v", test.path, err, test.wantErr)
			}
			if notebook != test.wantNotebook {
				t.Fatalf("repository path %q notebook = %q, want %q", test.path, notebook, test.wantNotebook)
			}
		})
	}
}

func TestEncryptedRepositoryRollbackDecryptFailsClosed(t *testing.T) {
	boxID, _ := setupEncryptedAssetStoreTest(t)
	const rootID = "20990717180702-repodoc"
	repoPath := "/" + boxID + "/" + rootID + ".sy"
	plaintext := []byte(`{"ID":"20990717180702-repodoc","Properties":{"title":"strict rollback"}}`)
	dek, err := GetDEK(boxID)
	if err != nil {
		t.Fatalf("get encrypted repository test key: %v", err)
	}
	ciphertext, err := EncryptFile(boxID, "/"+rootID+".sy", dek, plaintext)
	clear(dek)
	if err != nil {
		t.Fatalf("encrypt repository rollback fixture: %v", err)
	}
	ciphertext[len(ciphertext)-1] ^= 0xff

	data, owner, err := decryptRepoDataStrict(ciphertext, repoPath)
	if err == nil {
		t.Fatal("corrupted encrypted repository rollback data was accepted")
	}
	if owner != boxID {
		t.Fatalf("failed repository decrypt owner = %q, want %q", owner, boxID)
	}
	if data != nil || bytes.Equal(data, ciphertext) {
		t.Fatalf("failed repository decrypt returned data: %x", data)
	}
}

func TestEncryptedRepositoryRollbackStagingUsesPrivatePermissions(t *testing.T) {
	stagingDir := filepath.Join(t.TempDir(), "repo", "rollback", "encrypted")
	if err := os.MkdirAll(stagingDir, 0755); err != nil {
		t.Fatalf("create pre-existing public staging directory: %v", err)
	}
	stagedPath := filepath.Join(stagingDir, "document.sy")
	if err := os.WriteFile(stagedPath, []byte("old"), 0644); err != nil {
		t.Fatalf("create pre-existing public staging file: %v", err)
	}

	plaintext := []byte("encrypted notebook plaintext")
	gotPath, err := stageRepoRollbackFile(stagingDir, filepath.Base(stagedPath), plaintext, true)
	if err != nil {
		t.Fatalf("stage encrypted repository rollback document: %v", err)
	}
	if gotPath != stagedPath {
		t.Fatalf("staged path = %q, want %q", gotPath, stagedPath)
	}
	dirInfo, err := os.Stat(stagingDir)
	if err != nil {
		t.Fatalf("stat private staging directory: %v", err)
	}
	if permission := dirInfo.Mode().Perm(); permission != 0700 {
		t.Fatalf("private staging directory permission = %04o, want 0700", permission)
	}
	fileInfo, err := os.Stat(stagedPath)
	if err != nil {
		t.Fatalf("stat private staging file: %v", err)
	}
	if permission := fileInfo.Mode().Perm(); permission != 0600 {
		t.Fatalf("private staging file permission = %04o, want 0600", permission)
	}
	data, err := os.ReadFile(stagedPath)
	if err != nil {
		t.Fatalf("read private staging file: %v", err)
	}
	if !bytes.Equal(data, plaintext) {
		t.Fatalf("private staging content = %q, want %q", data, plaintext)
	}
}
