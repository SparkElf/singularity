---
title: "L1 Backup Restore Worker Restart Checkpoint"
description: "奇点L1备份、恢复及Worker执行链之重启现场"
author: "Codex"
date: "2026-07-19"
version: "1.0.4"
status: "checkpoint"
tags: ["plan", "l1", "backup", "restore", "worker", "checkpoint"]
---

# L1 Backup Restore Worker Restart Checkpoint

## Objective

存重启断点；续成API备份/恢复、Worker claim/retry/部署生命周期、单一`RuntimeKernelDeploymentRegistry`、React `BackupsPage`、合同、永久测试及ADR；交根代理集中评审、验证、提交。

## Background

- 仓库：`/root/projects/singularity`；WSL2；`master`；快照HEAD `904c70421e8a4b41e90701459ded26680f56d965`，当时与`origin/master`同值。
- 时间：`2026-07-19T18:33:43+08:00`。快照时工作树有62条status记录，具体路径以最新`git status --short`为准；禁reset、stash、checkout、覆写。
- ACL/ADR-018已独立提交；本切片不得改ACL、audit、discovery内部。
- 云端为内容事实源；备份对象非在线事实源；恢复只建隔离新空间，不覆盖、不合并源空间。
- 本机Node `v22.21.1`；Enterprise门禁Node 24。当前实现期禁正式runner、typecheck、build、Prisma、DB、服务、提交、推送。

## Locked Assumptions

- 实现Owner：`/root/backup_restore_chain_v2`；完整纵向收口，不再横拆前后端测试；本计划完成静态交接后释放给根代理。
- 根代理仅掌共享集成、后续P5、集中review/verification及提交推送。
- `enterprise/apps/worker/src/worker.module.ts`为共享点；写前查`/root/projects/mailbox.md`并协调。保留`MAXIMUM_AUDIT_ARCHIVE_EVENT_COUNT` provider及既有registry接线。
- contracts聚合器`index.ts`、`paths.ts`、`openapi.ts`有并行owner；非必要勿写，须写则先协调并重读最新内容。
- API身份显式携带`organizationId + sourceSpaceId`；内容链仍守`spaceId + notebookId + documentId`，不从DOM、全局态、首响应或URL推断。

## Compatibility / Contracts

- 权威：`docs/adr/0017-l1-share-audit-backup.md`、`docs/architecture/l1-implementation-handoff.md`、`output/md/Singularity_Enterprise_Knowledge_Base_v1.0.0_2026-07-13.md`。
- API：空间管理员方可操作；备份创建同事务写`space_backups`、`worker_jobs(backup-space)`及审计。恢复锁成功备份，新建`archived`目标空间、`starting` Kernel、管理员成员、`space_restore_jobs`、`worker_jobs(restore-space)`。
- 发现：按source space权威集合列恢复；稳定序`created_at DESC, id ASC`；不以首响应、DOM或restore URL为事实。
- 激活：仅`ready-for-activation`且Kernel `ready`、deployment/version齐全；激活后发布ACL close并刷新授权空间/管理能力。
- Worker：每次状态迁移绑定同一`workerJobId + workerAttempt` claim；成功、失败、重试、取消、重复执行皆须确定释放registry handle、进程、metadata、workspace及失败目标。
- 恢复边界：校验对象键、整体摘要、manifest、路径/文件型、SQLite、`.sy`、引用索引及一致性；任一败则停实例并删完整目标；无fallback。
- 就绪：metadata持久化、目标身份核验、Kernel authenticated readyz、registry注册皆成，方写`ready-for-activation`。
- 重启：逐字段核对metadata/workspace/process/DB endpoint；仅可信目标adopt；失败收敛清理。
- 日志：仅`backup.job`结构化字段；禁正文、凭证、绝对路径、错误原文。
- React：恢复集合未加载或存未完成任务时禁二次创建；queued/running/restoring轮询；ready任务显式激活；切换空间不得受迟到响应覆盖。

## Current Progress

- [x] ACL已完成、提交、推送；HEAD含`253cbdd29`。
- [x] API已有创建/列表/激活链：`enterprise/apps/api/src/backups/{backup.controller.ts,backup.service.ts,backup.types.ts,restore-status.persistence.ts}`。
- [x] Worker已有`BackupSpaceHandler`、`RestoreSpaceHandler`、claim字段、对象键/摘要/大小边界、restore部署、运行时注册/撤销、启动对账。
- [x] 单一`RuntimeKernelDeploymentRegistry`既有接线；禁另建handle map或重复schema解析。
- [x] React `BackupsPage`已有权威集合、轮询、显式激活及query invalidation。
- [x] contracts `enterprise/packages/contracts/src/backups.ts`已有schema、view、request及path合同。
- [x] 标准`test:e2e`发现目录已有单一真实备份恢复case：编辑器提交唯一marker后，经UI、API、PostgreSQL Worker claim/lease、FileObjectStore、真实Go归档恢复和隔离Kernel激活，再由恢复空间目录与Protyle读取同一marker；目标`getDoc`继续显式携带原`notebookId + documentId`。
- [x] 审计归档幂等owner会同时核对归档ID、组织、`fromSequence + throughSequence`及对象摘要/大小；PostgreSQL integration case经真实job payload、租约过期、重新claim、decode和handler证明改变范围的重放被拒绝。
- [x] 已完成逐行生命周期审计中的真实缺口修复：源空间锁内单一未终止恢复、React mutation响应丢失/跨行pending fencing、Worker停机后忽略Abort的handler不再complete/fail。
- [x] Go归档恢复门禁已补齐：明文/加密`.sy`分流、文档根ID/重复块ID/引用ID与可解析明文目标一致性、已有SQLite索引只读完整性及孤儿引用检查；缺失索引由Kernel启动重建，加密SQLite不尝试无密钥打开。
- [x] Kernel备份失败日志只保留稳定`requestId + operation`字段；不输出错误原文、路径或解析细节。
- [x] restore deployment已补可信metadata/workspace/process清理：metadata丢失按确定路径清理并扫描身份匹配进程，hardlink、symlink、非目录artifact和非真实工作区失败关闭；新增三条永久Worker部署合同及混合明文/加密引用门禁测试。
- [x] 实现期静态收口已完成：相关TypeScript语法转译诊断与scoped diff check通过。当前Node为22而非门禁要求的24；真实E2E代码虽已进入标准入口，正式测试、typecheck、build、Prisma、数据库和服务均未运行，不能据此宣称L1验收通过。
- [x] 本切片的API、React、Worker、Go生产代码、永久合同测试和ADR/handoff增量已落盘；共享改动仍须由根代理统一review，不能据dirty文件名宣称L1完成。
- [x] 两个只读审计已关闭；不再横拆前端、Worker、测试。
- [x] 用户曾要求重启增并发槽位，检查点已保存；随后根代理明确恢复主线，本线程按新指令继续实现。未提交、未推送。
- [x] 全局现场另见`plans/2026-07-19-restart-checkpoint.md`。

## Next Steps

1. 根代理复核API锁与审计查询、React权威集合fencing、Worker shutdown租约、restore deployment adoption/清理、Go引用语义及真实备份恢复E2E的总链路预算。
2. 由根代理在全部L1 implementation owner释放后进入`code-review`，通过`test-governance + verification`后使用Node 24、固定PostgreSQL 17测试库运行集中矩阵。
3. 根代理集中处理共享冲突、最终测试、commit与push；本切片完成静态交接后释放scope。

## Risks

- 并行写共享文件，旧快照覆新改；每次patch前须重读当前diff及mailbox。
- claim遗漏，迟到attempt可覆新状态或误删已提交目标。
- registry/metadata/DB顺序失当，可暴露未可信endpoint或留孤儿进程/工作区。
- Worker shutdown/adoption误清ready实例，或信任陈旧PID/endpoint。
- archive路径、link或特殊文件逃逸恢复根；须守既有restore工具与workspace校验合同。
- Node 22误作Node 24证据；不得虚报。

## Verification

- 本实现期仅静态：相关TS/TSX `transpileModule`语法诊断、格式和scoped diff check。
- 正式证据后置集中verification：contracts、API PostgreSQL HTTP、Worker integration/lifecycle、React component、必要browser contract。
- DB、服务、Prisma、完整test/typecheck/build未授权于本owner当前阶段，皆未运行。

## Resume Guide

先执行：`cd /root/projects/singularity`；读`/root/projects/AGENTS.md`、仓库`AGENTS.md`、`plans/2026-07-19-restart-checkpoint.md`、本计划、`/root/projects/mailbox.md`；查`git status --short --branch`、`git log -12 --oneline`、agents及goal。检查点基线为`acd0ea0c9`；若HEAD/工作树已变，以实测为准并先辨owner，绝不回退共有工作树。按Next Steps续纵向实现，后交根代理review/verification；任务完成前保留本计划。
