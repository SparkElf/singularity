---
title: "ADR-0033：L4 企业能力事实源与模块边界"
description: "确定 L4 身份、知识治理、发现嵌入和授权 AI 的控制面、权限与扩展边界"
author: "Codex"
date: "2026-07-23"
version: "1.3.0"
status: "accepted"
tags: ["adr", "l4", "enterprise", "governance"]
---

# ADR-0033：L4 企业能力事实源与模块边界

## Status

Accepted。L4 PRD 已获用户确认，架构方案和本 ADR 已冻结；本轮对 L4-D/E 的搜索、AI 和嵌入编辑数据流做收口，完成后需重新复评和集中验证。真实外部 IdP/provider 联调与部署 supervisor 回滚仍按验证报告列出的边界单独取证。

## Context

用户已确认建设 Docmost 企业差距和知识治理能力。若每项功能各自保存正文、权限、搜索快照或身份映射，会重新制造 L3 已消除的跨空间串库、迟到响应覆盖和撤权后事件泄漏。L4 还包含 SAML、SCIM、MFA、API Key、外部嵌入和 AI，信任边界明显多于普通页面功能。

## Decision

1. Go Kernel 继续拥有正文和历史；Nest/PostgreSQL 只拥有企业控制面与最小派生元数据。
2. 企业模板应用必须复用 Kernel 原生文档创建合同。API 在控制面边界生成新文档 ID，并把四段内容身份传入 Kernel；不得由前端复制正文、直接写 PostgreSQL 或从首个目录响应推断笔记本。
2. L4 分为 control-plane、identity、governance、discovery/extensions、authorized-AI 五个模块；ACL 继续由 `DocumentAccessPolicyService` 唯一负责。
3. 所有文档级请求、事件、任务和引用带完整 `organizationId + spaceId + notebookId + documentId`；搜索/AI 不允许用名称、路径或最近响应推断身份。
4. Nest 采用 `@Module`、DI、Guard、Pipe、Interceptor、custom metadata 和 DiscoveryService；同一 metadata kind/version 冲突启动失败。
5. SAML 只建立登录会话，SCIM 只同步成员/组，MFA 只完成二次认证，API Key 只建立机器身份；身份模块不直接写文档 ACL。
6. 治理、搜索、导出和 AI 都消费 ACL capability；AI 只返回带可验证引用的回答，无法授权或验证引用时拒绝。
7. React 使用共享 shadcn + Tailwind 4 token/variants，跨组件服务端状态使用 Zustand；业务组件不得建立局部视觉或事实源。
8. SAML Assertion 由 `@node-saml/node-saml` 在 callback 边界完成签名、issuer、audience 和时间校验；MFA 登录使用数据库摘要 challenge 后复用现有会话签发器。
9. 治理任务使用现有 Worker Discovery 的 `governance-task` job kind；PDF/导出成功前写入最小 `export_audits` 记录，AI provider 通过 token 注入并要求至少一条重新授权验证的引用。跨空间搜索直接消费 Kernel `discovery/search` 的授权结果；AI 当前文档取证使用独立的 Kernel `document/content` 读取接口，不使用问题关键词推断当前文档，也不使用未接入生产写入链路的控制面搜索索引作为事实源。
10. Draw.io/Excalidraw 以版本化 `postMessage` 编辑协议接入：协议版本固定为 `1`，父页面以 iframe 来源、来源 origin、`version`、`embedId`、`kind` 和公共 payload schema 作为唯一消息边界；仅允许跨源 HTTPS 编辑器地址，编辑器不携带四段内容身份，也不能越过文档 ACL 直接写入。
11. Kernel `document/content` 是授权 AI 的唯一正文读取 owner：请求通过 `FullContentIdentityRequired` 注入并绑定四段内容身份，响应只投影 `documentId`、`notebookId`、`title` 和有界纯文本。API 在 provider 前后各读取一次并比较身份与内容版本；读取失败或内容变化时拒绝回答，不添加关键词 fallback。

## Alternatives

| 方案 | 取舍 | 结论 |
| --- | --- | --- |
| 每个功能自带正文/权限/搜索表 | 开发初期快，但产生第二事实源和撤权竞态 | 拒绝 |
| 引入独立 IAM/权限引擎和全局消息总线 | 可覆盖更多企业场景，但改变 L3 部署边界和运维复杂度 | 拒绝，协议先落在 Nest 控制面 |
| 只做前端过滤和 AI 后置检查 | 交互容易，但不能作为安全控制 | 拒绝 |
| 一个 L4 巨型 service + 中央 switch | wiring 直观但模块边界和扩展冲突不可控 | 拒绝 |
| 控制面公共合同 + 粗粒度纵向模块 + 声明式发现 | 复用 owner、减少事实源，模块可按依赖交付 | 采用 |

## Consequences

### Positive

- 内容、权限、身份和治理职责清晰，撤权可以沿既有事件链收敛会话、任务、搜索和 AI。
- L4 功能可以按模块开发与集中验收，不需要并行维护同义字段或兼容路径。
- 敏感凭据与正文不进入控制面，审计和回滚证据可脱敏保存。

### Negative

- SAML/SCIM/AI provider 的外部差异必须在真实入口适配，前期 fixture 和合同工作量较高。
- 跨空间搜索和 AI 必须先建立授权 discovery/引用合同，不能用快速的全局全文表替代；遗留搜索索引不参与事实读取。
- L4 仍依赖单 API/单 Kernel 的 L3 边界，多副本和灾备另立 ADR。

## Verification Gate

实现前必须通过 PRD、架构方案和本 ADR 评审；实现完成后由 `code-review`、`test-governance` 和唯一 `verify:l4-governance` aggregate 验收。该门禁已通过，报告证明正文/权限/身份事实源未分叉、撤权后任务和回答收敛、敏感数据不落库不进日志，并明确外部 IdP/AI provider 替身边界。

验证报告：[L4 企业能力集中验证报告](../verification/l4-enterprise-capabilities.md)。

## References

1. [L4 产品需求](../product/l4-knowledge-governance.md)
2. [L4 企业能力架构方案](../architecture/l4-enterprise-governance.md)
3. [L3 生产实时协作验证](../verification/l3.1-realtime-collaboration.md)
