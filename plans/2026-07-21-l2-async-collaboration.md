---
title: "L2异步协作实施计划"
description: "奇点评论、提及、通知、版本历史与文档级权限的可恢复开发计划"
author: "Codex"
date: "2026-07-21"
version: "1.0.0"
status: "proposed"
tags: ["plan", "l2", "async-collaboration", "comments", "permissions"]
---

# L2 异步协作实施计划

## Objective

依据以下方案完成 L2 异步协作大阶段：

- 产品：[docs/product/l2-async-collaboration.md](../docs/product/l2-async-collaboration.md)
- 架构：[docs/architecture/l2-async-collaboration.md](../docs/architecture/l2-async-collaboration.md)
- ADR：[docs/adr/0029-l2-async-collaboration-boundary.md](../docs/adr/0029-l2-async-collaboration-boundary.md)
- 权威总案：[output/md/Singularity_Enterprise_Knowledge_Base_v1.0.0_2026-07-13.md](../output/md/Singularity_Enterprise_Knowledge_Base_v1.0.0_2026-07-13.md)

目标能力：评论线程、`@` 提及、站内通知、文档版本历史和文档级权限。L2 不实现实时多人编辑；L3 仍需独立 CRDT/内容语义原型。

## Current State

- L0/L1 已完成并推送至 `origin/master`。
- L1 已拥有组织/空间/用户组、显式三 ID 内容链、分享、审计、备份、Worker 声明式发现、React Query/shadcn/Tailwind 4 和现有 Kernel history 路由基础。
- 当前工作树除忽略的 `artifacts/`、`kernel/vendor/` 生成目录外干净；本计划建立后进入 L2 方案审阅，不运行 L2 正式测试。

## Locked Contracts

- 云端内容权威：正文、块、历史内容和块 ID 由 Go Kernel 拥有；PostgreSQL 不保存正文或完整历史快照。
- L2 内容身份显式携带 `organizationId + spaceId + notebookId + documentId`；块评论额外使用 Kernel 返回的 `anchorBlockId`。
- ACL 唯一 owner 为 `DocumentAccessPolicy`；只有 `inherit`/`restricted`，grant 只有 user/group 与 `viewer/commenter/editor`，无 deny 规则。
- `space.admin`、组织 owner/admin 始终保留管理访问；ACL 变更不由客户端自证。
- 评论、提及通知、ACL 变更、历史恢复和审计在一个控制面事务内提交；通知失败不得返回局部成功。
- 站内通知使用持久化 PostgreSQL 收件箱、刷新和有界轮询；不新增 L2 WebSocket 通知通道。
- 历史恢复通过现有 Gateway/Kernel history 合同，恢复为新版本，不覆盖旧版本。
- 后端使用 Nest 原生声明式装配、Prisma/PostgreSQL 和现有 `AuditWriter`；不新增中央 switch、手工 registry、fallback 或薄 adapter。
- 关键函数必须有必要中文备注；异常保留完整 `name/message/stack` 与 `requestId`，日志不得包含正文、令牌或路径。
- 只使用现有 shadcn + Tailwind 4 设计系统和语义 token；业务页面不写一次性视觉事实。

## Stage Boundary

这是一个完整集中评审/验证大阶段，包含五项功能的生产代码、类型、迁移、调用方、永久测试和文档。实现期间可以自查静态语法，但不运行正式 aggregate runner。全部 owner 释放后进行一次集中 code-review + test-governance，再一次性进入 verification。

## Module Owners and File Scope

| 顺序 | 模块 owner | 生产范围 | 交接合同 |
| --- | --- | --- | --- |
| 1 | L2 contracts | `enterprise/packages/contracts/src/` collaboration/access/notifications/history、`paths.ts`、`openapi.ts` | schema、OpenAPI 和三 ID 内容身份冻结后交给所有模块 |
| 2 | L2 database/control plane | `enterprise/packages/database/**`、API collaboration/access/notifications | 复合 FK、ACL policy、评论事务、通知收件箱和审计调用 |
| 3 | L2 Kernel history | API kernel authorization/Gateway/history 投影；必要 Go 合同 | 复用现有 mTLS/JWT/Gateway，返回 canonical history/restore |
| 4 | L2 Web | Web comments/notifications/document-access/history、路由和设计系统 variants | React Query 服务器状态、局部 Zustand/组件状态，不复制正文 |
| 5 | L2 integration | 各模块永久 contract/integration/component/browser/E2E 及文档收口 | 只有全部模块完成后集成唯一 runner 和 P5 |

共享文件（contracts 聚合器、Prisma schema、CoreModule、唯一 P5 launcher、根命令/lockfile）由集成 owner 统一写入；冲突先在仓库根目录 `mailbox.md` 记录，未决期间转做无冲突模块。

## Implementation Tasks

### A. Product and contracts

- [ ] PRD、架构、ADR 经审阅，冻结 ACL、comment anchor、notification 和 history 公开语义。
- [ ] 定义 `DocumentAccessPolicy/Grant`、`CommentThread/Entry`、`Notification`、history summary/diff/restore 的 Zod 与 OpenAPI schema。
- [ ] 为所有公共路径编排组织、空间、笔记本、文档身份；删除任何近似字段或客户端推断路径。

### B. Database and control plane

- [ ] 添加文档 ACL/Grant、评论线程/条目、通知收件箱的迁移和复合外键；设计唯一索引、分页索引和软删除语义。
- [ ] 实现唯一 `DocumentAccessPolicy`，覆盖继承/受限、用户/组 grant 和能力折叠。
- [ ] 实现评论/回复/解决/重开/删除事务；同事务写审计与提及/ACL/恢复通知。
- [ ] 实现通知列表、未读计数、已读/全部已读和当前权限重新检查。
- [ ] 保护异常日志、请求关联、正文脱敏和隐藏式 404 语义。

### C. Kernel history and API

- [ ] 复用并收紧现有 history Gateway 路由的文档 ACL、三 ID、mTLS/JWT 和最小投影。
- [ ] 实现版本列表、差异和恢复为新版本的 HTTP contracts；恢复失败不改变当前正文。
- [ ] 记录版本查看/恢复、ACL、评论、提及和通知动作的稳定审计。

### D. React Web and design system

- [ ] 在设计系统中定义 comment state、notification state、ACL capability、history diff 的 token/variants。
- [ ] 实现评论线程与块/文档锚点面板、提及候选、回复/解决/重开交互。
- [ ] 实现通知入口、未读计数、已读和权限失效后的统一不可见结果。
- [ ] 实现文档权限面板和历史列表/差异/恢复确认；不把正文或历史全文放入全局状态。
- [ ] 删除探索脚本、旧字段、重复 fixture、一次性样式和未注册 runner。

### E. Tests and documentation (written during implementation, run at stage end)

- [ ] 扩展 contracts/OpenAPI 标准 runner，保证 schema 可按 case 独立运行。
- [ ] 扩展 PostgreSQL integration：复合 FK、继承/受限、组变化、通知幂等和事务回滚。
- [ ] 扩展 API integration：真实 HTTP、ACL、评论、提及、通知、history/restore 及完整异常 stack。
- [ ] 扩展 Web component/browser integration：真实消费组件、设计系统状态、权限和导航生命周期。
- [ ] 扩展唯一 P5 E2E：至少一条评论+提及+通知、ACL 切换、历史恢复的真实链路；不新增 launcher。
- [ ] 更新权威方案 7/9/11.4、L2 文档和完成记录。

## Dependency Order

```text
PRD/ADR review
  -> contracts + ACL schema
  -> database migration + control-plane policy
  -> history Gateway + API
  -> Web surfaces and design variants
  -> permanent tests and old-path cleanup
  -> one code-review/test-governance review
  -> one L2 verification matrix
```

## Verification Matrix

执行时只使用一个 L2 aggregate（命令名在实现阶段随根 `package.json` 定稿），顺序如下：

1. static：TypeScript、ESLint、OpenAPI/architecture boundary、设计系统和旧路径审计。
2. contract：Zod/OpenAPI、内容身份、ACL/评论/通知/history 序列化。
3. database integration：固定 PostgreSQL 复合 FK、权限状态、事务和通知幂等。
4. API integration：真实 Nest HTTP、隐藏式 404、审计、Gateway/Kernel history。
5. component：评论、提及、通知、ACL、历史页面和 shadcn 状态 variants。
6. browser integration：桌面/mobile/320px、权限失效、迟到响应、console/network health。
7. P5 E2E：真实 React/Nest/PostgreSQL/Worker/Gateway/Go Kernel 链路；不以 route mock 替代目标后端。
8. Kernel/build/security：Go 回归、production build、SBOM、漏洞、许可证和旧入口闭包。

触发条件：所有任务和文档完成、code-review 复评通过后一次性执行。失败先按共同根因收集和整批修复，再复评和重跑受影响矩阵，不逐功能循环测试。

## Completion Definition

- PRD L2-ACL/L2-COM/L2-MEN/L2-NOT/L2-HIS/L2-OBS/L2-BOUND 全部通过。
- 无跨空间或跨文档泄露、客户端 ACL 自证、评论部分提交、重复未读通知、历史覆盖旧版本或 L3 实时协作越界。
- 所有新路径由统一 contracts、Nest 声明式装配、审计和设计系统承载；无旧路径、兼容字段、fallback、薄 adapter 或孤儿测试。
- 集中 verification 矩阵通过，更新权威方案、ADR、计划状态并提交推送。

## Resume Guide

下次先读取本计划、L2 PRD/架构/ADR、权威方案 7/9.2/11.4，再检查：

```text
cd /root/projects/singularity
git status --short --branch
git log -8 --oneline --decorate
cat /root/projects/mailbox.md 2>/dev/null || true
```

方案获审阅前只修改上述 L2 方案文件；获审阅后从 contracts/ACL schema 开始 implementation。不得启动或重配固定 PostgreSQL，不得恢复 L3 实时编辑范围。
