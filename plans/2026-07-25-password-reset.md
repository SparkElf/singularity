---
title: "L1密码找回实施计划"
description: "为奇点本地账号补齐从登录入口到一次性邮件重置的完整链路"
author: "Codex"
date: "2026-07-25"
version: "1.0.0"
status: "completed"
tags: ["plan", "l1", "identity", "password-reset"]
---

# L1密码找回实施计划

## 目标

交付可用的密码找回链路：登录入口、邮箱请求、一次性过期邮件链接、新密码设置、旧会话撤销、统一错误语义和亮暗主题验证。事实源与决策见 [`docs/product/l1-password-reset.md`](../docs/product/l1-password-reset.md) 与 [`docs/adr/0037-l1-password-reset.md`](../docs/adr/0037-l1-password-reset.md)。

## 大阶段

### 阶段 A：合同与持久化

- 增加 auth paths、Zod 请求/响应 schema、OpenAPI schema。
- 增加 Prisma `PasswordResetToken` 模型、迁移和生成客户端。
- 增加 SMTP 配置解析、DI token 和发送器接口；不连接 SMTP 直到调用。

完成条件：contracts、database、configuration 的唯一字段合同稳定，schema 生成可用，旧注册/登录合同不被兼容字段分叉。

### 阶段 B：API 状态链路

- 实现 `PasswordResetService`，覆盖令牌创建、邮件投递、事务消费和会话撤销。
- 在 `IdentityController` 以声明式路由接入请求和消费接口。
- 更新 `CoreModule`、应用选项和 OpenAPI；补充真实 HTTP/数据库合同测试与外部邮件捕获边界。

完成条件：存在、未知、未配置发送器、过期、重放、并发消费和旧会话失效均有明确业务结果；关键函数具备中文作用/副作用备注。

### 阶段 C：原生风格前端

- 在登录按钮下方增加“忘记密码”入口。
- 新增 `ForgotPasswordPage` 和 `ResetPasswordPage`，复用思源 `b3-*` 表单、现有主题 token 和 auth API 请求边界。
- 加入组件合同：统一成功语义、客户端确认密码、失效链接、请求竞态和会话清理。

完成条件：登录、请求、邮件链接、重置、返回登录用户路径连续；亮色/暗色/320px 不溢出。

### 阶段 D：整阶段评审与集中验证

- 完成 code-review 和 test-governance 复评：检查单一边界 owner、无重复会话撤销、无 token 泄露、无 fallback 和无孤儿测试。
- 统一执行 ADR 中的 contracts/database/API/web/browser 矩阵。
- 重建 Web、复用现有前后端进程体验；本轮不擅停用户已有服务。

实现与整阶段 code-review 已完成；复评确认无重复令牌校验、无会话撤销第二 owner、无敏感 token 日志和无孤儿测试，现进入集中验证。

## 功能模块集成图

```text
Contracts + Prisma + SMTP 配置
             |
             v
     PasswordResetService <---- IdentityService 会话撤销
             |
      IdentityController
             |
   ForgotPasswordPage / ResetPasswordPage
```

本轮不拆子代理；所有共享合同和身份文件由当前 owner 串行收敛，避免并行修改同一认证链路。

## 风险与决策

- 没有 SMTP 配置时不返回假成功；请求在查询用户前统一提示服务未配置。
- 邮件传输失败不把 token 写日志；保留完整异常堆栈并按进入投递阶段的统一文案收敛。
- 用户名形式账号没有可投递邮箱，不通过公开找回页猜测收件地址；页面引导管理员处理。
- 不改变现有 `admin` 首次部署密码生成合同，不在 Web 暴露初始密码。

## 测试治理口径

稳定合同按 API 状态转移、数据库持久化、组件交互和真实浏览器路径组织；不为每个函数或源码字符串新增测试。正式测试只有阶段 D 一个集中门禁，阶段 A-C 仅编写测试和做静态自查。

## 集中验证结果

验证日期：2026-07-25；环境：WSL2、Node.js 24.18.0、pnpm 11.15.1、Docker PostgreSQL `singularity-postgres-test`（`127.0.0.1:55432/singularity_test`）。

- Contracts：35 个用例通过；typecheck 通过。
- Database：7 个测试文件、60 个用例通过；Prisma generate 通过。
- API：16 个单元测试文件、138 个用例通过；21 个集成测试文件、250 个用例通过，包含真实 HTTP、数据库事务、SMTP 捕获、过期/重放/并发消费和旧会话撤销。
- Web：36 个测试文件、199 个用例通过；typecheck、生产构建和目标文件 ESLint 通过。
- Browser integration：129 条路径中 65 条通过、64 条按既有环境条件跳过，覆盖桌面、移动和 320px 窄屏；Playwright 预览进程在测试结束后已清理。
- 复评期间发现并修复 SMTP 自定义协议根路径规范化问题；前端 503 夹具改为符合公共 UUID 响应合同，未增加运行时兜底校验。

## 交付结论

L1 密码找回已完成：用户可从登录页进入邮箱找回、通过一次性 30 分钟链接设置新密码，成功后所有旧会话失效；未知邮箱不泄露账号存在性，SMTP 未配置明确返回服务不可用，令牌不会进入响应、日志或浏览器持久化。
