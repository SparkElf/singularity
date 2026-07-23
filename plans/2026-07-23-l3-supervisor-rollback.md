---
title: "奇点 L3 多进程 supervisor 回滚演练"
description: "以既有真实三进程 E2E supervisor 补齐候选/批准制品切换证据"
author: "Codex"
date: "2026-07-23"
version: "1.2.0"
status: "completed"
tags: ["plan", "l3", "rollback", "supervisor"]
---

## Change Log

| Version | Date | Author | Changes |
| --- | --- | --- | --- |
| 1.0.0 | 2026-07-23 | Codex | 建立 L3 多进程 supervisor 回滚演练计划 |
| 1.1.0 | 2026-07-23 | Codex | 本地候选/批准三进程切换与资源清理验证通过；保留目标部署手工认证门禁 |
| 1.2.0 | 2026-07-23 | Codex | 新增目标部署结构化证据验证器与唯一发布附件入口 |

# Objective

补齐 L3-REL-10 本地可复现多进程制品回滚演练：候选与批准版本均启动 Go Kernel、Nest API、Nest Worker；同端口切换；核对 readiness/OpenAPI/Worker 任务/PID 归属；失败全清理；不把本地演练称为目标生产认证。

# Background

既有回滚证据仅轮换 API；P5 `start-stack.mjs` 已有真实三进程启动、固定 PostgreSQL schema、端口检查和清理。复用该边界，避免第二套 wiring、数据库或 supervisor。

# Locked Assumptions

- WSL2；Node 24、pnpm 11、Go、Docker 固定库可用。
- 固定库 `singularity-postgres-test` / `127.0.0.1:55432` / `singularity_test` 保留；不动用户常驻服务。
- 首期仍单 API 副本、单空间 Kernel；L4 不因本演练扩大范围。
- 版本切换只替换制品来源；数据合同、权限、Kernel、Worker 事实源不变。

# Compatibility / Contracts

- `start-stack.mjs` 是唯一三进程启动/清理 owner；新驱动只编排其 supervisor。
- 每个阶段使用独立 `singularity_p5_e2e_<pid>` schema、临时 runtime 根和同一端口组。
- 健康证据：Kernel `/internal/readyz`、API `/api/v1/health/database`、API `/api/openapi.json`、Worker `sample-kernel` succeeded。
- 进程证据：supervisor PID、三子进程 PID/PPID/命令；切换后旧端口无监听、旧子进程无存活。
- 报告脱敏：版本、端口、PID、状态、耗时、清理；无正文、密钥、token、完整 payload。

# Current Progress

- [x] 发现既有 API-only 回滚、P5 三进程 supervisor、固定数据库和清理合同。
- [x] 完成架构边界与测试矩阵补充。
- [x] 实现多进程回滚驱动并接入 L3 aggregate。
- [x] code-review/test-governance 复评。
- [x] 集中验证并更新报告/runbook/总计划。

# Next Steps

1. [x] 实现驱动：构建当前/批准 worktree，启动/停止 P5 supervisor，收集健康与 PID 归属。
2. [x] 接入 `verify:l3-release-certification`，保留 API-only drill 作为更窄合同或删除重复入口。
3. [x] 整阶段评审后集中运行 L3/L4 受影响 aggregate。
4. [x] 更新 L3 报告、runbook、ADR 和总计划，明确本地演练与真实部署手工门禁。
5. [x] 提供 `pnpm verify:l3-target-supervisor`，校验目标部署三进程回滚证据并生成发布附件。

## Release Gate

本地演练已完成：候选与批准版本均启动 Go Kernel、Nest API、Nest Worker，共享端口切换成功，readiness/OpenAPI/Worker/PID 归属和清理均通过。目标部署 supervisor 仍需在真实部署环境按运行手册重复一次；执行记录需先通过 `pnpm verify:l3-target-supervisor`，报告字段才可从 `pending` 更新为 `passed`。

# Risks

- 批准 worktree 依赖 node_modules/app 资源；准备失败必须删除 worktree/runtime/schema。
- 用户保留端口/进程不得被发现或终止；所有端口必须使用显式 runner 值并先检查空闲。
- supervisor 提前退出、子进程残留或清理失败均判演练失败，不改写报告为成功。

# Verification

- 标准入口：`cd enterprise && pnpm verify:l3-release-certification`。
- 目标部署附件校验：`cd enterprise && pnpm verify:l3-target-supervisor`。
- 受影响静态/架构入口：`pnpm test:architecture`；不得新增孤儿脚本。
- 结构化证据：`enterprise/test-results/l3-release-certification/rollback.json`，包含候选/批准两次三进程检查及清理结果。
- 验证结束检查固定 PostgreSQL 保留、临时 schema/runtime/端口/进程清理和工作树无额外回滚副作用。

# Resume Guide

```text
cd /root/projects/singularity
sed -n '1,260p' plans/2026-07-23-l3-supervisor-rollback.md
sed -n '1,260p' docs/architecture/l3-production-certification.md
sed -n '1,220p' enterprise/apps/web/tests/e2e/support/start-stack.mjs
sed -n '1,260p' enterprise/scripts/l3-supervisor-rollback-drill.mjs
```
