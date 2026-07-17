// SiYuan - Refactor your thinking
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

package api

import (
	archivezip "archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/88250/lute/ast"
	"github.com/88250/lute/render"
	"github.com/gin-gonic/gin"
	kernelconf "github.com/siyuan-note/siyuan/kernel/conf"
	"github.com/siyuan-note/siyuan/kernel/model"
	"github.com/siyuan-note/siyuan/kernel/treenode"
	"github.com/siyuan-note/siyuan/kernel/util"
)

const encryptedRepoResponsePassword = "response-contract-password"

type encryptedRepoResponseFixture struct {
	boxA       string
	boxB       string
	rootA      string
	rootB      string
	fileA      string
	leftIndex  string
	rightIndex string
}

func TestEncryptedRepoHTTPResponsesHoldGateUntilJSONCompletes(t *testing.T) {
	fixture := setupEncryptedRepoResponseFixture(t)
	router := gin.New()
	router.Use(ContentResponseLifecycle)
	router.POST("/api/repo/openRepoSnapshotFile", openRepoSnapshotFile)
	router.POST("/api/repo/diffRepoSnapshots", diffRepoSnapshots)
	router.POST("/api/repo/searchRepoFile", searchRepoFile)
	router.POST("/api/repo/exportRepoFile", exportRepoFile)

	assertManagedRepoExportDownload(t, router, fixture.fileA, "Repo response alpha v2")

	tests := []struct {
		name          string
		path          string
		payload       map[string]any
		boxID         string
		wantPlaintext string
		managedExport bool
	}{
		{
			name:          "open snapshot",
			path:          "/api/repo/openRepoSnapshotFile",
			payload:       map[string]any{"id": fixture.fileA},
			boxID:         fixture.boxA,
			wantPlaintext: "Repo response alpha v2",
		},
		{
			name:          "diff snapshots",
			path:          "/api/repo/diffRepoSnapshots",
			payload:       map[string]any{"left": fixture.leftIndex, "right": fixture.rightIndex},
			boxID:         fixture.boxB,
			wantPlaintext: "Repo Response Beta",
		},
		{
			name:          "search snapshots",
			path:          "/api/repo/searchRepoFile",
			payload:       map[string]any{"keyword": fixture.rootB, "page": 1},
			boxID:         fixture.boxB,
			wantPlaintext: "Repo Response Beta",
		},
		{
			name:          "export snapshot capability",
			path:          "/api/repo/exportRepoFile",
			payload:       map[string]any{"id": fixture.fileA},
			boxID:         fixture.boxA,
			wantPlaintext: "/export/managed/",
			managedExport: true,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			body, err := json.Marshal(test.payload)
			if err != nil {
				t.Fatal(err)
			}
			request := httptest.NewRequest(http.MethodPost, test.path, bytes.NewReader(body))
			request.Header.Set("Content-Type", "application/json")
			writer := &blockingResponseWriter{
				ResponseRecorder: httptest.NewRecorder(),
				writeStarted:     make(chan struct{}),
				writeRelease:     make(chan struct{}),
			}
			requestDone := make(chan struct{})
			lockDone := make(chan error, 1)
			requestStarted, requestCompleted := false, false
			lockStarted, lockCompleted := false, false
			defer func() {
				writer.release()
				if requestStarted && !requestCompleted {
					select {
					case <-requestDone:
					case <-time.After(responseTestTimeout):
						t.Errorf("repository response request cleanup timed out")
					}
				}
				if lockStarted && !lockCompleted {
					select {
					case lockErr := <-lockDone:
						if lockErr != nil {
							t.Errorf("repository response LockBox cleanup: %v", lockErr)
						}
					case <-time.After(responseTestTimeout):
						t.Errorf("repository response LockBox cleanup timed out")
					}
				}
				if !model.IsBoxUnlocked(test.boxID) {
					boxCrypt := (&model.Box{ID: test.boxID}).GetConf().BoxCrypt
					if unlockErr := model.UnlockBox(test.boxID, encryptedRepoResponsePassword, boxCrypt); unlockErr != nil {
						t.Errorf("unlock repository response notebook during cleanup: %v", unlockErr)
					}
				}
			}()

			requestStarted = true
			go func() {
				router.ServeHTTP(writer, request)
				close(requestDone)
			}()
			waitResponseTestSignal(t, writer.writeStarted, "repository response did not reach JSON serialization")

			writeBlocked := observeBoxResponseWriteBlocked(t, test.boxID)
			lockStarted = true
			go func() { lockDone <- model.LockBox(test.boxID) }()
			waitResponseTestSignal(t, writeBlocked, "LockBox was not blocked by the repository response gate")

			writer.release()
			waitResponseTestSignal(t, requestDone, "repository response did not finish")
			requestCompleted = true
			err = waitResponseTestError(t, lockDone, "LockBox did not finish after the repository JSON body")
			lockCompleted = true
			if err != nil {
				t.Fatalf("LockBox after repository JSON body: %v", err)
			}

			responseBody := writer.Body.String()
			if writer.Code != http.StatusOK || !strings.Contains(responseBody, test.wantPlaintext) {
				t.Fatalf("repository response: status=%d body=%q, want %q", writer.Code, responseBody, test.wantPlaintext)
			}
			if test.managedExport {
				managedPath := repoExportPathFromResponse(t, writer.Body.Bytes())
				claim, claimErr := model.ClaimManagedEncryptedExport(strings.TrimPrefix(managedPath, "/export/"))
				if claim != nil || !errors.Is(claimErr, model.ErrManagedEncryptedExportUnavailable) {
					t.Fatalf("managed repository export survived LockBox: claim=%v err=%v", claim, claimErr)
				}
				if _, statErr := os.Stat(filepath.Join(util.TempDir, "export", "repo")); !os.IsNotExist(statErr) {
					t.Fatalf("encrypted repository export created an ordinary export root: %v", statErr)
				}
			}
		})
	}
}

func setupEncryptedRepoResponseFixture(t *testing.T) encryptedRepoResponseFixture {
	t.Helper()
	boxIDs := setupEncryptedResponseTest(t, 2)
	previousRepoDir := util.RepoDir
	util.RepoDir = filepath.Join(util.WorkspaceDir, "repo")
	t.Cleanup(func() { util.RepoDir = previousRepoDir })
	model.Conf.Repo = kernelconf.NewRepo()
	model.Conf.Repo.Key = bytes.Repeat([]byte{0x5a}, 32)

	fixture := encryptedRepoResponseFixture{
		boxA:  boxIDs[0],
		boxB:  boxIDs[1],
		rootA: "20990717180000-repoaaa",
		rootB: "20990717180001-repobbb",
	}
	baseTime := time.Now().Add(-time.Minute).Truncate(time.Second)
	writeEncryptedRepoResponseTree(t, fixture.boxA, fixture.rootA, "Repo Response Alpha", "Repo response alpha v1", baseTime)
	writeEncryptedRepoResponseTree(t, fixture.boxB, fixture.rootB, "Repo Response Beta", "Repo response beta v1", baseTime)
	var err error
	fixture.rightIndex, err = model.IndexRepo("encrypted repository response fixture v1")
	if err != nil {
		t.Fatalf("index first encrypted repository response snapshot: %v", err)
	}

	updatedTime := baseTime.Add(2 * time.Second)
	writeEncryptedRepoResponseTree(t, fixture.boxA, fixture.rootA, "Repo Response Alpha", "Repo response alpha v2", updatedTime)
	writeEncryptedRepoResponseTree(t, fixture.boxB, fixture.rootB, "Repo Response Beta", "Repo response beta v2", updatedTime)
	fixture.leftIndex, err = model.IndexRepo("encrypted repository response fixture v2")
	if err != nil {
		t.Fatalf("index second encrypted repository response snapshot: %v", err)
	}
	if fixture.leftIndex == fixture.rightIndex {
		t.Fatal("encrypted repository response fixture did not create distinct snapshots")
	}
	fixture.fileA = latestEncryptedRepoResponseFile(t, fixture.rootA, fixture.boxA)
	return fixture
}

func writeEncryptedRepoResponseTree(t *testing.T, boxID, rootID, title, content string, updated time.Time) {
	t.Helper()
	treePath := "/" + rootID + ".sy"
	tree := treenode.NewTree(boxID, treePath, "/"+title, title)
	tree.Root.FirstChild.Unlink()
	tree.Root.ID = rootID
	tree.ID = rootID
	tree.Root.SetIALAttr("id", rootID)
	tree.Root.SetIALAttr("title", title)
	childID := rootID[:14] + "-repochild"
	child := &ast.Node{Type: ast.NodeParagraph, ID: childID, Box: boxID, Path: treePath}
	child.SetIALAttr("id", childID)
	child.SetIALAttr("updated", childID[:14])
	child.AppendChild(&ast.Node{Type: ast.NodeText, Tokens: []byte(content)})
	tree.Root.AppendChild(child)
	tree.Root.Spec = "1"
	luteEngine := util.NewLute()
	plaintext := render.NewJSONRenderer(tree, luteEngine.RenderOptions, luteEngine.ParseOptions).Render()
	dek, err := model.GetDEK(boxID)
	if err != nil {
		t.Fatalf("get encrypted repository response key: %v", err)
	}
	ciphertext, err := model.EncryptFile(boxID, treePath, dek, plaintext)
	clear(dek)
	if err != nil {
		t.Fatalf("encrypt repository response tree: %v", err)
	}
	filePath := filepath.Join(util.DataDir, boxID, treePath)
	if err = os.MkdirAll(filepath.Dir(filePath), 0700); err != nil {
		t.Fatalf("create encrypted repository response tree directory: %v", err)
	}
	if err = os.WriteFile(filePath, ciphertext, 0600); err != nil {
		t.Fatalf("write encrypted repository response tree: %v", err)
	}
	if err = os.Chtimes(filePath, updated, updated); err != nil {
		t.Fatalf("set encrypted repository response tree timestamp: %v", err)
	}
}

func latestEncryptedRepoResponseFile(t *testing.T, rootID, boxID string) string {
	t.Helper()
	files, _, _, err := model.SearchRepoFile(rootID, 1)
	if err != nil {
		t.Fatalf("search encrypted repository response fixture [%s]: %v", rootID, err)
	}
	for _, file := range files {
		if strings.HasPrefix(strings.TrimPrefix(file.Path, "/"), boxID+"/") {
			return file.FileID
		}
	}
	t.Fatalf("encrypted repository response fixture [%s] has no repository file", rootID)
	return ""
}

func assertManagedRepoExportDownload(t *testing.T, router http.Handler, fileID, wantPlaintext string) {
	t.Helper()
	payload, err := json.Marshal(map[string]any{"id": fileID})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/repo/exportRepoFile", bytes.NewReader(payload))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	managedPath := repoExportPathFromResponse(t, response.Body.Bytes())
	if !strings.HasPrefix(managedPath, "/export/managed/") {
		t.Fatalf("encrypted repository export path = %q, want managed capability", managedPath)
	}
	claim, err := model.ClaimManagedEncryptedExport(strings.TrimPrefix(managedPath, "/export/"))
	if err != nil {
		t.Fatalf("claim encrypted repository export: %v", err)
	}
	defer func() {
		if closeErr := claim.Close(); closeErr != nil {
			t.Errorf("close encrypted repository export claim: %v", closeErr)
		}
	}()
	info, err := claim.File.Stat()
	if err != nil {
		t.Fatalf("stat encrypted repository export: %v", err)
	}
	archive, err := archivezip.NewReader(claim.File, info.Size())
	if err != nil {
		t.Fatalf("open encrypted repository export archive: %v", err)
	}
	for _, entry := range archive.File {
		reader, openErr := entry.Open()
		if openErr != nil {
			t.Fatal(openErr)
		}
		data, readErr := io.ReadAll(reader)
		closeErr := reader.Close()
		if readErr != nil || closeErr != nil {
			t.Fatalf("read encrypted repository export entry: %v", errors.Join(readErr, closeErr))
		}
		if strings.Contains(string(data), wantPlaintext) {
			return
		}
	}
	t.Fatalf("encrypted repository export archive does not contain %q", wantPlaintext)
}

func repoExportPathFromResponse(t *testing.T, body []byte) string {
	t.Helper()
	var result struct {
		Code int    `json:"code"`
		Msg  string `json:"msg"`
		Data struct {
			Path string `json:"path"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		t.Fatalf("decode repository export response: %v", err)
	}
	if result.Code != 0 || result.Data.Path == "" {
		t.Fatalf("repository export response = %#v", result)
	}
	return result.Data.Path
}
