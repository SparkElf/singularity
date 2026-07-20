---
title: "Singularity L1 Restart Checkpoint"
description: "L1 implementation恢复结果与集中评审验证入口"
author: "Codex"
date: "2026-07-21"
version: "2.1.0"
status: "completed"
tags: ["checkpoint", "restart", "l1", "singularity"]
---

# Singularity L1 Restart Checkpoint

## Objective

记录重启后的权威现场、已完成implementation范围和下一阶段入口。详细功能合同见`docs/architecture/l1-implementation-handoff.md`，产品与架构权威依据见`output/md/Singularity_Enterprise_Knowledge_Base_v1.0.0_2026-07-13.md`。

## Current State

- 仓库：`/root/projects/singularity`；环境：WSL2/Linux；分支：`master`。
- 完整implementation工作树的前置`HEAD`与`origin/master`均为`9ccb54f74`。本文所在提交是重启后的L1 implementation checkpoint，不重写历史。
- L0已经完成。L1全部纵向功能owner已经完成并释放；生产代码、公共合同、迁移、调用方、永久测试代码、旧企业路径清理和功能文档已经进入目标形态。
- 当前状态是`verified`：2026-07-21已完成正式unit、contract、integration、browser、E2E、typecheck、build、Prisma、数据库、服务、Kernel和供应链验收。
- Enterprise正式验证使用Node `24.18.0`、pnpm `11.9.0`和固定PostgreSQL 17容器`singularity-postgres-test`（`127.0.0.1:55432/singularity_test`）。不得用默认Node 22结果替代。
- 本轮没有启动、停止、重启或重配PostgreSQL、Kernel、API、Worker、Vite或用户watch进程；3000端口的用户进程保持不变。

## Completed Implementation

- 身份、邀请、OIDC、CSRF、会话撤销与强制下线。
- 组织、成员、用户组、空间生命周期、两级授权和幂等AccessChanged。
- 内容目录、唯一空间Session组合根、撤权销毁与显式三ID内容选择。
- mTLS/服务JWT Gateway、动态Kernel端点、WSS连接生命周期与私网部署恢复。
- 正式Protyle Core/PluginPort、复杂内容身份、viewer写门禁和Vite唯一企业入口。
- 空间/文档Discovery、搜索、图谱、大纲、反链与历史。
- 分享最小投影、主动内容/PDF/OCR隔离、公开资源闭包与真实分享E2E。
- PostgreSQL内容审计intent、声明式Worker最终化、HMAC事件、真实请求关联与稳定日志。
- 备份/恢复、容量/健康、真实恢复Kernel、P5启动器与备份恢复E2E。
- Worker生产镜像、三镜像health/SBOM/漏洞/许可证门禁和上游兼容闭包。

## Locked Contracts

- 内容身份只来自当前授权目录与Session，完整链路显式携带`spaceId + notebookId + documentId`。
- 同一非法状态只由首次真实边界处理；不增加下游重复拦截、同义字段、fallback或兼容双路径。
- React共享领域状态使用既有Zustand/组合根，目录、Session和Core对象不复制进全局store。
- PostgreSQL不复制正文；Go Kernel仍是`.sy`、SQLite、搜索、引用与图谱的内容事实源。
- `app/src/block/Panel.ts`、`EmbeddedProtyleOwner`和App Webpack保留给上游真实客户端消费者；企业Vite依赖图只排除它们，不物理删除上游能力。
- implementation测试代码已经落盘，但只有集中code-review通过后的verification结果可以作为L1交付证据。

## Completion Record

1. L1 第9.3节逐项验收已闭合，权威方案11.4和L1交接文档已更新。
2. 后续实时协作、评论、通知、文档级权限和跨空间搜索按方案9.2进入新的L2/L3计划。

## Risks

- 当前工作树跨React、Nest、Prisma、Worker与Go Kernel，静态检查不能替代真实装配、迁移、浏览器和跨进程证据。
- 内容审计、撤权关闭、恢复Kernel和P5启动器存在跨进程时序风险，必须以真实PostgreSQL/HTTPS/WSS/浏览器验证为准。
- 上游App与企业Vite共享部分Protyle源码；企业闭包门禁与上游App lint/Kernel测试都必须保留，不能用单侧通过代表整体通过。
- 工作树中的未跟踪migration和永久测试必须随checkpoint一并提交，禁止清理或遗漏。

## Resume Guide

```text
cd /root/projects/singularity
cat /root/projects/AGENTS.md
cat AGENTS.md
cat plans/2026-07-19-restart-checkpoint.md
cat docs/architecture/l1-implementation-handoff.md
git status --short --branch
git log -12 --oneline --decorate
```

恢复时以当前仓库和真实测试证据为准。不要恢复旧owner列表、旧百分比、旧HEAD、历史暂停线或“PluginPort尚未落盘”等已失效状态；不要reset、stash或覆盖共享工作树。
