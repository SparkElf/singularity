---
title: "L1身份初始化与注册架构"
description: "奇点本地身份、首次安装引导、开放注册与邀请注册的模块边界和数据流"
author: "Codex"
date: "2026-07-24"
version: "1.0.0"
status: "draft"
tags: ["l1", "identity", "registration", "bootstrap", "nestjs", "prisma"]
---

# L1身份初始化与注册架构

## 1. 决策摘要

在现有 NestJS 身份模块内增加声明式 HTTP 合同和一个安装/注册领域服务。该服务复用现有 `IdentityService` 的 Argon2、会话签发、审计和访问失效能力，把首次部署自动初始化与注册收敛到同一个事务事实源。Web 直接消费思源 `accountUi.ts` 的 DOM/CSS，所有账号逻辑调用奇点 API。

不新增 JWT、不新增用户表、不让浏览器直接调用访问操作 CLI，也不把注册用户加入任何组织。注册始终开放；安装状态接口只报告 `system_installations` 是否存在，不承担注册权限判断。思源云账号的 `cloudRegion` 不进入奇点身份链路。

## 2. 数据流

```text
React 登录/初始化/注册表单
  -> contracts Zod schema
  -> Nest @Controller + @SameOrigin
  -> IdentityProvisioningService
  -> Prisma transaction
  -> 首装：User + Organization + Membership + Space + KernelInstance；注册：User
  -> IdentityService.issueSessionForCreatedUser
  -> HttpOnly session cookie + memory CSRF
  -> React Query 清理 -> /spaces
```

状态查询只读取 `system_installations` 是否存在。它不推断用户、组织或空间身份，也不决定注册入口，不从首个响应补全字段。

## 3. 模块边界与声明式装配

| 模块 | 权威职责 | 公开合同 |
| --- | --- | --- |
| `contracts/identity.ts`、`paths.ts` | 请求/响应 schema、路径和 OpenAPI schema | `GET /auth/setup`、`POST /auth/login`、`POST /auth/register` |
| `identity/identity.controller.ts` | HTTP 访问模式、schema pipe、Cookie 和状态码 | `@SameOrigin()`、`@Header("Cache-Control", "no-store")` |
| `identity/identity-provisioning.service.ts` | 首次安装图和无组织用户注册的事务状态转换 | 只接收规范化 DTO，返回用户 ID 或安装图 |
| `identity/identity.service.ts` | 密码哈希、用户创建后的会话签发、CSRF、审计 | 既有 `issueSessionForCreatedUser` |
| `identity-provisioning.service.ts` | 首次安装状态与注册事务 | `GET /auth/setup` 只返回 `initialized`；`POST /auth/register` 始终可用 |
| `main.ts` + `IdentityProvisioningService` | 首次部署自动生成固定 admin 和随机密码 | `ensureInitialInstallation()` 只允许 `system_installations(id=1)` 一个成功者 |
| `AccessOperationsService` | 受控访问操作协议 | 继续复用同一 provisioning transaction owner，测试/迁移场景可显式建图 |
| `auth/LoginPage.tsx`、`auth/ProvisioningPage.tsx` | 思源原生账号 DOM/CSS 与路由状态 | 只消费奇点 API，不调用思源账号接口；部署页不再收集管理员账号 |

Nest 通过 `CoreModule` 的 `@Module` providers 和既有 Controller 元数据完成装配；无需中央字符串 registry。路由、schema、访问 guard 和依赖注入均由框架声明表达。

## 4. 事务与并发合同

### 4.1 首次初始化

`IdentityProvisioningService.ensureInitialInstallation` 在 API 启动时生成 32 字节 CSPRNG 密码并在同一 Prisma transaction 中按以下顺序写入：`SystemInstallation(id=1)`、固定 `admin` User、默认 Organization、owner Membership、Space、space admin Membership、KernelInstance 以及权限审计。`SystemInstallation` 的唯一主键是一次性锁，冲突启动不会重新生成或覆盖密码。

Web 不再拥有首装写入入口；启动初始化只创建控制面安装图，管理员随后通过普通登录建立会话。已有受控操作仍复用同一安装图写入 owner，不能改变生产首次部署固定 `admin` 合同。

### 4.2 本地注册

注册请求在同一事务中只创建 User。账号唯一冲突由 `users_login_identifier_key` 负责，映射为 `409 conflict`。注册路径不会创建 Organization、Membership、Space 或 KernelInstance，也不会读取或修改已有组织；用户后续只能通过邀请、管理员分配或企业身份同步获得组织归属。

### 4.3 单一边界 owner

- HTTP 参数 trim、NFKC、大小和密码长度由 contracts Zod schema 一次完成。
- 初始化是否完成由 `system_installations` 唯一行一次判定；下游不重复猜测用户数。
- 事务负责组织关系和 Kernel 实例的原子写入；Controller 不重复校验数据库状态。
- React 只展示 API 状态，不在前端复制“是否初始化”的数据库推断。

## 5. 错误与可观测性

API Problem filter 继续作为统一异常边界。初始化冲突、重复账号和非法请求分别使用既有 `conflict`、`validation-failed` 合同；密码、token、密码摘要和组织内部路径不写入日志。新增 provisioning 入口在失败时使用 Nest Logger 记录完整原始异常链、`requestId`、流程类型和结果，不记录请求敏感字段。

关键函数必须有中文备注，说明事务范围、并发约束、会话签发副作用和错误语义；简单转发函数不增加空泛注释。

## 6. 前端设计系统与路由

页面直接使用思源运行时已加载的 `b3-form__icon`、`b3-text-field`、`b3-button` 和 `config-account--auth` 样式；React 只负责事件绑定、状态和奇点 API 请求，不复制一套 shadcn 表单外观。亮暗色由思源主题 token 继承，表单最小宽度保持 320px。

路由为 `/login`、`/setup`、`/register`。API 启动时先完成固定 admin 的部署初始化；`/setup` 可读取安装状态，登录和注册页面不依赖该接口决定可见入口，受保护空间路由仍由现有 `SessionRedirect` 处理。

## 7. 阶段与并行图

本大阶段串行收敛，原因是 contracts、事务 owner、Controller 和登录页共享同一身份合同，拆分会造成同一文件和同一状态转移的并发写入。

```text
产品合同
  -> contracts + configuration
  -> provisioning service + CLI 收敛
  -> HTTP controller + React routes/pages
  -> code-review
  -> 集中 verification
```

## 8. 测试矩阵与完成条件

| 合同 | 最低层级 | 证据 |
| --- | --- | --- |
| 安装状态和 schema | static + contract | identity contract runner |
| 空安装初始化、并发唯一成功、无半成品 | HTTP + PostgreSQL integration | `identity-bootstrap.http.test.ts` |
| 始终注册、隔离现有组织、重复账号 | HTTP + PostgreSQL integration | 同一 aggregate |
| 登录页 setup/register 入口和表单反馈 | React component | `LoginPage.test.tsx` / 页面测试 |
| 成功后的 CSRF、Query 清理、无空间空态和路由 | React component + browser integration | 现有 auth runner 扩展 |
| 亮暗色、320px 溢出、console/network 健康 | visual + browser integration | 既有 Playwright 配置 |

只有本大阶段全部实现、旧入口清理、代码评审复评通过后运行上述一次集中测试矩阵。实现中不穿插正式测试；阻塞时最多使用一次最小诊断探针。
