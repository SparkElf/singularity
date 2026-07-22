---
title: "ADR-030: L3.0 语义协作原型边界"
description: "确定实时协作原型的操作事实、Go Kernel 归属、因果合并和生产隔离边界"
author: "Codex"
date: "2026-07-22"
version: "1.0.0"
status: "verified"
tags: ["adr", "l3", "collaboration", "crdt", "prototype"]
---

# ADR-030: L3.0 语义协作原型边界

## Status

Verified：L3.0 PRD、架构方案和本 ADR 已完成复评，原型实现和唯一验证入口已通过；原型路径仍不接入默认生产入口，生产实时协作由已独立验证的 L3.1 方案定义。

## Context

L2 通过异步评论、提及、通知、历史和文档 ACL 完成企业控制面协作，但生产 Protyle WebSocket 仍只接收推送，正文和历史继续由 Go Kernel 拥有。直接把 Yjs、Automerge 或现有 transaction 广播接入生产，会把块树、块引用、嵌入、属性视图、历史和撤销拆成两套事实，且无法解释并发删除/移动/撤销。

L3 必须先证明语义操作能在不同到达顺序下收敛，不能用锁或最后写入获胜掩盖冲突。原型还必须保持 L2 的显式四段内容身份和 ACL 重新授权合同。

## Decision

1. L3.0 只建立独立语义原型，不修改生产 WebSocket、Gateway、React 默认路由、Prisma schema 或 Go Kernel 生产 HTTP 合同。
2. 原型正文操作使用显式 `operationId + clientId + clientSequence + causalContext + DocumentIdentity` 封装；不传整篇最终正文，不复制 `userId`/权限字段作为第二事实源。
3. 语义 reducer 和内容 bridge 放在 Go Kernel 侧，利用现有 block/AV/history 模型；TypeScript 只提供协议 schema、测试协调器和浏览器原型壳，不重写 Go Kernel 为 Rust/TypeScript。
4. 并发操作必须交换、保留 tombstone 或形成显式 conflict record；禁止锁、LWW、静默丢失和隐式 fallback。无法无损合并的移动、AV schema 或引用身份冲突必须拒绝或进入可观察冲突状态。
5. 历史使用原型 append-only operation log 和可重建 checkpoint；撤销生成当前客户端操作的 inverse operation，经同一 reducer 处理，不能直接覆盖当前文档。
6. presence/光标只走短生命周期内存/TTL 流，不进正文历史、PostgreSQL 或 Kernel 内容存储。
7. 任何生产候选都必须在 L3.0 全部验收后另立 L3.1 方案和 ADR；L3.0 通过不等于生产功能已交付。

## Data Flow

```text
test/browser client
  -> contracts parse (four-part identity)
  -> prototype coordinator + existing ACL result
  -> Go semantic reducer
  -> accepted / duplicate / rejected result
  -> canonical operation broadcast to authorized clients
  -> bridge applies only to isolated Kernel content fixture
```

正文事实只在隔离 Kernel 内容模型中存在；协调器拥有操作因果和会话生命周期；presence 只在内存 TTL 中存在。任何跨边界失败都带 `operationId`、四段身份和完整异常 stack，但不记录正文或令牌。

## Alternatives

- **浏览器完整 CRDT + Kernel 快照双写**：拒绝。会产生第二正文事实源，快照与块/AV/历史可能分叉。
- **服务器锁定文档**：拒绝。无法满足同时编辑，且把冲突转为人为等待，不解决历史和撤销。
- **最后写入获胜**：拒绝。静默丢弃已确认操作，无法形成可追踪历史。
- **继续广播现有 transaction**：拒绝。只有传输，没有并发语义；到达顺序会被误当成用户意图。
- **立刻重写为 Rust**：拒绝。L3 风险在内容语义和协议，不在语言；Go Kernel 已是内容事实源，跨语言重写会扩大验证面。

## Consequences

- L3.0 前期没有生产用户功能，但能以较小边界验证最危险的内容语义。
- Go semantic core 需要定义稳定操作类型、因果版本和冲突结果；这比 LWW 复杂，但失败结果诚实且可重放。
- 原型不会污染 L2 控制面数据库和生产 WebSocket；生产化需要另行解决部署、扩展、持久化、ACL 撤权和客户端升级。
- 普通块、引用、嵌入、AV、历史和撤销已全部无损通过，L3.1 已完成独立评审；后续多副本、移动端和零知识协作仍需新方案和 ADR。

## Implementation Checklist

- [x] L3.0 PRD、架构和本 ADR 评审通过。
- [x] contracts 操作/确认/presence schema 与四段身份完成。
- [x] Go semantic reducer、因果合并、冲突记录和 inverse operation 完成。
- [x] Kernel block/AV/history bridge 在隔离夹具中完成。
- [x] 两客户端协议、重复/乱序/断线/撤权和完整日志合同完成。
- [x] 浏览器原型覆盖 DOM 结果、presence 和撤销状态。
- [x] 唯一 `pnpm verify:l3-prototype` 聚合通过。
- [x] L3.1 生产候选方案另行评审；不把原型路径接入默认生产入口。

## References

1. [L3.0 实时协作语义原型 PRD](../product/l3-realtime-collaboration.md)
2. [L3.0 实时协作语义原型架构方案](../architecture/l3-realtime-collaboration.md)
3. [ADR-006：实时协作技术门禁](0006-realtime-collaboration-gate.md)
4. [ADR-029：L2 异步协作控制面边界](0029-l2-async-collaboration-boundary.md)
5. [L3.1 生产实时协作 ADR](0031-l3-production-collaboration.md)
6. [L3.1 集中验证报告](../verification/l3.1-realtime-collaboration.md)
