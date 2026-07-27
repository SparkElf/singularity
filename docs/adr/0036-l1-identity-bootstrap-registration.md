---
title: "ADR-036: 首次管理员初始化与开放注册"
description: "决定奇点如何直接复用思源账号 UI，并在首次部署生成本地管理员与开放注册闭环"
author: "Codex"
date: "2026-07-24"
version: "1.0.0"
status: "proposed"
tags: ["adr", "identity", "registration", "bootstrap"]
---

# ADR-036: 首次管理员初始化与开放注册

## Context

奇点已有本地 User、Organization、Membership、Space、Invitation 和 AuthSession 模型，也已有 Argon2 登录和受控 CLI 初始化；但 Web 没有首个管理员入口，登录页也没有始终可用的注册入口。直接调用思源官方账号接口会把云账号和企业权限混成两个事实源。

## Decision

1. 登录和注册直接使用思源 `accountUi.ts` 的 DOM/CSS；所有提交、会话和错误逻辑使用奇点本地身份 API。
2. API 首次部署启动时固定创建 `admin`，密码由 CSPRNG 生成并仅一次性输出到部署日志。
3. 首次初始化和注册都使用同一个声明式 Nest provider `IdentityProvisioningService` 的事务写入合同。
4. 首次初始化在 `system_installations(id=1)` 空时只允许一次，固定创建 `admin`、首个组织 owner、首个空间 admin 和 Kernel 实例；成功后不通过 Web 表单覆盖账号或密码。
5. 注册始终开放。每个新用户只创建本地 User 和 AuthSession，不创建组织、空间或任何成员关系；安装状态接口不承担注册权限判断。
6. 企业成员默认使用既有邀请接受路径；邀请角色由服务端 token 事实决定，注册表单不能选择组织或角色。
7. 所有用户输入在 contracts schema 边界规范化一次，所有密码使用现有 PasswordHasher，所有 session 使用现有 IdentityService；不引入 JWT、第二套用户表或前端权限推断。

## Alternatives

- 直接把思源 `/api/account/login` 接到企业页：拒绝，会把官方云账号当成企业成员身份，无法表达组织权限和会话撤销；只复用 UI，不复用云账号后端。
- 仅保留人工 CLI 初始化：拒绝，部署结果依赖额外人工步骤且可能生成非固定管理员身份。
- 注册时自动创建组织：拒绝，身份注册与组织生命周期耦合且会制造大量无管理组织。
- 直接让 Controller 复制 AccessOperationsService 的初始化 SQL：拒绝，形成第二套事务 owner 和并发语义。
- 让安装状态接口决定注册权限：拒绝，用户会被与注册无关的部署状态阻断，且前后端容易出现可见性与实际权限分叉。

## Consequences

- 首次部署自动完成管理员初始化，且与 CLI/HTTP 共享同一数据库事实和安全合同。
- 注册入口始终可用，但新用户没有组织权限，进入空间列表后等待邀请或管理员分配；后续加入组织必须走邀请、管理员分配或企业身份映射。
- 增加一个身份 provisioning 服务和三条 API 合同，但删除了 Web/CLI 两套初始化规则的潜在分叉。

## Verification

集中验证必须覆盖空库初始化、初始化竞争、始终注册、组织隔离、重复账号、登录页亮暗色和会话缓存清理。验证报告记录真实 PostgreSQL/Nest HTTP 边界、React runner、浏览器 console/network 结果以及异常完整堆栈日志。
