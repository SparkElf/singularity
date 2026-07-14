---
title: "S1 Identity Space Startup Plan"
description: "奇点S1身份、空间授权与启动切片之可恢复执行计划"
author: "Codex"
date: "2026-07-14"
version: "1.5.0"
status: "verification"
tags: ["plan", "s1", "identity", "space", "authorization"]
---

# S1 Identity Space Startup Plan

## Change Log

| Version | Date | Author | Changes |
| --- | --- | --- | --- |
| 1.0.0 | 2026-07-14 | Codex | 建立S1可恢复执行计划 |
| 1.1.0 | 2026-07-14 | Codex | 以受控运维入口闭合初始化、多账号、多空间与撤权来源 |
| 1.1.1 | 2026-07-14 | Codex | 补组织空间停用与产品复评修订 |
| 1.1.2 | 2026-07-14 | Codex | 区分初始化普通失败与并发败者 |
| 1.2.0 | 2026-07-14 | Codex | S1产品、安全、测试价值复评通过，进入架构阶段 |
| 1.3.0 | 2026-07-14 | Codex | 补Kernel三态生产路径并经产品复评批准；架构按安全、Schema与测试复核修订 |
| 1.4.0 | 2026-07-14 | Codex | 架构、安全、Schema与测试治理复评通过；进入S1实现阶段 |
| 1.5.0 | 2026-07-15 | Codex | S1实现与代码复评通过，本地Node 24门禁完成，等待提交、推送及PostgreSQL CI收口 |

## Objective

成S1：首次初始化、本地会话、授权空间列表与启动合同、React组织/空间路由；越权拒绝；`verify:s0-s3`增非空HTTP与component证据；评审验证毕，提交推送。

## Background

权威总案：`output/md/Singularity_Enterprise_Knowledge_Base_v1.0.0_2026-07-13.md`。S0已成：Nest/Fastify、Prisma/PostgreSQL、readiness、Node 24门禁。Protyle生产迁移须先得服务端授权之真实`spaceId`，不可用路径、设备ID、随机ID代之。

## Locked Assumptions

- 云端内容权威；浏览器无本地事实源。
- 首次初始化与最小访问配置仅走部署主机受控运维入口，不经公网HTTP；原子建首位owner、组织、空间。
- 登录后列本人活动授权空间；单一则直入，多则选择，无则空态。
- 运维入口可建账号/空间、授撤两级成员、调空间角色、停组织/空间/用户、撤用户全会话；主动退出仅撤当前会话；设备会话UI后置。
- 运维入口亦为Kernel `starting|ready|unavailable`唯一生产写路径；测试不得直写状态。
- HTTP使用必填HTTPS公开Origin与明确受信代理CIDR；KDF、会话续期和撤权并发均有有界/线性化合同。
- S1不含邀请、密码恢复/MFA/OIDC、用户组、完整成员UI、Gateway、编辑器Core。
- API单副本合同延续；本地PostgreSQL未启，不擅启。

## Compatibility / Contracts

- 产品：`docs/product/s1-identity-space-startup.md`。
- 架构：`docs/architecture/space-session-composition-root.md`；ADR-011。
- 路由参数仅查询键；授权响应方可确认组织、空间、角色、状态。
- 不可见/不存在/停用统一404；未登录401；已知动作拒绝403。
- `viewer`只读；`starting|ready|unavailable`三态；仅ready可用。
- Cookie安全、CSRF、Origin、30m idle、12h absolute、Argon2id、账号/IP限流不降级。
- 不增`workspaceId`、local Session、默认空间硬码、兼容fallback。
- Node严格24；pnpm 11.9.0；既有package/runner边界不破。

## Current Progress

- [x] S0实现、复评、本地门禁与GitHub CI全绿；HEAD `eefaf2b8e`。
- [x] S1既有产品/架构/测试证据盘点。
- [x] Docmost与Outline定向官方资料核对。
- [x] 首轮产品、安全与测试治理复评；阻断已修。
- [x] S1 PRD产品、安全与测试价值复评通过，状态approved。
- [x] S1三态生产路径增量经产品与测试安全复评通过，PRD v1.1.5重新approved。
- [x] S1架构差距、公开合同、测试矩阵定稿并approved；ADR-011/013 accepted。
- [x] S1实现。
- [x] 代码与测试价值复评通过；无遗留运行时代码阻断，退役shell/E2E文档引用已收敛。
- [x] Node 24本地static、unit、component、build与三视口browser integration验证通过。
- [ ] 提交、推送及PostgreSQL CI收口。

## Next Steps

1. 复评`docs/product/s1-identity-space-startup.md`；修阻断；标approved。
2. 启`architecture-planning`与`test-governance`；盘代码、依赖、公开API、受控运维边界、初始化竞态、限流、会话时钟、路由状态及browser门禁；修架构/ADR。
3. 启`implementation`；先合同与schema，再API，再Web，再manifest/lock/CI；测试随稳定合同同批落。
4. 启`code-review`与`test-governance`；边审边修，复评通过。
5. 启`verification`与`test-governance`；Node24跑static/unit/build；真实PG交GitHub Actions；浏览器验桌面/移动/键盘/console/network。
6. 更新总案与本计划进度；提交、推送`origin/master`；监CI至绿。

## Risks

- 首次初始化竞态或运维秘密泄露，可致重复租户或部署接管；须数据库唯一事实、非HTTP边界与恒定错误。
- 登录/启动错误差异，可枚举账号或空间。
- 角色/撤权缓存陈旧，可保留越权状态。
- 反向代理共享来源桶、并发登录越过停用或KDF内存峰值，可造成全站拒绝服务或撤权失效；须按架构配置、锁序和准入实现。
- 本机Node22误跑；须临时Node24前置PATH。
- 本地PG未启；不得虚报integration通过，CI为真实证据。
- S1误纳Gateway/Core，越硬门禁并扩爆炸半径。

## Verification

- 产品：PRD逐项可判定；无实现型验收；两独立复评无阻断。
- 架构：合同至层级矩阵、真实/模拟边界、runner、入口、清理齐。
- 本地：Node 24.18.0与pnpm 11.9.0下`lint:s0-s3`、`typecheck:s0-s3`和`build:s0-s3`通过；contracts `10/10`、API unit `40/40`、React身份/空间component `9/9`通过。
- PostgreSQL：本机服务按方案未启动；迁移回放、真实HTTP、运维与并发集成由GitHub `space-session` PostgreSQL 17 service运行，结果待推送后收口。
- Web：Playwright browser integration在desktop、390x844 mobile与320x568三项目共`15/15`通过；键盘、响应式、退出历史、轮询、网络恢复及console/network/pending诊断均通过。
- Git：`git diff --check`、工作树审计；提交后`origin/master`与HEAD同。

## Resume Guide

先读`/root/projects/AGENTS.md`、仓库`AGENTS.md`、本计划、S1 PRD、空间架构与ADR-011；再查`git status`、goal、agents。若产品复评未批，禁入架构。系统Node22；用`/root/.cache/pnpm/dlx/cb39032a5e9268a038762c66ab60f208/pkg/node_modules/.bin`前置PATH，并以`/root/.cache/node/corepack/v1/pnpm/11.9.0/bin/pnpm.cjs`执行。勿启本地PostgreSQL。
