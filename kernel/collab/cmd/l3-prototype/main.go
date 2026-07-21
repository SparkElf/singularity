// l3-prototype 是测试协调器使用的 JSON Lines 语义核心进程，不注册 Kernel HTTP 路由。
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"

	"github.com/siyuan-note/siyuan/kernel/collab"
)

type request struct {
	Action   string                   `json:"action"`
	Identity collab.DocumentIdentity  `json:"identity"`
	Envelope collab.OperationEnvelope `json:"envelope"`
}

type response struct {
	Error  string         `json:"error,omitempty"`
	Result *collab.Result `json:"result,omitempty"`
	State  *stateSnapshot `json:"state,omitempty"`
}

type stateSnapshot struct {
	Blocks    map[string]*collab.Block `json:"blocks"`
	Conflicts []collab.ConflictRecord  `json:"conflicts"`
	Version   collab.VersionVector     `json:"version"`
}

func main() {
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 4*1024), 4*1024*1024)
	encoder := json.NewEncoder(os.Stdout)
	var bridge *collab.Bridge
	for scanner.Scan() {
		var input request
		if err := json.Unmarshal(scanner.Bytes(), &input); err != nil {
			write(encoder, response{Error: err.Error()})
			continue
		}
		switch input.Action {
		case "init":
			created, err := collab.NewBridge(input.Identity)
			if err != nil {
				write(encoder, response{Error: err.Error()})
				continue
			}
			bridge = created
			write(encoder, response{State: snapshot(bridge)})
		case "apply":
			if bridge == nil {
				write(encoder, response{Error: "semantic core is not initialized"})
				continue
			}
			result := bridge.Apply(input.Envelope)
			write(encoder, response{Result: &result, State: snapshot(bridge)})
		default:
			write(encoder, response{Error: fmt.Sprintf("unknown action %q", input.Action)})
		}
	}
	if err := scanner.Err(); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, err)
	}
}

func snapshot(bridge *collab.Bridge) *stateSnapshot {
	state := bridge.State()
	return &stateSnapshot{Blocks: state.Blocks, Conflicts: state.ConflictsSnapshot(), Version: state.Version}
}

func write(encoder *json.Encoder, value response) {
	if err := encoder.Encode(value); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, err)
	}
}
