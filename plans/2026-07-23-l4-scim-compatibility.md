---
title: "奇点 L4 SCIM 2.0 兼容实施计划"
description: "将内部批量身份同步收口为可被外部 IdP 使用的标准资源合同"
author: "Codex"
date: "2026-07-23"
version: "1.1.0"
status: "automated-passed"
tags: ["plan", "l4", "scim", "identity"]
---

# 奇点 L4 SCIM 2.0 兼容实施计划

## 前置与目标

前置资料：[L4 产品需求](../docs/product/l4-knowledge-governance.md)、[L4 企业能力架构](../docs/architecture/l4-enterprise-governance.md)、[ADR-0034](../docs/adr/0034-l4-scim-2.0-compatibility.md)。目标是补齐 `ServiceProviderConfig`、Users、Groups、分页、filter、PATCH 和标准错误语义；不改变现有 SCIM token、成员、会话、组成员或 ACL 事实源。

## 任务清单

- [x] 扩展 contracts：SCIM resource、ListResponse、PatchOp、ServiceProviderConfig 和稳定错误输出。
- [x] 扩展 Nest controller：声明式 Bearer Guard + SCIM Zod Pipe 下的标准资源路由。
- [x] 扩展治理 service：用户/组查询、幂等 upsert、PATCH、停用和成员关系收敛。
- [x] 补充 API HTTP/DB 合同和 OpenAPI 装饰器证据；复用固定 PostgreSQL 与现有 runner。
- [x] 更新 L4 架构、ADR 和总计划中的 SCIM 范围。
- [x] 完成整阶段 code-review/test-governance 复评。
- [x] 运行唯一 L4 aggregate，并回填验证报告和结构化结果。

## 完成条件

1. 外部 IdP 可以仅使用 Bearer token 通过标准 Users/Groups 资源完成创建、读取、分页、过滤、更新和停用。
2. 资源 ID、organizationId、externalId 和组成员关系全链路显式；无 DOM、首响应或局部全局状态推断。
3. 用户停用关闭已有会话、协作和 API Key；组/成员同步不直接修改文档 ACL。
4. SCIM token、密码、完整 PATCH 和正文不进入日志或数据库；异常保留完整堆栈。
5. API/DB/browser 合同进入标准 aggregate；阶段末报告明确供应商扩展未覆盖范围。

## 阶段门禁

实现阶段只编写生产代码、合同、测试和文档，不执行正式验收。全部任务完成后进入 code-review 和 test-governance 复评，再集中运行 `cd enterprise && pnpm verify:l4-governance`。

## 验证结果

2026-07-23 已完成唯一 `pnpm verify:l4-governance` aggregate。12 个阶段命令全部通过，其中 SCIM contracts、真实 Nest HTTP/DB 合同、OpenAPI/typecheck 与 L3 回归均通过；API integration 为 233/233，React 组件为 186/186，浏览器验证为 65 通过、64 条件跳过、0 失败。结构化结果见 `enterprise/test-results/l4-governance/report.json`，集中报告见 `docs/verification/l4-enterprise-capabilities.md`。
