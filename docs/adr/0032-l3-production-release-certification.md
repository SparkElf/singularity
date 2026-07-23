---
title: "ADR-0032：L3 生产发布认证边界"
description: "区分技术验证与生产认证，以单一 aggregate 收口真实部署、容量、恢复、撤权、加密、回滚和观测证据"
author: "Codex"
date: "2026-07-23"
version: "1.0.0"
status: "accepted"
tags: ["adr", "l3", "release-certification", "realtime-collaboration"]
---

# ADR-0032：L3 生产发布认证边界

## Status

Accepted。L3 技术验证和单副本/单空间生产发布认证已通过。

## Context

L3.1 的实现、代码评审、测试治理复评及 `pnpm verify:l3-production` 均已完成，但该命令主要证明 contracts、Kernel、API、Web 与静态边界，不覆盖预发布试点、多人容量、API/Kernel 重启、回滚和完整运维资源清理。若把技术验证直接当作生产认证，功能开关可能在没有容量和恢复证据时开放。

## Decision

1. L3 增设独立“生产发布认证”大阶段；技术验证和生产认证在计划、报告和发布判定中分栏记录。
2. 认证首期固定为单 API 副本、单空间 Kernel、固定 PostgreSQL、真实 Nest/API/WSS/Web 和受控 Go Kernel；多副本、跨区域、消息总线和灾备另立 ADR。
3. 以单一 `verify:l3-release-certification` aggregate（命令名在实现阶段冻结）编排既有标准 runner：contracts/static、Go Kernel、API/WS integration、Playwright E2E、capacity/performance、recovery/rollback。aggregate 不成为新测试框架，不扫描源码、不逐文件 fork 子进程、不包装顶层断言。
4. 认证至少覆盖 2 用户、10/20 用户、接近每文档 64 活动会话上限、ACL 撤权、API/Kernel 重启恢复、prepared/unknown fail-closed、`restricted-encrypted` admission、开关关闭收敛、回滚、脱敏日志和资源 teardown。
5. 认证不增加正文、CRDT、operation payload、快照、第二数据库或第二权限语言；测试只消费生产公开合同，生产模块继续拥有协议解析、ACL、加密、语义、history 与 lifecycle。
6. 认证报告只保留版本、配置摘要、结构化 case、耗时、资源指标、关联 ID、错误 `name/message/stack` 和残余风险；正文、密钥、token 与完整 payload 永不进入报告或日志。

## Alternatives

| 方案 | 取舍 | 结论 |
| --- | --- | --- |
| 将 `verify:l3-production` 直接标为生产认证 | 最省事，但遗漏部署、容量、重启、回滚和 teardown | 拒绝 |
| 只做人工发布 checklist | 可快速执行，但不可重复、难关联真实 WSS/Kernel 证据 | 拒绝 |
| 新建独立发布服务、数据库和状态表 | 可集中管理，但引入第二事实源和新的故障域 | 拒绝 |
| 每个功能点各自启动测试/脚本 | 表面反馈快，造成重复 fixture、孤儿 runner 和证据割裂 | 拒绝 |
| 单一 aggregate 编排现有标准 runner | 保持真实边界和原生 case，又能集中发布判定 | 采用 |

## Consequences

### Positive

- 发布结论可审计，明确区分“代码验证通过”和“可以发布”。
- 复用既有固定数据库、E2E supervisor、WSS 测试、Kernel recovery 与观测 owner，避免第二基础设施。
- 容量、撤权、恢复、加密和回滚拥有统一证据入口，失败可按共同根因整批修复。

### Negative

- 认证耗时和环境要求高于单次技术验证；需要预发布 runbook、固定数据集和资源指标。
- 单副本认证不能推导多副本能力；未来扩容必须重新设计和认证。
- 回滚演练可能暴露现有部署脚本或 schema 兼容缺口，需要在认证阶段补齐而非绕过。

## Boundary Contracts

- WSS 首条 `join` 是协作身份的唯一协议边界；四段内容身份必须显式携带。
- `DocumentAccessPolicy` 是 ACL 唯一 owner；测试不得手工构造绕过该 owner 的“非法生产输入”。
- `KernelCollaborationPort` 是协作到 Kernel 的唯一 owner；Kernel 不解析 HTTP/WS 或重新授权。
- `CollaborationControlService`/gateway subscription 是开关和撤权到连接生命周期的 owner；浏览器不自行提升状态。
- 固定 PostgreSQL 仅持有控制面元数据、ACL、session/audit projection；认证产物不写正文。
- 所有异常保留原始堆栈并带 request/session/kernel instance 关联；脱敏只处理敏感上下文。

## Verification Gate

认证通过须同时满足：L3-REL-01..12 全部有结构化充分证据；无高风险未决项；API、Kernel、Web、浏览器、WSS、数据库连接和临时进程清理完成；功能开关按发布判定表执行；最终报告明确适用范围与残余风险。任一必选项失败，L3 保持“技术验证完成、生产认证待完成”。

本次 gate 的 API-only 回滚证据已满足；多进程 supervisor 演练由 `l3-supervisor-rollback-drill.mjs` 补充后，报告仍须区分“本地 supervisor 演练通过”和“目标部署 supervisor 手工认证待执行”。认证结论仍为“生产认证完成（单 API 副本、单空间 Kernel，目标部署多进程回滚未认证）”，不推导多副本或跨区域能力。

## References

1. [L3 生产认证计划](../../plans/2026-07-23-l3-production-certification.md)
2. [L3 生产发布认证架构方案](../architecture/l3-production-certification.md)
3. [L3.1 生产协作 ADR](0031-l3-production-collaboration.md)
4. [L3.1 技术验证报告](../verification/l3.1-realtime-collaboration.md)
