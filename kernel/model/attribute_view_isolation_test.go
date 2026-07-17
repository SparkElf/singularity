package model

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/88250/gulu"
	"github.com/siyuan-note/siyuan/kernel/av"
	"github.com/siyuan-note/siyuan/kernel/cache"
	"github.com/siyuan-note/siyuan/kernel/conf"
	"github.com/siyuan-note/siyuan/kernel/util"
)

func TestEncryptedAttributeViewRenderingFailsClosed(t *testing.T) {
	previousDataDir := util.DataDir
	previousConf := Conf
	util.DataDir = t.TempDir()
	Conf = NewAppConf()
	Conf.FileTree = conf.NewFileTree()
	t.Cleanup(func() {
		Conf = previousConf
		util.DataDir = previousDataDir
	})

	const boxID = "20260716020101-abcdefg"
	confDir := filepath.Join(util.DataDir, boxID, ".siyuan")
	if err := os.MkdirAll(confDir, 0755); err != nil {
		t.Fatalf("create encrypted notebook config dir: %v", err)
	}
	boxConf := conf.NewBoxConf()
	boxConf.Encrypted = true
	data, err := gulu.JSON.MarshalIndentJSON(boxConf, "", "  ")
	if err != nil {
		t.Fatalf("marshal encrypted notebook config: %v", err)
	}
	if err = os.WriteFile(filepath.Join(confDir, "conf.json"), data, 0644); err != nil {
		t.Fatalf("write encrypted notebook config: %v", err)
	}

	const avID = "20260716020102-abcdefg"
	_, _, err = RenderAttributeViewInBox(boxID, "", avID, "", "", 1, -1, nil, true, false)
	if !errors.Is(err, ErrEncryptedAttributeViewUnsupported) {
		t.Fatalf("current render error = %v, want ErrEncryptedAttributeViewUnsupported", err)
	}
	if _, statErr := os.Stat(filepath.Join(util.DataDir, "storage", "av", avID+".json")); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("encrypted render created a global AV: %v", statErr)
	}

	_, _, err = RenderHistoryAttributeViewInBox(boxID, "", avID, "", "", 1, -1, nil, "invalid-created")
	if !errors.Is(err, ErrEncryptedAttributeViewUnsupported) {
		t.Fatalf("history render error = %v, want ErrEncryptedAttributeViewUnsupported", err)
	}
}

func TestHistoryAttributeViewRenderingDoesNotPersistSnapshot(t *testing.T) {
	previousDataDir := util.DataDir
	previousHistoryDir := util.HistoryDir
	previousLang := util.Lang
	previousAttrViewLangs := util.AttrViewLangs
	root := t.TempDir()
	util.DataDir = filepath.Join(root, "data")
	util.HistoryDir = filepath.Join(root, "history")
	util.Lang = "test"
	util.AttrViewLangs = map[string]map[string]any{
		"test": {"table": "Table", "key": "Key", "select": "Select"},
	}
	t.Cleanup(func() {
		util.AttrViewLangs = previousAttrViewLangs
		util.Lang = previousLang
		util.HistoryDir = previousHistoryDir
		util.DataDir = previousDataDir
	})

	const avID = "20260716020103-abcdefg"
	created := time.Now().Unix()
	historyDir := filepath.Join(util.HistoryDir, time.Unix(created, 0).Format("2006-01-02-150405")+"-test")
	avDir := filepath.Join(historyDir, "storage", "av")
	if err := os.MkdirAll(avDir, 0755); err != nil {
		t.Fatalf("create history AV dir: %v", err)
	}
	attrView := av.NewAttributeView(avID)
	historyView := av.NewTableView()
	attrView.Views = append(attrView.Views, historyView)
	data, err := gulu.JSON.MarshalJSON(attrView)
	if err != nil {
		t.Fatalf("marshal history AV: %v", err)
	}
	if err = os.WriteFile(filepath.Join(avDir, avID+".json"), data, 0644); err != nil {
		t.Fatalf("write history AV: %v", err)
	}

	if _, _, err = RenderHistoryAttributeView("", avID, historyView.ID, "", 1, -1, nil, fmt.Sprint(created)); err != nil {
		t.Fatalf("render history AV: %v", err)
	}
	if _, err = os.Stat(filepath.Join(util.DataDir, "storage", "av", avID+".json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("history render persisted the snapshot into current data: %v", err)
	}
}

func TestHistoryAttributeViewMissingSnapshotDoesNotFallbackToCurrent(t *testing.T) {
	previousDataDir := util.DataDir
	previousHistoryDir := util.HistoryDir
	root := t.TempDir()
	util.DataDir = filepath.Join(root, "data")
	util.HistoryDir = filepath.Join(root, "history")
	cache.ClearAVCache()
	t.Cleanup(func() {
		cache.ClearAVCache()
		util.HistoryDir = previousHistoryDir
		util.DataDir = previousDataDir
	})

	const avID = "20260716020106-abcdefg"
	current := &av.AttributeView{Spec: av.CurrentSpec, ID: avID, RenderedViewables: map[string]av.Viewable{}}
	if err := av.SaveAttributeView(current); err != nil {
		t.Fatalf("save current AV: %v", err)
	}
	created := time.Now().Add(-time.Hour).Unix()
	historyDir := filepath.Join(util.HistoryDir, time.Unix(created, 0).Format("2006-01-02-150405")+"-test")
	if err := os.MkdirAll(historyDir, 0755); err != nil {
		t.Fatalf("create history dir: %v", err)
	}

	_, _, err := RenderHistoryAttributeView("", avID, "", "", 1, -1, nil, fmt.Sprint(created))
	if !errors.Is(err, av.ErrAttributeViewNotFound) {
		t.Fatalf("history render error = %v, want ErrAttributeViewNotFound", err)
	}
}

func TestDuplicateDatabaseBlockUsesStructuredIdentityAndCreatesMirror(t *testing.T) {
	previousDataDir := util.DataDir
	util.DataDir = t.TempDir()
	cache.ClearAVCache()
	t.Cleanup(func() {
		cache.ClearAVCache()
		util.DataDir = previousDataDir
	})

	const avID = "20260716020104-abcdefg"
	const relationKeyID = "20260716020105-abcdefg"
	name := "database name contains " + avID
	attrView := &av.AttributeView{
		Spec: av.CurrentSpec,
		ID:   avID,
		Name: name,
		KeyValues: []*av.KeyValues{{Key: &av.Key{
			ID: relationKeyID, Type: av.KeyTypeRelation,
			Relation: &av.Relation{AvID: avID},
		}}},
		RenderedViewables: map[string]av.Viewable{},
	}
	if err := av.SaveAttributeView(attrView); err != nil {
		t.Fatalf("save source AV: %v", err)
	}

	newAvID, newBlockID, err := DuplicateDatabaseBlock(avID)
	if err != nil {
		t.Fatalf("duplicate database block: %v", err)
	}
	duplicated, err := av.ParseAttributeView(newAvID)
	if err != nil {
		t.Fatalf("parse duplicated AV: %v", err)
	}
	if !strings.Contains(duplicated.Name, name) {
		t.Fatalf("duplicated name = %q, want original literal %q", duplicated.Name, name)
	}
	if got := duplicated.KeyValues[0].Key.Relation.AvID; got != newAvID {
		t.Fatalf("self relation AV ID = %q, want %q", got, newAvID)
	}
	if got := av.GetBlockRels()[newAvID]; len(got) != 1 || got[0] != newBlockID {
		t.Fatalf("duplicated mirror = %v, want [%s]", got, newBlockID)
	}
}
