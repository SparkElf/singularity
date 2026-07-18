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

	const rootID = "20990717180000-reloadx"
	for _, test := range []struct {
		name     string
		notebook string
	}{
		{name: "ordinary global store"},
		{name: "encrypted store", notebook: "20990717180001-reloadx"},
	} {
		t.Run(test.name, func(t *testing.T) {
			PushReloadProtyle(rootID, test.notebook)
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
			if len(data) != 2 || data["rootID"] != rootID || data["notebook"] != test.notebook {
				t.Fatalf("reload payload = %#v, want rootID %q and notebook %q only", data, rootID, test.notebook)
			}
		})
	}
}
