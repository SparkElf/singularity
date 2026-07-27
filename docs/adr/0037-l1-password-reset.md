---
title: "ADR-0037 L1密码找回链路"
description: "为本地账号建立一次性邮件令牌和会话撤销的声明式 Nest/Prisma 实现边界"
author: "Codex"
date: "2026-07-25"
status: "accepted"
tags: ["adr", "l1", "identity", "password-reset"]
---

# ADR-0037 L1密码找回链路

## 背景

现有奇点只有登录、注册和会话撤销能力，用户无法恢复遗忘的本地密码。`User` 目前以 `loginIdentifier` 保存账号，使用邮箱形式的账号可直接作为 SMTP 收件地址；固定 `admin` 没有邮箱，不在公开邮件恢复路径中伪造可用性。

## 决策

1. 在 `packages/contracts` 增加找回请求、重置请求和统一成功响应 schema 与路径常量。控制器使用现有 `ZodValidationPipe`、`@SameOrigin()` 和 Swagger metadata 声明 HTTP 边界。
2. 增加 `PasswordResetToken` Prisma 模型和迁移。令牌明文只存在于邮件链接，数据库保存域隔离摘要、用户、过期时间和消费时间；`(userId, expiresAt)` 建索引。
3. 增加 `PasswordResetService` 作为状态转换 owner：请求阶段检查发送器就绪、查找邮箱用户、创建令牌并发送邮件；消费阶段在单事务内锁定 token/user，更新密码、标记 token、撤销旧会话并发布既有访问变化事件。
4. 通过 `PASSWORD_RESET_MAILER` DI token 注入 `PasswordResetMailer`。生产 provider 使用 `nodemailer` SMTP transport；测试通过 `CreateApiApplicationOptions.passwordResetMailer` 注入捕获实现。没有 SMTP 配置时 provider 抛出统一的配置错误，服务在查询用户前返回 503。
5. `IdentityService.revokeUserSessionsInTransaction` 继续是会话撤销唯一 owner；密码重置服务只调用它，不复制 `auth_sessions` 更新和访问变化广播。
6. 前端新增 `ForgotPasswordPage`、`ResetPasswordPage` 和 auth API 函数；页面沿用思源 `b3-*` 表单 class 与现有 Tailwind/shadcn 状态组件，不新建全局状态。token 只由重置页面的当前 URL 消费。

找回请求复用 `LoginRateLimiter` 的来源与邮箱双键限流，不另建同义限流器。
重置提交也复用该限流器，以限制无效 token 触发的 Argon2 计算成本。

生产部署通过 `SINGULARITY_PASSWORD_RESET_SMTP_URL` 和 `SINGULARITY_PASSWORD_RESET_FROM` 提供 SMTP 地址与发件人；两者缺一时找回入口明确显示服务未配置，不查询账号。

## 数据流和边界 owner

`用户输入 -> Zod schema -> Controller -> PasswordResetService -> Prisma/PasswordResetMailer -> 页面结果`。

- 邮箱格式由合同 schema 唯一负责；服务不重复正则检查。
- 令牌格式由重置请求 schema 负责，数据库摘要匹配和过期/消费状态由事务服务负责；消费者不再次归一化。
- 密码规则由既有 `passwordSchema` 负责，服务只调用既有 `PasswordHasher`。
- 邮件异常由 mailer boundary 记录完整堆栈；API Problem Filter 负责未预期异常的统一响应。

## 更简单方案比较

- 仅恢复一个前端链接不具备用户结果，排除。
- 把重置 token 放在响应或日志中能省掉邮件依赖，但会形成凭据泄露和不可部署的安全路径，排除。
- 在 `IdentityService` 内复制会话撤销 SQL 会产生第二个 owner，排除；复用已有事务方法。

## 声明式装配

`CoreModule.register` 以 Nest `@Module` provider metadata 装配 `PasswordResetService` 和 `PASSWORD_RESET_MAILER`。路由、schema、权限和序列化使用既有装饰器；没有中央 switch、手工 registry 或双写配置。生产 SMTP provider 是 singleton，启动不连接 SMTP；调用前以配置对象判断就绪，传输错误保留原始堆栈并按合同收敛。

## 测试大阶段与集中门禁

本变更为一个完整大阶段“L1密码恢复”。实现阶段只补齐 contracts、Prisma 迁移、API、页面和测试；全部代码、文档、旧合同更新并完成整阶段 code-review 后，统一执行：

1. `pnpm --filter @singularity/contracts test && pnpm --filter @singularity/contracts typecheck`
2. `pnpm --filter @singularity/database generate && pnpm --filter @singularity/database test:integration`
3. `pnpm --filter @singularity/api typecheck && pnpm --filter @singularity/api test:unit && pnpm --filter @singularity/api test:integration`
4. `pnpm --filter @singularity/web typecheck && pnpm --filter @singularity/web test -- src/app/App.test.tsx src/auth/ForgotPasswordPage.test.tsx src/auth/ResetPasswordPage.test.tsx`
5. `pnpm --filter @singularity/web build && pnpm --filter @singularity/web test:browser-integration`

正式验证只在 code-review 复评通过后集中执行；固定 PostgreSQL 继续使用 `singularity-postgres-test`，不创建临时数据库。
