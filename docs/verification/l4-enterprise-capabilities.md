---
title: "奇点 L4 企业能力集中验证报告"
description: "记录 L4 企业身份、知识治理、发现嵌入与授权 AI 的整阶段验证证据"
author: "Codex"
date: "2026-07-23"
version: "1.4.0"
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

## Table of Contents

1. [结论](#1-结论)
2. [环境与入口](#2-环境与入口)
3. [结果摘要](#3-结果摘要)
4. [测试治理与边界](#4-测试治理与边界)
5. [残余风险](#5-残余风险)
6. [References](#references)

## 1. 结论

唯一 aggregate `pnpm verify:l4-governance` 已通过，报告状态为 `automated-passed`；L4-F React 用户入口、组件测试、浏览器路径和 L3 回归均已纳入同一轮正式证据。当前仍保持功能开关默认关闭，发布遵守单 API 副本、单空间 Kernel 的 L3 边界。

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

2026-07-23 17:44（Asia/Shanghai）在固定 PostgreSQL schema `singularity_p5_e2e_7230723` 上复用已启动的 Go Kernel、Nest API、Nest Worker 和 Vite preview 完成实时 smoke。API readiness、账号登录、空间列表、Kernel 内容目录和治理仪表盘均返回 200；Web 首页返回 200。该 smoke 只证明当前本地体验链路可用，不替代 `target-supervisor-evidence.json` 要求的真实部署多进程回滚认证。

## 3. 结果摘要

| 验证模块 | 结果 |
| --- | --- |
| Architecture and contract boundary | 通过 |
| Contracts | 33/33 通过 |
| Prisma/database integration | 60/60 通过 |
| API typecheck + unit | 130/130 通过 |
| API integration | 229/229 通过 |
| Worker unit | 40/40 通过 |
| Worker integration | 21/21 通过 |
| React component | 185/185 通过 |
| Browser integration | 65 通过，64 按项目条件跳过，无失败 |
| L3 production regression aggregate | 通过，contracts、Kernel、API、Web 和 L3.1 boundary 均通过 |
| L4-F React 用户入口 | 组件、浏览器和 L3 回归证据已通过 |

### 3.1 本轮失败根因与修复

第一轮浏览器失败集中来自治理面板随文档挂载后，共享 fixture 未提供治理只读投影；同时搜索 fixture 使用了不符合 `14 位时间戳-7 位后缀` 的内容 ID，迟到搜索取消也未在诊断证据中区分。已补齐四段身份治理投影、合法内容 ID 和预期取消请求语义，完整聚合重跑通过。

## 4. 测试治理与边界

- **声明式装配**：Nest module、DI、metadata discovery 和 Worker job handler 由真实 bootstrap/API/worker 结果证明；没有中央 registry 或源码扫描替代装配。
- **身份链路**：API、任务、搜索、导出、AI 和浏览器测试均沿 `organizationId + spaceId + notebookId + documentId` 传递身份；下游不从 DOM、全局状态或首个响应推断。
- **事实源**：Go Kernel 继续拥有正文、块、AV、历史和导出内容；PostgreSQL 只保存控制面、任务、审计和最小索引/引用元数据。
- **异常可观测性**：异常路径保留原始 `name/message/stack` 与 request/session 关联；敏感 token、断言、正文、prompt 和密钥不进入日志或持久化。
- **测试边界**：固定 PostgreSQL、真实 Nest bootstrap、受控 Kernel 和真实浏览器用于跨层合同；外部 IdP 与 AI provider 只在明确的协议/provider 边界使用最小替身。
- **重构收敛**：本轮没有新增兼容入口、重复 validator、fallback、第二正文事实源或同义字段。
- **用户入口边界**：治理管理页、MFA challenge、个人空间导航、跨空间搜索结果打开和文档治理面板已进入代码，并由本轮唯一 aggregate 完成组件与浏览器验证。

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
