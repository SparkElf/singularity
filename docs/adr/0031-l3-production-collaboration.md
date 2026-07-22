---
title: "ADR-031: L3.1 生产实时协作边界"
description: "确定奇点首期生产实时协作的事实源、单副本部署、加密限制和发布策略"
author: "Codex"
date: "2026-07-22"
version: "1.0.0"
status: "verified"
tags: ["adr", "l3.1", "collaboration", "production"]
---

# ADR-031: L3.1 生产实时协作边界

## Status

Verified：用户已批准首期单副本部署、加密内容库受限协作及其余 L3.1 默认范围；实现、代码复评、测试治理复评和集中验证均已完成。

## Context

L3.0 已证明思源块语义可以在隔离原型中通过增量操作、因果合并、历史、撤销、presence、断线和撤权保持一致，但生产 Protyle WebSocket 仍只接收推送。直接把原型或浏览器 CRDT 接入生产，会产生第二正文事实源、绕过现有 ACL、破坏加密内容边界或让迟到响应覆盖当前文档。

L3.1 需要在不重写 Go Kernel、不开启多副本复杂度的前提下，提供第一版可灰度的企业实时协作。

## Decision

1. **生产范围**：首期只支持桌面 Web 同文档协作，包含已验证的文本、块树、引用、嵌入、AV 单元格、历史、撤销、presence、重连和冲突状态；移动端、离线无限编辑、跨文档原子操作和附件并发另行评审。
2. **唯一正文事实源**：Go Kernel 拥有正文、块、AV、历史和 canonical operation log。Nest/PostgreSQL 不保存第二份正文、CRDT 快照或 operation payload。
3. **传输边界**：新增独立双向协作 WSS 合同；既有 Protyle 只接收推送的 WebSocket 不接受浏览器正文命令，也不被包装成协作协议。
4. **单副本部署**：首期使用单 API 副本、单空间 Kernel 协作通道和进程内 connection/coordinator registry；不引入 Redis、NATS 或跨副本广播。API 重启后 presence 丢弃，客户端从 Kernel canonical history 缺口恢复。
5. **权限 owner**：复用 L2 `DocumentAccessPolicy` 和 `AccessChanged` 提交通知。协作入口重验 capability；协调器不复制权限算法。撤权提交后关闭旧会话，迟到消息不得广播。
6. **加密内容**：加密库默认关闭实时协作。只有管理员显式开启受限协作、成员具有当前文档授权且 Go Kernel 内容会话可用密钥时才允许加入。密钥不进入 PostgreSQL、审计、日志或浏览器持久化；零知识 E2E 协作不在本 ADR 范围。
7. **一致性**：不使用整篇快照覆盖、锁、LWW、静默冲突丢弃或明文 fallback。不可无损合并的操作必须产生可观察冲突或稳定拒绝。
8. **声明式装配**：Nest 使用 `@Module`、DI provider、Guard、Pipe、Interceptor 和 operation handler metadata 发现协作能力；同一操作版本冲突时启动失败，不维护第二套中央 registry。
9. **发布**：以功能开关、内部试用和灰度指标控制开放范围。关闭开关后新会话拒绝，旧会话收敛到只读/关闭；不切换备用地址，不伪造成功。

## Data Flow

```text
React/Protyle semantic action
  -> dedicated WSS + contract parser
  -> existing session/ACL owner
  -> in-process coordinator (single API replica)
  -> Go Kernel semantic reducer and canonical history
  -> canonical result/broadcast to authorized sessions
```

控制面只拥有认证、ACL、开关、会话元数据和审计；Kernel 拥有正文和历史；浏览器只拥有当前编辑器视图、会话临时状态和用户未确认引用。四段内容身份贯穿每个跨边界载荷。

## Alternatives

- **浏览器 Yjs/Automerge + Kernel 快照双写**：拒绝。会产生第二正文事实源，块引用、AV、历史和加密内容无法保持同一语义。
- **继续复用只接收推送的 Protyle WS**：拒绝。传输没有并发操作合同，且扩大浏览器可写权限。
- **PostgreSQL 保存 operation payload**：拒绝。会把内容历史复制到控制面，且加密库可能泄露操作明文。
- **首期直接多副本 + Redis/NATS**：拒绝。用户已批准单副本；跨副本恢复、顺序和撤权广播应另立 ADR，不在本期预留兼容分支。
- **加密内容降级为只读旧快照或明文**：拒绝。用户可见结果必须是明确不可协作，不能隐藏数据流分叉。
- **重写 Go Kernel 为 Rust/TypeScript**：拒绝。当前风险是生产接入和语义保持，不是语言能力；重写会扩大事实源和验证面。

## Consequences

### 正面

- 内容、历史和加密处理仍在 Kernel 内闭合，避免第二正文事实源。
- 单副本让连接、presence、撤权和恢复状态易于证明，部署依赖少。
- 专用 WSS 不改变既有 Protyle 推送安全边界，旧路径可以结构化审计和删除。
- 受限加密模式不给出不真实的 E2E 承诺，失败语义可观察。

### 成本与风险

- 单副本不是水平扩展方案，容量达到上限时必须灰度关闭或另立多副本 ADR。
- 重启会丢失 presence，所有客户端需要重新加入；这是可接受的临时状态代价。
- 语义冲突需要前端可见状态和后续处理流程，不能用 LWW 简化 UI。
- Kernel bridge、真实 WSS 和加密 admission 的联调成本高于独立原型，但可保留历史和权限证据。

## Implementation Checklist

- [x] L3.1 PRD、架构方案和实施计划完成并链接本 ADR。
- [x] contracts、OpenAPI、拒绝码和四段身份生产合同冻结。
- [x] Go Kernel production bridge、canonical history replay 和加密 admission 完成。
- [x] Nest 专用协作 WSS、单副本 registry、ACL 撤权和声明式 handler discovery 完成。
- [x] React/Protyle host、Zustand 会话状态、冲突和受限加密 UI 完成。
- [x] 集中 code-review + test-governance 复评通过。
- [x] 唯一 `pnpm verify:l3-production` aggregate 通过，验证报告已归档。

## References

1. [L3.1 产品需求](../product/l3.1-realtime-collaboration.md)
2. [L3.1 架构方案](../architecture/l3.1-realtime-collaboration.md)
3. [L3.0 语义协作原型 ADR](0030-l3-semantic-collaboration-prototype.md)
4. [L2 异步协作 ADR](0029-l2-async-collaboration-boundary.md)
5. [实时协作技术门禁 ADR](0006-realtime-collaboration-gate.md)
6. [L3.1 集中验证报告](../verification/l3.1-realtime-collaboration.md)
