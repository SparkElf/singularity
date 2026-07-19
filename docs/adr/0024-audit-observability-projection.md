---
title: "ADR-024: 审计与空间观测投影"
description: "定义企业审计查询和空间健康容量投影的授权、身份与样本语义"
author: "Codex"
date: "2026-07-19"
version: "1.0.0"
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
3. 容量状态区分 `no-sample` 与 `sample-failed`。后者必须返回持久化 `sampledAt`；前者不伪造时间。健康状态沿用相同的无样本/失败/不可用区分。
4. React 审计页面把 MAC、密钥版本和请求标识标为“链信息”，不声称浏览器持钥完成 HMAC 重算。观测页面在失败状态显示最近采样时间，刷新请求始终使用当前路由的组织和空间身份。
5. Producer 不在本 ADR 中复制实现；登录、权限、分享、内容、备份和恢复 producer 继续由各自领域事务调用 `AuditWriter`。本切片通过真实 HTTP producer 测试和查询投影测试消费同一追加链，避免第二套事件注册表。

### Producer Coverage

| Actions | Transaction owner | Permanent HTTP evidence |
| --- | --- | --- |
| `authentication.login` | `IdentityService` | `enterprise/apps/api/test/sharing.http.test.ts` |
| `permission.change` | organization, group, space and operations services | `enterprise/apps/api/test/organization-management.http.test.ts` |
| `share.create`, `share.password-change`, `share.revoke` | `ShareService` | `enterprise/apps/api/test/sharing.http.test.ts` |
| `content.edit`, `content.delete`, `content.export` | `KernelGatewayService` | `enterprise/apps/api/test/kernel-gateway.http.test.ts` |
| `backup.create`, `restore.create`, `restore.activate` | `BackupService` | `enterprise/apps/api/test/sharing-ops.http.test.ts` |

## Contract and Evidence

| Area | Stable contract | Permanent evidence |
| --- | --- | --- |
| Audit query | organization/space scope, descending cursor pages, chain fields, no-store response | `enterprise/apps/api/test/audit-observability.http.test.ts` |
| Audit authorization | organization manager, space admin, ordinary member and cross-organization rejection | `enterprise/apps/api/test/audit-observability.http.test.ts` |
| Observation query | persisted health/capacity only, fresh/stale/unavailable states, no hot-path recalculation | `enterprise/apps/api/test/audit-observability.http.test.ts`, `enterprise/apps/api/test/sharing-ops.http.test.ts` |
| Capacity failure | `sample-failed` carries `sampledAt`; `no-sample` carries no timestamp | `enterprise/packages/contracts/test/contracts.test.mjs`, `enterprise/apps/api/test/sharing-ops.http.test.ts` |
| React audit | explicit route identity, visible-sequence cursor, previous-cursor restoration, chain-information wording | `enterprise/apps/web/src/enterprise/AuditPage.test.tsx` |
| React observation | fresh/stale/failed rendering and routed refresh identity | `enterprise/apps/web/src/enterprise/ObservabilityPage.test.tsx` |

## Consequences

- Revocation and read authorization share one transaction boundary, so a completed response cannot be authorized by a membership snapshot that was invalidated before the transaction acquired its locks.
- Capacity values remain snapshots with an explicit freshness clock; the API does not synchronously traverse a Kernel workspace to fill a missing sample.
- The UI exposes enough chain metadata for operators and archive tooling without making a cryptographic verification claim that belongs to a trusted service with the external HMAC key.
- Filtered space pages can contain a chain gap when organization events or another space's events are omitted; consumers must treat `previousMac` as linkage metadata rather than assume adjacent displayed rows are consecutive organization events.

## References

1. [ADR-017：L1分享、审计、备份恢复与运行观测](./0017-l1-share-audit-backup.md)
2. [Audit service](../../enterprise/apps/api/src/audit/audit.service.ts)
3. [Space observability service](../../enterprise/apps/api/src/spaces/space-observability.service.ts)
