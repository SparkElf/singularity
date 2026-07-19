// SiYuan - Refactor your thinking
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

package model

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/olahol/melody"
	"github.com/siyuan-note/siyuan/kernel/treenode"
	"github.com/siyuan-note/siyuan/kernel/util"
)

func TestPushReloadQueuePreservesCanonicalNotebookIdentity(t *testing.T) {
	setupPushQueueTestStorage(t)

	const (
		ordinaryBox   = "20990717180105-reloadx"
		ordinaryRoot  = "20990717180100-reloadx"
		encryptedRoot = "20990717180101-reloadx"
		encryptedBox  = "20990717180102-reloadx"
		ordinaryAV    = "20990717180103-reloadx"
		encryptedAV   = "20990717180104-reloadx"
	)
	AppendPushReloadProtyleEntry(ordinaryBox, ordinaryRoot, "")
	AppendPushReloadProtyleEntry(encryptedBox, encryptedRoot, encryptedBox)
	AppendPushReloadAttrViewEntry(ordinaryAV, "")
	AppendPushReloadAttrViewEntry(encryptedAV, encryptedBox)
	entries := loadPushQueue()
	if len(entries) != 4 {
		t.Fatalf("reload queue entries = %#v, want four entries", entries)
	}
	if entries[0].Action != "reloadProtyle" || entries[0].Box != ordinaryBox || entries[0].ID != ordinaryRoot || entries[0].Notebook != "" {
		t.Fatalf("ordinary reload queue entry = %#v", entries[0])
	}
	if entries[1].Action != "reloadProtyle" || entries[1].Box != encryptedBox || entries[1].ID != encryptedRoot || entries[1].Notebook != encryptedBox {
		t.Fatalf("encrypted reload queue entry = %#v", entries[1])
	}
	if entries[2].Action != "reloadAttrView" || entries[2].ID != ordinaryAV || entries[2].Notebook != "" {
		t.Fatalf("ordinary AV reload queue entry = %#v", entries[2])
	}
	if entries[3].Action != "reloadAttrView" || entries[3].ID != encryptedAV || entries[3].Notebook != encryptedBox {
		t.Fatalf("encrypted AV reload queue entry = %#v", entries[3])
	}
}

func TestPushQueueBroadcastsSameRootFromDistinctContentStores(t *testing.T) {
	fixture := setupDerivedContentStoreFixture(t)
	setupPushQueueTestStorage(t)
	connection := openPushQueueWebSocket(t, "protyle")
	const ordinaryBox = "20990717181200-ordinary"
	sharedRoot := fixture.defID
	ordinaryTree := treenode.NewTree(ordinaryBox, "/"+sharedRoot+".sy", "/Ordinary", "Ordinary")
	if err := treenode.UpsertBlockTree(ordinaryTree); err != nil {
		t.Fatalf("index ordinary duplicate root for push queue: %v", err)
	}

	AppendPushReloadProtyleEntry(ordinaryBox, sharedRoot, "")
	AppendPushReloadProtyleEntry(fixture.boxA, sharedRoot, fixture.boxA)
	AppendPushReloadAttrViewEntry(fixture.avID, "")
	AppendPushReloadAttrViewEntry(fixture.avID, fixture.boxA)
	PollPushQueue()

	events := map[string]pushQueueEvent{}
	for range 4 {
		event := readPushQueueEvent(t, connection, 5*time.Second)
		if event.Cmd != "reload" && event.Cmd != "refreshAttributeView" {
			t.Fatalf("push queue command = %q, want reload or refreshAttributeView", event.Cmd)
		}
		notebook := event.Data.Notebook
		if event.Cmd == "refreshAttributeView" {
			notebook = event.Data.BoxID
		}
		events[event.Cmd+"/"+notebook] = event
	}
	if len(events) != 4 {
		t.Fatalf("push queue store events = %#v, want reload and AV events for global and encrypted identities", events)
	}
	for _, notebook := range []string{"", fixture.boxA} {
		event, ok := events["reload/"+notebook]
		expectedNotebookID := ordinaryBox
		if notebook != "" {
			expectedNotebookID = notebook
		}
		if !ok || event.Data.NotebookID != expectedNotebookID || event.Data.DocumentID != sharedRoot {
			t.Fatalf("push queue event for notebook %q = %#v, want root %s", notebook, event, sharedRoot)
		}
		avEvent, ok := events["refreshAttributeView/"+notebook]
		if !ok || avEvent.Data.ID != fixture.avID {
			t.Fatalf("push queue AV event for notebook %q = %#v, want AV %s", notebook, avEvent, fixture.avID)
		}
	}
}

func TestPushQueueDropsEncryptedReloadLockedAfterEnqueue(t *testing.T) {
	fixture := setupDerivedContentStoreFixture(t)
	setupPushQueueTestStorage(t)
	connection := openPushQueueWebSocket(t, "protyle")

	AppendPushReloadProtyleEntry(fixture.boxA, fixture.defID, fixture.boxA)
	AppendPushReloadAttrViewEntry(fixture.avID, fixture.boxA)
	if err := LockBox(fixture.boxA); err != nil {
		t.Fatalf("lock encrypted notebook after push enqueue: %v", err)
	}
	PollPushQueue()
	assertNoPushQueueEvent(t, connection, 250*time.Millisecond)
}

func TestFinalContentEventHandlersDropLockedEncryptedStore(t *testing.T) {
	boxID, _ := setupEncryptedAssetStoreTest(t)
	protyleConnection := openPushQueueWebSocket(t, "protyle")
	mainConnection := openPushQueueWebSocket(t, "main")
	const (
		rootID     = "20990717181300-reloadx"
		avID       = "20990717181301-reloadx"
		blockID    = "20990717181302-reloadx"
		defBlockID = "20990717181303-reloadx"
	)
	util.PushReloadProtyle(boxID, rootID, boxID)
	pushReloadAttrView(avID, boxID)
	util.PushSetRefDynamicText(rootID, blockID, defBlockID, "Encrypted reference", boxID)
	util.PushSetDefRefCount(rootID, blockID, []string{defBlockID}, 2, 1, boxID)
	events := map[string]pushQueueEvent{}
	for _, subscription := range []struct {
		typ      string
		conn     *websocket.Conn
		commands map[string]struct{}
	}{
		{typ: "protyle", conn: protyleConnection, commands: map[string]struct{}{"reload": {}, "refreshAttributeView": {}}},
		{typ: "main", conn: mainConnection, commands: map[string]struct{}{"setRefDynamicText": {}, "setDefRefCount": {}}},
	} {
		for range len(subscription.commands) {
			event := readPushQueueEvent(t, subscription.conn, 5*time.Second)
			if _, ok := subscription.commands[event.Cmd]; !ok {
				t.Fatalf("%s websocket received unexpected command %q", subscription.typ, event.Cmd)
			}
			if _, duplicated := events[event.Cmd]; duplicated {
				t.Fatalf("%s websocket received duplicate command %q", subscription.typ, event.Cmd)
			}
			events[event.Cmd] = event
		}
	}
	if event := events["reload"]; event.Data.NotebookID != boxID || event.Data.DocumentID != rootID || event.Data.Notebook != boxID {
		t.Fatalf("unlocked encrypted reload event = %#v", event)
	}
	if event := events["refreshAttributeView"]; event.Data.ID != avID || event.Data.BoxID != boxID {
		t.Fatalf("unlocked encrypted AV event = %#v", event)
	}
	if event := events["setRefDynamicText"]; event.Data.RootID != rootID || event.Data.BlockID != blockID ||
		event.Data.DefBlockID != defBlockID || event.Data.RefText != "Encrypted reference" || event.Data.BoxID != boxID {
		t.Fatalf("unlocked encrypted dynamic-reference event = %#v", event)
	}
	if event := events["setDefRefCount"]; event.Data.RootID != rootID || event.Data.BlockID != blockID ||
		event.Data.RefCount != 2 || event.Data.RootRefCount != 1 || len(event.Data.DefIDs) != 1 ||
		event.Data.DefIDs[0] != defBlockID || event.Data.BoxID != boxID {
		t.Fatalf("unlocked encrypted reference-count event = %#v", event)
	}

	if err := LockBox(boxID); err != nil {
		t.Fatalf("lock encrypted notebook before final delayed handlers: %v", err)
	}
	util.PushReloadProtyle(boxID, rootID, boxID)
	pushReloadAttrView(avID, boxID)
	util.PushSetRefDynamicText(rootID, blockID, defBlockID, "Encrypted reference", boxID)
	util.PushSetDefRefCount(rootID, blockID, []string{defBlockID}, 2, 1, boxID)
	assertNoPushQueueEvent(t, protyleConnection, 250*time.Millisecond)
	assertNoPushQueueEvent(t, mainConnection, 250*time.Millisecond)
}

func TestEncryptedBroadcastExecutorLinearizesWithLockBox(t *testing.T) {
	boxID, _ := setupEncryptedAssetStoreTest(t)
	broadcastStarted := make(chan struct{})
	releaseBroadcast := make(chan struct{})
	var releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(releaseBroadcast) }) }
	t.Cleanup(release)
	broadcastDone := make(chan struct{})
	go func() {
		util.ExecuteContentStoreBroadcast(boxID, func() {
			close(broadcastStarted)
			<-releaseBroadcast
		})
		close(broadcastDone)
	}()
	select {
	case <-broadcastStarted:
	case <-time.After(5 * time.Second):
		t.Fatal("encrypted broadcast did not acquire the content-store read lock")
	}

	lifecycleBlocked := make(chan string, 1)
	restoreObserver := SetBoxLifecycleWriteBlockedObserverForTest(func(candidateBoxID string) {
		lifecycleBlocked <- candidateBoxID
	})
	t.Cleanup(restoreObserver)
	lockDone := make(chan error, 1)
	go func() { lockDone <- LockBox(boxID) }()
	select {
	case blockedBoxID := <-lifecycleBlocked:
		if blockedBoxID != boxID {
			release()
			t.Fatalf("lifecycle writer blocked for %q, want %q", blockedBoxID, boxID)
		}
	case <-time.After(5 * time.Second):
		release()
		t.Fatal("LockBox did not reach the in-flight broadcast read lock")
	}
	release()
	select {
	case <-broadcastDone:
	case <-time.After(5 * time.Second):
		t.Fatal("encrypted broadcast did not finish after release")
	}
	select {
	case err := <-lockDone:
		if err != nil {
			t.Fatalf("LockBox after encrypted broadcast: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("LockBox did not finish after encrypted broadcast released its read lock")
	}

	lateBroadcast := false
	util.ExecuteContentStoreBroadcast(boxID, func() { lateBroadcast = true })
	if lateBroadcast {
		t.Fatal("encrypted content event executed after LockBox returned")
	}
}

func setupPushQueueTestStorage(t *testing.T) {
	t.Helper()
	previousQueueDir := util.QueueDir
	previousQueuePath := pushQueuePath
	previousFlock := pushFlock
	util.QueueDir = t.TempDir()
	pushQueuePath = ""
	pushFlock = nil
	t.Cleanup(func() {
		select {
		case <-pushNotifyCh:
		default:
		}
		util.QueueDir = previousQueueDir
		pushQueuePath = previousQueuePath
		pushFlock = previousFlock
	})
	select {
	case <-pushNotifyCh:
	default:
	}
}

type pushQueueEvent struct {
	Cmd  string `json:"cmd"`
	Data struct {
		RootID       string   `json:"rootID"`
		Notebook     string   `json:"notebook"`
		NotebookID   string   `json:"notebookId"`
		DocumentID   string   `json:"documentId"`
		ID           string   `json:"id"`
		BoxID        string   `json:"boxID"`
		BlockID      string   `json:"blockID"`
		DefBlockID   string   `json:"defBlockID"`
		RefText      string   `json:"refText"`
		RefCount     int      `json:"refCount"`
		RootRefCount int      `json:"rootRefCount"`
		DefIDs       []string `json:"defIDs"`
	} `json:"data"`
}

func openPushQueueWebSocket(t *testing.T, typ string) *websocket.Conn {
	t.Helper()
	server := melody.New()
	connected := make(chan struct{})
	disconnected := make(chan struct{})
	var connectOnce, disconnectOnce sync.Once
	server.HandleConnect(func(session *melody.Session) {
		identity, identityErr := util.ParsePushChannelIdentity(session.Request)
		if identityErr != nil {
			t.Errorf("parse push channel identity: %v", identityErr)
			return
		}
		if identityErr = util.AddPushChan(session, identity); identityErr != nil {
			t.Errorf("add push channel: %v", identityErr)
			return
		}
		connectOnce.Do(func() { close(connected) })
	})
	server.HandleDisconnect(func(session *melody.Session) {
		util.RemovePushChan(session)
		disconnectOnce.Do(func() { close(disconnected) })
	})
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(writer http.ResponseWriter, request *http.Request) {
		if err := server.HandleRequest(writer, request); err != nil {
			t.Errorf("handle push queue websocket: %v", err)
		}
	})
	httpServer := httptest.NewServer(mux)
	t.Cleanup(httpServer.Close)
	query := url.Values{"app": {"push-queue-contract"}, "id": {"push-queue-contract-" + typ}, "type": {typ}}
	endpoint := "ws" + strings.TrimPrefix(httpServer.URL, "http") + "/ws?" + query.Encode()
	connection, _, err := websocket.DefaultDialer.Dial(endpoint, nil)
	if err != nil {
		t.Fatalf("connect push queue websocket: %v", err)
	}
	t.Cleanup(func() {
		_ = connection.Close()
		select {
		case <-disconnected:
		case <-time.After(5 * time.Second):
			t.Error("push queue websocket session was not removed")
		}
	})
	select {
	case <-connected:
	case <-time.After(5 * time.Second):
		t.Fatal("push queue websocket session was not registered")
	}
	return connection
}

func readPushQueueEvent(t *testing.T, connection *websocket.Conn, timeout time.Duration) pushQueueEvent {
	t.Helper()
	if err := connection.SetReadDeadline(time.Now().Add(timeout)); err != nil {
		t.Fatal(err)
	}
	_, payload, err := connection.ReadMessage()
	if err != nil {
		t.Fatalf("read push queue websocket event: %v", err)
	}
	var event pushQueueEvent
	if err = json.Unmarshal(payload, &event); err != nil {
		t.Fatalf("decode push queue websocket event: %v", err)
	}
	return event
}

func assertNoPushQueueEvent(t *testing.T, connection *websocket.Conn, timeout time.Duration) {
	t.Helper()
	if err := connection.SetReadDeadline(time.Now().Add(timeout)); err != nil {
		t.Fatal(err)
	}
	_, payload, err := connection.ReadMessage()
	if err == nil {
		t.Fatalf("unexpected push queue websocket event: %s", payload)
	}
	if networkErr, ok := err.(net.Error); !ok || !networkErr.Timeout() {
		t.Fatalf("read push queue websocket without event: %v", err)
	}
}
