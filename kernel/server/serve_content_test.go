// SiYuan - Refactor your thinking
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

package server

import (
	"bytes"
	"compress/gzip"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/siyuan-note/siyuan/kernel/api"
	"github.com/siyuan-note/siyuan/kernel/model"
	"github.com/siyuan-note/siyuan/kernel/util"
)

type gzipFooterBlockingResponseWriter struct {
	recorder        *httptest.ResponseRecorder
	handlerReturned <-chan struct{}
	footerStarted   chan struct{}
	release         chan struct{}
	startOnce       sync.Once
	releaseOnce     sync.Once
}

func newGzipFooterBlockingResponseWriter(handlerReturned <-chan struct{}) *gzipFooterBlockingResponseWriter {
	return &gzipFooterBlockingResponseWriter{
		recorder:        httptest.NewRecorder(),
		handlerReturned: handlerReturned,
		footerStarted:   make(chan struct{}),
		release:         make(chan struct{}),
	}
}

func (writer *gzipFooterBlockingResponseWriter) Header() http.Header {
	return writer.recorder.Header()
}

func (writer *gzipFooterBlockingResponseWriter) WriteHeader(status int) {
	writer.recorder.WriteHeader(status)
}

func (writer *gzipFooterBlockingResponseWriter) Write(data []byte) (int, error) {
	select {
	case <-writer.handlerReturned:
		writer.startOnce.Do(func() { close(writer.footerStarted) })
		<-writer.release
	default:
	}
	return writer.recorder.Write(data)
}

func (writer *gzipFooterBlockingResponseWriter) Release() {
	writer.releaseOnce.Do(func() { close(writer.release) })
}

func readGzipResponse(t *testing.T, response *httptest.ResponseRecorder) string {
	t.Helper()
	reader, err := gzip.NewReader(bytes.NewReader(response.Body.Bytes()))
	if err != nil {
		t.Fatalf("open gzip response: %v", err)
	}
	data, readErr := io.ReadAll(reader)
	closeErr := reader.Close()
	if err = errors.Join(readErr, closeErr); err != nil {
		t.Fatalf("read gzip response: %v", err)
	}
	return string(data)
}

func TestEncryptedStaticResponsesHoldGateUntilBodyCompletes(t *testing.T) {
	tests := []struct {
		name        string
		content     string
		preparePath func(t *testing.T, boxID, content string) string
		serve       func(*gin.Context, string) bool
	}{
		{
			name:    "svg asset",
			content: `<svg xmlns="http://www.w3.org/2000/svg"><text>svg-response-contract</text></svg>`,
			preparePath: func(t *testing.T, boxID, content string) string {
				return writeEncryptedServerAsset(t, boxID, "response.svg", content)
			},
			serve: serveSVG,
		},
		{
			name:    "binary asset",
			content: "asset-response-contract",
			preparePath: func(t *testing.T, boxID, content string) string {
				return writeEncryptedServerAsset(t, boxID, "response.txt", content)
			},
			serve: serveEncryptedAsset,
		},
		{
			name:        "history",
			content:     "history-response-contract",
			preparePath: writeEncryptedServerHistory,
			serve:       serveEncryptedHistory,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			boxID, _ := setupManagedExportDownloadTest(t)
			absPath := test.preparePath(t, boxID, test.content)
			router := gin.New()
			router.Use(api.ContentResponseLifecycle)
			router.GET("/content", func(context *gin.Context) {
				if !test.serve(context, absPath) {
					context.Status(http.StatusInternalServerError)
				}
			})

			response := newBlockingBodyResponseWriter()
			t.Cleanup(response.Release)
			requestDone := make(chan struct{})
			go func() {
				router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/content", nil))
				close(requestDone)
			}()
			waitManagedExportSignal(t, response.started, "encrypted response body did not start")

			lockDone := make(chan error, 1)
			writeBlocked := observeServerBoxResponseWriteBlocked(t, boxID)
			go func() { lockDone <- model.LockBox(boxID) }()
			waitManagedExportSignal(t, writeBlocked, "LockBox was not blocked by the encrypted response body")

			response.Release()
			waitManagedExportSignal(t, requestDone, "encrypted response did not finish")
			select {
			case err := <-lockDone:
				if err != nil {
					t.Fatalf("LockBox after encrypted response: %v", err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("LockBox did not finish after encrypted response")
			}
			if response.recorder.Code != http.StatusOK || !strings.Contains(response.recorder.Body.String(), test.content) {
				t.Fatalf("encrypted response: status=%d body=%q", response.recorder.Code, response.recorder.Body.String())
			}
		})
	}
}

func TestEncryptedRepoDiffResponseHoldsGateThroughGzipFooter(t *testing.T) {
	boxID, _ := setupManagedExportDownloadTest(t)
	content := "encrypted-repository-diff-response"
	filePath := filepath.Join(util.TempDir, "repo", "diff", boxID, "preview.txt")
	if err := os.MkdirAll(filepath.Dir(filePath), 0700); err != nil {
		t.Fatalf("create repository diff fixture directory: %v", err)
	}
	if err := os.WriteFile(filePath, []byte(content), 0600); err != nil {
		t.Fatalf("write repository diff fixture: %v", err)
	}

	handlerReturned := make(chan struct{})
	var handlerReturnedOnce sync.Once
	router := gin.New()
	router.Use(func(c *gin.Context) {
		c.Set(model.RoleContextKey, model.RoleAdministrator)
		c.Next()
	})
	router.Use(contentResponseMiddlewares()...)
	router.Use(func(c *gin.Context) {
		c.Next()
		handlerReturnedOnce.Do(func() { close(handlerReturned) })
	})
	serveRepoDiff(router)

	response := newGzipFooterBlockingResponseWriter(handlerReturned)
	t.Cleanup(response.Release)
	request := httptest.NewRequest(http.MethodGet, "/repo/diff/"+boxID+"/preview.txt", nil)
	request.Header.Set("Accept-Encoding", "gzip")
	request.RemoteAddr = "127.0.0.1:12345"
	requestDone := make(chan struct{})
	go func() {
		router.ServeHTTP(response, request)
		close(requestDone)
	}()
	waitManagedExportSignal(t, response.footerStarted, "repository diff response did not reach gzip finalization")

	lockDone := make(chan error, 1)
	writeBlocked := observeServerBoxResponseWriteBlocked(t, boxID)
	go func() { lockDone <- model.LockBox(boxID) }()
	waitManagedExportSignal(t, writeBlocked, "LockBox was not blocked by the repository diff gzip footer")

	response.Release()
	waitManagedExportSignal(t, requestDone, "repository diff gzip response did not finish")
	select {
	case err := <-lockDone:
		if err != nil {
			t.Fatalf("LockBox after repository diff gzip response: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("LockBox did not finish after repository diff gzip response")
	}
	body := readGzipResponse(t, response.recorder)
	if response.recorder.Code != http.StatusOK || body != content {
		t.Fatalf("repository diff gzip response: status=%d body=%q", response.recorder.Code, body)
	}
}

func writeEncryptedServerAsset(t *testing.T, boxID, name, content string) string {
	t.Helper()
	assetsDir := filepath.Join(util.DataDir, boxID, "assets")
	if err := os.MkdirAll(assetsDir, 0755); err != nil {
		t.Fatalf("create encrypted asset directory: %v", err)
	}
	diskName, err := model.StoreAssetForBox(boxID, assetsDir, name, []byte(content))
	if err != nil {
		t.Fatalf("store encrypted asset: %v", err)
	}
	return filepath.Join(assetsDir, diskName)
}

func writeEncryptedServerHistory(t *testing.T, boxID, content string) string {
	t.Helper()
	previousHistoryDir := util.HistoryDir
	util.HistoryDir = filepath.Join(util.WorkspaceDir, "history")
	t.Cleanup(func() { util.HistoryDir = previousHistoryDir })

	const relativePath = "/20990717143000-history.sy"
	dek, err := model.GetDEK(boxID)
	if err != nil {
		t.Fatalf("get encrypted history key: %v", err)
	}
	ciphertext, err := model.EncryptFile(boxID, relativePath, dek, []byte(content))
	clear(dek)
	if err != nil {
		t.Fatalf("encrypt history: %v", err)
	}
	historyPath := filepath.Join(util.HistoryDir, "2099-07-17-143000-update", boxID, relativePath)
	if err = os.MkdirAll(filepath.Dir(historyPath), 0755); err != nil {
		t.Fatalf("create encrypted history directory: %v", err)
	}
	if err = os.WriteFile(historyPath, ciphertext, 0600); err != nil {
		t.Fatalf("write encrypted history: %v", err)
	}
	return historyPath
}
