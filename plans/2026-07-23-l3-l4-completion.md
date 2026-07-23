---
title: "奇点 L3 生产认证与 L4 企业能力持续交付计划"
description: "先闭合 L3 生产发布认证，再按已选 Docmost 差距完成 L4；含恢复上下文、边界合同与验证门禁"
author: "Codex"
date: "2026-07-23"
version: "1.2.0"
status: "active"
tags: ["plan", "l3", "l4", "docmost", "enterprise"]
---

# 奇点 L3 生产认证与 L4 企业能力持续交付计划

## Change Log

| Version | Date | Author | Changes |
| --- | --- | --- | --- |
| 1.0.0 | 2026-07-23 | Codex | 建立 L3 认证与 L4 持续交付计划 |
| 1.1.0 | 2026-07-23 | Codex | 归档 L4 集中验证通过，保留 supervisor 回滚手工门禁 |
| 1.2.0 | 2026-07-23 | Codex | 重跑 L4 唯一 aggregate 并归档浏览器竞态修复后的 L3/L4 全量证据 |

## Objective

先完成 L3.1 生产发布认证，再按用户已选范围完成 L4 知识治理与 Docmost 企业能力差距；全程遵守产品设计 → 架构方案 → implementation → code-review → test-governance/verification 门禁。目标路径：本计划；L3 权威资料见 `docs/product/l3.1-realtime-collaboration.md`、`docs/architecture/l3.1-realtime-collaboration.md`、`docs/adr/0031-l3-production-collaboration.md`、`docs/verification/l3.1-realtime-collaboration.md`；L4 产品草案见 `docs/product/l4-knowledge-governance.md`。

## Background

L3.0/L3.1 已完成实现、代码评审、测试治理复评、技术验证和单副本生产发布认证；认证范围仍限定为单 API 副本、单空间 Kernel，功能开关默认关闭。L4 已完成 PRD、架构、ADR、实现、整阶段复评和集中验证；本轮 L4 aggregate 在浏览器竞态修复后重新通过，当前只保留真实部署 supervisor 多进程回滚这一发布前手工门禁。

## Locked Assumptions

- L3 首期为单 API 副本、单空间 Kernel 通道；跨副本实时协作另立方案。
- Go Kernel 独占正文、块、AV、历史与 canonical operation log；Nest/PostgreSQL 仅持有控制面元数据、ACL、会话、任务与审计投影。
- 每条跨边界请求/事件显式携带 `organizationId + spaceId + notebookId + documentId`；不得从 DOM、全局状态、路径或首个响应推断。
- `DocumentAccessPolicy` 为 ACL 唯一 owner；下游消费 capability 与撤权代次，不复制权限算法。
- `restricted-encrypted` 为唯一加密协作模式；密钥不可进入控制面、日志、正文快照或浏览器持久化。
- 后端沿用 Nest 声明式 `@Module`、DI、Guard、Pipe、Interceptor、Discovery metadata；同一 kind/version 冲突启动失败。
- 固定测试库保留 `singularity-postgres-test`、`127.0.0.1:55432`、`singularity_test`；不得每次新建临时库。
- 不使用子代理；关键函数须有必要中文备注；不重复处理上游已保证的不可达非法值。

## Compatibility / Contracts

- L3 技术验证通过 ≠ 生产发布认证通过；发布状态须单独记录，不得把 `status: verified` 当成默认开放。
- L3 生产认证至少覆盖：2 用户冒烟、10/20 用户容量、接近单文档 64 活动会话上限、ACL 撤权、API/Kernel 重启、加密密钥不可用拒绝、关闭开关收敛、回滚、脱敏日志与观测关联。
- L4 不修改 `.sy` 正文事实模型，不在 PostgreSQL 建正文/operation payload 第二事实源；治理状态、外部身份映射与任务均为控制面事实。
- SCIM 只同步外部用户/用户组，不直接改文档 ACL；SAML/OIDC 负责登录，MFA 负责二次认证，API Key 仅用于机器身份。本期闭合凭据生命周期和可注入校验服务，既有会话业务路由不宣称已整体支持 API Key。
- 所有新增 API、消息、任务和 UI 文案须进入公共合同、i18n、审计与权限边界；用户撤权后会话、协作和待处理任务必须收敛。
- 现有 Protyle 推送 WS 与专用协作 WSS 保持分离；L4 不引入第二正文状态源或隐式兼容 fallback。

## Current Progress

- [x] L0-L2 已完成并同步 `origin/master`。
- [x] L3.0 语义原型已完成技术验证。
- [x] L3.1 生产协作实现、代码评审、测试治理复评和唯一技术验证 aggregate 已通过。
- [x] L3 生产认证 PRD/验收矩阵、架构方案与 ADR 已建立；技术验证与发布认证已分栏。
- [x] L3 生产发布认证（认证范围内）已完成：automated aggregate 通过，20 用户/64 会话上限、重启、撤权、加密、开关关闭、浏览器和受控 API 回滚均有证据；真实多进程 supervisor 回滚明确列为发布前重复动作，未误报为自动化覆盖。
- [x] L4 产品、架构、ADR 和实施计划已获确认并落盘，公共四段身份、ACL owner、控制面事实源和集中测试矩阵已冻结。
- [x] L4 整阶段 code-review/test-governance 复评完成，已移交唯一 `verify:l4-governance` 集中验证。
- [x] L4 完整 SAML Assertion、MFA 登录 challenge、治理 Worker、真实 PDF 导出/审计和带引用 AI provider 已实现并通过集中验证；报告见 `docs/verification/l4-enterprise-capabilities.md`。
- [x] 2026-07-23 重跑 `pnpm verify:l4-governance`：12 个阶段命令全部通过，浏览器 65 通过、64 条件跳过，L3 regression aggregate 通过；固定数据库、临时运行资源和测试端口均已清理。
- [x] L3 目标 supervisor 认证已形成唯一结构化证据入口：`pnpm verify:l3-target-supervisor`；在真实部署执行前仍保持 pending，不以本地演练代替。
- [x] L4-F 用户入口实现与集中验证已收口：治理管理面、身份安全、MFA challenge、个人空间导航、跨空间搜索结果打开和文档侧治理/嵌入/AI 均有 React 路径，组件与浏览器证据已纳入唯一 aggregate。

## Next Steps

### L3 生产认证

1. [x] 依据认证计划、架构方案和 ADR 完成 aggregate、runbook 和证据矩阵。
2. [x] 使用固定 PostgreSQL、受控 Kernel 和真实 Nest/WSS/浏览器完成认证。
3. [x] 完成 10/20 用户容量、64 会话上限、撤权、重启、加密、开关关闭和回滚证据。
4. [ ] 在目标部署 supervisor 上重复一次多进程制品回滚并保存运维记录；本地 supervisor 演练已通过，不影响当前单副本认证结论。

### L4 方案收口

1. [x] 将页面验证、企业模板、审批/发布、密级、归档、保留/法律保留、水印、治理仪表盘与 Docmost 差距写入正式 PRD。
2. [x] 以身份安全、知识治理、内容发现/嵌入、AI 四条边界冻结功能和权限 owner。
3. [x] 明确用户故事、状态机、数据归属、失败语义、开关、审计与验收证据。
4. [x] PRD、架构方案、ADR 和实施计划已完成；外部协议和 provider 的未实现项仍受阶段门禁约束。

### L4 实现与交付

1. [x] 完成首批控制面、治理、SCIM/API Key/MFA 边界、个人空间、搜索、嵌入和导出水印实现，并补齐真实 HTTP/DB 合同测试。
2. [x] 完成整阶段 code-review/test-governance 复评，移交唯一 `pnpm verify:l4-governance` aggregate。
3. [x] 完成 SAML Assertion adapter、MFA 登录 challenge、治理 Worker、真实 PDF 导出审计和带引用 AI provider。
4. [x] 完成 L4-F React 用户入口、文档侧面板和作用域导航实现，并由唯一 `pnpm verify:l4-governance` 生成最终组件/浏览器证据。

## Risks

- 把技术验证误报为生产认证，导致功能开关过早开放。
- 试点容量、Kernel 重启或固定数据库环境不可用，认证证据不完整。
- MFA/SCIM/SAML 与外部 IdP 差异造成协议、租户隔离和撤权竞态。
- L4 同时覆盖多项企业能力，若不按边界拆分会形成重复权限、重复身份或第二事实源；本期 API Key 保持生命周期和可注入验证服务边界，既有会话业务路由不宣称整体改造。
- Draw.io/Excalidraw、AI Chat 等外部运行时和数据边界未定义，可能突破内容身份与加密合同。

## Verification

- L3 技术回归入口：`cd /root/projects/singularity/enterprise && pnpm verify:l3-production`。
- L3 生产认证须增加可复现的预发布/试点、容量、重启、撤权、加密、回滚和观测证据；不能以静态检查替代。
- L4 采用各阶段唯一 aggregate，覆盖 contracts、Nest/Prisma、Kernel/导出、React/浏览器、权限/安全、任务/审计、性能和静态边界。
- 所有测试变更同时遵守 `test-governance`；真实边界使用真实 Nest、固定数据库、受控 Kernel 和浏览器证据，明确替身边界。
- 验证后检查工作树、进程、固定数据库、敏感日志、Markdown/UTF-8 和远程同步状态。
- L4 集中验证报告：`docs/verification/l4-enterprise-capabilities.md`；结构化结果：`enterprise/test-results/l4-governance/report.json`。

## Resume Guide

```text
cd /root/projects/singularity
git status --short --branch
git log -8 --oneline --decorate
sed -n '1,260p' plans/2026-07-23-l3-l4-completion.md
sed -n '1,220p' docs/verification/l3.1-realtime-collaboration.md
sed -n '1,220p' docs/product/l4-knowledge-governance.md
sed -n '1,260p' docs/verification/l4-enterprise-capabilities.md
```

恢复后先读取本计划、L4 实施计划和 L4 验证报告；L4-F 已完成实现与集中验证，后续仅保留目标部署 supervisor 的多进程制品回滚手工门禁，不得把本地替身或受控 API 回滚扩大解释为真实部署认证。
