package collab

// Bridge 是隔离测试内容模型与语义 reducer 的边界，不向生产 Kernel 路由注册任何入口。
type Bridge struct {
	state   *State
	history []OperationEnvelope
}

func NewBridge(identity DocumentIdentity) (*Bridge, error) {
	state, err := NewState(identity)
	if err != nil {
		return nil, err
	}
	return &Bridge{state: state}, nil
}

// Apply 将已授权的操作提交到隔离内容模型，并仅把已接受操作追加到原型历史。
func (bridge *Bridge) Apply(envelope OperationEnvelope) Result {
	result := bridge.state.Apply(envelope)
	if result.Outcome == OutcomeAccepted {
		bridge.history = append(bridge.history, envelope)
	}
	return result
}

func (bridge *Bridge) State() *State {
	return bridge.state
}

func (bridge *Bridge) History() []OperationEnvelope {
	return append([]OperationEnvelope(nil), bridge.history...)
}

// Replay 在新的隔离状态中按历史顺序重放，验证历史与实时结果保持一致。
func (bridge *Bridge) Replay() (*Bridge, error) {
	replayed, err := NewBridge(bridge.state.Identity)
	if err != nil {
		return nil, err
	}
	for _, envelope := range bridge.history {
		if result := replayed.Apply(envelope); result.Outcome != OutcomeAccepted {
			return nil, &ReplayError{OperationID: envelope.OperationID, Result: result}
		}
	}
	return replayed, nil
}

type ReplayError struct {
	OperationID string
	Result      Result
}

func (err *ReplayError) Error() string {
	return "replay operation " + err.OperationID + " failed with " + string(err.Result.Code)
}
