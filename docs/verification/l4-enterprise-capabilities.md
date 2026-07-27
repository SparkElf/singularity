---
title: "奇点 L4 企业能力集中验证报告"
description: "记录 L4 企业身份、知识治理、发现嵌入与授权 AI 的整阶段验证证据"
author: "Codex"
date: "2026-07-23"
version: "1.9.0"
status: "automated-passed"
tags: ["verification", "l4", "enterprise", "governance"]
---

# 奇点 L4 企业能力集中验证报告

> 本报告记录 L4 整阶段唯一验证入口的结果。L4 不改变 Go Kernel 正文事实源，也不扩大 L3 单 API 副本、单空间 Kernel 的发布范围。

## Change Log

| Version | Date | Author | Changes |
| --- | --- | --- | --- |
| 1.0.0 | 2026-07-23 | Codex | 记录 L4 集中验证通过和残余发布边界 |
| 1.1.0 | 2026-07-23 | Codex | 重跑 L4 唯一 aggregate，补齐浏览器竞态修复后的 59/64 结果和 L3 回归证据 |
| 1.2.0 | 2026-07-23 | Codex | 校正报告范围：上一轮只证明 L4-A 到 L4-E，L4-F 用户入口进入 implementation |
| 1.3.0 | 2026-07-23 | Codex | L4-F 用户入口完成集中验证；修复治理 fixture 身份合同和预期取消请求证据 |
| 1.4.0 | 2026-07-23 | Codex | 补充固定 P5 体验栈实时 smoke 证据，并明确不替代目标 supervisor 认证 |
| 1.5.0 | 2026-07-23 | Codex | SCIM 2.0 Users/Groups 扩展完成唯一 aggregate 验证 |
| 1.6.0 | 2026-07-23 | Codex | 修复固定测试库并发争用与 Kernel 纯文本投影尾部零宽字符后，完成 12 项 aggregate 最终复验 |
| 1.7.0 | 2026-07-23 | Codex | 纳入真实 Nest HTTP SAML start/callback 成功、重放拒绝、签名篡改拒绝和脱敏堆栈证据；最终 aggregate 通过 |
| 1.8.0 | 2026-07-23 | Codex | L4-G 收口：记录 23 条验收标准逐项证据矩阵，更新最终 aggregate 的 API/Worker 集成计数 |
| 1.9.0 | 2026-07-24 | Codex | 更新当前固定测试库 P5 体验栈 smoke 证据，保留目标 supervisor 发布门禁边界 |

## Table of Contents

1. [结论](#1-结论)
2. [环境与入口](#2-环境与入口)
3. [结果摘要](#3-结果摘要)
4. [23 项验收证据矩阵](#32-23-项验收证据矩阵)
5. [测试治理与边界](#4-测试治理与边界)
6. [残余风险](#5-残余风险)
7. [References](#references)

## 1. 结论

唯一 aggregate `pnpm verify:l4-governance` 已通过，报告状态为 `automated-passed`；SCIM 2.0 ServiceProviderConfig、Users、Groups、分页/filter、PATCH 和标准错误资源，真实 Nest HTTP SAML start/callback 成功与拒绝路径，以及 L4-F React 用户入口、组件测试、浏览器路径和 L3 回归均已纳入同一轮正式证据。当前仍保持功能开关默认关闭，发布遵守单 API 副本、单空间 Kernel 的 L3 边界。

## 2. 环境与入口

正式命令：

```bash
cd /root/projects/singularity/enterprise
pnpm verify:l4-governance
```

结构化证据：`enterprise/test-results/l4-governance/report.json`。

固定数据库保持运行：

| 项目 | 值 |
| --- | --- |
| 容器 | `singularity-postgres-test` |
| 地址 | `127.0.0.1:55432` |
| 数据库 | `singularity_test` |
| 状态 | Docker 容器运行中，供后续测试复用 |

验证结束后，runner 拉起的 Nest、Vite preview、Playwright 和 Chromium 进程均已退出；没有残留测试端口。

### 2.1 固定 P5 体验栈 smoke

2026-07-24 00:36（Asia/Shanghai）在固定 PostgreSQL schema `singularity_p5_e2e_1784824570` 上启动 Go Kernel、Nest API、Nest Worker 和 HTTPS Vite preview 完成实时 smoke。API readiness、编辑账号登录、授权空间列表和 Web 首页均返回 200；体验入口为 `https://127.0.0.1:4174/`。该 smoke 只证明当前本地体验链路可用，不替代 `target-supervisor-evidence.json` 要求的真实部署多进程回滚认证。

## 3. 结果摘要

| 验证模块 | 结果 |
| --- | --- |
| Architecture and contract boundary | 通过 |
| Contracts | 34/34 通过 |
| Prisma/database integration | 60/60 通过 |
| API typecheck + unit | 130/130 通过 |
| API integration | 241/241 通过 |
| Worker unit | 40/40 通过 |
| Worker integration | 22/22 通过 |
| React component | 187/187 通过 |
| Browser integration | 65 通过，64 按项目条件跳过，无失败 |
| L3 production regression aggregate | 通过，contracts、Kernel、API、Web 和 L3.1 boundary 均通过 |
| L4-F React 用户入口 | 组件、浏览器和 L3 回归证据已通过 |
| L4-B 身份协议与 SCIM 资源兼容 | SAML 真实 HTTP start/callback 成功、重放拒绝、签名篡改拒绝；ServiceProviderConfig、Users、Groups、分页/filter、PATCH、标准错误和组织隔离证据已通过 |

### 3.1 本轮失败根因与修复

第一轮浏览器失败集中来自治理面板随文档挂载后，共享 fixture 未提供治理只读投影；同时搜索 fixture 使用了不符合 `14 位时间戳-7 位后缀` 的内容 ID，迟到搜索取消也未在诊断证据中区分。已补齐四段身份治理投影、合法内容 ID 和预期取消请求语义，完整聚合重跑通过。

## 3.2 23 项验收证据矩阵

以下矩阵以本轮唯一入口 `cd enterprise && pnpm verify:l4-governance` 的标准 runner 结果为准；一个验收标准可以由多个跨层 case 共同证明，未用源码字符串、私有访问或局部 mock 代替运行时证据。

| 编号 | 真实入口与证据 | 结果 |
| --- | --- | --- |
| L4-LIFE-01 | `apps/api/test/governance.http.test.ts`：`keeps approval decisions bound to the current version and policy interval` 覆盖合法状态链和非法 publish/旧版本拒绝 | 通过 |
| L4-APP-01 | 同一 HTTP case 的重复 submit/approve 409；`packages/database/test/l4-governance.integration.test.ts` 的显式版本唯一约束 | 通过 |
| L4-APP-02 | 同一 HTTP case 的 approve/reject 结果、意见和版本返回；治理审计写入由 API integration 复验 | 通过 |
| L4-APP-03 | 当前版本 token 绑定与 stale approve 拒绝；审批表按四段身份+versionToken 唯一持久化 | 通过 |
| L4-VER-01 | HTTP verify 依据策略产生 `nextVerificationAt`；`apps/worker/test/governance-task.integration.test.ts` 的 verify 任务一次执行/幂等完成 | 通过 |
| L4-TPL-01 | `apps/api/test/governance-template.http.test.ts` 的发布模板、一次 Kernel 建文档和未发布拒绝；浏览器治理路径可达 | 通过 |
| L4-CLS-01 | `apps/api/test/governance.http.test.ts`：密级提升成功、降低 409；DB/审计结果可读 | 通过 |
| L4-RET-01 | Worker retention/archive case 在 legal hold 下不改变正文生命周期；关闭开关后的 retain 任务不执行 | 通过 |
| L4-RET-02 | `governance-task.integration.test.ts` 的任务状态收敛、失败保留和重试幂等；数据库唯一 idempotency key 约束 | 通过 |
| L4-WM-01 | `apps/api/test/kernel-gateway.http.test.ts`：真实 HTTP export 返回身份水印响应头并写入 `watermarkRef` 审计引用 | 通过 |
| L4-WM-02 | 同一 export case 证明正文响应不变；数据库只保存摘要引用，未写正文/历史/浏览器持久化 | 通过 |
| L4-AUD-01 | 治理状态、legal hold、模板、API Key、Worker 结果均通过现有 audit writer/DB integration 查询 | 通过 |
| L4-ACL-01 | 治理 HTTP 入口先经过既有 document/space ACL owner；manager capability 和跨组织隔离由 API integration 复验 | 通过 |
| L4-OBS-01 | API/Worker 失败路径统一保留原始 `name/message/stack` 与 request/task 关联；aggregate observability cases 通过 | 通过 |
| L4-ROLL-01 | `governance.http.test.ts` 的关闭开关新 mutation 403；Worker 关闭开关事务内将在途任务标为 `cancelled` 并写 denied 审计 | 通过 |
| L4-ID-01 | `identity.http.test.ts`：真实 Nest SAML start/callback 成功、重放/篡改拒绝；MFA enrollment/challenge/verify 和禁用会话 401 | 通过 |
| L4-ID-02 | `governance.http.test.ts`：SCIM Users/Groups、分页/filter/PATCH、撤销 token 和组织隔离；不修改文档 ACL | 通过 |
| L4-ID-03 | API Key HTTP 创建/摘要/撤销 + service 机器验证覆盖最小 scope、过期、撤销、一次性明文和 secretDigest 脱敏 | 通过 |
| L4-SPACE-01 | 个人空间创建、组织成员约束、撤权后不可返回；React 管理路径和 DB constraint 均通过 | 通过 |
| L4-SEARCH-01 | `space-discovery.http.test.ts` 的 Kernel 授权搜索；`l4-governance.spec.ts`/Discovery component case 证明迟到响应丢弃且不串空间 | 通过 |
| L4-EMBED-01 | `DocumentGovernancePanel.test.tsx` 的 sandbox 预览、来源窗口/kind/version 匹配保存；正文在嵌入失败时仍可读 | 通过 |
| L4-AI-01 | `space-discovery.http.test.ts` 的 re-authorized Kernel citation + `DocumentGovernancePanel.test.tsx` 的四段引用跳转和 scope 竞态 | 通过 |
| L4-AI-02 | AI provider 不可用/引用复验失败稳定拒绝；API integration 保留原始堆栈，不返回无引用 fallback | 通过 |

矩阵结论：23/23 条验收标准均有对应的真实入口、跨层结果和标准 runner 证据。L3 目标 supervisor 多进程回滚不是 L4 验收项，仍由独立 pending 证据门禁控制。

## 4. 测试治理与边界

- **声明式装配**：Nest module、DI、metadata discovery 和 Worker job handler 由真实 bootstrap/API/worker 结果证明；没有中央 registry 或源码扫描替代装配。
- **身份链路**：API、任务、搜索、导出、AI 和浏览器测试均沿 `organizationId + spaceId + notebookId + documentId` 传递身份；下游不从 DOM、全局状态或首个响应推断。
- **事实源**：Go Kernel 继续拥有正文、块、AV、历史和导出内容；PostgreSQL 只保存控制面、任务、审计和最小索引/引用元数据。
- **异常可观测性**：异常路径保留原始 `name/message/stack` 与 request/session 关联；敏感 token、断言、正文、prompt 和密钥不进入日志或持久化。
- **测试边界**：固定 PostgreSQL、真实 Nest bootstrap、受控 Kernel 和真实浏览器用于跨层合同；外部 IdP 与 AI provider 只在明确的协议/provider 边界使用最小替身。
- **重构收敛**：本轮没有新增兼容入口、重复 validator、fallback、第二正文事实源或同义字段。
- **用户入口边界**：治理管理页、MFA challenge、个人空间导航、跨空间搜索结果打开和文档治理面板已进入代码，并由本轮唯一 aggregate 完成组件与浏览器验证。
- **SAML HTTP 边界**：测试先通过真实 `/api/v1/auth/saml/start` 取得 AuthnRequest，再由固定自签名 IdP fixture 生成合法 Assertion 访问真实 `/api/v1/auth/saml/callback`；同一响应重放和签名篡改均返回 503。验证保留完整异常堆栈与 request 关联，同时确认 SAMLResponse、邮箱和断言内容不进入日志。该 fixture 证明本地 ACS/协议链路，不等同于外部企业 IdP 灰度联调。

## 5. 残余风险

1. L3 生产认证仍限定为单 API 副本、单空间 Kernel；多副本、跨区域和消息总线需要另立方案和 ADR。
2. 真实部署 supervisor 的多进程制品回滚仍是发布前手工门禁，当前未伪造为自动化完成。
3. SAML 的真实企业 IdP 联调、SCIM 供应商差异和 AI provider 生产容量不在固定本地 aggregate 的替身边界内，进入灰度前需按 runbook 补充外部系统证据。

## References

1. [L4 产品需求](../product/l4-knowledge-governance.md)
2. [L4 企业能力架构方案](../architecture/l4-enterprise-governance.md)
3. [ADR-0033：L4 企业能力事实源与模块边界](../adr/0033-l4-enterprise-capabilities.md)
4. [L3.1 生产实时协作验证报告](l3.1-realtime-collaboration.md)
5. [L3 生产认证运行手册](../runbooks/l3-production-certification.md)
