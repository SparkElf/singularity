---
title: "奇点 L4 企业能力架构方案"
description: "在 L3 单副本实时协作之上建设知识治理、企业身份、发现嵌入与授权 AI"
author: "Codex"
date: "2026-07-23"
version: "1.2.0"
status: "accepted"
tags: ["architecture", "l4", "enterprise", "governance"]
---

# 奇点 L4 企业能力架构方案

## Decision

L4 继续把 Go Kernel 作为正文、块、AV、历史和导出内容的唯一事实源；NestJS + Prisma + PostgreSQL 只保存企业控制面：组织身份、成员同步、API Key 摘要、治理策略、生命周期状态、审批/验证/保留任务、搜索索引元数据、嵌入元数据、AI 引用审计和通知。所有内容请求显式传递 `organizationId + spaceId + notebookId + documentId`，不从前端路由、DOM、全局状态或首个响应推断身份。

身份安全、知识治理、发现/嵌入和 AI 是四个粗粒度模块；它们共享一个控制面基础合同和既有 ACL/审计 owner，不各自建立权限、正文、搜索或任务事实源。

## Local Precedents and Research

| 来源 | 采用 | 规避 |
| --- | --- | --- |
| `docs/architecture/l1-share-audit-backup.md`、`docs/adr/0024-audit-observability-projection.md` | 控制面投影、任务状态、稳定审计事件和 worker 对账 | 不把内容正文复制进 PostgreSQL |
| `DocumentAccessPolicyService`、L3 `CollaborationControlService` | ACL 单一 owner、撤权代次和服务端状态收敛 | 不在每个 L4 service 复制角色算法 |
| `KernelGatewayService`、`ContentDirectoryService` | Kernel bridge 只接收已授权的四段内容身份和最小载荷 | 不在搜索、AI 或导出层拼接近似身份 |
| `enterprise/apps/api` 的 `DiscoveryModule`/metadata handler | Nest `@Module`、DI、Guard、Pipe、Interceptor、Discovery metadata 声明式装配 | 不用中央 switch、文件名扫描或双 registry |
| L4 PRD 对标的 Docmost、Confluence、Outline、GitLab Wiki | 空间内治理、文档状态侧栏、集合搜索、审阅时间线 | 不复制其私有实现或隐式权限继承 |

本地证据已覆盖模块边界、任务、审计和内容 owner；SAML/SCIM 协议按公开标准合同实现，L4 不依赖某个 IdP 的私有扩展。当前实现已闭合 `@node-saml/node-saml` Assertion 校验、MFA 登录 challenge、治理 Worker、导出审计和可注入 AI provider；整阶段 code-review/test-governance 复评和 `verify:l4-governance` 已通过，结论见 [L4 集中验证报告](../verification/l4-enterprise-capabilities.md)。

上一轮 aggregate 证明的是控制面和既有页面合同，不等于所有已实现 API 都有可达用户入口。本轮新增 L4-F 用户路径收口，完成前不把 L4 标记为完整交付。

## Scope and Stages

### L4-A Control-plane foundation

建立治理策略、文档生命周期、任务/审计事件、feature gate、组织和空间级配置的公共合同。该阶段不新增用户功能页面，只提供后续纵向模块的事实源和状态机。

### L4-B Identity and machine access

MFA、SAML、SCIM、API Key 共用组织身份边界。SAML 只负责登录断言，MFA 负责二次认证，SCIM 只同步用户/组生命周期，API Key 只负责机器调用；四者不能直接改文档 ACL。

### L4-C Knowledge governance

实现审批、页面验证、模板、密级、归档、保留、法律保留、PDF/分享水印和治理仪表盘。治理状态是控制面事实，正文变更仍经 Kernel。

### L4-D Discovery and content extensions

实现个人空间、授权范围内跨空间搜索、Draw.io/Excalidraw 嵌入和企业 PDF 导出。搜索结果和嵌入元数据只保存最小索引/引用，正文读取由 Kernel bridge 完成。

### L4-E Authorized AI

在 L4-D 稳定后实现 AI Chat。检索服务必须先按四段身份和 ACL 过滤，再生成带引用的回答；AI 不可用或引用校验失败时不返回无依据答案。

## Module Boundaries

| 模块 | 生产 owner | 输入 | 输出 | 不拥有 |
| --- | --- | --- | --- | --- |
| `l4-control-plane` | GovernancePolicy/Task/Audit services | 组织/空间策略、四段内容身份 | 状态转移、任务租约、脱敏审计 | 正文、登录协议、搜索正文 |
| `l4-identity` | Identity/SAML/MFA/SCIM/API-Key services | 外部断言、SCIM 资源、机器请求 | 本地身份、成员/组同步、凭据状态 | 文档 ACL、正文、AI 权限 |
| `l4-governance` | Lifecycle/Approval/Verification/Retention services | 当前版本摘要、策略、ACL capability | 生命周期、决策、验证/归档任务、水印策略 | Kernel 内容、外部身份 |
| `l4-discovery` | PersonalSpace/Search/Embed/Export services | 授权空间集合、内容引用、嵌入声明 | 最小索引结果、嵌入状态、导出请求 | 未授权内容、正文快照 |
| `l4-ai` | Retrieval/Chat services | 授权查询、引用 ID、AI provider result | 带引用回答、会话审计、失败状态 | 全局向量库、绕过 ACL 的上下文 |

## Source-to-Consumer Data Flow

```text
Browser/IdP/SCIM/CLI
  -> Nest transport (HTTP/SAML/SCIM)
  -> schema/parser + auth/session boundary
  -> Guard resolves ACL capability and four-part identity
  -> feature service/use case owns state transition
  -> Prisma transaction writes control metadata and outbox/task/audit projection
  -> Worker claims idempotent task
  -> Kernel bridge reads/writes canonical content only when capability is valid
  -> React/Zustand consumes typed result and server state
```

Each boundary has one owner:

| 边界 | 唯一 owner | 下游假设 |
| --- | --- | --- |
| SAML assertion → local session | SAML parser + IdentityService | 下游只消费已验证 subject/organization，不再解析 XML |
| SCIM request → member/group mutation | SCIM schema + provisioning service | ACL service 只消费同步后的 active membership，不把 SCIM role 当文档角色 |
| API Key header → machine identity | API Key verifier service（供后续机器入口通过 DI/Guard 注入） | controller 不读取原始 token，不重复 hash/解析；L4 本期不替换现有会话业务路由 |
| content request → capability | `DocumentAccessPolicyService` | governance/search/AI 只消费 capability 和四段身份 |
| lifecycle command → state | Lifecycle state service | controller 不自行改变状态，worker 不推断状态 |
| Kernel content → export/index/AI | Kernel bridge | 控制面不保存正文快照；消费点就近生成派生结果 |
| result → React view | typed query + Zustand store | UI 不提升权限、不以旧响应覆盖当前 identity |

非法值只在真实入口处理：外部 HTTP/SCIM/SAML、数据库历史任务、第三方嵌入响应和 AI provider 响应。上游 schema 已排除的理论值不在 service/controller/worker 重复拦截。

## Declarative Nest Design

- 每个模块使用 `@Module` 声明 imports/providers/controllers/exports；跨模块能力通过 token interface 注入。
- 认证和治理策略以 `@Injectable` service + `@UseGuards`/custom metadata 表达；请求 schema 使用 Zod Pipe，错误由全局 problem filter 转成稳定合同。
- 可扩展治理动作实现公开 `GovernanceActionHandler` interface 并标注 `@GovernanceAction(kind, version)`；`DiscoveryService` 在所属模块启动时发现。相同 `kind/version` 或缺必需 provider 时启动失败，禁止中央手工 registry。
- 任务处理器使用现有 `@HandlesWorkerJob({ kind: "governance-task" })` metadata，由 Worker Discovery 在模块边界内装配；治理任务表负责业务状态，统一 worker job 表负责租约、重试和幂等。
- 事件使用现有 PostgreSQL notification/outbox owner；不新增消息总线，不让 handler 直接互相调用内部方法。

声明式 metadata 只承担装配、权限标签和任务分类；生命周期状态转移、审批决策、SCIM 幂等和检索授权仍在显式 service/use case 中。

## Persistence and Contracts

Prisma 控制面新增实体按模块命名且只保留一个权威语义字段：

- Identity：`mfa_factors`、`mfa_login_challenges`、`saml_providers`、`scim_external_identities`、`scim_tokens`、`enterprise_api_keys`（仅摘要、prefix、用途、过期和状态）。
- Governance：`governance_policies`、`document_governance`、`governance_approval_requests`、`governance_templates`、`governance_tasks`。
- Discovery：`personal_spaces`、`search_document_index`（只存内容 ID/摘要/授权索引元数据）、`embedded_objects`、`export_audits`。
- AI：`ai_conversations`、`ai_messages`、`ai_citations`（用户查询只存摘要，回答和引用绑定四段身份，不存原始 prompt 或正文快照）。

所有实体包含组织/空间作用域；文档级实体必须同时保存 notebook/document identity，不允许用路径或名称替代。正文、operation payload、SAML assertion、SCIM bearer token、API Key 明文和 AI provider credential 不进入数据库。

## React and Design System

L4 前端沿用当前思源风格，先更新共享 shadcn + Tailwind 4 设计系统，再组合业务页面：

- 语义 token：`surface`、`surface-muted`、`border`、`text`、`text-muted`、`accent`、`success`、`warning`、`danger`、`focus`，同时提供 light/dark 主题。
- 共享组件：`StatusBadge`、`PolicySummary`、`GovernanceTimeline`、`DataTable`、`AuditDrawer`、`Wizard`、`ConfirmDialog`、`EmptyState`、`ErrorState`。
- 状态/数据流：跨页面治理筛选、身份同步和搜索上下文使用 Zustand store；组件内部表单仍用局部 state。store 只保存当前作用域的 typed server state，不保存正文或密钥。
- 用户路径：组织治理页提供模板、策略、身份凭据、个人空间和跨空间搜索；文档侧面板提供生命周期、审批、密级、法律保留、Draw.io/Excalidraw 和 AI Chat。文档面板只接受 `organizationId + spaceId + notebookId + documentId`，不从 DOM 或首个响应推断身份。
- 模板应用：`POST /api/v1/organizations/{organizationId}/spaces/{spaceId}/governance/templates/{templateId}/documents` 的请求必须显式携带 `notebookId + title`，父文档通过可选 `parentDocumentId` 指定。API 生成符合 Kernel 内容 ID 合同的 `documentId`，调用 Kernel `/api/filetree/createDocWithMd`，并在成功后写入治理元数据；模板 `initialContent.markdown` 是唯一正文种子，控制面不保存正文事实。
- 敏感值：API Key 与 SCIM token 的明文只存创建成功后的组件瞬时状态，刷新或离开页面即丢弃；查询缓存与 Zustand 不保存密钥。
- 视觉改动必须回写 token 或 shadcn variant；业务页面不得增加一次性颜色、间距、阴影和 inline style。

## Design Pattern Review

- Dependency Injection + Discovery metadata：减少模块间中央分发，新增治理动作只增加声明和自身 provider。
- State：生命周期、验证、保留和凭据状态由显式 transition service 管理，禁止 controller/worker 直接修改状态。
- Observer/Event-driven：权限撤销、SCIM 停用和 feature gate 变化通过既有通知链收敛会话、任务和索引。
- Strategy：SAML provider、AI provider 和水印策略只在真实协议/供应商差异处使用；不为同形 service 造 adapter。
- Command：治理任务和审批决策作为可审计命令，记录幂等 key 和结果。
- 未采用第二 CRDT、全局 event bus、Repository wrapper、全量 DTO mapper 或独立权限引擎；它们会增加事实源和数据路径。

## Observability and Security

- 稳定标签：`identity.saml`、`identity.scim`、`identity.mfa`、`identity.api-key`、`governance.lifecycle`、`governance.task`、`discovery.search`、`embed.lifecycle`、`ai.retrieval`。
- 每条日志保留 request/trace、组织/空间/文档摘要、状态转移、耗时和错误 `name/message/stack`；不记录正文、断言、token、API Key、prompt、provider credential 或完整 payload。
- AI、搜索和导出建立授权失败、引用验证失败、迟到响应和任务重试诊断点；日志只记录原因码和计数，正文/向量不进日志。
- SAML XML、SCIM JSON、嵌入 URL 和 AI provider 回包视为不可信输入；SSRF、XML entity、重放、密钥轮换和请求限流由各自真实入口 owner 处理。

## Test Matrix and Governance

| 合同 | 最低充分层级 | 真实边界 | 统一入口 |
| --- | --- | --- | --- |
| 生命周期/审批/验证/保留状态 | contract + API integration | Prisma transaction、任务租约、审计 | `verify:l4-governance` |
| SAML/MFA/SCIM/API Key | contract + identity integration + browser | 真实 HTTP、签名断言 fixture、固定 DB；IdP/邮件仅替身 | 同上 |
| 模板/密级/水印/导出 | API/integration + browser | Kernel bridge、真实导出响应、存储/日志检查 | 同上 |
| 个人空间/跨空间搜索 | API + browser race | 固定多空间数据集、真实 ACL、迟到响应 | 同上 |
| Draw.io/Excalidraw | browser + export integration | 不可信嵌入响应、正文可读性和导出审计 | 同上 |
| AI Chat 授权引用 | retrieval integration + browser | 授权检索真实控制面，AI provider 使用最小替身 | 同上 |
| 安全/敏感数据/回滚 | static + integration | logger、数据库、任务和 feature gate | 同上 |

L4 每个大阶段只运行一次集中 aggregate。implementation 期间允许编写永久测试但不运行正式门禁；code-review/test-governance 复评完成后统一执行 `pnpm verify:l4-governance`。现有 L1-L3 测试保留，重复的治理边界测试合并到 L4 aggregate，不新增孤儿脚本或伪 E2E。

## Parallel Module Graph

```text
L4-A control-plane contracts / design tokens
  ├──> L4-B identity and machine access
  ├──> L4-C knowledge governance
  └──> L4-D personal space + search + embeds/export
             └──> L4-E authorized AI Chat
```

模块 owner 和合并顺序：L4-A 先冻结公共合同、Prisma migration、设计 token 和 test fixture；L4-B/C/D 可在合同稳定后分模块开发，但共享 ACL、审计和任务文件由 L4-A owner 统一集成；L4-E 等待搜索授权结果和引用合同稳定后开发。整阶段 integration 只在所有模块完成后进行。

## Completion Definition

- PRD、架构方案、ADR 和实施计划完成评审，功能开关默认关闭。
- L4-A~E 所有生产代码、迁移、调用方、永久测试、旧路径清理和中文关键函数备注完成；L4-F 的组织管理面和文档侧用户路径可达。
- 没有第二正文/权限/搜索/AI 事实源；所有跨边界事件带四段内容身份，敏感数据不落控制面。
- 代码评审和 test-governance 复评通过，`verify:l4-governance` 统一 aggregate 通过，报告逐条说明 API、真实用户入口和残余风险覆盖范围。

## References

1. [L4 产品需求](../product/l4-knowledge-governance.md)
2. [L3 生产认证架构](./l3-production-certification.md)
3. [L1 控制面与审计架构](./l1-share-audit-backup.md)
4. [L3 生产认证与 L4 持续交付计划](../../plans/2026-07-23-l3-l4-completion.md)
