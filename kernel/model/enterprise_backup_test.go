package model

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/siyuan-note/siyuan/kernel/util"
)

type enterpriseBackupTestEntry struct {
	mode os.FileMode
	name string
	data []byte
}

func writeEnterpriseBackupTestArchive(
	t *testing.T,
	manifest *EnterpriseBackupManifest,
	entries []enterpriseBackupTestEntry,
) (string, string) {
	t.Helper()
	archivePath := filepath.Join(t.TempDir(), "backup.zip")
	file, err := os.Create(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	writer := zip.NewWriter(file)
	manifestHeader := &zip.FileHeader{Name: "manifest.json", Method: zip.Store}
	manifestHeader.SetMode(0600)
	manifestWriter, err := writer.CreateHeader(manifestHeader)
	if err != nil {
		t.Fatal(err)
	}
	if err = json.NewEncoder(manifestWriter).Encode(manifest); err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		header := &zip.FileHeader{Name: entry.name, Method: zip.Store}
		header.SetMode(entry.mode)
		entryWriter, createErr := writer.CreateHeader(header)
		if createErr != nil {
			t.Fatal(createErr)
		}
		if _, err = entryWriter.Write(entry.data); err != nil {
			t.Fatal(err)
		}
	}
	if err = writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err = file.Close(); err != nil {
		t.Fatal(err)
	}
	digestFile, err := os.Open(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.New()
	if _, err = io.Copy(digest, digestFile); err != nil {
		_ = digestFile.Close()
		t.Fatal(err)
	}
	if err = digestFile.Close(); err != nil {
		t.Fatal(err)
	}
	return archivePath, hex.EncodeToString(digest.Sum(nil))
}

func validEnterpriseBackupTestManifest(data []byte, path string) *EnterpriseBackupManifest {
	digest := sha256.Sum256(data)
	return &EnterpriseBackupManifest{
		CreatedAt:     time.Date(2026, 7, 18, 0, 0, 0, 0, time.UTC),
		Entries:       []*EnterpriseBackupEntry{{
			Path: path, SHA256: hex.EncodeToString(digest[:]), SizeBytes: int64(len(data)), Type: "file",
		}},
		FileCount:     1,
		FormatVersion: EnterpriseBackupFormatVersion,
		KernelVersion: util.Ver,
		SourceSpaceID: "space-contract",
		TotalSizeBytes: int64(len(data)),
	}
}

func TestEnterpriseBackupArchiveRoundTripAndDigestContract(t *testing.T) {
	data := []byte("enterprise backup contract")
	manifest := validEnterpriseBackupTestManifest(data, "data/docs/readme.txt")
	archivePath, digest := writeEnterpriseBackupTestArchive(t, manifest, []enterpriseBackupTestEntry{{
		mode: os.FileMode(0600),
		name: "data/docs/readme.txt",
		data: data,
	}})

	validated, err := ValidateEnterpriseBackupArchive(archivePath, digest, EnterpriseRestoreLimits{
		MaximumArchiveBytes: 1 << 20,
		MaximumEntryBytes:   1 << 20,
		MaximumFiles:        10,
		MaximumTotalBytes:   1 << 20,
	})
	if err != nil {
		t.Fatalf("validate backup archive: %v", err)
	}
	if validated.SourceSpaceID != manifest.SourceSpaceID || validated.FileCount != 1 {
		t.Fatalf("validated manifest = %#v", validated)
	}

	destination := filepath.Join(t.TempDir(), "restored")
	extracted, err := ExtractEnterpriseBackupArchive(archivePath, destination, digest, EnterpriseRestoreLimits{
		MaximumArchiveBytes: 1 << 20,
		MaximumEntryBytes:   1 << 20,
		MaximumFiles:        10,
		MaximumTotalBytes:   1 << 20,
	})
	if err != nil {
		t.Fatalf("extract backup archive: %v", err)
	}
	if extracted.FileCount != 1 {
		t.Fatalf("extracted manifest = %#v", extracted)
	}
	restored, err := os.ReadFile(filepath.Join(destination, "data", "docs", "readme.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if string(restored) != string(data) {
		t.Fatalf("restored content = %q", restored)
	}
}

func TestEnterpriseBackupArchiveRejectsPathSymlinkAndDigestViolations(t *testing.T) {
	data := []byte("unsafe archive")
	cases := []struct {
		name  string
		entry enterpriseBackupTestEntry
		path  string
	}{
		{
			name:  "path traversal",
			entry: enterpriseBackupTestEntry{mode: 0600, name: "data/../escape", data: data},
			path:  "data/../escape",
		},
		{
			name:  "backslash path",
			entry: enterpriseBackupTestEntry{mode: 0600, name: "data\\escape", data: data},
			path:  "data\\escape",
		},
		{
			name:  "symbolic link",
			entry: enterpriseBackupTestEntry{mode: os.ModeSymlink | 0777, name: "data/link", data: []byte("target")},
			path:  "data/link",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			manifest := validEnterpriseBackupTestManifest(data, testCase.path)
			archivePath, digest := writeEnterpriseBackupTestArchive(t, manifest, []enterpriseBackupTestEntry{testCase.entry})
			_, err := ValidateEnterpriseBackupArchive(archivePath, digest, EnterpriseRestoreLimits{
				MaximumArchiveBytes: 1 << 20,
				MaximumEntryBytes:   1 << 20,
				MaximumFiles:        10,
				MaximumTotalBytes:   1 << 20,
			})
			if err == nil || !errors.Is(err, ErrEnterpriseBackupInvalid) {
				t.Fatalf("validation error = %v, want ErrEnterpriseBackupInvalid", err)
			}
		})
	}

	manifest := validEnterpriseBackupTestManifest(data, "data/valid.txt")
	archivePath, digest := writeEnterpriseBackupTestArchive(t, manifest, []enterpriseBackupTestEntry{{
		mode: 0600,
		name: "data/valid.txt",
		data: data,
	}})
	if _, err := ValidateEnterpriseBackupArchive(archivePath, strings.Repeat("0", sha256.Size*2), EnterpriseRestoreLimits{
		MaximumArchiveBytes: 1 << 20,
		MaximumEntryBytes:   1 << 20,
		MaximumFiles:        10,
		MaximumTotalBytes:   1 << 20,
	}); err == nil || !errors.Is(err, ErrEnterpriseBackupInvalid) {
		t.Fatalf("digest mismatch error = %v", err)
	}
	if digest == "" {
		t.Fatal("test archive digest is empty")
	}
}
