---
title: "身份初始化与注册实现计划"
description: "L1首个管理员、邀请注册和始终开放注册的实现与验证计划"
author: "Codex"
date: "2026-07-24"
version: "1.0.0"
status: "completed"
tags: ["plan", "l1", "identity", "registration"]
---

# 身份初始化与注册实现计划

## 目标

将思源原生账号页接入奇点本地用户系统，补齐首次部署自动生成管理员和始终开放的本地注册，同时保留邀请制企业成员路径。目标完成后，空安装启动时自动产生唯一 owner；非空安装可以登录、邀请或直接自助注册。

## 方案文件

- 产品：`docs/product/l1-identity-bootstrap-registration.md`
- 架构：`docs/architecture/l1-identity-bootstrap-registration.md`
- 决策：`docs/adr/0036-l1-identity-bootstrap-registration.md`

## 阶段

### P1 合同与配置

- 增加 setup/status、bootstrap、register API paths、Zod DTO、响应和 OpenAPI schema；setup 只报告初始化状态。
- 注册不增加配置开关；安装状态接口只报告初始化状态。

### P2 事务能力

- 新增 `IdentityProvisioningService`，拥有首装图和无组织用户注册的事务写入。
- 让受控 `initialize` handler 调用同一事务 owner，删除重复初始化写入。
- 保持 `IdentityService.issueSessionForCreatedUser` 为会话签发唯一 owner。

### P3 HTTP 与 Web

- 增加身份状态、首装和注册 Controller 方法，使用 `@SameOrigin`、Zod pipe、no-store 和既有 Problem filter。
- 保留 `/register` 路由；登录/注册页面直接使用思源 `accountUi.ts` 的 `b3-form__icon`、`b3-text-field`、`b3-button` DOM/CSS，业务请求改为奇点身份 API。
- 成功后统一写入 CSRF、清理 Query 并进入 `/spaces`。

### P3.1 部署身份引导（新增）

- API 首次部署启动时原子生成固定用户名 `admin` 和随机强密码，创建默认组织、空间、成员关系和 Kernel。
- 初始密码只在创建成功的部署日志中一次性输出；后续重启不重新生成、不覆盖。
- Web 不再提供自定义首个管理员表单；`/setup` 只说明管理员由部署初始化生成。

### P4 评审与集中验证

- 代码评审检查事务边界、重复校验、敏感日志、中文关键函数注释、字段唯一性和无 fallback。
- 一次性运行静态、HTTP/PostgreSQL、React component、browser integration/visual 矩阵；首轮 6 个浏览器合同失败已按共同根因集中修复并复跑通过。
- 形成 `docs/verification/l1-identity-bootstrap-registration.md`；本计划已完成。

## 完成条件

P1-P3 全部实现，P4 code-review 复评无阻塞；空库初始化、并发唯一性、始终注册、组织隔离、登录/注册页面和亮暗色/320px 视觉合同全部有实际证据。
