---
title: "奇点 L4 企业能力实施计划"
description: "按控制面、身份、知识治理、发现嵌入和授权 AI 的依赖顺序完成 L4"
author: "Codex"
date: "2026-07-23"
version: "1.3.0"
status: "active"
tags: ["plan", "l4", "enterprise", "governance"]
---

# 奇点 L4 企业能力实施计划

## Change Log

| Version | Date | Author | Changes |
| --- | --- | --- | --- |
| 1.0.0 | 2026-07-23 | Codex | 建立 L4 模块实施顺序和阶段门禁 |
| 1.1.0 | 2026-07-23 | Codex | 归档整阶段验证通过和残余发布边界 |
| 1.2.0 | 2026-07-23 | Codex | 校正 API 与用户入口完成边界，新增 L4 React 用户路径收口阶段 |
| 1.3.0 | 2026-07-23 | Codex | 收口模板应用合同、同步治理用户入口完成状态 |

## Objective

在 L3 单副本/单空间生产认证通过后，按已确认范围完成 L4：MFA、SAML、SCIM、API Key、页面验证、企业模板、审批、密级、归档/保留/法律保留、水印、个人空间、授权跨空间搜索、PDF 企业导出、Draw.io/Excalidraw 和带引用 AI Chat。

权威文件：

- PRD：`docs/product/l4-knowledge-governance.md`
- 架构：`docs/architecture/l4-enterprise-governance.md`
- ADR：`docs/adr/0033-l4-enterprise-capabilities.md`
- 总计划：`plans/2026-07-23-l3-l4-completion.md`

## Locked Contracts

- Go Kernel 是正文、块、AV、历史和导出内容事实源。
- PostgreSQL 只保存控制面、策略、任务、审计和最小引用/索引元数据。
- 文档级请求和事件必须显式带四段内容身份；ACL 由 `DocumentAccessPolicyService` 唯一负责。
- SAML/SCIM/MFA/API Key 不直接修改文档 ACL；AI/search 先授权再消费内容。
- Nest 使用声明式 module/DI/Guard/Pipe/metadata；React 使用 Zustand + shadcn/Tailwind 4 设计系统。
- 固定 PostgreSQL 测试库继续使用 `singularity-postgres-test`；正式 aggregate 只在整阶段完成后运行。

## Work Packages

### L4-A Control-plane foundation

范围：治理策略、生命周期状态机、任务/租约、审计动作、feature gate、公共四段身份合同、设计 token/variants。

完成条件：Prisma migration 和公共 contracts 稳定；非法状态转移、幂等 key、task retry、audit redaction 有 API/contract 证据；共享 UI 组件进入设计系统。

当前实现：三条 L4 migration、治理策略、文档状态机、审批版本条件、治理任务幂等键、密级/法律保留、审计和 shadcn 管理页已落地；治理任务已接入 `governance-task` 声明式 Worker job，个人空间复合成员约束和 SCIM Guard 已补齐。

### L4-B Identity and machine access

范围：MFA、SAML 登录、SCIM 用户/组同步、API Key 生命周期、会话/协作撤权联动。

完成条件：SAML/MFA 成功与失败状态稳定；SCIM upsert/deactivate 幂等且不改 ACL；API Key hash/过期/最小权限/一次性显示闭合，并提供可注入的机器身份校验服务；本阶段不把现有会话业务路由整体改成 API Key 入口。密钥/断言/token 不进日志和持久化。

当前实现：MFA TOTP enrollment/verify 与登录 challenge、SAML 配置和 `@node-saml/node-saml` Assertion callback、SCIM 用户/组幂等同步、SCIM Bearer Guard、API Key 创建/撤销/摘要校验服务已落地；现有业务路由仍以会话合同为准，治理管理页和身份安全入口已收口。

依赖：L4-A contracts、现有 Identity/Organization/Access owner。

### L4-C Knowledge governance

范围：生命周期、审批、页面验证、模板、密级、归档、保留、法律保留、水印、治理仪表盘。

完成条件：当前版本审批和验证可追溯；新版本不继承旧批准；任务可重试且不重复副作用；水印只在响应边界生成；治理动作复用 ACL 和审计。

当前实现：生命周期/审批/验证/模板发布与应用/密级单调提升/归档法律保留/仪表盘/失败堆栈、治理 Worker 和导出水印响应头已落地；治理策略、模板、审批、文档治理侧栏和导出动作均有真实 React 用户入口。

依赖：L4-A contracts、Kernel history/version、Worker。

### L4-D Discovery and extensions

范围：个人空间、授权跨空间搜索、Draw.io/Excalidraw、PDF 企业导出和导出审计。

完成条件：个人空间策略可追溯；搜索结果绑定空间/文档且迟到响应不覆盖当前 scope；嵌入失效不阻断正文；导出无授权或水印不可用时明确失败。

当前实现：个人空间幂等创建、服务端 ACL 搜索过滤、Draw.io/Excalidraw 元数据、导出水印边界和最小导出审计已落地；跨空间搜索、个人空间导航、受控嵌入编辑/预览、引用跳转和模板应用均由 L4-F 页面收口。

依赖：L4-A、L4-C policy/identity、Kernel bridge。

### L4-E Authorized AI

范围：AI Chat 会话、授权检索、引用、失权收敛、provider failure。

完成条件：回答带可验证引用；权限、密级或引用验证失败时拒绝；provider 不可用可重试；prompt、正文和凭据不进入控制面、日志或浏览器持久化。

当前实现：AI endpoint 复用文档 ACL，provider 通过 DI token 注入，回答持久化并写入四段身份引用；未配置 provider 时保留完整异常堆栈并稳定返回 503，不允许无引用 fallback。文档侧 AI Chat 和带完整身份的引用跳转均已接入。

依赖：L4-D search/reference contract、L4-B identity、L4-C governance policy。

### L4-F React user paths

范围：治理管理面中的模板、身份安全、SCIM/API Key/SAML/MFA、个人空间、跨空间搜索，以及文档侧治理、嵌入和 AI Chat 面板。

完成条件：每条已实现 API 都有可达的 React 用户入口；所有请求和查询 key 显式携带当前组织/空间/笔记本/文档身份；迟到响应不能覆盖当前作用域；密钥只在创建成功时显示一次；文档正文仍可在嵌入或 AI provider 失败时读取；关键用户路径有组件与浏览器 integration 证据。

依赖：L4-A~E 已冻结的公共合同、现有 shadcn/Tailwind 4 设计 token、Zustand 作用域状态。

当前实现：治理页已覆盖策略、模板创建/发布/应用、身份安全、个人空间和跨空间搜索；登录页消费 MFA challenge 联合合同并完成一次性验证码验证；搜索结果通过显式路由 state 进入目标空间，空间会话按四段身份从授权目录选择文档；文档侧治理、嵌入和引用式 AI 面板已接入编辑工作区。模板应用 API 先调用 Kernel 创建正文，再写入治理元数据，未创建控制面假文档；整阶段组件、浏览器和 API 合同证据由唯一 aggregate 生成。

## File Ownership and Integration Order

| 阶段 | 主要目录 | owner | 集成顺序 |
| --- | --- | --- | --- |
| A | `packages/contracts`、`packages/database`、`apps/api/src/governance`、`apps/web/src/design-system` | control-plane | 先合入 |
| B | `apps/api/src/identity`、`apps/api/src/scim`、`apps/web/src/settings/security` | identity | A 后 |
| C | `apps/api/src/governance`、`apps/worker/src/governance`、`apps/web/src/governance` | governance | A 后，可与 B 并行开发 |
| D | `apps/api/src/discovery`、`apps/api/src/embeds`、`apps/web/src/search`、`apps/web/src/embeds` | discovery | A/B/C 合同稳定后 |
| E | `apps/api/src/ai`、`apps/web/src/ai` | AI | D 的授权检索稳定后 |
| F | `apps/web/src/enterprise`、`apps/web/src/spaces`、`apps/web/src/governance`、`apps/web/src/ai` | integration | B~E API 合同稳定后，统一收口用户路径 |

共享 contracts、Prisma schema、ACL/审计 owner 和设计 token 不并行抢写；每个模块完成自身生产代码、调用方、迁移、永久测试和文档后，再由集成 owner 收口。

## Declarative Implementation Rules

- 新 controller 只负责 transport/schema/response；业务状态转移在 `@Injectable` service/use case。
- 新 handler 用 `@GovernanceAction`/`@GovernanceTask` metadata + Discovery 装配；kind/version 冲突在 bootstrap 失败。
- 权限用既有 Guard/capability；不在 controller、worker、AI retrieval 再写角色判断。
- 关键函数必须写必要中文备注，说明前置条件、状态转移和副作用；简单 getter 不强行备注。
- 所有异步/外部 I/O 错误保留 `name/message/stack`，日志只增加脱敏上下文。

## Stage Test Governance

实现阶段只编写和自查测试，不执行正式门禁；每个阶段完成后先 code-review/test-governance 复评，L4 全部模块完成后一次性运行：

```bash
cd /root/projects/singularity/enterprise
pnpm verify:l4-governance
```

统一矩阵：contracts/static、Nest/Prisma integration、Worker task integration、Kernel/export integration、真实 HTTP、React component、真实浏览器路径、搜索竞态、敏感日志/存储审计和回滚。已有 L1-L3 runner 保留并纳入 aggregate；不新增逐文件脚本、完整内部 mock 链或伪 E2E。

## Risks and Controls

- 身份协议差异：只在边界 adapter 处理，统一映射到本地 identity contract，保留原始错误关联但不保留敏感正文。
- 搜索/AI 串库：四段身份和 capability 作为查询输入的必需字段，迟到结果按 scope 丢弃。
- 治理任务重复：数据库唯一幂等 key + lease owner + 状态 transition，失败可重试但不重复副作用。
- 外部嵌入/导出泄露：响应边界鉴权与水印，失败不走无水印 fallback。
- L4 范围过大：按 A→B/C→D→E 大阶段集中评审；不按按钮或文件拆测试门禁。

## Resume Guide

```text
cd /root/projects/singularity
sed -n '1,260p' docs/product/l4-knowledge-governance.md
sed -n '1,320p' docs/architecture/l4-enterprise-governance.md
sed -n '1,220p' docs/adr/0033-l4-enterprise-capabilities.md
git status --short --branch
```

## Verification Result

L4 控制面、迁移、API、Worker 和用户入口已由唯一 `pnpm verify:l4-governance` aggregate 统一验证；组件 185/185、浏览器 65 通过且 64 条件跳过，L3 回归同步通过。发布仍遵守单 API 副本、单空间 Kernel 和目标 supervisor 手工门禁。

```bash
cd /root/projects/singularity/enterprise
pnpm verify:l4-governance
```

L4-F 当前状态为“实现与集中验证通过”。发布仍遵守 L3 单 API 副本、单空间 Kernel 和功能开关默认关闭的边界；真实 supervisor 多进程回滚和外部 IdP/provider 灰度证据不由本地 aggregate 伪造覆盖。

## Template Application Contract (completed)

- `governanceTemplateRequest.initialContent` 收敛为 `{ markdown?: string }`；Markdown 是唯一传给 Kernel 的正文种子，空对象表示空正文。
- 新建文档请求必须明确 `notebookId`、`title`，可选 `parentDocumentId`；API 生成 `documentId`，不会从空间首个笔记本、DOM 或模板名称推断身份。
- Kernel 创建成功后才写入治理元数据，默认密级和验证周期来自模板；Kernel 仍是正文事实源。
