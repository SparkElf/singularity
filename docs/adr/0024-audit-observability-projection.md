---
title: "ADR-024: 审计与空间观测投影"
description: "定义企业审计查询和空间健康容量投影的授权、身份与样本语义"
author: "Codex"
date: "2026-07-19"
version: "1.2.0"
status: "accepted"
tags: ["adr", "audit", "observability", "authorization"]
---

# ADR-024: 审计与空间观测投影

## Status

Accepted；实现已进入 L1 implementation 阶段，正式 runner 由 code-review/verification 阶段统一执行。

## Context

审计事件和 Kernel 观测样本由 PostgreSQL 持久化，但浏览器只需要按组织或空间读取受控的最小投影。授权与读取若分属两次数据库查询，撤权可能在两者之间生效，导致迟到响应继续暴露已失效范围。容量采样失败也必须保留最后一次持久化样本时间，不能让失败状态看起来像从未采样。

## Decision

1. 组织审计查询只接受显式 `organizationId`，空间审计查询同时接受显式 `organizationId` 和 `spaceId`；游标使用严格小于 `sequence` 的 `beforeSequence`，结果按 `sequence DESC` 返回并保留 `previousMac`、`mac` 和 `keyVersion` 链信息。
2. 审计和观测服务在同一个 Prisma 事务内调用既有 `requireManagerInTransaction` 或 `requireSpaceManagerInTransaction`，随后用同一事务读取投影。授权锁定组织、用户和空间事实，查询额外带组织与空间条件，不从 DOM、全局状态、首个响应或 Kernel 结果推断身份。
3. 容量状态区分 `no-sample` 与 `sample-failed`。后者必须返回持久化 `sampledAt`；前者不伪造时间。健康投影在同一查询中读取 PostgreSQL 权威的当前 Kernel 三态：当前实例为 `unavailable` 时明确返回 `kernel-unavailable`，有历史样本则同时返回最后 `sampledAt`，没有历史样本则不伪造时间；`starting` 有历史样本时同样不得继续显示旧样本为 `ready` 或 `stale`，而是返回带最后 `sampledAt` 的 `kernel-unavailable`，尚无样本时仍表达为 `no-sample`；当前为 `ready` 时才按样本错误和新鲜度区分 `sample-failed`、`ready` 与 `stale`。不得用样本年龄、错误码或容量状态近似推断实例三态。
4. React 审计页面把 MAC、密钥版本和请求标识标为“链信息”，不声称浏览器持钥完成 HMAC 重算。观测页面在失败状态显示最近采样时间，刷新请求始终使用当前路由的组织和空间身份。
5. Producer 不在本 ADR 中复制实现；登录、权限、分享、备份和恢复等PostgreSQL自有领域在各自事务内调用唯一`AuditWriter`。跨Kernel内容路由不在HTTP事务内直接追加事件，而按[ADR-027](0027-cross-kernel-content-audit-durability.md)先写intent、再由Worker消费；查询投影仍只消费`audit_events`，不union intent或日志。
6. PostgreSQL 是审计目标类型的持久化校验 owner。`audit_events_target_type_check` 只接受公开 `AuditTargetType` 集合；Controller、Service 和查询投影依赖该历史数据合同，不重复解析或用未知类型 fallback。
7. Kernel 观测响应是独立跨进程字节边界。Worker 的唯一 response schema 只接受最长 64 字符的小写连字符机器错误码；路径、空白说明、换行、正文和任意错误原文以脱敏 `kernel-response-invalid` 拒绝，`SampleKernelHandler` 和 PostgreSQL 写入不再重复清洗。
8. 当前生产运行链会生成 HMAC-SHA-256 事件 MAC、串联组织序号、阻止普通应用角色修改事件并把规范字段归档；永久 PostgreSQL/HTTP 证据使用外部测试密钥独立重算每个事件 MAC。仓库尚无持有历史密钥环的生产在线 verifier 或运维校验命令，因此本期只能声明事件可由外部持钥方验证，不能声明产品已经执行在线全链校验；若 L1 验收要求内建 verifier，必须另行定义密钥轮换、历史 key lookup、失败语义和受控入口后实现。

### Producer Coverage

| Actions | Transaction owner | Permanent HTTP evidence |
| --- | --- | --- |
| `authentication.login` | `IdentityService` | `enterprise/apps/api/test/sharing.http.test.ts` |
| `permission.change` | organization, group, space and operations services | `enterprise/apps/api/test/organization-management.http.test.ts` |
| `share.create`, `share.password-change`, `share.revoke` | `ShareService` | `enterprise/apps/api/test/sharing.http.test.ts` |
| `content.edit`, `content.delete`, `content.export` | `KernelGatewayService`持久化意图和结果，`ContentAuditHandler`最终追加 | `enterprise/apps/api/test/kernel-gateway.http.test.ts`、`enterprise/apps/worker/test/l1-handlers.integration.test.ts` |
| `backup.create`, `restore.create`, `restore.activate` | `BackupService` | `enterprise/apps/api/test/sharing-ops.http.test.ts` |

## Contract and Evidence

| Area | Stable contract | Permanent evidence |
| --- | --- | --- |
| Audit query | organization/space scope, descending cursor pages, independently recomputable chain fields, no-store response | `enterprise/apps/api/test/audit-observability.http.test.ts` |
| Audit authorization | organization manager, space admin, ordinary member and cross-organization rejection | `enterprise/apps/api/test/audit-observability.http.test.ts` |
| Audit target persistence | PostgreSQL rejects target types outside the public `AuditTargetType` set | `enterprise/packages/database/prisma/migrations/20260719010000_audit_target_type_contract/migration.sql`, `enterprise/packages/database/test/audit-acl.integration.test.ts` |
| Observation query | persisted health/capacity only, explicit current Kernel state, fresh/stale/unavailable states, no hot-path recalculation | `enterprise/apps/api/test/audit-observability.http.test.ts`, `enterprise/apps/api/test/sharing-ops.http.test.ts` |
| Capacity failure | `sample-failed` carries `sampledAt`; `no-sample` carries no timestamp | `enterprise/packages/contracts/test/contracts.test.mjs`, `enterprise/apps/api/test/sharing-ops.http.test.ts` |
| Observation parser | stable machine error codes only; arbitrary error detail is rejected before persistence | `enterprise/apps/worker/test/kernel-worker-client.test.ts` |
| React audit | explicit route identity, visible-sequence cursor, previous-cursor restoration, chain-information wording | `enterprise/apps/web/src/enterprise/AuditPage.test.tsx` |
| React observation | fresh/stale/failed rendering and routed refresh identity | `enterprise/apps/web/src/enterprise/ObservabilityPage.test.tsx` |

## Consequences

- Revocation and read authorization share one transaction boundary, so a completed response cannot be authorized by a membership snapshot that was invalidated before the transaction acquired its locks.
- Capacity values remain snapshots with an explicit freshness clock; the API does not synchronously traverse a Kernel workspace to fill a missing sample.
- The UI exposes enough chain metadata for operators and archive tooling without making a cryptographic verification claim that belongs to a trusted service with the external HMAC key.
- Filtered space pages can contain a chain gap when organization events or another space's events are omitted; consumers must treat `previousMac` as linkage metadata rather than assume adjacent displayed rows are consecutive organization events.
- Cross-Kernel content audit is eventually consistent; an unresolved intent is projected only after Worker finalization and may be shown as `indeterminate`, never as an inferred failure.

## References

1. [ADR-017：L1分享、审计、备份恢复与运行观测](./0017-l1-share-audit-backup.md)
2. [ADR-027：跨Kernel内容操作审计耐久性](./0027-cross-kernel-content-audit-durability.md)
3. [Audit service](../../enterprise/apps/api/src/audit/audit.service.ts)
4. [Space observability service](../../enterprise/apps/api/src/spaces/space-observability.service.ts)
