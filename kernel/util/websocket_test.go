// SiYuan - Refactor your thinking
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

package util

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/olahol/melody"
)

func TestProtyleDocumentEventPayloadsCarryExplicitIdentity(t *testing.T) {
	const (
		notebookID = "20990719000000-eventbox"
		documentID = "20990719000001-eventdoc"
	)

	loading, err := json.Marshal(ProtyleDocumentIdentity{NotebookID: notebookID, DocumentID: documentID})
	if err != nil {
		t.Fatalf("marshal loading payload: %v", err)
	}
	unfold, err := json.Marshal(ProtyleUnfoldHeadingData{
		ProtyleDocumentIdentity: ProtyleDocumentIdentity{NotebookID: notebookID, DocumentID: documentID},
		ID:                      "20990719000002-eventhead",
		CurrentNodeID:           "20990719000003-eventnode",
	})
	if err != nil {
		t.Fatalf("marshal unfold payload: %v", err)
	}
	for name, payload := range map[string][]byte{"loading": loading, "unfold": unfold} {
		t.Run(name, func(t *testing.T) {
			var data map[string]any
			if err := json.Unmarshal(payload, &data); err != nil {
				t.Fatalf("decode %s payload: %v", name, err)
			}
			if data["notebookId"] != notebookID || data["documentId"] != documentID {
				t.Fatalf("%s payload = %#v, want explicit notebookId/documentId", name, data)
			}
			if _, hasLegacyRootID := data["rootID"]; hasLegacyRootID {
				t.Fatalf("%s payload retained legacy rootID: %#v", name, data)
			}
		})
	}
}

func TestProtyleMoveDocumentPayloadCarriesSourceIdentity(t *testing.T) {
	payload, err := json.Marshal(ProtyleMoveDocumentData{
		DocumentID:   "20990719000004-movedoc",
		FromNotebook: "20990719000005-sourcebox",
		FromPath:     "/source.sy",
		ToNotebook:   "20990719000006-targetbox",
		ToPath:       "/target.sy",
		NewPath:      "/target",
	})
	if err != nil {
		t.Fatalf("marshal move document payload: %v", err)
	}
	var data map[string]any
	if err = json.Unmarshal(payload, &data); err != nil {
		t.Fatalf("decode move document payload: %v", err)
	}
	if data["documentId"] != "20990719000004-movedoc" || data["fromNotebook"] != "20990719000005-sourcebox" ||
		data["fromPath"] != "/source.sy" || data["toNotebook"] != "20990719000006-targetbox" ||
		data["toPath"] != "/target.sy" || data["newPath"] != "/target" {
		t.Fatalf("move document payload = %#v, want explicit source and destination fields", data)
	}
	if _, hasLegacyID := data["id"]; hasLegacyID {
		t.Fatalf("move document payload retained legacy id: %#v", data)
	}
}

func TestPushReloadProtyleBroadcastsOneStoreAwarePayloadShape(t *testing.T) {
	server := melody.New()
	connected := make(chan struct{})
	disconnected := make(chan struct{})
	var connectOnce, disconnectOnce sync.Once
	server.HandleConnect(func(session *melody.Session) {
		identity, identityErr := ParsePushChannelIdentity(session.Request)
		if identityErr != nil {
			t.Errorf("parse push channel identity: %v", identityErr)
			return
		}
		if identityErr = AddPushChan(session, identity); identityErr != nil {
			t.Errorf("add push channel: %v", identityErr)
			return
		}
		connectOnce.Do(func() { close(connected) })
	})
	server.HandleDisconnect(func(session *melody.Session) {
		RemovePushChan(session)
		disconnectOnce.Do(func() { close(disconnected) })
	})
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(writer http.ResponseWriter, request *http.Request) {
		if err := server.HandleRequest(writer, request); err != nil {
			t.Errorf("handle websocket request: %v", err)
		}
	})
	httpServer := httptest.NewServer(mux)
	t.Cleanup(httpServer.Close)

	query := url.Values{"app": {"reload-contract"}, "id": {"reload-contract"}, "type": {"protyle"}}
	endpoint := "ws" + strings.TrimPrefix(httpServer.URL, "http") + "/ws?" + query.Encode()
	connection, _, err := websocket.DefaultDialer.Dial(endpoint, nil)
	if err != nil {
		t.Fatalf("connect reload websocket: %v", err)
	}
	t.Cleanup(func() {
		_ = connection.Close()
		select {
		case <-disconnected:
		case <-time.After(5 * time.Second):
			t.Error("reload websocket session was not removed")
		}
	})
	select {
	case <-connected:
	case <-time.After(5 * time.Second):
		t.Fatal("reload websocket session was not registered")
	}

	const documentID = "20990717180000-reloadx"
	for _, test := range []struct {
		name         string
		notebookID   string
		contentStore string
	}{
		{name: "ordinary global store", notebookID: "20990717180001-reloadx"},
		{name: "encrypted store", notebookID: "20990717180002-reloadx", contentStore: "20990717180002-reloadx"},
	} {
		t.Run(test.name, func(t *testing.T) {
			PushReloadProtyle(test.notebookID, documentID, test.contentStore)
			if err = connection.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
				t.Fatal(err)
			}
			_, payload, readErr := connection.ReadMessage()
			if readErr != nil {
				t.Fatalf("read reload event: %v", readErr)
			}
			var event struct {
				Cmd  string          `json:"cmd"`
				Data json.RawMessage `json:"data"`
			}
			if err = json.Unmarshal(payload, &event); err != nil {
				t.Fatalf("decode reload event: %v", err)
			}
			if event.Cmd != "reload" {
				t.Fatalf("event command = %q, want reload", event.Cmd)
			}
			var data map[string]any
			if err = json.Unmarshal(event.Data, &data); err != nil {
				t.Fatalf("decode reload payload object: %v", err)
			}
			if len(data) != 3 || data["notebookId"] != test.notebookID || data["documentId"] != documentID || data["notebook"] != test.contentStore {
				t.Fatalf("reload payload = %#v, want explicit document identity and selector", data)
			}
			if _, hasLegacyRootID := data["rootID"]; hasLegacyRootID {
				t.Fatalf("reload payload retained legacy rootID: %#v", data)
			}
		})
	}
}
