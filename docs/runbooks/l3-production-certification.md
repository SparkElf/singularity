---
title: "L3 生产发布认证运行手册"
description: "奇点首期实时协作预发布、试点、容量、恢复、回滚与发布判定步骤"
author: "Codex"
date: "2026-07-23"
version: "1.1.0"
status: "production-certified"
tags: ["runbook", "l3", "release-certification", "realtime-collaboration"]
---

# L3 生产发布认证运行手册

## 适用范围

本手册只适用于单 API 副本、单空间 Kernel、固定 PostgreSQL 测试库和显式开启协作开关的预发布试点。它不能证明多副本、跨区域或灾备能力。

## 前置检查

1. 确认 Node.js 24、pnpm 11、Go、Docker 和 Playwright Chromium 可用。
2. 确认固定数据库容器 `singularity-postgres-test` 正常，地址为 `127.0.0.1:55432`，数据库为 `singularity_test`；不得创建临时测试库。
3. 确认本轮使用的 API/Web/Kernel/恢复端口空闲；不得停止或重配用户已保留的固定数据库。
4. 确认工作树和发布 commit 可追溯，认证报告目录为空或已归档。

## 技术验证

```bash
cd /root/projects/singularity/enterprise
pnpm verify:l3-production
```

该命令只证明技术合同，不等于生产发布认证。失败时先按共同根因修复，不能通过修改报告状态绕过。

## 发布认证 aggregate

```bash
cd /root/projects/singularity/enterprise
pnpm verify:l3-release-certification
```

aggregate 顺序为：技术验证、Kernel release case、真实 API/WSS release case、受控三进程 supervisor 回滚演练、真实浏览器 release case。结构化报告写入 `enterprise/test-results/l3-release-certification/report.json`，回滚证据写入同目录 `rollback.json`；本地演练通过后，`manualEvidence.rollback` 仍标记目标部署 supervisor 手工门禁待执行。

## 试点与容量

1. 以一组织、一空间、一笔记本、一文档创建试点数据；明确两名成员角色和文档 ACL。
2. 先以 2 用户完成 join、submit、确认、presence、冲突、离开、撤权和开关关闭。
3. 再以固定数据集逐步达到 10、20 用户；记录成功/拒绝、p95 延迟、限流、连接数、presence 数、CPU/内存和清理耗时。
4. 逐步接近单文档 64 活动会话上限；第 65 个会话必须得到稳定 `collaboration-capacity-exceeded`，已建立会话不能误关或串库。
5. 每次容量试验结束关闭全部客户端，确认 WSS、数据库 session、presence 和临时进程均已清理。

## 恢复与回滚演练

1. API 重启：协作开关开启时停止并重新启动 API；旧连接必须关闭，客户端重新 join/resume，history 缺口不重复写入。
2. Kernel 重启：停止并重新启动同一空间 Kernel；prepared/unknown journal 必须 fail-closed，committed journal 只能恢复 canonical history。
3. 加密 admission：在受限加密库无法取得密钥时 join 必须返回 `encrypted-collaboration-unavailable`，不得明文降级。
4. 开关回收：关闭标准/受限开关；新 join 拒绝，旧会话收到关闭结果并停止自动重连或进入只读收敛态。
5. 回滚：运行 `node scripts/l3-supervisor-rollback-drill.mjs`。runner 复用既有 P5 supervisor，在固定测试库独立 schema 和同一端口组中依次启动候选与 `HEAD^` 已批准版本的 Go Kernel、Nest API、Nest Worker，检查 Kernel readiness、API database readiness/OpenAPI、Worker sample job、PID/PPID/命令归属，停止候选并确认旧端口/进程退出，再启动批准版本并重复检查；证据写入 `rollback.json`。该命令只证明本地 supervisor 演练，不等价于目标生产 supervisor 认证，实际发布前仍须在目标部署执行并归档运维记录。
6. 将每次演练的版本、时间、执行人、case 结果、日志关联、资源清理和残余风险写入发布记录。

目标部署的多进程回滚记录必须写入 `enterprise/test-results/l3-release-certification/target-supervisor-evidence.json`，并包含候选/批准版本的 Kernel、API、Worker readiness，三进程 PID/PPID 归属，候选停止、旧进程退出、共享端口复用和资源清理。完成后执行：

```bash
cd /root/projects/singularity/enterprise
pnpm verify:l3-target-supervisor
```

验证器只接受结构化运行时观察结果；命令退出码、日志片段、本地演练报告不能替代这些字段。验证通过后生成 `target-supervisor.json`，发布记录才能将 `targetDeploymentSupervisorCertification` 标记为 `passed`。

## 发布判定

本次认证判定：L3-REL-01..12 均有结构化证据；20 用户、64 活动会话上限和资源清理通过；API/Kernel 重启、撤权、加密 admission、日志脱敏和受控 API 版本回滚通过；无高风险未决项。L3 状态为“生产认证完成（单副本/单空间范围）”，功能开关仍保持默认关闭。自动化 API 回滚演练不等同于目标部署 supervisor 的多进程制品回滚；实际发布前仍必须按本手册重复该动作并归档执行记录。

## 安全与清理

- 报告、日志和截图不得包含正文、完整 operation payload、密码、cookie、CSRF token、服务凭证或密钥。
- 本轮拉起的 API、Worker、Kernel、Web、Playwright 和临时目录在结束时由 supervisor 清理；用户明确保留的固定 PostgreSQL 不停止。
- 认证失败不自动回滚代码、不改写用户数据、不删除未授权的工作树改动；先保留诊断证据并按计划回到 implementation。

## 关联资料

1. [L3 生产认证计划](../../plans/2026-07-23-l3-production-certification.md)
2. [L3 生产认证架构方案](../architecture/l3-production-certification.md)
3. [ADR-0032：L3 生产发布认证边界](../adr/0032-l3-production-release-certification.md)
4. [L3.1 技术验证报告](../verification/l3.1-realtime-collaboration.md)
