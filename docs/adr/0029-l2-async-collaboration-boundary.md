---
title: "ADR-029: L2异步协作控制面边界"
description: "确定评论、提及、通知、文档级权限与版本历史在Nest控制面和Go Kernel之间的事实源边界"
author: "Codex"
date: "2026-07-21"
version: "1.0.0"
status: "verified"
tags: ["adr", "l2", "collaboration", "permissions", "history"]
---

# ADR-029: L2异步协作控制面边界

## Status

Verified：L2 生产实现、永久测试、代码复评、test-governance 和统一 verification 已完成；静态、控制面、Kernel、构建、单 worker 三视口 browser integration 与 P5 E2E 均通过。

## Context

L1 已建立服务器权威内容、空间隔离、文档三 ID 内容链、分享、审计、备份和声明式 Worker。L2 需要补评论、`@` 提及、通知、文档级权限和版本历史。如果把评论或 ACL 写入 `.sy`，或把正文/历史复制到 PostgreSQL，会形成第二事实源；如果用 WebSocket 推送通知或编辑事件，会提前进入 ADR-006 保护的 L3 实时协作范围。

现有 Nest 模块化单体、Prisma/PostgreSQL、Kernel Gateway、审计写入器、React Query/shadcn 和 Worker 声明式发现已经能承载 L2，不需要新消息总线或新服务。

## Decision

1. 评论线程、评论正文、文档 ACL grant、站内通知收件箱和协作审计属于 NestJS/PostgreSQL 控制面；正文、块、Kernel history 内容和版本 opaque ID仍由 Go Kernel 拥有。
2. 所有 L2 内容请求显式携带 `organizationId + spaceId + notebookId + documentId`；块评论额外携带 Kernel 返回的 `anchorBlockId`。不从标题、路径、DOM、全局状态、首响应或相邻块推断。
3. 文档 ACL 只有 `inherit` 和 `restricted` 两态；受限模式使用 user/group grant 和 `viewer/commenter/editor`，不支持 deny 规则。组织 owner/admin 与 space admin 保留管理访问。ACL 提交后关闭该文档全部 pending/active Kernel WebSocket，所有连接在重连时重新授权，以一致性优先于保留仍有权限用户的旧连接。
4. 评论、提及通知、ACL 变更、历史恢复和审计在同一控制面事务中提交；通知以持久化 inbox row 表达，React 使用 Query refresh/有界轮询，不新增实时 WebSocket 通知通道。
5. 版本列表、差异和恢复复用现有 Gateway 与 Kernel history 路由。恢复只创建新的当前版本并写审计，不覆盖或删除旧版本，不在 PostgreSQL 保存正文。
6. API 使用 Nest 原生 Controller/Guard/Pipe/DI；ACL policy、CommentService、NotificationService 和 AuditWriter 是各自唯一 owner。不得增加中央 switch、手工 registry、同义 DTO 或兼容 fallback。
7. L2 不新增 Worker handler。只有外部邮件等未来渠道经独立产品和架构评审批准后，才使用现有声明式 Worker job；站内通知不依赖 Worker 才可见。

## Data Flow

```text
React form/query
  -> contracts + Zod ingress
  -> authenticated HTTP/WS boundary
  -> DocumentAccessPolicy
  -> Comment/ACL/Notification use case
  -> PostgreSQL transaction + AuditWriter
  -> canonical response / Query invalidation

React history action
  -> contracts + DocumentAccessPolicy
  -> existing Gateway (mTLS + service JWT + explicit three IDs)
  -> Go Kernel history/restore
  -> canonical result + audit/notification transaction
```

评论、ACL 和通知不穿过 Kernel；正文和历史不进入控制面数据库。每个边界只验证自己拥有的合同，下游消费已收敛状态。

## Alternatives

- **把评论/ACL写入Kernel**：拒绝。企业权限和通知需要 PostgreSQL 事务、组织复合约束和审计，写入 `.sy` 会形成双事实源。
- **把正文/历史快照复制到PostgreSQL**：拒绝。复制会破坏服务器权威内容和空间 Kernel 隔离，且增加恢复一致性成本。
- **使用WebSocket实时通知**：拒绝。L2只要求可追踪异步协作；实时通道会混入L3在线状态、排序和断线重放问题。
- **新增CQRS/Event Sourcing或专用微服务**：拒绝。现有模块化单体已提供事务边界，事件溯源会重复评论/ACL事实并扩大测试面。
- **用deny/allow优先级表达文档权限**：拒绝。`inherit/restricted + grant`足以覆盖L2，减少策略状态和冲突解释。
- **为外部通知提前增加Worker**：拒绝。站内收件箱可在同一事务可靠生成；外部渠道另行评审，不让未来需求污染主路径。

## Consequences

- L2 评论、权限和通知具有同一 PostgreSQL 事务可见性、审计序列和恢复语义。
- 站内通知不是实时的，页面依赖刷新和有界轮询；产品文案不得暗示即时广播。
- 文档 ACL 会让现有分享在每次读取时重新经过当前权限判断，增加一次控制面查询，但避免公开链接绕过受限文档。
- Kernel history 继续遵循现有内容身份和服务认证合同；L2 不需要重写 Go Kernel。
- L3 若采用 CRDT，必须另行解决正文操作排序、历史/撤销、在线状态和冲突合并，不能沿用本 ADR 的异步通知语义。

## Implementation Checklist

- [x] L2 PRD 与架构方案经产品/架构评审通过。
- [x] contracts、OpenAPI 和复合外键迁移完成并接入统一入口。
- [x] ACL、评论、通知和历史 API/React 调用方完成，旧路径和 fallback 删除。
- [x] 集中 code-review + test-governance 通过。
- [x] L2 统一 verification 矩阵中的三视口 browser integration 聚合完全通过；P5 纵向合同已通过。
- [x] 权威方案、计划和本 ADR 更新为 verified，并提交推送。

## References

1. [L2 异步协作产品需求](../product/l2-async-collaboration.md)
2. [L2 异步协作架构方案](../architecture/l2-async-collaboration.md)
3. [ADR-006：实时协作技术门禁](0006-realtime-collaboration-gate.md)
4. [ADR-017：L1分享、审计、备份恢复与运行观测](0017-l1-share-audit-backup.md)
5. [ADR-019：NestJS声明式控制面装配](0019-declarative-nest-control-plane.md)
6. [ADR-024：审计与空间观测投影](0024-audit-observability-projection.md)
7. [ADR-027：跨 Kernel 内容操作审计耐久性](0027-cross-kernel-content-audit-durability.md)
