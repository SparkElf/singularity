---
title: "S1 Identity Space Startup Plan"
description: "奇点S1身份、空间授权与启动切片之可恢复执行计划"
author: "Codex"
date: "2026-07-14"
version: "1.7.3"
status: "completed"
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
| 1.5.0 | 2026-07-15 | Codex | S1首轮实现及本地Node 24门禁完成，进入代码复评 |
| 1.6.0 | 2026-07-15 | Codex | 代码复评发现API/Web及L0阻断，补修复架构与供应链ADR并退回实现阶段 |
| 1.7.0 | 2026-07-15 | Codex | API/Web与L0复评阻断清零，固定真实供应链证据并进入最终验证前文档收口 |
| 1.7.1 | 2026-07-15 | Codex | 本地最终verification通过，拆分稳定提交、PostgreSQL CI和正式上游merge后续状态 |
| 1.7.2 | 2026-07-15 | Codex | 稳定提交与GitHub Actions全绿，收口PostgreSQL 17和CI供应链证据 |
| 1.7.3 | 2026-07-17 | Codex | 记录固定上游候选显式merge、基线晋升与L0完成状态 |

## Objective

完成S1：首次初始化、本地会话、授权空间列表与启动合同、React组织/空间路由；越权拒绝；`verify:s0-s3`增非空HTTP与component证据；评审验证毕，提交推送。

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
- [x] 首轮Node 24本地static、unit、component、build与三视口browser integration门禁通过。
- [x] 代码与测试价值复评完成；结论不通过，已记录API/Web/L0阻断。
- [x] S1复评修复架构定稿；L0 Fork与供应链决策见ADR-014。
- [x] 实现并复评OpenAPI、撤权锁、运维边界、数据库约束与死代码收敛。
- [x] 实现并复评登录代次/冷却、授权缓存失效、显式单空间返回、移动侧栏与原始浏览器诊断。
- [x] 完成L0 Fork隔离、品牌法律、企业镜像、SBOM、漏洞、许可证和固定候选影响报告。
- [x] API/Web、上游治理与供应链代码复评通过；Node 24 L0标准入口`84/84`。
- [x] 完成本地最终verification，覆盖static、unit、component、build、browser integration、镜像、供应链与Git门禁。
- [x] 稳定S1/L0提交`8f7ed852a`已推送；GitHub Actions run `29410946297`的PostgreSQL 17与供应链门禁全绿。
- [x] 以双父显式merge提交`ebe5e941b6dbdc9c139d76883b2746f9db7fa7fa`合并固定上游候选，解决22个冲突路径并提升基线。

## Completion Record

1. 证据收口文档、稳定提交与GitHub Actions run `29410946297`已经通过。
2. 固定候选`c8dcdd0860ef000a14552c619fe19c0dcb5175f5`已经由双父显式merge提交`ebe5e941b6dbdc9c139d76883b2746f9db7fa7fa`合入并推送。
3. `config/upstream-baseline.json`已晋升到SiYuan 3.7.2候选，总方案1.4.8已经记录L0完成；后续S0-S3/B4与企业能力均按L1跟踪。

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
- 最终本地verification：Node 24.18.0与pnpm 11.9.0下`lint:s0-s3`、`typecheck:s0-s3`、`build:s0-s3`、contracts `10/10`、API unit `41/41`、真实Nest失败operations聚焦 `1/1`、Web component `22/22`及三视口Playwright browser integration `21/21`通过；完整integration标准入口仍由PostgreSQL 17 CI拥有。
- PostgreSQL：本机服务按方案未启动；GitHub Actions run `29410946297`的`space-session`在PostgreSQL 17 service上完成迁移回放、真实HTTP、运维与并发集成并通过。
- Web证据：修复后的Playwright browser integration在desktop、390x844 mobile与320x568三项目共`21/21`通过；诊断按原始Request保留并发请求、响应、失败和pending，不在共享support内预判业务结果。
- L0证据：标准Node runner `84/84`；API raw SBOM与只读断网运行图均为115个唯一npm PURL且双向差集为零，Web运行镜像npm组件为零；本地许可证为源码`2005 allowed / 0 denied / 0 unknown`、总计`2293 allowed / 0 denied / 0 unknown`，run `29410946297`为源码`2006 / 0 / 0`、总计`2294 / 0 / 0`；CI raw SBOM保留`exp-html`的scanner `BSD-2-Clause`，canonical SBOM以完整历史来源链证明`BSD-3-Clause`并记录原值；三份非空漏洞报告合计`0 fixable / 0 unfixed / 0 total`。
- 上游证据：真实基线校验全项通过；固定候选影响报告覆盖451个变更路径并发现22个冲突路径。双父显式merge提交`ebe5e941b6dbdc9c139d76883b2746f9db7fa7fa`已完成冲突解决、进入`master`与`origin/master`并晋升为当前基线。
- Git：`git diff --check`、工作树审计；提交后`origin/master`与HEAD同。

## Resume Guide

先读`/root/projects/AGENTS.md`、仓库`AGENTS.md`、本计划、S1 PRD、空间架构、ADR-013与ADR-014；再查`git status`、goal、agents。稳定提交`8f7ed852a`与GitHub Actions run `29410946297`已经全绿；先提交推送本次证据更新并确认CI，再独立执行固定候选正式`--no-ff` merge。系统Node22，复核时用`/root/.cache/pnpm/dlx/cb39032a5e9268a038762c66ab60f208/pkg/node_modules/.bin`前置PATH，并以`/root/.cache/node/corepack/v1/pnpm/11.9.0/bin/pnpm.cjs`执行。勿启本地PostgreSQL。
