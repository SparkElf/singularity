---
title: "L3.0 实时协作语义原型实施计划"
description: "奇点实时协作进入生产前的语义、因果、历史与撤销原型门禁"
author: "Codex"
date: "2026-07-22"
version: "1.0.0"
status: "verified"
tags: ["plan", "l3", "realtime-collaboration", "crdt", "prototype"]
---

# L3.0 实时协作语义原型实施计划

## Objective

依据以下方案建立并验证 L3.0 独立语义原型：

- 产品：[docs/product/l3-realtime-collaboration.md](../docs/product/l3-realtime-collaboration.md)
- 架构：[docs/architecture/l3-realtime-collaboration.md](../docs/architecture/l3-realtime-collaboration.md)
- ADR：[docs/adr/0030-l3-semantic-collaboration-prototype.md](../docs/adr/0030-l3-semantic-collaboration-prototype.md)
- 上游门禁：[docs/adr/0006-realtime-collaboration-gate.md](../docs/adr/0006-realtime-collaboration-gate.md)

目标：证明普通块、结构块、块引用、嵌入、属性视图单元格、历史、撤销、presence、四段内容身份和故障恢复可以在并发操作下保持语义一致。L3.0 不接入生产 Protyle、Gateway、WebSocket 或数据库，不宣称实时协作已交付。

## Current State

- L0/L1/L2 已完成并推送至 `origin/master`。
- 生产 Go Kernel 仍是正文、块、AV 和历史唯一事实源；现有 Protyle WebSocket 只接收推送。
- L3.0 PRD、架构、ADR 和本计划已完成复评，原型实现和集中 verification 已通过，当前为 `verified`；L3.1 生产协作也已完成独立验证。
- 原型没有 CRDT 依赖和生产路由；L3.1 的生产路由受功能开关保护，固定测试数据库按其计划保留。

## Locked Contracts

- 所有操作和恢复消息显式携带 `organizationId + spaceId + notebookId + documentId`。
- 操作唯一封装为 `operationId + clientId + clientSequence + causalContext + operation`；不传整篇正文快照。
- Go semantic reducer 是原型语义唯一 owner；TypeScript 只消费协议，不复制 reducer 或正文。
- 并发冲突必须交换、保留 tombstone 或形成明确冲突记录；禁止锁、LWW、静默丢弃和 fallback。
- 历史是 append-only operation log；撤销生成 inverse operation，不覆盖旧历史。
- presence/光标是内存 TTL 投影，不进入内容历史、PostgreSQL 或 Kernel 正文。
- L3.0 通过前不得添加生产路由、默认 WebSocket 双向写、Prisma 表或生产编辑器开关。

## Stage Boundary

这是一个完整的 prototype implementation/review/verification 大阶段，包含公共 contracts、Go 语义核心、Kernel bridge、协议协调器、浏览器原型、测试夹具和文档。所有模块完成后已进行一次 code-review + test-governance 复评，并执行唯一 `verify:l3-prototype` 聚合；本阶段现为 `verified`。

## Module Owners and File Scope

| 顺序 | 模块 owner | 生产/原型范围 | 交接合同 |
| --- | --- | --- | --- |
| 1 | L3 contracts | `enterprise/packages/contracts/src/realtime-collaboration.ts`、聚合器、contract tests | 操作/确认/presence schema、四段身份和拒绝码冻结 |
| 2 | Go semantic core | `kernel/collab/**`、Go unit/integration tests | 纯 reducer、因果上下文、冲突和 inverse operation |
| 3 | Kernel bridge | `kernel/collab/bridge.go` 及隔离内容夹具 | 语义操作到 block/AV/history 的真实转换；不增加生产路由 |
| 4 | Protocol harness | `enterprise/packages/realtime-prototype/**` | 两客户端、乱序/重复/断线/撤权和日志证据 |
| 5 | Browser prototype | `enterprise/apps/web/tests/l3-prototype/**`、独立 Playwright config | 两页面 DOM、presence、撤销和健康证据；不称真实 E2E |
| 6 | Integration/docs | `enterprise/package.json`、唯一 runner、L3 文档和权威总案 | 只在所有 owner 释放后接入聚合和完成记录 |

共享 contracts、Go 核心协议、唯一 runner 和权威文档为单一 owner；发生文件重叠先在当前工作目录根 `mailbox.md` 协调，未解决前转做无冲突模块。

## Implementation Tasks

### A. Product and architecture

- [x] 形成 L3.0 PRD、验收标准和测试价值口径。
- [x] 形成架构方案、ADR 和本可恢复计划。
- [x] 完成产品/架构评审，冻结操作联合类型、冲突语义和原型隔离边界。

### B. Contracts and semantic core

- [x] 定义 `CollaborationOperationEnvelope`、`CollaborationOperationResult`、presence 和拒绝码 schema。
- [x] 实现纯 Go causal context/reducer，覆盖 text、block tree、reference、embed、AV cell、tombstone 和 conflict record。
- [x] 实现 inverse operation、重放和 duplicate/ordering 幂等语义。

### C. Kernel bridge and harness

- [x] 在隔离测试内容模型中实现语义操作到 Kernel block/AV/history 的转换。
- [x] 建立两客户端协议协调器，覆盖 join/submit/ack/broadcast/resume/leave。
- [x] 注入乱序、重复、断线、迟到和 ACL 撤权，保留完整日志和资源清理。

### D. Browser prototype

- [x] 建立独立 prototype 页面/Playwright config，不修改生产默认路由和 WebSocket。
- [x] 覆盖两个真实浏览器实例的普通块、引用/嵌入、AV 单元格、presence 和本地撤销结果。
- [x] 覆盖桌面与 320px 最小布局；原型文案不得暗示 L3 生产已支持。

### E. Review and verification

- [x] 删除探索脚本、重复 reducer、整文档快照 fallback 和未注册 runner。
- [x] 完成一次整阶段 code-review + test-governance 复评。
- [x] 执行唯一 `pnpm verify:l3-prototype`，记录每条 PRD 验收证据。
- [x] 全部通过后已更新权威总案为 L3.0 `verified`；L3.1 已另立方案并独立完成验证。

## Verification Matrix

统一入口只在本阶段实现完成和 code-review 复评通过后执行：

1. static：生产入口无 L3 路由/默认双向 WS/Prisma 正文表；contracts 导入方向和配置隔离。
2. contract：四段身份、操作联合类型、因果上下文、确认/拒绝/presence 序列化。
3. Go unit：因果合并、文本/树/引用/嵌入/AV reducer、tombstone、conflict、inverse operation。
4. Kernel integration：隔离 block/AV/history bridge、重放一致性和锁态/身份拒绝。
5. protocol integration：双客户端 accepted/duplicate/rejected、乱序、断线恢复、撤权和日志 stack。
6. browser prototype：两个页面的真实 DOM 结果、presence 生命周期、本地撤销和最小视口合同。
7. cleanup：runner、临时目录、浏览器、端口和测试内容在成功/失败路径均释放。

正式命令：`cd enterprise && pnpm verify:l3-prototype`，已完成并通过。实现阶段不按模块插入正式 aggregate；若后续变更原型合同，必须按共同根因整批回到 implementation，再统一复评和重跑。

## Completion Definition

- L3.0 PRD、架构、ADR 和本计划门禁均已评审通过并为 `verified`。
- L3-SEM/HIS/ID/ACL/PRES/REC/GATE 全部通过；不存在跨空间/跨库污染、静默丢失、LWW、锁或整文档覆盖。
- 生产 Web、Gateway、Prisma 和默认 Kernel WS 路径没有被原型接入或改变。
- `pnpm verify:l3-prototype` 是唯一集中入口，标准 runner 可按 case 过滤，失败路径完整清理。
- L3.1 生产协作方案已另行形成并通过验证，不能把原型路径当作生产实现。

## Resume Guide

L3.0/L3.1 均已验证。后续恢复时先检查：

```text
cd /root/projects/singularity
git status --short --branch
git log -8 --oneline --decorate
sed -n '1,220p' docs/product/l3-realtime-collaboration.md
sed -n '1,260p' docs/architecture/l3-realtime-collaboration.md
cat /root/projects/mailbox.md 2>/dev/null || true
```

不得把 L3.0 prototype runner 当作生产验收。若进入多副本、移动端、离线无限编辑或零知识协作，必须新建产品/架构方案和 ADR；固定 PostgreSQL 按 L3.1 计划复用，不创建临时数据库。
