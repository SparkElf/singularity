---
title: "奇点 L3 生产发布认证计划"
description: "区分技术验证与发布认证，闭合 L3.1 单副本实时协作的预发布、容量、恢复、撤权、加密、回滚与观测证据"
author: "Codex"
date: "2026-07-23"
version: "1.0.0"
status: "completed"
tags: ["plan", "l3", "release-certification", "realtime-collaboration"]
---

# 奇点 L3 生产发布认证计划

## Objective

证明 L3.1 在首期单 API 副本、单空间 Kernel、固定 PostgreSQL 与功能开关边界下具备可发布性；认证通过前不得默认开放，也不得把 `pnpm verify:l3-production` 技术验证结果直接当发布认证。

## Background

L3.1 已完成产品、架构、ADR、implementation、code-review、test-governance 复评和唯一技术验证 aggregate。现缺预发布部署、试点组织/空间、多人容量、单副本重启、加密 admission、关闭开关收敛、回滚和发布观测证据。本计划只定义认证目标和证据，不改变 L3 既有内容/权限合同。

## Locked Assumptions

- 首期只认证单 API 副本与单空间 Kernel；多副本、跨区域、消息总线另立产品/架构/ADR。
- Go Kernel 是正文、块、AV、历史与 canonical operation log 唯一事实源；PostgreSQL 不保存正文或 operation payload。
- 每条 join、submit、resume、presence、确认、冲突、撤权、关闭消息显式携带四段内容身份。
- ACL 由既有 `DocumentAccessPolicy` 唯一负责；协作只消费 capability 与撤权代次。
- `restricted-encrypted` 仅在成员、文档 ACL、Kernel 内容密钥和客户端版本均满足时准入；密钥不可进日志、控制面或浏览器持久化。
- 固定测试库使用 `singularity-postgres-test` / `127.0.0.1:55432` / `singularity_test`；本计划不创建临时数据库。
- 功能开关默认关闭；认证试点可显式开启，完成后恢复关闭或按发布判定表执行。

## Compatibility / Contracts

- 技术验证结果只能证明当前代码合同；发布认证还须证明部署生命周期、负载上限、失败恢复、回滚和运维可见性。
- 不得新增第二 CRDT、锁、LWW、正文快照、跨层身份推断或绕过 ACL 的测试入口。
- 认证使用真实 Nest bootstrap、固定 PostgreSQL、受控 Kernel、真实协作 WSS 和真实浏览器；外部 IdP 不是本阶段边界。
- 异常证据保留原始 `name/message/stack` 与 request/session 关联，严禁正文、token、密钥和完整 operation payload 进入日志。
- 测试按用户可观察合同、状态转移、权限、资源释放和失败语义组织；不以源码字符串、完整内部 mock 或截图替代运行时证据。

## User Stories

- 试点管理员可按既定步骤启动协作功能，能看到健康、容量、限流和关闭状态，不能因隐藏开关误开放。
- 两名成员同时编辑同一文档时，双方能看到确认、冲突和最终收敛；不同空间、笔记本、文档之间不串写、不串广播。
- 管理员撤销成员或文档权限后，旧协作会话立即关闭或只读，迟到操作与迟到事件均不能生效。
- API 或 Kernel 重启后，成员能从 canonical history 缺口恢复；presence 清理，不重复写入、不恢复旧授权。
- 加密库密钥不可用时，用户得到明确的不可协作结果，不出现明文降级、旧快照覆盖或密钥泄露。
- 运维人员执行回滚后，旧版本可恢复服务；未确认结果不伪造成功，日志可关联且不泄露内容。

## Acceptance Matrix

| 编号 | 认证结果 | 最低充分证据 | 失败即判定 |
| --- | --- | --- | --- |
| L3-REL-01 | 预发布部署可重复启动，固定数据库/Kernel/配置与功能开关状态可核对 | release runbook + real bootstrap + health/ready evidence | 依赖漂移、启动状态不明或开关非默认关闭 |
| L3-REL-02 | 2 用户可完成 join、编辑、确认、presence、冲突可见和正常离开 | real API/WS/browser chain | 丢操作、跨文档写入、静默冲突或资源残留 |
| L3-REL-03 | 10/20 用户固定数据集下协作正确性保持，限流/上限明确且可观察 | performance/integration report | 无界队列、错误身份、超限后静默成功或无法释放 |
| L3-REL-04 | 接近单文档 64 活动会话上限时，系统按合同限流或关闭，不破坏已确认操作 | capacity run + structured metrics | 超限未拒绝、误关他文档、presence 泄漏或内存持续增长 |
| L3-REL-05 | API 重启后旧会话按合同关闭/重连，Kernel history 缺口恢复且无重复写入 | controlled restart + database/kernel history evidence | 旧 grant 复活、重复事务、迟到结果覆盖或恢复假成功 |
| L3-REL-06 | Kernel 重启/恢复异常时 fail closed，prepared/unknown 事务不冒充已提交 | controlled failure + recovery log | 半提交、正文丢失、静默回退或未关联异常 |
| L3-REL-07 | ACL 撤权后旧会话关闭，迟到 submit/presence/broadcast 全部失效 | real HTTP/WS + audit evidence | 撤权后仍写入、仍接收事件或只依赖 UI 禁用 |
| L3-REL-08 | `restricted-encrypted` 无密钥、版本不符或匿名加入均明确拒绝 | real admission path + storage/logger audit | 明文 fallback、密钥进控制面/日志/浏览器或错误码不稳定 |
| L3-REL-09 | 关闭功能开关后新 join 拒绝，在途会话只读/关闭，客户端状态收敛 | real toggle transition | 新会话可写、旧会话继续广播或伪造成功 |
| L3-REL-10 | 发布回滚恢复旧版本与数据合同，失败窗口可重试且不重复副作用 | rollback drill + runbook evidence | 回滚后 schema/协议不兼容、数据损坏或无法判断结果 |
| L3-REL-11 | 日志/审计可按 request/session/space 关联，保留异常堆栈且无敏感内容 | logger/audit inspection | 只有 message、缺 stack、出现正文/token/密钥或身份串库 |
| L3-REL-12 | 试点结束能关闭开关、释放 WSS/Kernel/浏览器/数据库资源并恢复干净状态 | teardown evidence + process/connection check | 端口、进程、连接、presence 或临时数据残留 |

## Product / Interaction Definition

- 管理入口显示协作发布状态：`关闭`、`试点中`、`已认证`、`回滚中`、`不可用`；显示用户可理解的原因和可执行动作，不暴露内部类名、路径或测试实现。
- 认证失败显示稳定结果、关联编号与重试/回滚动作；不显示正文、密钥、服务凭据和内部地址。
- 协作面板显示连接、重连、冲突、撤权、加密不可用和只读状态；状态来自服务端合同，不由浏览器本地提升。
- 容量达到阈值时显示明确的暂不可协作结果；不以无限等待、静默丢弃或旧状态冒充成功。

## Test Governance

- 正式入口设为单一 L3 发布认证 aggregate；整阶段 implementation、文档、fixture 与 runbook 完成、code-review/test-governance 复评后集中执行。
- 证据层级：contract 验证公开消息与错误；integration 验证真实 Nest/Prisma/Kernel/WSS；e2e 验证两用户浏览器链路；performance 验证固定客户端数据集与资源上限；static 只验证边界配置。
- 复用既有 L3 contracts、API/Kernel/Web tests、固定数据库与 E2E supervisor；不得另造第二 registry、第二数据库或逐文件子进程 runner。
- 允许阶段内做最小诊断；正式测试失败后按共同根因整批修复，复评通过后统一重跑受影响矩阵。

## Certification Result

2026-07-23 唯一 aggregate 已通过：技术验证、Kernel、API/WSS、真实浏览器和受控回滚 5 个 runner 均为退出码 0。API release suite 覆盖 20 用户、64 活动会话上限、重启恢复、撤权、加密不可用和日志堆栈；浏览器 suite 覆盖真实协作状态和撤权关闭；回滚报告确认候选版本与 `HEAD^` 已批准 API 均通过 readiness/OpenAPI，schema、进程和 worktree 清理通过。L3 在“单 API 副本、单空间 Kernel、固定 PostgreSQL、功能开关显式开启”的范围内生产认证完成。

## Next Steps

1. 按 runbook 在目标部署 supervisor 重复一次多进程制品回滚，并保存运维发布记录。
2. 以本计划的 L3 认证报告为门禁，进入 L4 产品设计和架构规划。

## Risks

- 当前没有可复用的真实容量驱动或回滚演练入口，可能需先补运行合同。
- 单副本限制不能证明多副本发布能力；认证报告必须明确适用范围。
- 固定数据库或本地服务状态异常时，只记录阻塞证据，不擅自重配依赖。

## Verification

- 既有技术验证：`cd /root/projects/singularity/enterprise && pnpm verify:l3-production`。
- 新增发布认证入口及命令名在 architecture-planning 阶段冻结；不得在本计划中凭空宣称通过。
- 最终报告必须区分：技术验证结果、生产认证证据、未覆盖范围、残余风险、功能开关判定。

## Resume Guide

```text
cd /root/projects/singularity
git status --short --branch
sed -n '1,260p' plans/2026-07-23-l3-production-certification.md
sed -n '1,220p' docs/verification/l3.1-realtime-collaboration.md
cat enterprise/package.json | sed -n '/verify:l3-production/,+2p'
```

先完成现有入口与认证矩阵差距盘点，再进入 architecture-planning；不得把技术验证命令直接改名为生产认证。
