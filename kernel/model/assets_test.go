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
	"encoding/json"
	"errors"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/88250/gulu"
	"github.com/gin-gonic/gin"
	"github.com/siyuan-note/siyuan/kernel/cache"
	"github.com/siyuan-note/siyuan/kernel/conf"
	"github.com/siyuan-note/siyuan/kernel/util"
)

func setupEncryptedAssetStoreTest(t *testing.T) (boxID, assetsDir string) {
	t.Helper()
	useTemporaryQueueDir(t)
	previousDataDir := util.DataDir
	previousWorkspaceDir := util.WorkspaceDir
	previousConf := Conf
	util.DataDir = t.TempDir()
	util.WorkspaceDir = util.DataDir
	Conf = NewAppConf()
	Conf.Editor = conf.NewEditor()
	Conf.FileTree = conf.NewFileTree()
	Conf.Search = conf.NewSearch()
	Conf.Sync = conf.NewSync()
	t.Cleanup(func() {
		Conf = previousConf
		util.DataDir = previousDataDir
		util.WorkspaceDir = previousWorkspaceDir
	})

	boxID = "20990101120000-assets1"
	assetsDir = filepath.Join(util.DataDir, boxID, "assets")
	confDir := filepath.Join(util.DataDir, boxID, ".siyuan")
	if err := os.MkdirAll(assetsDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(confDir, 0755); err != nil {
		t.Fatal(err)
	}
	boxConf := conf.NewBoxConf()
	boxConf.Encrypted = true
	confData, err := gulu.JSON.MarshalIndentJSON(boxConf, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(confDir, "conf.json"), confData, 0644); err != nil {
		t.Fatal(err)
	}
	dek, err := util.GenerateDEK()
	if err != nil {
		t.Fatal(err)
	}
	setDEKForTest(boxID, dek)
	t.Cleanup(func() {
		LockBox(boxID)
		assetNameMappingLocks.Delete(boxID)
	})
	return
}

func TestEncryptedFileAnnotationCommitBlocksLockUntilMutationAndSyncScheduling(t *testing.T) {
	for _, test := range []struct {
		name   string
		remove bool
	}{
		{name: "write"},
		{name: "remove", remove: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			boxID, assetsDir := setupEncryptedAssetStoreTest(t)
			annotationPath := filepath.Join(assetsDir, "asset.pdf.sya")
			if test.remove {
				if err := CommitFileAnnotation(annotationPath, []byte(`{"pages":{"1":[]}}`), false); err != nil {
					t.Fatalf("seed encrypted annotation: %v", err)
				}
			}

			previousAcceptedHook := fileAnnotationCommitOwnedHook
			previousAdmissionBlockedHook := lockBoxAdmissionBlockedHook
			commitAccepted := make(chan struct{})
			allowMutation := make(chan struct{})
			admissionBlocked := make(chan struct{})
			var acceptedOnce, blockedOnce, releaseOnce sync.Once
			releaseMutation := func() { releaseOnce.Do(func() { close(allowMutation) }) }
			fileAnnotationCommitOwnedHook = func(candidateBoxID string) {
				if candidateBoxID == boxID {
					acceptedOnce.Do(func() { close(commitAccepted) })
					<-allowMutation
				}
			}
			lockBoxAdmissionBlockedHook = func(candidateBoxID string) {
				if candidateBoxID == boxID {
					blockedOnce.Do(func() { close(admissionBlocked) })
				}
			}

			mutationExited := make(chan struct{})
			lockExited := make(chan struct{})
			lockLaunched := false
			t.Cleanup(func() {
				releaseMutation()
				fileAnnotationCommitOwnedHook = previousAcceptedHook
				lockBoxAdmissionBlockedHook = previousAdmissionBlockedHook
				select {
				case <-mutationExited:
				case <-time.After(5 * time.Second):
					t.Error("annotation mutation did not exit during cleanup")
				}
				if lockLaunched {
					select {
					case <-lockExited:
					case <-time.After(5 * time.Second):
						t.Error("LockBox did not exit during cleanup")
					}
				}
			})

			mutationDone := make(chan error, 1)
			go func() {
				defer close(mutationExited)
				mutationDone <- CommitFileAnnotation(annotationPath, []byte(`{"pages":{"2":[]}}`), test.remove)
			}()
			select {
			case <-commitAccepted:
			case <-time.After(5 * time.Second):
				t.Fatal("annotation mutation did not acquire content ownership")
			}

			lockDone := make(chan error, 1)
			lockLaunched = true
			go func() {
				defer close(lockExited)
				lockDone <- LockBox(boxID)
			}()
			select {
			case <-admissionBlocked:
			case <-time.After(5 * time.Second):
				t.Fatal("LockBox did not wait on the accepted annotation mutation")
			}
			select {
			case err := <-lockDone:
				t.Fatalf("LockBox completed before annotation mutation release: %v", err)
			default:
			}

			releaseMutation()
			select {
			case err := <-mutationDone:
				if err != nil {
					t.Fatalf("commit annotation mutation: %v", err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("annotation mutation did not finish")
			}
			select {
			case err := <-lockDone:
				if err != nil {
					t.Fatalf("lock encrypted notebook after annotation mutation: %v", err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("LockBox did not finish after annotation mutation")
			}

			_, statErr := os.Stat(annotationPath)
			if test.remove && !os.IsNotExist(statErr) {
				t.Fatalf("removed annotation still exists after lock: %v", statErr)
			}
			if !test.remove && statErr != nil {
				t.Fatalf("written annotation missing after lock: %v", statErr)
			}
		})
	}
}

func TestEncryptedAssetStoreAndSearchShareCommitSnapshot(t *testing.T) {
	boxID, assetsDir := setupEncryptedAssetStoreTest(t)
	previousCommitHook := encryptedAssetCommitAfterFileWriteHook
	previousSearchHook := encryptedAssetSearchBlockedHook
	assetWritten := make(chan struct{})
	releaseCommit := make(chan struct{})
	searchBlocked := make(chan struct{})
	writerExited := make(chan struct{})
	searchExited := make(chan struct{})
	searchLaunched := false
	var assetWrittenOnce, searchBlockedOnce, releaseCommitOnce sync.Once
	releaseCommitBarrier := func() { releaseCommitOnce.Do(func() { close(releaseCommit) }) }
	encryptedAssetCommitAfterFileWriteHook = func(candidateBoxID string) {
		if candidateBoxID == boxID {
			assetWrittenOnce.Do(func() { close(assetWritten) })
			<-releaseCommit
		}
	}
	encryptedAssetSearchBlockedHook = func(candidateBoxID string) {
		if candidateBoxID == boxID {
			searchBlockedOnce.Do(func() { close(searchBlocked) })
		}
	}
	t.Cleanup(func() {
		releaseCommitBarrier()
		<-writerExited
		if searchLaunched {
			<-searchExited
		}
		encryptedAssetCommitAfterFileWriteHook = previousCommitHook
		encryptedAssetSearchBlockedHook = previousSearchHook
	})

	type storeResult struct {
		diskName string
		err      error
	}
	writerDone := make(chan storeResult, 1)
	go func() {
		defer close(writerExited)
		diskName, err := StoreAssetForBox(boxID, assetsDir, "asset.txt", []byte("asset-content"))
		writerDone <- storeResult{diskName: diskName, err: err}
	}()
	select {
	case <-assetWritten:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for encrypted asset file write")
	}

	type searchResult struct {
		assets []*cache.Asset
		err    error
	}
	searchDone := make(chan searchResult, 1)
	searchLaunched = true
	go func() {
		defer close(searchExited)
		HoldBoxReadLock(boxID)
		defer ReleaseBoxReadLock(boxID)
		assets, err := SearchAssetsByNameInBoxLocked("asset", nil, boxID)
		searchDone <- searchResult{assets: assets, err: err}
	}()
	select {
	case <-searchBlocked:
		releaseCommitBarrier()
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for encrypted asset search commit lock")
	}

	stored := <-writerDone
	if stored.err != nil {
		t.Fatalf("store encrypted asset failed: %v", stored.err)
	}
	searched := <-searchDone
	if searched.err != nil {
		t.Fatalf("search encrypted asset snapshot: %v", searched.err)
	}
	if len(searched.assets) != 1 || !strings.Contains(searched.assets[0].Path, stored.diskName+"?box="+boxID) {
		t.Fatalf("search snapshot = %#v, want committed asset %s", searched.assets, stored.diskName)
	}
	plain, err := ReadAssetBytesInBox(boxID, searched.assets[0].Path)
	if err != nil {
		t.Fatalf("read encrypted asset [%s] failed: %v", searched.assets[0].Path, err)
	}
	if string(plain) != "asset-content" {
		t.Fatalf("unexpected encrypted asset content: %q", plain)
	}
}

func TestEncryptedAssetMappingWriteFailureRollsBackAssetFile(t *testing.T) {
	boxID, assetsDir := setupEncryptedAssetStoreTest(t)
	previousCommitHook := encryptedAssetCommitAfterFileWriteHook
	mappingPath := assetNameMappingPath(boxID)
	var mappingSetupErr error
	encryptedAssetCommitAfterFileWriteHook = func(candidateBoxID string) {
		if candidateBoxID == boxID {
			mappingSetupErr = os.Mkdir(mappingPath, 0755)
		}
	}
	t.Cleanup(func() { encryptedAssetCommitAfterFileWriteHook = previousCommitHook })

	if _, err := StoreAssetForBox(boxID, assetsDir, "rollback.txt", []byte("rollback-content")); err == nil {
		t.Fatal("encrypted asset store succeeded after the name-map destination became a directory")
	}
	if mappingSetupErr != nil {
		t.Fatalf("create real name-map rename failure: %v", mappingSetupErr)
	}
	entries, err := os.ReadDir(assetsDir)
	if err != nil {
		t.Fatalf("read encrypted asset directory after rejected commit: %v", err)
	}
	for _, entry := range entries {
		if entry.Name() != ".names.json" {
			t.Fatalf("rejected encrypted asset commit left partial file %q", entry.Name())
		}
	}
}

func TestRemoveUnusedAssetRejectsEncryptedNotebookAsset(t *testing.T) {
	boxID, assetsDir := setupEncryptedAssetStoreTest(t)
	diskName, err := StoreAssetForBox(boxID, assetsDir, "protected.txt", []byte("protected"))
	if err != nil {
		t.Fatalf("store encrypted asset: %v", err)
	}
	mappingBefore, err := os.ReadFile(assetNameMappingPath(boxID))
	if err != nil {
		t.Fatalf("read encrypted asset mapping: %v", err)
	}
	paths := []string{
		filepath.ToSlash(filepath.Join(boxID, "assets", diskName)),
		"assets/" + diskName + "?box=" + boxID,
	}
	for _, relativePath := range paths {
		removed, removeErr := RemoveUnusedAsset(relativePath)
		if !errors.Is(removeErr, ErrEncryptedAssetCleanupUnsupported) {
			t.Fatalf("remove encrypted asset [%s] error = %v, want %v", relativePath, removeErr, ErrEncryptedAssetCleanupUnsupported)
		}
		if removed != "" {
			t.Fatalf("remove encrypted asset [%s] returned removed path %q", relativePath, removed)
		}
	}
	if _, statErr := os.Stat(filepath.Join(assetsDir, diskName)); statErr != nil {
		t.Fatalf("encrypted asset changed after rejected cleanup: %v", statErr)
	}
	mappingAfter, err := os.ReadFile(assetNameMappingPath(boxID))
	if err != nil {
		t.Fatalf("read encrypted asset mapping after rejected cleanup: %v", err)
	}
	if !bytes.Equal(mappingAfter, mappingBefore) {
		t.Fatal("encrypted asset mapping changed after rejected cleanup")
	}
}

func TestStoreAssetForOrdinaryWorkspaceRemainsPlaintext(t *testing.T) {
	assetsDir := t.TempDir()
	diskName, err := StoreAssetForBox("", assetsDir, "ordinary.txt", []byte("plain"))
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(assetsDir, diskName))
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "plain" {
		t.Fatalf("ordinary asset content = %q, want plaintext", data)
	}
}

func TestUploadRejectsEncryptedAssetPathAsNotebookIdentity(t *testing.T) {
	boxID, _ := setupEncryptedAssetStoreTest(t)
	otherBoxID := "20990101120000-assets2"
	otherAssetsDir := filepath.Join(util.DataDir, otherBoxID, "assets")
	if err := os.MkdirAll(otherAssetsDir, 0755); err != nil {
		t.Fatal(err)
	}
	otherConf := conf.NewBoxConf()
	otherConf.Encrypted = true
	otherConfData, err := gulu.JSON.MarshalIndentJSON(otherConf, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	otherConfDir := filepath.Join(util.DataDir, otherBoxID, ".siyuan")
	if err = os.MkdirAll(otherConfDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(otherConfDir, "conf.json"), otherConfData, 0644); err != nil {
		t.Fatal(err)
	}

	previousMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(previousMode) })
	router := gin.New()
	router.POST("/api/asset/upload", Upload)

	for _, test := range []struct {
		name   string
		fields map[string]string
	}{
		{
			name: "encrypted path cannot select notebook",
			fields: map[string]string{
				"assetsDirPath": filepath.ToSlash(filepath.Join(otherBoxID, "assets")),
			},
		},
		{
			name: "declared notebook must match encrypted path",
			fields: map[string]string{
				"notebook":      boxID,
				"assetsDirPath": filepath.ToSlash(filepath.Join(otherBoxID, "assets")),
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			var body bytes.Buffer
			writer := multipart.NewWriter(&body)
			for key, value := range test.fields {
				if err := writer.WriteField(key, value); err != nil {
					t.Fatal(err)
				}
			}
			if err := writer.Close(); err != nil {
				t.Fatal(err)
			}

			request := httptest.NewRequest(http.MethodPost, "/api/asset/upload", &body)
			request.Header.Set("Content-Type", writer.FormDataContentType())
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			if response.Code != http.StatusOK {
				t.Fatalf("HTTP status = %d, want 200", response.Code)
			}
			var result struct {
				Code int `json:"code"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			if result.Code != -1 {
				t.Fatalf("result code = %d, want -1", result.Code)
			}
		})
	}
}
