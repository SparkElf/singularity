---
title: "奇点 L1 实现重启交接"
description: "L1 implementation checkpoint、并行范围与恢复顺序"
author: "Codex"
date: "2026-07-19"
version: "1.0.0"
status: "working"
tags: ["l1", "implementation", "handoff"]
---

# 奇点 L1 实现重启交接

## 目标

权威方案：`output/md/Singularity_Enterprise_Knowledge_Base_v1.0.0_2026-07-13.md`。
L0 已完成；当前仍处于 implementation，L1 全部生产代码、永久测试代码、旧路径清理和文档完成前，不进入正式 code-review 或 verification。

## 当前基线

- 远程：`origin/master`。
- 最近已推送的独立 P3 提交：`d8245f555`（真实 Vite Core 编辑器 browser integration 合同）。
- 本交接提交包含一批尚未完成的 ACL/ADR-018 实现草稿和旧路径收口改动；它是可恢复 checkpoint，不表示功能已验收。
- 工作估计：实现代码约 `75%–85%`；包含集中评审和验证约 `65%–75%`。现实剩余 `4–7` 个工作日；跨进程撤权或 P5 E2E 暴露跨层回归时可能 `7–10` 个工作日。

## Checkpoint 范围

- `.github/workflows/singularity-l0.yml`：测试库审计角色与部署入口草稿。
- `docs/adr/0018-cross-process-access-change.md`：ADR-018 前五项实现状态勾选；集中验证仍未完成。
- `enterprise/apps/api/src/application.ts`：HTTPS 测试启动选项。
- `enterprise/apps/api/test/support/{kernel-gateway.ts,test-app.ts}`：真实 TLS/WSS 测试支撑草稿。
- `enterprise/apps/api/test/access-change.http.test.ts`：真实 PostgreSQL/HTTPS/WSS/operations 撤权合同草稿。
- `enterprise/apps/api/test/kernel-gateway.http.test.ts`、`organization-management.http.test.ts`：同批 API 永久测试扩展。
- `enterprise/packages/database/package.json`、`test/audit-acl.integration.test.ts`：审计 ACL 部署合同草稿。
- `app/src/block/Panel.ts`：旧 BlockPanel 入口收口草稿，按 P5 原子旧路径删除处理；不要在恢复时回退或混入 P3。

实现期只做静态语法、差异和文件归属检查；本 checkpoint 未运行 unit、contract、integration、browser、E2E、typecheck、build、Prisma 或数据库命令。

## 暂停的并行线

1. **ACL/ADR-018**：恢复后继续独占 `application.ts`、API test support、`access-change.http.test.ts`、database ACL/package、workflow 迁移段和 ADR-018。完成后静态检查并释放文件，不自行提交。
2. **P4 PluginPort**：尚未落盘生产文件。目标是 public `ProtylePluginPort` 的非空 React 注入、菜单/快捷键/斜杠/paste 合同和独立 browser integration；不得改 PDF、API、CI 或 `Panel.ts`。
3. **P4 主动内容/PDF**：尚未落盘生产文件。已确认仓内 `app/stage/protyle/js/pdf` 资产可复用，不新增依赖；需要决定受控 loader 或字面动态入口，并实现授权字节到 canvas 的生命周期。不得改 PluginPort、ACL support 或 lockfile。

## 恢复顺序

1. 读取本文件、`AGENTS.md`、方案文件和当前 `git status`；确认 checkpoint 后再继续。
2. 先完成 ACL/ADR-018，释放 API support 和 workflow；仍不运行正式测试。
3. 用独立 agent 并行完成 P4 PluginPort 与 P4 主动内容/PDF；共享合同、manifest、lockfile 和 CI 由集成 owner 最后统一处理。
4. P4 完成后，单一集成 owner 收口 P5：真实 React + Nest + PostgreSQL + Gateway + Go Kernel E2E、旧 Webpack Web 入口/旧 Adapter/重复 runner/`Panel.ts` 物理删除。
5. 全部 implementation 完成后才进入集中 code-review；复评通过后由 verification 一次运行完整矩阵。

## 不变量

- 内容链显式携带 `spaceId + notebookId + documentId`；禁止从 DOM、全局状态、首响应或首实例推断。
- viewer/撤权/锁定状态不得产生写事务或迟到推送；连接关闭前先停上游订阅。
- 后端优先 Nest 原生装饰器、metadata、DI、schema 与拦截器；业务状态转移留在显式 service/use case。
- 不新增未获批准的 fallback、双路径、同义字段或重复下游校验。
- 固定测试库使用 PostgreSQL 17 Docker 映射 `127.0.0.1:55432`；服务动作必须经用户授权。
