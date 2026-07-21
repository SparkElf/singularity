---
title: "奇点 L2 异步协作架构方案"
description: "定义评论、提及、站内通知、版本历史与文档级权限的模块边界、数据流和集中验证门禁"
author: "Codex"
date: "2026-07-21"
version: "1.0.0"
status: "verification"
tags: ["architecture", "l2", "async-collaboration", "prisma", "nestjs", "react"]
---

# 奇点 L2 异步协作架构方案

## 1. 目标与前置

L1 已闭合组织、空间、分享、审计、备份、Gateway、唯一 Session 组合根和显式内容身份。L2 只增加企业元数据协作能力，不改变 Go Kernel 的正文事实源，不实现实时多人编辑。

前置依据：

- 产品合同：[L2 异步协作产品需求](../product/l2-async-collaboration.md)。
- 权威范围：[奇点企业知识库完整方案](../../output/md/Singularity_Enterprise_Knowledge_Base_v1.0.0_2026-07-13.md) 第 7、9.2、9.3 节。
- 本地先例：ADR-006 的实时协作门禁、ADR-017/024/027 的审计与 Worker、ADR-019 的 Nest 声明式装配、ADR-020/021 的内容目录和边界 owner。

本地证据已覆盖同类产品的空间/成员权限调研，不再引入外部技术事实；外部 CRDT 资料只在 L3 原型阶段重新评估。

## 2. 架构决策

### 2.1 数据所有权

| 领域 | 唯一事实源 | L2 负责内容 |
| --- | --- | --- |
| 正文、块、历史内容、块 ID | Go Kernel `.sy`/SQLite | 通过已有 Gateway 读取、差异投影和恢复 |
| 文档 ACL、评论线程、通知收件箱 | NestJS + PostgreSQL | 事务、复合外键、分页查询、有效权限计算 |
| 审计 | 现有 `audit_events` | 评论、ACL、历史、通知动作复用 `AuditWriter` |
| UI 服务器状态 | React Query | 分页缓存、失效和重取；不复制正文或完整历史 |
| UI 局部交互状态 | 组件局部状态；跨页面通知筛选才用 Zustand | 不把 ACL/评论事实复制进全局 store |
| 异步外部发送 | L2 不实现 | 未来邮件等渠道另立 Worker job 与计划 |

PostgreSQL 不保存正文、块 DOM、历史全文或 Kernel 快照。版本历史的 `versionId` 是 Kernel 返回的 opaque 标识，不在控制面重新生成或猜测。

### 2.2 文档权限模型

`DocumentAccessPolicy` 是文档级权限唯一 owner：

- `inherit`：调用现有空间角色决策。
- `restricted`：空间普通成员默认无权，只有 `DocumentAccessGrant` 的 user/group grant 有效。
- 组织 owner/admin 与 space admin 永远保留管理访问；不支持 `deny` grant。
- grant capability 只有 `viewer`、`commenter`、`editor`，服务端向下折叠能力，不向上提升。

请求链为 `HTTP/WS ingress -> Zod contract -> DocumentAccessPolicy -> use case -> Prisma/Kernel -> response`。Controller 不重新计算权限，Kernel 不知道组织 ACL；所有正文、评论、历史和分享入口都消费同一 policy 输出。

目录分页是 ACL 的热路径：API 在一次事务中批量读取当前页的组织/空间角色、文档策略和匹配 grant，再在内存中按文档身份派生可见项；不得为每个目录项重新打开权限事务。

### 2.3 内容身份

所有 L2 公共请求、事件和持久化查询都显式携带：

`organizationId + spaceId + notebookId + documentId`

块评论再携带 Kernel 返回的 `anchorBlockId`。文档级评论的 `anchorBlockId` 为 `null`，不得用空字符串、首块、标题、路径或当前编辑器状态替代。`CommentThread` 是锚点身份的唯一持有者，`CommentEntry` 只引用线程，避免重复写一套内容身份。

### 2.4 评论与通知事务

评论、回复、解决、重开、删除、ACL 变更和版本恢复都在同一控制面事务中：

1. 读取已通过 ingress schema 的最小输入。
2. 在唯一 policy owner 复验当前文档能力和实体状态。
3. 写领域状态、审计事件和站内 `Notification` 收件箱记录。
4. 事务提交后返回 canonical 结果；失败回滚全部领域变更，不返回局部成功。

L2 站内通知不新增 WebSocket 或消息总线。持久化通知行本身是可靠收件箱，React 使用 Query invalidation、显式刷新和有界轮询读取。未来外部渠道以独立 `worker_jobs` kind 扩展，不改变站内收件箱事实源。

ACL 替换提交后通过事务内通知发送文档身份关闭事件，撤销该文档全部 pending/active Kernel WebSocket；浏览器重连时重新执行完整 ACL 判定。短暂关闭仍有权限的连接是可接受的可用性代价，用于避免旧 grant 在权限切换窗口继续推送，且不向客户端推送权限快照。

### 2.5 历史与恢复

复用已授权的 Kernel history 路由和当前 Gateway，不添加第二套 History service。API 负责：

- 在入口用文档 ACL 决定是否允许读取历史。
- 把 Kernel 历史响应裁剪为最小版本摘要/差异合同。
- 恢复前要求 `editor`，通过正式三 ID 内容链调用 Kernel。
- 在 Kernel canonical 响应后写恢复审计和通知。

恢复失败不改变当前正文；旧版本不可变。历史列表、差异和恢复请求均拥有独立 `requestId`，异常保留完整堆栈。

## 3. 模块边界与文件 owner

模块按可独立实现、集成和验收的纵向切片划分；同一模块包含 schema、生产代码、调用方、迁移、永久测试和文档。

| 模块 | 目标 | 主要文件范围 | 前置/输出 |
| --- | --- | --- | --- |
| L2 contracts | 统一 ACL、评论、通知、历史 API/event schema 和 OpenAPI | `enterprise/packages/contracts/src/{collaboration,document-access,notifications,history}.ts`、`paths.ts`、`openapi.ts` | 输入给 API/Web/测试；不持有业务状态 |
| L2 control-plane | Prisma 模型、迁移、ACL policy、评论事务、通知收件箱、审计 | `enterprise/packages/database/**`、`enterprise/apps/api/src/collaboration/**`、`document-access/**`、`notifications/**` | 依赖现有组织/空间/组/审计；输出真实 HTTP |
| L2 kernel history | 在现有 Gateway/route policy 上补齐历史最小投影和恢复合同 | `enterprise/apps/api/src/kernel/**`、`enterprise/packages/authorization/**`、必要 Kernel 路由测试 | 依赖显式内容身份和 ACL 输出；不复制正文 |
| L2 web | 评论面板、提及选择、通知入口、ACL 页面、历史面板 | `enterprise/apps/web/src/comments/**`、`notifications/**`、`document-access/**`、`history/**`、现有路由与 shadcn components | 只消费 contracts/API；跨页面通知筛选用既有 Query/Zustand |
| L2 integration | 真实 HTTP、PostgreSQL、Gateway、浏览器和 P5 纵向合同 | `enterprise/apps/*/test/**`、`enterprise/apps/web/tests/{browser-integration,e2e}/**` | 依赖全部模块完成后一次集中验证 |
| L2 docs | PRD、架构、ADR、计划和验收证据 | `docs/product/l2-*`、`docs/architecture/l2-*`、`docs/adr/0029-*`、`plans/2026-07-21-l2-*` | 与权威方案同步，不写隐藏推理 |

共享 `contracts/src/index.ts`、`paths.ts`、`openapi.ts`、`CoreModule`、Worker registry 和 React 应用组合根由集成 owner 统一修改；模块 owner 不并发抢写。

### 3.1 声明式装配

- API 使用 Nest `@Module`、`@Injectable`、`@Controller`、已有访问装饰器、Zod `Pipe` 和 DI token。
- ACL policy 是被 service 注入的唯一公开接口，不在 Controller、Kernel client、React 或分享 service 中复制判断。
- 评论/通知领域事件通过明确 service method 产生，不建立中央 `switch` 或文件扫描 registry。
- L2 不新增 Worker handler；只有未来外部通知发送经用户确认后，才使用现有 `@HandlesWorkerJob`/`@ProducesWorkerJob` 声明式发现。

## 4. 持久化结构与状态

以下为方案级模型，最终字段由 contracts/Prisma owner 定稿；同一语义不保留同义字段。

| 模型 | 关键字段/约束 | 状态 |
| --- | --- | --- |
| `DocumentAccessPolicy` | `organizationId + spaceId + notebookId + documentId` 唯一；`mode=inherit|restricted` | 当前策略 |
| `DocumentAccessGrant` | policyId、principal `user|group`、principalId、capability；同一 principal 唯一 | active/revoked |
| `CommentThread` | policy 内容身份、anchorKind、nullable anchorBlockId、createdBy、state | open/resolved/deleted |
| `CommentEntry` | threadId、author、body、parentId、createdAt、editedAt、deletedAt | immutable history + soft delete |
| `Notification` | recipientUserId、eventKey、content identity、sourceId、readAt、createdAt | unread/read |

所有跨组织/空间关系使用现有复合外键习惯；`CommentEntry` 通过 thread 归属内容，不重复保存三 ID。ACL grant 成员关系查询必须在事务中读取当前组织/用户组状态，不能使用前端快照。

### 4.1 状态转换

```text
DocumentAccessPolicy: inherit -> restricted
CommentThread: open <-> resolved -> deleted
Notification: unread -> read
Version: immutable -> current (restore creates a new version)
```

状态转换由各自 use case owner 负责；重复提交按公开幂等合同处理，不增加 fallback 或第二状态机。

## 5. source-to-consumer 链路与边界 owner

### 5.1 评论/提及

`React form -> contracts schema -> authenticated HTTP controller -> DocumentAccessPolicy -> CommentService transaction -> Prisma CommentThread/Entry + Notification + AuditWriter -> React Query response`

- 首次 ingress owner：contracts/Zod pipe，负责字段形状和大小。
- 权限 owner：DocumentAccessPolicy，负责当前文档和收件人可见性。
- 持久化 owner：CommentService transaction，负责线程、通知、审计原子提交。
- 下游假设：Web 不再自行过滤收件人，Kernel 不读取评论元数据。

### 5.2 历史/恢复

`React history action -> contracts schema -> ACL policy -> existing Gateway -> Kernel history API -> canonical response -> AuditWriter/Notification -> React Query invalidation`

- Gateway 继续拥有 mTLS、服务 JWT、路由和三 ID 合同。
- ACL service 不解析 Kernel 正文；Kernel 不判断组织/用户组权限。
- 历史差异只在消费点展示，禁止写入全局 store 或 PostgreSQL 正文表。

## 6. 设计模式与简化评估

- **Dependency Injection**：复用 Nest 原生 DI，让 ACL policy、CommentService、NotificationService 和 AuditWriter 可真实装配；不增加自造容器。
- **Policy/Strategy**：`inherit` 与 `restricted` 是两个明确策略分支，由一个 policy owner 承担；不把每个角色做成独立 registry。
- **Observer/Event-driven（有限采用）**：仅用数据库中已提交的通知行/审计行表达异步结果，不做实时订阅或进程内事件总线。
- **不采用 CQRS/Event Sourcing**：L2 的评论和 ACL 需要普通事务与当前投影，事件溯源会复制正文/权限事实并增加恢复成本。
- **不采用专用 Comment/Notification 微服务**：Nest 模块化单体已有真实事务边界，拆服务会破坏评论、ACL、审计原子提交。
- **不采用客户端 ACL store 或全局文档快照**：服务端每次读取复验，React 只缓存 Query 结果，数据路径更短且不会形成第二事实源。

## 7. 安全、可观测性与错误语义

- 所有新异常路径使用既有 API logger/problem filter，记录原始异常对象、完整 `name/message/stack`、`requestId` 和稳定事件标签；正文、提及文本、令牌、Cookie、路径和组成员快照不入日志。
- ACL/评论/历史/通知响应统一使用授权后的最小投影；隐藏式 404 不暴露文档存在、标题、作者或数量。
- 评论正文按普通文本处理；HTML、脚本、SVG、XML、PDF 和未知附件继续沿用 L1 主动内容隔离。
- 通知点击重新读取权限；不能用已读通知中的旧标题、URL 或角色绕过当前授权。
- 锚点删除不自动迁移；跨空间/跨文档身份不通过标题、路径、首响应或 DOM 推断。
- 所有重要写入写入 L1 审计，`requestId` 与 HTTP/WS/Kernel 请求链一致；不新增同义 audit writer。

## 8. 前端设计系统与状态流

- 复用 `enterprise/apps/web/src/components/ui` 中的 shadcn/Radix 组件和 Tailwind 4 语义 token；新增 `CommentStatus`、`NotificationState`、`DocumentAccessCapability` variants 必须先写入设计系统。
- 评论编辑器、ACL 表格、通知抽屉和历史差异使用已有 `Sheet`、`Dialog`、`Table`、`Badge`、`Tabs`、`Tooltip`、`Alert` 组件；页面不写一次性颜色/间距/圆角。
- 文档、评论、ACL、通知和历史服务器状态使用 React Query；仅通知筛选/抽屉局部状态进入既有 Zustand 或组件局部状态。不会通过多层 props/callback drilling 传递领域事实。
- UI 操作使用明确按钮和现有 Lucide 图标；没有必要的文字胶囊或自绘图标。

## 9. 测试矩阵与统一门禁

L2 是一个集中 verification 大阶段，全部五个功能、迁移、调用方、旧路径清理和文档完成后才进入 code-review/verification。实现期间只运行一次必要的静态诊断，不运行正式聚合 runner。

| 合同 | 最低层级 | 真实边界 | 既有测试处置 |
| --- | --- | --- | --- |
| contracts/OpenAPI/内容身份 | contract/static | Zod、OpenAPI、真实序列化 | 扩展现有 contracts runner，不新建孤儿脚本 |
| ACL 复合外键、继承/受限、组变更 | database integration | 固定 PostgreSQL | 扩展 `database/test/l1-control-plane.integration.test.ts` 或同领域新 suite |
| 评论事务、提及收件人、通知幂等 | API integration | Nest HTTP + PostgreSQL | 扩展 API integration，保留异常 stack 合同 |
| Kernel history/restore | API/Kernel integration | mTLS Gateway + Go Kernel | 扩展现有 gateway/history 入口，不复制客户端解析 |
| 评论/ACL/通知/历史 UI | component | Vitest + Testing Library +真实消费组件 | 扩展现有 Web component runner，复用 shadcn setup |
| ACL 越权、评论、通知点击、版本恢复 | browser integration | Playwright，必要时替换明确外部边界 | 复用现有 diagnostics；不称真实 E2E |
| 一条跨层 L2 用户链 | E2E | 真实 React/Nest/PostgreSQL/Gateway/Kernel | 扩展唯一 P5 `test:e2e`，不新增第二 launcher |
| 异常、日志和清理 | integration/e2e | 原始异常对象、进程/DB/浏览器生命周期 | 复用现有 logger/diagnostics/stack supervisor |

统一命令形态在实现完成后一次确定并执行：`pnpm verify:l2`（或由 `enterprise/package.json` 扩展现有 `verify:s0-s3` 聚合），内部按 lint/typecheck/contracts/database/API/Web/browser/Kernel/P5 顺序执行。不得按功能点插入测试命令。

## 10. 任务依赖与完成条件

1. contracts 与 ACL/评论/通知/历史公开 schema 定稿，并完成 OpenAPI 同步。
2. Prisma 迁移与复合约束定稿；database owner 完成有效权限和通知事务合同。
3. API ACL policy、评论事务、通知查询和历史 Gateway 接线完成；旧 L1 分享/审计入口不复制。
4. Web 评论、通知、ACL、历史页面完成并消费统一 Query/contracts；设计系统 variants 收口。
5. 真实 integration/browser/P5 永久测试和文档完成；删除探索脚本、重复 runner、旧字段或 fallback。
6. 集中 code-review + test-governance 复评通过。
7. 集中 verification 矩阵通过，更新权威方案和本计划证据，提交并推送。

完成定义：所有 PRD 验收项通过；不存在跨文档/跨空间泄露、评论事务部分成功、通知重复未读、ACL 客户端自证、历史覆盖旧版本或实时协作越界；异常保留完整堆栈，关键函数有必要中文备注。

## 11. 并行模块图

```text
Contracts + ACL policy contract (唯一共享 owner)
        |
        +--> Control-plane: Prisma + API comments/ACL/notifications
        |
        +--> Kernel history: existing Gateway/history projection
        |
        +--> Web: comments/notifications/document ACL/history UI
        |
        +--> Integration: API/DB/Kernel contracts
                    |
                    +--> P5 E2E + unified L2 verification
```

模块可在共享 contracts 和数据库迁移合同冻结后并行；`paths.ts`、`openapi.ts`、`CoreModule`、App 组合根和唯一 P5 launcher 只能由集成 owner 修改。发生冲突时先在仓库根目录 `mailbox.md` 记录文件、owner、未完成意图和可转做任务，处理完成后删除已解决消息。

## 10. 当前验证状态

代码复评和 test-governance 复评已通过。静态、合同、固定 PostgreSQL/API/Worker/Web、生产构建、Kernel service-auth 与 P5 真实 E2E（12/12）通过；三视口 browser integration 聚合仍有 40 个既有页面元素稳定性超时（19 passed、64 skipped），因此暂不宣称 L2 全阶段 verified。

## References

1. [L2 异步协作产品需求](../product/l2-async-collaboration.md)
2. [ADR-029：L2异步协作控制面边界](../adr/0029-l2-async-collaboration-boundary.md)
3. [ADR-006：实时协作技术门禁](../adr/0006-realtime-collaboration-gate.md)
4. [ADR-019：NestJS声明式控制面装配](../adr/0019-declarative-nest-control-plane.md)
5. [ADR-020：空间内容目录引导](../adr/0020-space-content-directory-bootstrap.md)
6. [ADR-021：信任边界校验所有权](../adr/0021-trust-boundary-validation-ownership.md)
