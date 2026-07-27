---
title: "奇点 L4 SCIM 2.0 兼容架构方案"
description: "在既有组织成员生命周期同步之上补齐标准 SCIM Users/Groups 资源合同"
author: "Codex"
date: "2026-07-23"
version: "1.0.0"
status: "accepted-for-implementation"
tags: ["architecture", "l4", "scim", "identity"]
---

# 奇点 L4 SCIM 2.0 兼容架构方案

## 目标与差距

现有 L4 已有带组织作用域的 Bearer token、externalId 幂等同步和成员停用收敛，但公开入口是内部批量接口 `POST /api/v1/organizations/{organizationId}/scim/sync`。外部身份供应商通常要求 SCIM 2.0 的 `ServiceProviderConfig`、`Users` 和 `Groups` 资源，因此本阶段补齐协议合同，不改变现有成员、会话、机器凭据或文档 ACL 的事实源。

## 锁定边界

- `ScimTokenGuard` 是 Bearer 摘要校验、过期/撤销和组织路径绑定的唯一认证边界。
- SCIM controller 只负责 HTTP 资源解析、分页和 SCIM 响应序列化；成员生命周期由 `EnterpriseGovernanceService` 负责。
- `ScimExternalIdentity` 的 `(organizationId, externalId)` 是外部资源稳定身份；当供应商未提供 `externalId` 时，SCIM `userName` 作为 SCIM 服务提供商范围内的稳定资源键，不从姓名、邮箱片段或首条结果推断。
- Users 的 `active=false`、DELETE 和 Groups 成员变更只同步组织成员/组成员；不直接写文档 ACL。既有 `DocumentAccessPolicy` 继续是唯一 ACL owner。
- PostgreSQL 只保存控制面身份映射和成员关系；正文、`.sy` 内容、Kernel 历史和操作日志不进入 SCIM 表。
- 现有批量 `/scim/sync` 保留为内部批量导入合同，复用同一 use case；标准资源和批量导入不得各自维护状态机。

## 数据流

```text
外部 IdP
  -> SCIM HTTP Users/Groups/ServiceProviderConfig
  -> ScimTokenGuard（Bearer 摘要 + organizationId）
  -> Zod SCIM resource / patch schema
  -> EnterpriseGovernanceService SCIM use case
  -> User / OrganizationMembership / UserGroup / UserGroupMembership / ScimExternalIdentity
  -> AccessChangedPublisher（停用用户时关闭会话与协作）
```

分页、filter 和 PATCH 只在协议边界解析一次；service 接收已解析的最小领域输入，不再次解析 SCIM JSON。响应中的 `id` 始终是 `ScimExternalIdentity.externalId`，不会用数据库首项或 DOM 状态推断。

## 资源合同

### ServiceProviderConfig

`GET /api/v1/organizations/{organizationId}/scim/v2/ServiceProviderConfig` 返回 Bearer 认证、Users/Groups 支持、PATCH 支持和分页上限。它不泄露 token 或组织成员数据。

### Users

- `GET /Users` 支持 `filter=userName eq "..."`、`startIndex`（默认 1）和 `count`（默认 100，最大 200）。
- `POST /Users` 创建或幂等更新用户；必需 `userName`，`externalId` 可选，`active` 默认 true。
- `GET /Users/{id}` 返回指定 externalId 的用户；不存在返回 SCIM 404。
- `PATCH /Users/{id}` 只接受 SCIM `replace` 操作中的 `active`、`userName` 和 `externalId`，同一请求内按声明顺序执行。
- `DELETE /Users/{id}` 等价于 `active=false`，保留审计、映射和历史，不物理删除账号。

### Groups

- `GET /Groups` 支持 `filter=displayName eq "..."`、`startIndex` 和 `count`。
- `POST /Groups` 创建或幂等更新组；`displayName` 必需，`externalId` 可选，成员使用 SCIM user resource id。
- `GET /Groups/{id}` 返回组及当前成员的 SCIM user resource id。
- `PATCH /Groups/{id}` 支持 `replace` 的 `displayName`、`externalId`、`members`，以及 `add/remove` 成员操作。
- `DELETE /Groups/{id}` 将组标记为 disabled 并清理组成员关系，不修改文档 ACL grant；现有 ACL 对 disabled 组的授权仍由既有权限策略决定。

### 已落地入口

- `GET /api/v1/organizations/{organizationId}/scim/v2/ServiceProviderConfig`
- `GET|POST /api/v1/organizations/{organizationId}/scim/v2/Users`
- `GET|PATCH|DELETE /api/v1/organizations/{organizationId}/scim/v2/Users/{resourceId}`
- `GET|POST /api/v1/organizations/{organizationId}/scim/v2/Groups`
- `GET|PATCH|DELETE /api/v1/organizations/{organizationId}/scim/v2/Groups/{resourceId}`
- 既有 `POST /api/v1/organizations/{organizationId}/scim/sync` 已复用同一用户/组 upsert use case。

## 错误与观测

- 协议不合法由 Zod pipe 返回稳定 400；未知资源返回 SCIM `404`；Bearer 失败返回 401；组织路径不匹配不泄露资源存在性，仍返回 401。
- 每个异常保留原始 `name/message/stack`，日志只关联 requestId、organizationId、externalId 摘要和资源类型，不记录 Bearer token、完整 PATCH、密码或正文。
- 用户停用必须复用现有撤权发布，确保会话、协作和 API Key 收敛；组成员变化只写组织控制面并进入审计。

## 设计取舍

更简单的方案是把 SCIM 供应商请求继续转换为内部批量数组，但它缺少资源读取、PATCH、分页和标准错误语义，无法称为 SCIM 兼容。本方案增加一个薄协议层，但所有状态转移仍复用同一 service use case，不新增 registry、数据库事实源或权限算法。

采用的模式是 Nest 声明式 Controller/Guard/Pipe + service transaction；没有新增自定义扫描器。SCIM 资源 controller 为单例，Guard 由所属模块 DI 装配，冲突和启动失败沿 Nest 默认语义暴露。

## 阶段完成条件与测试矩阵

本阶段作为一个完整“SCIM 2.0 协议兼容” implementation 阶段，完成合同、controller、service、调用方、测试和文档后统一进入 code-review/test-governance/verification。

| 合同 | 最低充分证据 | 边界 |
| --- | --- | --- |
| ServiceProviderConfig、Users、Groups 序列化 | contracts + real HTTP contract | 真实 Nest；无完整内部 mock 链 |
| Bearer、组织隔离、分页/filter/PATCH 错误 | API integration | 固定 PostgreSQL；Guard 为唯一认证 owner |
| externalId 幂等、停用撤权、组成员同步 | API/DB integration | 复用现有 service 和 access-change 发布 |
| 标准用户入口可达 | browser integration | 使用现有治理身份页面和统一诊断 fixture |
| 现有 L4/L3 回归 | 唯一 `pnpm verify:l4-governance` aggregate | 阶段末集中执行，不逐功能运行 |

## 文件归属与集成顺序

本阶段不使用子代理。唯一 owner 为当前实现线程；公共 contracts、governance controller/service、API tests、架构文档和 aggregate 由同一 owner 串行收口。实现顺序为 contracts → controller/service → HTTP/DB tests → OpenAPI/文档 → code-review → aggregate verification。
