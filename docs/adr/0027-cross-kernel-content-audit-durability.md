---
title: "ADR-027: 跨 Kernel 内容操作审计耐久性"
description: "以 PostgreSQL 意图和声明式 Worker 收敛编辑、删除与导出审计，避免把已提交内容伪装成失败"
author: "Codex"
date: "2026-07-19"
version: "1.0.0"
status: "accepted"
tags: ["adr", "audit", "kernel", "durability", "worker"]
---

# ADR-027: 跨 Kernel 内容操作审计耐久性

## Status

Accepted。root 已批准方案 C、canonical intent 字段与状态机，并已释放 Gateway、Prisma、Worker、contracts、database shared writer、API intent/Core provider 和 AuditPage 范围进入 implementation；实现阶段不运行 runner、构建、数据库或服务，也不提交。

## Context

L1 要求编辑、删除和导出产生审计事件。PostgreSQL 是企业审计事实源，Go Kernel 是正文和内容提交事实源，两者之间没有共同事务管理器。

当前 `KernelGatewayService` 先等待 Kernel HTTP 成功及 JSON `code = 0`，再另开 Prisma 事务调用 `AuditWriter`。如果 Kernel 已提交内容而审计事务失败，Gateway 返回 `503 service-unavailable`。客户端会把一次已经生效的内容操作识别为失败，并可能重试非幂等事务；审计故障由此改变了内容操作的公开结果。

本仓证据同时表明，不能把一个普通“回执文件”包装成精确一次协议：

- `kernel/api/transaction.go` 在 `WaitForCommit` 完成后才返回 `code = 0`，因此当前 Gateway 能确认普通成功响应对应一次已经完成的 Kernel 提交。
- `kernel/model/transaction.go` 的提交横跨 `.sy` 文件、内存块树和持久索引队列；文件写入发生在 `index.queue` 的持久追加之前，现有提交不是可直接扩展为跨资源原子回执的单一数据库事务。
- `kernel/sql/index_queue.go` 的 `index.queue` 只承载可恢复的索引操作，采用追加、`fsync`、启动恢复和已提交前缀删除；它会合并索引操作并在索引提交后删除条目，不保留业务请求响应，也没有 API 确认后的回执生命周期。
- PostgreSQL `worker_jobs` 已提供声明式 handler/producer、持久领取、租约、重试和 `FOR UPDATE SKIP LOCKED` 先例；备份创建已经证明业务状态、Worker 任务和审计可在同一 PostgreSQL 事务内组装。
- `audit_events` 由数据库触发器保持追加不可变，HMAC 链密钥位于数据库外。一个已经写入的“尝试”事件不能原地改成“成功”或“失败”。

本地证据足以完成本决策，未进行网页搜索。

## Decision

### 选择 C：PostgreSQL 意图、明确结果投递和 `indeterminate` 终态

每个需要审计的内容请求只走一条生产链：

1. Gateway 完成既有身份解析和空间授权后，在调用 Kernel 之前向 PostgreSQL 插入一条 `content_audit_intents`。插入未提交时禁止调用 Kernel；插入失败返回 `503`，此时内容没有执行。
2. Gateway 使用现有显式 `organizationId + spaceId + notebookId + documentId` 和原始请求调用 Kernel。Kernel 不读取企业角色、不写 PostgreSQL，也不增加 L1 回执旁路。
3. Gateway 是 Kernel 结果分类的唯一 owner。可信成功响应写入 `observedOutcome = succeeded`，可信业务拒绝写入 `observedOutcome = failed`，并把 `availableAt` 推进到当前时间。超时、连接中断、私网认证 `401/403`、Kernel `5xx`、畸形成功响应或结果持久化失败都不猜测结果，意图保持未解析。
4. Gateway 不再直接为内容操作调用 `AuditWriter`。已知 Kernel 结果保持原 HTTP 语义；PostgreSQL 结果投递失败只记录稳定诊断，不把 Kernel 成功改写成 `503`，也不把 Kernel 业务拒绝替换成审计错误。
5. 声明式 Worker producer 按组织为已到 `availableAt` 的意图创建有界 `reconcile-content-audit` 任务，并保证同一组织只有一个活动任务。声明式 handler 在一个 Prisma 事务内按稳定顺序锁定有界批次，使用共享的唯一 `AuditWriter` 追加最终事件，然后删除已消费意图。
6. `observedOutcome` 非空时最终事件使用该 `succeeded` 或 `failed`。到期仍为空时最终事件使用新增的 `indeterminate`；它表示跨进程结果没有被可靠持久化，不表示内容失败，也不授权自动重试。
7. `AuditService`、React 审计页和归档 handler 仍只读取 `audit_events`。`content_audit_intents` 只属于投递状态，不进入查询、归档或用户投影，因此 PostgreSQL 审计事实源仍只有追加事件表，没有查询 union、内存 fallback 或第二事件路径。

本决策接受最终事件的短暂延迟，并以诚实的 `indeterminate` 换取 L1 可实现的耐久性。它不宣称跨 PostgreSQL 和 Kernel 的精确一次执行，也不宣称网络失败后客户端重试是幂等的。

### 未选择的方案

| 方案 | 结果 | 决策 |
| --- | --- | --- |
| A：Kernel 提交后 best-effort 审计 | 若吞掉写入错误会永久丢失事件；若像当前实现一样返回 `503`，会把已提交内容伪装成失败 | 拒绝 |
| B：Kernel 调用前写入 `attempted` 审计 | 追加事件不可更新，单条事件不能表达最终结果；再写结果事件会让一个逻辑操作拥有两种事件语义，并扩大查询和归档心智模型 | 拒绝 |
| C：PostgreSQL intent 加 `indeterminate` 终态 | 调用前已有耐久证据，明确结果异步追加，未知窗口不被伪装；无需改造 Kernel 内容提交 | 采用 |
| D：intent 加 Kernel 耐久幂等回执和 reconciliation | 可以在完整协议下支持跨重试的精确结果，但当前 Kernel 没有把内容写入、请求回执和响应缓存原子持久化的边界 | 延后到独立 Kernel WAL 决策 |

### D 的必要前置，不作为本期 fallback

D 只有同时完成以下合同才成立：浏览器为一个逻辑操作生成跨重试稳定的 `operationId`；Gateway 传递 `operationId + requestDigest`；Kernel 在任何内容可见前写入可恢复 WAL；内容提交、幂等回执和可重放响应处于同一崩溃恢复协议；重复 `operationId` 只接受相同摘要并返回原结果；PostgreSQL reconciliation 确认事件后显式回收回执。

当前 `requestId` 表示一次 HTTP/服务调用并参与服务 JWT `jti`，不能冒充跨重试 `operationId`。当前 `index.queue` 在内容文件写入后才追加且会在索引提交后删除，不能作为上述 WAL 或响应回执。仅增加一个回执 header、SQLite 表或 JSON 文件会保留“内容已写、回执未写”的崩溃窗口，因此禁止以 D 的名称实现近似方案。

## Source To Consumer Contract

| 链路位置 | 唯一 owner | 输入 | 输出与下游假设 |
| --- | --- | --- | --- |
| Source | 已认证浏览器与现有 Protyle 调用 | 当前逻辑 HTTP 请求 | 不新增客户端幂等字段；C 只追踪本次 `requestId` |
| Transport identity | `parseKernelGatewayTarget` | 路由、header、query | 已验证的 `organizationId + spaceId + notebookId + documentId`；下游不再解析或推断身份 |
| Audit action classification | `KernelGatewayService` 的单一 action resolver | route policy 与本次 body | `content.edit`、`content.delete`、`content.export` 或不审计；`content.mutation` 延续“含 delete 即 delete，否则 edit”的现有单事件语义 |
| Authorization | `KernelAccessService` | 组织、空间、用户、route action | 已授权 deployment；意图写入不重复角色判断 |
| Intent persistence | `ContentAuditIntentService.prepare` | request、actor、action、document 和发生时间 | PostgreSQL 已提交的最小意图；失败时 Kernel 尚未调用 |
| Kernel execution | `KernelPrivateClient` 与 Go Kernel | 原请求、显式内容身份和 deployment | 不消费企业审计字段；返回现有跨进程结果 |
| Result classification | `KernelGatewayService` | HTTP status、可信 JSON envelope 或导出响应 | 只有明确 `succeeded`/`failed` 被投递；其余保持未知 |
| Result persistence | `ContentAuditIntentService.resolve` | `requestId`、明确 outcome、当前时间 | 更新同一意图的 `observedOutcome` 和 `availableAt`；失败不改变 Kernel HTTP 结果 |
| Delivery scheduling | `ContentAuditJobProducer` | 已到期意图 | 每组织至多一个活动 `reconcile-content-audit` job；payload 为空，不复制业务字段 |
| Finalization | `ContentAuditHandler` | job 的组织身份和有界意图批次 | 同一事务追加 HMAC 事件并删除意图；空 outcome 只在到期后派生为 `indeterminate` |
| Consumers | `AuditService`、`AuditPage`、`ArchiveAuditHandler` | `audit_events` | 不读取 intent，不从 job、日志、Kernel 或首个响应补事件语义 |

现有 route parser、授权服务、contracts schema 和 PostgreSQL 约束继续拥有各自真实边界。本决策不在 Worker、AuditService 或 React 重复校验内容 ID、action 或组织关系；Worker 只消费迁移已约束的历史数据。

## State Machine

数据库不新增与 outcome 同义的 `status` 字段。状态由一条 intent 的存在、`observedOutcome` 和 `availableAt` 唯一表达：

| 状态 | 持久化形态 | 允许转移 |
| --- | --- | --- |
| 无意图 | `content_audit_intents` 无 `requestId` | `prepare` 成功后进入 pending；失败时保持无意图且不调用 Kernel |
| pending | intent 存在，`observedOutcome IS NULL`，`availableAt > now` | 明确 Kernel 结果进入 resolved；到期进入 due-indeterminate |
| resolved | intent 存在，`observedOutcome IN (succeeded, failed)`，`availableAt <= now` | Worker 事务追加同 outcome 事件并删除 intent |
| due-indeterminate | intent 存在，`observedOutcome IS NULL`，`availableAt <= now` | Worker 事务追加 `indeterminate` 事件并删除 intent |
| finalized | `audit_events` 存在且 intent 不存在 | 终态；不更新、不补写第二结果事件 |

`resolve` 只更新仍存在的本次 intent。Worker 已经消费后到达的迟到结果只记录 `content.audit-resolution` 的 `late` 诊断，不重建 intent、不更新追加事件、不写纠正事件。

## Canonical Fields

`content_audit_intents` 只保存：

| 字段 | 语义与来源 |
| --- | --- |
| `requestId` | Fastify 本次请求 UUID，也是最终审计事件的请求关联 ID和 intent 主键 |
| `organizationId` | Gateway route 显式组织身份 |
| `spaceId` | Gateway route 显式空间身份，非空 |
| `actorUserId` | 已认证用户身份，非空 |
| `action` | 唯一内容审计 action：`content.edit`、`content.delete` 或 `content.export` |
| `documentId` | route parser 已验证的目标文档身份；不保存 block ID、路径或 body |
| `occurredAt` | `prepare` 时的操作发生时间，最终事件沿用该值 |
| `observedOutcome` | nullable；只保存 Gateway 明确观察到的 `succeeded` 或 `failed` |
| `availableAt` | Worker 最早可消费时间；prepare 时为未知结果截止时间，resolve 时原子推进到当前时间 |

不新增 `operationId`、`intentId`、`result/status/state`、`workspaceId/orgId`、Kernel 地址、请求摘要或同义时间字段。Worker job 只保存自己的 job 身份、组织、调度时间和空对象 payload；内容事件字段不复制到 job payload。

`availableAt` 的唯一配置 owner 是 API `ApiConfiguration.contentAuditIndeterminateAfterMilliseconds`。部署边界从 `SINGULARITY_CONTENT_AUDIT_INDETERMINATE_AFTER_MS` 解析一个正整数毫秒值，未配置时使用唯一默认值 `120000`；`ContentAuditIntentService.prepare` 用本次 `occurredAt + configuration` 计算并持久化 `availableAt`，`resolve` 只把同一字段推进到明确结果的观察时间。Worker 不读取该环境变量、不复制默认值、不从 Kernel client timeout 或 job interval 重新计算截止时间，只判断持久化的 `availableAt <= now`。该期限只定义“跨进程结果仍未知时何时追加 `indeterminate`”，不声称覆盖完整 Kernel 执行时间，也不把到期解释为内容失败。

`AuditOutcome` 新增唯一值 `indeterminate`。React 显示“结果未确定”，复用设计系统现有 `Badge` 的 `outline` variant，不新增页面私有颜色、CSS 或视觉 token。

## Failure And Crash Windows

| 窗口 | 可观察结果 | 最终审计 |
| --- | --- | --- |
| intent 插入前或插入失败 | Gateway 返回 `503`，Kernel 未调用 | 无事件，因为内容操作未进入跨进程执行 |
| intent 提交后、Kernel 调用前 API 崩溃 | 客户端连接失败 | 到期 `indeterminate`，不伪造 Kernel 失败 |
| Kernel 明确拒绝，resolve 成功 | 保留原 Kernel 业务错误 | `failed` |
| Kernel 明确成功，resolve 成功 | 保留原 Kernel 成功 | `succeeded` |
| Kernel 明确结果后 resolve 失败 | 保留原 Kernel 成功或业务错误；记录 deferred | 到期 `indeterminate` |
| Kernel timeout、连接断开、私网认证 `401/403`、`5xx` 或畸形成功响应 | 保留现有 service-unavailable/validation 语义，禁止猜测是否提交 | 到期 `indeterminate` |
| resolve 已提交、Worker 未运行或进程崩溃 | 内容响应不受影响，intent 持久存在 | Worker 恢复后按 observed outcome 追加 |
| Worker 追加 HMAC 事件前失败 | handler 事务回滚，intent 保留，job 按租约重试 | 不丢失、不产生半条链 |
| Worker 事件和 intent 删除事务提交后、job complete 前崩溃 | 事件存在、intent 已删除，job 租约稍后重领 | 重领 handler 找不到可消费 intent 并幂等完成，不重复事件 |
| Worker 与迟到 resolve 竞争 | intent 行锁决定唯一终态 | 截止时间前的明确结果正常胜出；Worker 已消费后不覆盖 `indeterminate` |

`indeterminate` 是安全而诚实的审计结论，不是 fallback。客户端是否重试仍由调用方和产品语义决定；本期不通过隐藏重试、重复请求或近似回执声称幂等。

## Declarative Nest And Worker Assembly

- `ContentAuditIntentService` 使用 `@Injectable()` 和构造器 DI，仅实现显式 `prepare`、`resolve` 两个有序 use case；不使用 interceptor 扫描 route，不从源码或文件名发现审计 action。
- PostgreSQL 专属 `AuditWriter` 和 `AuditConfiguration` 移到 `@singularity/database` 的明确审计模块，保留一个 HMAC/序号追加实现。该类不依赖 Nest；API `CoreModule` 和 Worker `WorkerModule` 分别用 typed `useFactory` 声明同一 provider，不复制 HMAC 算法或 SQL。
- `ContentAuditJobProducer` 使用现有 `@ProducesWorkerJob({ kind: "reconcile-content-audit" })`；`ContentAuditHandler` 使用现有 `@HandlesWorkerJob({ kind: "reconcile-content-audit" })`。`WorkerDeclarationDiscovery` 继续负责完整性与冲突失败，禁止中央 switch、第二 registry 或手工 handler 列表。
- producer 复用现有 schema 级事务 advisory lock，按组织创建任务，并以 `NOT EXISTS` 阻止同组织相同 kind 的 `queued/running` 重复任务。
- handler 每次最多消费配置中的有界批次，按 `occurredAt ASC, requestId ASC` 锁定；领域顺序留在 handler，不塞进装饰器、Prisma hook 或触发器。
- API 和 Worker 都从同一配置 parser 读取 `SINGULARITY_AUDIT_HMAC_KEY` 与 `SINGULARITY_AUDIT_KEY_VERSION`。Worker 启动缺失审计密钥时失败关闭，不能生成无 MAC 事件或调用另一服务代写。

## Migration

1. PostgreSQL `audit_outcome` 新增 `indeterminate`；contracts、OpenAPI、Prisma enum、query projection、归档类型和 React exhaustiveness 同步更新。
2. PostgreSQL `worker_job_kind` 新增 `reconcile-content-audit`；Worker discriminated union、声明式 discovery、producer、handler 和配置同步更新。
3. 新建 `content_audit_intents`，以 `request_id` 为主键，保存上文唯一字段；组织、空间和操作者使用现有同组织复合外键，`action` CHECK 只接受三种内容 action，`observed_outcome` CHECK 只接受 null、`succeeded` 或 `failed`。
4. 为 producer 增加 `(available_at, organization_id, occurred_at, request_id)` 索引。Intent 不增加正文、body、路径、Kernel handle、角色副本、HMAC 或归档字段。
5. 迁移不回填历史内容事件，不从日志或 Kernel 猜测旧请求；部署切换后新请求只走 intent 链。
6. `audit_events` 的不可变 trigger、组织序号和数据库 ACL 保持不变。Intent 是可删除的投递状态，不被授予为审计查询表。

## Observability And Security

长期保留稳定日志标签 `content.audit-intent`、`content.audit-resolution` 和 `content.audit-finalization`。固定上下文只含 `requestId`、`organizationId`、`spaceId`、`action`、`documentId`、结果、批次数和耗时；不记录正文、transaction body、附件路径、Kernel endpoint、JWT、HMAC 密钥、MAC 输入或数据库错误原文。

授权仍在 intent 前由 `KernelAccessService` 完成。Intent 不赋予内容权限，也不能触发 Kernel 调用；Worker 只把已经存在的最小投递事实写入审计链。HMAC 密钥继续来自数据库外的 secret，API 与 Worker 需要相同当前 key/version，日志和 job payload 不包含密钥材料。

此变更不生成 HTML、报告、snapshot 或 debug payload；ADR、注释和日志只记录合同、结果和必要诊断，不保存隐藏推理或提示词内容。

## Design Pattern Review

- 使用 Transactional Intent：先在控制面持久化最小意图，再跨进程执行，解决“操作可能发生但完全无耐久审计线索”的问题。
- 使用 Outbox-like Worker Delivery，但不把 intent 称为审计事件；唯一事件事实只在 `AuditWriter` 追加后成立。
- 使用 State Machine：null outcome、明确 outcome 和时间门限构成最小状态，不增加重复 `status`。
- 使用 Dependency Injection 与声明式 discovery：API/Worker 共享一个 PostgreSQL 审计 writer，producer/handler 由现有 Nest metadata 发现。
- 不使用 Adapter：Gateway 与 Kernel 协议在 C 中不变，不增加同形 DTO、透传 service 或兼容层。
- 不使用 Observer/事件总线：数据库 intent 已是耐久协调点，再广播进程事件只会引入第二投递路径。

SOLID 结论：Gateway 只拥有跨进程结果分类，Intent service 只拥有投递状态，AuditWriter 只拥有 HMAC 追加，Worker slice 只拥有最终化；依赖均指向公开 typed contract。安全结论：没有正文双写、身份推断、秘密泄露或公网 Kernel 新入口。性能结论：请求热路径增加一次 intent insert 和一次明确结果 update，但移除同步组织序号/HMAC 锁；Worker 以有界组织批次串行追加。可测试性结论：每一层都可通过真实 PostgreSQL、真实 HTTP 外部 Kernel 边界和现有 Worker runner 观察，不需要私有方法或完整内部 mock 链。

## Implementation Ownership And Order

本功能是一个纵向切片，不能再按 API、Worker、测试或文档横拆。共享文件释放后由同一 owner 一次完成生产代码、迁移、调用方、永久测试和文档。

| 顺序 | 文件范围 | 当前 owner/依赖 | 完成条件 |
| --- | --- | --- | --- |
| 1 | 本 ADR | `content_audit_durability` 独占 | root 审批 C、字段与状态机 |
| 2 | `enterprise/packages/contracts/src/audit.ts`、contracts tests、`enterprise/packages/database/src/audit*`、database package exports | 需 root 释放共享 contract/database 接口 | `indeterminate` 和唯一 AuditWriter/配置 parser 形成单一合同；旧 API writer 删除清单冻结 |
| 3 | Prisma schema 与一条新 migration | 当前由 backup/audit owner 占用，需显式交接 | enum、intent 表、外键、CHECK 和索引一次落盘，无兼容字段 |
| 4 | `enterprise/apps/api/src/audit/content-audit-intent.service.ts`、Core DI、configuration consumers | Core 组合根需 root 交接 | prepare/resolve 成为唯一 intent 写入口，shared AuditWriter provider 生效 |
| 5 | `enterprise/apps/api/src/kernel/kernel-gateway.service.ts` 及现有 HTTP contract | 当前由 gateway owner 占用，需显式交接 | 旧 post-commit `AuditWriter` 路径删除；所有 audited route 先 prepare，明确结果 resolve，结果写失败不覆盖 Kernel 响应 |
| 6 | `enterprise/apps/worker/src/content-audit-reconciliation.ts`、job declarations、configuration、module、tests | 当前由 backup/audit owner 占用，需显式交接 | decorator producer/handler 被真实 Nest discovery 发现，批量最终化和租约恢复闭合 |
| 7 | `AuditPage.tsx`、component test、P5 start-stack、CI Worker secret、ADR-017/024、权威方案和 handoff | 与 root 集成 owner 协调 | 用户可见 `indeterminate`、Worker 获得同一审计 secret、文档不再声称跨 Kernel 同事务 |
| 8 | 整个 L1 implementation 交付到 code-review | root | 生产代码、迁移、测试代码、旧路径删除和文档全部就绪后统一复评 |

文件冲突时只在 `/root/projects/mailbox.md` 记录未决协调，收到 owner 释放后再编辑；处理完成立即删除对应 mailbox 消息。禁止 reset、checkout、全文件覆盖或格式化其他 owner 的文件。

## Old Path Deletion

实现必须在同一批删除：

- `KernelGatewayService.#appendContentAudit` 及其 post-commit `AuditWriter`/`DatabaseRuntime` 依赖。
- 审计失败后 `throw new ApiProblemError("service-unavailable", 503)` 的内容操作分支。
- API 本地 `audit-writer.service.ts` 中被 shared writer 取代的第二实现，以及所有旧 import。
- 只接受三值 `AuditOutcome` 的 contracts、Prisma、React exhaustive 分支和 fixture。
- 任何为迁移临时保留的 direct append 开关、同步/异步双写、intent 查询 union、内存 retry 或 Kernel 回执近似实现。

## Test Governance

### Existing evidence disposition

- 扩展 `enterprise/apps/api/test/kernel-gateway.http.test.ts`，保留其真实 HTTP、真实 PostgreSQL和外部 HTTPS Kernel 边界；不新建重复 Gateway runner。
- 扩展 contracts 现有 Node runner，验证 `indeterminate` 公共 schema；不为单个 enum 新建脚本。
- 新增一个 Worker PostgreSQL integration suite 或扩展现有 L1 handler suite，复用现有 isolated PostgreSQL support 和真实声明式 discovery；不 mock `AuditWriter` 或 repository 全链。
- 扩展 `AuditPage.test.tsx` 证明用户可见“结果未确定”；不新增截图或视觉 baseline，因为复用现有设计系统 variant。
- 扩展现有 P5 E2E 用户链验证事件最终可查询；复用现有 stack-state、会话和诊断 support，不创建第二套启动器。

### Stable contract matrix

| 稳定合同 | 真实故障 | 最低充分层级 | 真实/模拟边界 |
| --- | --- | --- | --- |
| intent 提交失败时不调用 Kernel | 无耐久意图仍执行内容 | API HTTP integration | 真实 PostgreSQL；现有外部 Kernel fixture 只用于观察请求计数 |
| Kernel 成功后结果写入失败仍返回成功 | 当前 `503` 诱发已提交事务重试 | API HTTP integration | 真实 HTTP/Kernel fixture；用测试 schema trigger 制造真实 PostgreSQL update 失败，测试后由 hook 清理 |
| 明确成功/失败只更新对应 intent outcome | action 或结果被下游猜测 | API HTTP integration | 真实 PostgreSQL和可信 Kernel envelope |
| 超时、`5xx`、畸形响应保持未知 | 把不确定提交误记为失败 | API HTTP contract | 外部 Kernel 协议边界；不 mock 内部 services |
| producer 每组织只创建一个活动 job | 并发 scheduler 重复最终化 | Worker PostgreSQL integration | 真实 advisory lock、job 表和并发事务 |
| handler 把 resolved/due intent 分别追加为明确/indeterminate，并删除 intent | 事件丢失、错误 outcome 或重复链 | Worker PostgreSQL integration | 真实 Prisma transaction、真实 HMAC writer、独立 MAC 重算 |
| handler 事务/租约失败后 intent 可重新领取且不重复事件 | 崩溃窗口丢失或双写 | Worker PostgreSQL integration | 真实 lease expiry 与 PostgreSQL，不用固定 sleep |
| Audit query/archive 只消费 `audit_events` | intent 成为第二查询事实源 | API/Worker integration，加必要 static 依赖门禁 | 真实查询与归档；static 只证明禁用依赖方向 |
| React 明确显示 `indeterminate` | 操作未知被显示为失败 | React component | 真实组件和 contracts fixture |
| 真实编辑最终产生同一 `requestId` 的唯一事件；delete/export 复用同一已验证投递链 | 组合根未装配 Worker/secret | 现有 P5 Playwright E2E，加 Gateway/Worker integration | 真实浏览器、API、Worker、PostgreSQL和 Go Kernel 证明编辑全链；Gateway HTTP 与 Worker PostgreSQL integration 分别证明 delete/export 分类和最终化；按可观察事件轮询，不固定 sleep |

不新增共享测试 helper。现有 PostgreSQL support 和 P5 stack support 已有多个稳定消费者，直接复用；业务 action、失败注入和最终 outcome 断言留在各自 test case。

## Stage Gate

本功能属于当前“完整 L1 企业基础版”大阶段，不建立独立小批测试循环。implementation 期间只落生产代码、migration、fixture、永久测试代码、旧路径删除和文档，不运行 runner、typecheck、build、数据库、服务或浏览器。

整个 L1 implementation 完成后先集中执行 `code-review + test-governance`。复评通过后才由 verification 使用 Node 24、pnpm 11.9 和固定 PostgreSQL 17 集中运行至少：`pnpm verify:s0-s3`、`pnpm test:e2e`，以及权威 L1 矩阵中的 Kernel、B4 和供应链入口。C 不修改 Go Kernel，因此不为本 ADR 单独增加 Go runner；整阶段既有 Kernel 聚合仍照常运行。

## Consequences

- 内容成功不再依赖后置审计事务成功，当前最危险的伪失败和非幂等重试诱因被移除。
- 每次内容审计请求增加一条短生命周期 PostgreSQL intent，并增加一次明确结果 update；组织 HMAC 序号锁移出 HTTP 热路径，由 Worker 有界批量承担。
- 审计查询具有短暂最终一致性。Worker 停止时 intent 不丢失，但事件不可见，恢复后继续最终化。
- 在跨进程不确定窗口内，最终事件可能是 `indeterminate`。这比错误记录 `failed` 或丢失事件更诚实，但不能回答内容是否真正提交。
- 跨重试精确一次仍需 D 的 Kernel WAL、稳定 `operationId` 和响应回放；在这些前置完成前不得宣称已有幂等回执。

## References

1. [ADR-001：服务器权威内容](0001-server-authoritative-content.md)
2. [ADR-005：内容单一事实源](0005-single-content-fact-source.md)
3. [ADR-015：Kernel 内容库隔离与 drain](0015-kernel-content-store-isolation-and-drain.md)
4. [ADR-017：L1 分享、审计、备份恢复与运行观测](0017-l1-share-audit-backup.md)
5. [ADR-019：声明式 Nest 控制面](0019-declarative-nest-control-plane.md)
6. [ADR-021：信任边界校验所有权](0021-trust-boundary-validation-ownership.md)
7. [ADR-024：审计与空间观测投影](0024-audit-observability-projection.md)
8. [奇点企业知识库方案](../../output/md/Singularity_Enterprise_Knowledge_Base_v1.0.0_2026-07-13.md)
