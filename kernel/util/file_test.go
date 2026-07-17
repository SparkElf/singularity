package util

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestResolveLocalExportFilePathResolvesNestedEscapedBasename(t *testing.T) {
	previousTempDir := TempDir
	TempDir = t.TempDir()
	t.Cleanup(func() { TempDir = previousTempDir })

	got, err := ResolveLocalExportFilePath("/export/random/name%20x.zip")
	if err != nil {
		t.Fatalf("resolve export download path: %v", err)
	}
	want := filepath.Join(TempDir, "export", "random", "name x.zip")
	if got != want {
		t.Fatalf("resolved export path = %q, want %q", got, want)
	}
}

func TestResolveLocalExportFilePathRejectsInvalidAndEscapingPaths(t *testing.T) {
	for _, downloadPath := range []string{
		"",
		"/downloads/export.zip",
		"/export/",
		"/export/%2e%2e",
		"/export/%2e%2e%2fsecret.zip",
		"/export/nested%5cexport.zip",
		"/export/%zz",
	} {
		t.Run(downloadPath, func(t *testing.T) {
			if resolved, err := ResolveLocalExportFilePath(downloadPath); err == nil {
				t.Fatalf("unsafe download path resolved to %q", resolved)
			}
		})
	}
}

func TestPublishFileFailurePreservesDestinationAndCleansPartial(t *testing.T) {
	dir := t.TempDir()
	destination := filepath.Join(dir, "existing.zip")
	if err := os.WriteFile(destination, []byte("existing"), 0600); err != nil {
		t.Fatal(err)
	}
	copyErr := errors.New("source read failed")

	err := PublishFile(&failingPublishReader{err: copyErr}, 0644, destination)
	if !errors.Is(err, copyErr) {
		t.Fatalf("publish error = %v, want %v", err, copyErr)
	}
	content, err := os.ReadFile(destination)
	if err != nil || string(content) != "existing" {
		t.Fatalf("existing destination changed: content=%q err=%v", content, err)
	}
	assertNoPublishPartials(t, dir)
}

func TestPublishFileReplacesCompletedDestination(t *testing.T) {
	dir := t.TempDir()
	destination := filepath.Join(dir, "nested", "export.zip")

	if err := PublishFile(strings.NewReader("completed"), 0640, destination); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(destination)
	if err != nil || string(content) != "completed" {
		t.Fatalf("published destination: content=%q err=%v", content, err)
	}
	info, err := os.Stat(destination)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0640 {
		t.Fatalf("published mode = %o, want %o", got, 0640)
	}
	assertNoPublishPartials(t, filepath.Dir(destination))
}

func TestPublishFilePathRejectsSameFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "export.zip")
	if err := os.WriteFile(path, []byte("completed"), 0600); err != nil {
		t.Fatal(err)
	}

	if err := PublishFilePath(path, path); err == nil {
		t.Fatal("publishing a file onto itself unexpectedly succeeded")
	}
	content, err := os.ReadFile(path)
	if err != nil || string(content) != "completed" {
		t.Fatalf("same-file publish changed source: content=%q err=%v", content, err)
	}
}

type failingPublishReader struct {
	err  error
	done bool
}

func (reader *failingPublishReader) Read(buffer []byte) (int, error) {
	if reader.done {
		return 0, reader.err
	}
	reader.done = true
	return copy(buffer, "partial"), reader.err
}

func assertNoPublishPartials(t *testing.T, dir string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".siyuan-export-partial-") {
			t.Fatalf("publish partial remained: %s", entry.Name())
		}
	}
}
