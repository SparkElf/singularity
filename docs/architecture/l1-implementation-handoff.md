---
title: "奇点 L1 实现交接"
description: "L1 implementation收口状态、稳定合同与集中评审验证入口"
author: "Codex"
date: "2026-07-21"
version: "2.1.0"
status: "completed"
tags: ["l1", "implementation", "handoff"]
---

# 奇点 L1 实现交接

## 目标与阶段

权威方案为`output/md/Singularity_Enterprise_Knowledge_Base_v1.0.0_2026-07-13.md`。L0已经完成；L1生产代码、公共合同、迁移、调用方、永久测试代码、旧路径删除与功能文档已经完成implementation收口，所有功能owner均已释放。2026-07-21已完成整阶段code-review、安全与许可证复评及正式verification，按方案第9.3节宣告L1完成。

## 当前现场

- 仓库：`/root/projects/singularity`；环境：WSL2 Linux；分支：`master`；远程：`origin/master`。
- 本轮implementation开始前的`HEAD`与`origin/master`均为`9ccb54f74`（`feat(backup): harden restore lifecycle`）；后续完整实现及验证提交已进入当前`master`，本文作为完成交接记录保留。
- Enterprise正式命令必须使用Node `24.18.0`与pnpm `11.9.0`；SiYuan App使用自身锁定的pnpm `11.12.0`。不得以默认Node 22的结果作为交付证据。
- 固定PostgreSQL 17测试服务为`singularity-postgres-test`，仅绑定`127.0.0.1:55432`并使用数据库`singularity_test`。本实现波未启动、停止或重配该容器，也未触碰用户占用的3000端口进程。
- 集中verification使用Node `24.18.0`、pnpm `11.9.0`与固定PostgreSQL 17测试库完成正式runner、typecheck、build、Prisma、数据库、浏览器、服务、Kernel及供应链验收；本轮没有启动、停止或重配固定数据库。

## 纵向功能状态

| 功能 | 已落盘合同 | verification重点 |
| --- | --- | --- |
| 身份、邀请与会话 | 本地账号、OIDC、显式邀请绑定、CSRF单一请求owner、到期/撤销/禁用强制下线与统一`SessionRedirect` | 真实HTTP、并发邀请、401清理、会话与WSS关闭 |
| 组织、用户组与空间管理 | owner防降级、组织/组/空间生命周期、两级授权、相同状态写入幂等且不重复通知或审计 | PostgreSQL通知屏障、角色边界、管理页面组件 |
| 内容目录与Session组合根 | 目录产生显式`spaceId + notebookId + documentId`，锁态/空库不创建Protyle，撤权有序销毁且网络故障保留内容 | 真实Kernel目录、分页、迟到响应、撤权清屏 |
| Gateway与Kernel生命周期 | mTLS、服务JWT、动态端点唯一、通知fail-closed、pending/active连接关闭、私网监听和恢复deployment事实源 | HTTPS/WSS、LISTEN、shutdown与恢复对账 |
| Protyle与Vite入口 | canonical标题/推送身份、同文档多实例来源、viewer唯一写门禁、正式PluginPort、Vite唯一企业生产入口 | P3/P4 browser integration、AST闭包、App runner |
| Discovery与工作面板 | 空间搜索/图谱仅用空间身份；文档搜索、大纲、反链、历史和局部图谱携带显式内容身份 | Kernel/Nest/contracts、迟到请求、不可导航节点 |
| 分享与主动内容 | 公网最小投影、每次读取重验分享、资源闭包、MIME隔离、PDF canvas、canonical OCR路径 | HTTP、组件、browser integration与真实分享E2E |
| 审计与可观测性 | 调用前intent、明确结果/`indeterminate`、声明式Worker最终化、唯一HMAC事件、真实`requestId`/`kernelInstanceId` | Gateway失败窗口、Worker有界批次/MAC/租约、日志字段省略 |
| 备份、恢复与容量健康 | Worker claim、加密/明文归档一致性、隔离恢复Kernel、显式激活、容量/健康三态投影 | PostgreSQL锁、Go归档、真实恢复E2E、观测错误码 |
| Worker镜像与供应链 | Node 24非root镜像、Go恢复命令、appearance、健康检查、三镜像SBOM/漏洞/许可证闭包 | 冷构建、断网制品探测、healthy smoke与报告非空性 |

## 稳定不变量

- 内容链显式携带`spaceId + notebookId + documentId`；禁止从DOM、全局状态、URL、首响应、首节点或当前编辑器推断。
- 每个真实边界只有一个解析、校验或清理owner；下游依赖已验证合同，不添加重复guard、fallback、兼容字段或第二事实源。
- viewer、撤权与锁定状态不得产生写事务或迟到推送；显式撤权按freeze、dispose、清DOM/选择、通知上层的顺序完成，Kernel或网络故障不冒充撤权。
- 空间搜索和图谱不携带文档身份；文档面板只走当前Session的Gateway内容链，图谱导航身份只来自源block。
- 浏览器只传播服务端真实HTTP/WS请求产生的`requestId`；后续事件使用可选`triggeringRequestId`，无来源时省略，不生成随机替代值。
- 内容审计intent写入失败时不调用Kernel；明确Kernel结果的resolve失败不覆盖内容响应；查询、React和归档只消费`audit_events`。
- 后端装配优先Nest原生`@Module`、`@Injectable`、Controller、DI、schema和Worker声明式decorator；业务状态转移留在显式service/handler。
- `app/src/block/Panel.ts`、`EmbeddedProtyleOwner`与上游Webpack仍有desktop/mobile/export等真实消费者，必须保留；企业Vite闭包通过AST门禁排除这些路径，不把企业入口收口误写成上游源码物理删除。

## P5真实链

- 唯一E2E入口使用真实React/Vite、Nest API、PostgreSQL、mTLS Gateway、Go Kernel与声明式Worker，不使用`page.route`替代目标后端。
- 已落盘登录、空间选择、编辑保存重载、viewer写拒绝、撤权清屏、分享即时撤销、备份隔离恢复与内容审计最终事件链。
- 启动器使用测试私有schema、工作区、密钥与对象存储；退出时清理API、Worker、源/恢复Kernel、schema和临时文件，但不启动或停止固定PostgreSQL服务。
- 企业Web镜像只交付Vite `dist`；旧企业shell runner、错位Adapter测试和企业Webpack入口已物理删除。上游App构建链保持不变。

## Verification Record

- `pnpm verify:b4`：architecture `25/25`、Protyle Browser `10/10`、Web `33/33`、App `78/78`，生产构建通过。
- `pnpm verify:s0-s3`：contracts `24/24`、database `53/53`、API unit `123/123`、API integration `221/221`、Worker `59/59`、Web component `78/78`、browser integration `59 passed / 64 skipped / 0 failed`，Kernel serviceauth及企业构建通过。
- `pnpm test:e2e`：P5真实链 `11 expected / 0 unexpected / 0 skipped`；Kernel全量、Docker冷构建、生产SBOM闭包、漏洞和许可证策略均通过。
- 供应链标准runner：`node --test scripts/singularity/*.test.mjs` 为 `112/112`；许可证 `2642 allowed / 0 denied / 0 unknown`，漏洞 `0 fixable / 0 unfixed High/Critical`，生产依赖闭包 `0`。

## 后续范围

L1交付不包含方案第9.2节的实时多人编辑、评论、通知、文档级权限、LDAP/SCIM、本地离线和跨空间搜索；这些能力必须分别进入L2/L3产品与架构评审。

## 恢复入口

```text
cd /root/projects/singularity
cat /root/projects/AGENTS.md
cat AGENTS.md
cat docs/architecture/l1-implementation-handoff.md
git status --short --branch
git log -12 --oneline --decorate
```

恢复时以仓库、代理状态和真实测试结果为准，不使用旧百分比、旧owner、旧HEAD或历史“暂停线”推断当前状态，不回退共享工作树。
