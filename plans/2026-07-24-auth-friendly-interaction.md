---
title: "登录与注册友好交互收敛"
description: "在保持思源原生账号表面不变的前提下，补齐奇点身份入口的可理解状态和下一步动作"
author: "Codex"
date: "2026-07-24"
version: "1.0.0"
status: "completed"
tags: ["product-design", "architecture", "identity", "ux"]
---

# 登录与注册友好交互收敛

## 产品合同

### 用户目标

- 用户打开登录页后能明确知道当前操作、可用的登录方式和失败后的下一步。
- 用户注册后知道账号已经创建，但不会自动加入组织或知识空间。
- 首次部署管理员能区分“系统未完成初始化”和“系统已经可以登录”，不会重复提交初始化。

### 交互规则

1. 继续复用思源账号页的表单 DOM/CSS、间距和主题 token；本轮不重做登录皮肤。
2. 登录按钮下方展示可操作的“忘记密码”入口；找回页与登录页保持思源原生表面，真实 API 合同见 [`docs/product/l1-password-reset.md`](../docs/product/l1-password-reset.md)。
3. 没有企业单点登录配置时隐藏整个单点登录区域；已配置时使用用户可理解的“企业单点登录”文案。
4. 单点登录加载失败不阻塞账号密码登录，错误必须给出重试动作。
5. 注册 API 继续保证账号创建与组织归属分离；注册页保持思源原生表面，不增加改变版式的说明段落，输入修改后清除上一轮错误。
6. 初始化页根据真实安装状态展示不同说明，并提供回到登录的明确动作。

### 验收标准

| ID | 可观察结果 | 最低证据 |
| --- | --- | --- |
| UX-AUTH-01 | 登录页保留思源原生表单外观；忘记密码控件可进入真实恢复路径 | component + visual |
| UX-AUTH-02 | 无单点登录配置时不显示单点登录标题、空态或内部 Provider 术语 | component |
| UX-AUTH-03 | 单点登录请求失败时账号密码登录仍可用，并提供明确重试动作 | component + browser integration |
| UX-AUTH-04 | 注册页保持思源原生表单表面；重复账号提示只描述用户可采取的动作，组织归属由 API 合同保证 | component |
| UX-AUTH-05 | 注册错误后修改输入会清除旧错误；成功后仍按既有会话合同进入空间列表 | component + HTTP contract |
| UX-AUTH-06 | `/setup` 对已初始化和未初始化状态给出不同、可执行的说明 | component + HTTP contract |
| UX-AUTH-07 | 亮色、暗色和 320px 视口无横向溢出、重叠或不可读错误 | browser integration + visual |

## 技术方案

### 模块边界

- `LoginPage` 只拥有登录表单、MFA 和单点登录展示状态；不新增跨页面状态或 API 字段。
- `ProvisioningPage` 只拥有注册表单和初始化说明；注册 API 仍由既有 schema 和服务端事务负责。
- 思源 `b3-*` CSS 与现有 shadcn/Tailwind token 继续作为视觉事实源；本轮不新增局部颜色、阴影或布局 token。

### 数据流

`用户输入 -> 既有 schema -> 既有 auth API -> 会话/路由` 保持不变。

单点登录空态只由既有 providers 响应在消费点派生，不把空列表写入全局状态；安装说明只消费 `/api/v1/auth/setup` 的 `initialized` 字段，不把它用于注册权限判断。

### 更简单方案比较

- 密码找回单独使用一次性邮件令牌 API，不把 token 放入登录响应或全局状态；这比恢复死链接或泄露重置凭据更简单且语义完整。
- 不新增全局 UX store；所有状态都由当前页面拥有，跨页面没有共享需求。
- 不新增表单适配层；继续直接使用思源表面和现有请求函数。

### 声明式与边界

- API、schema、React Query 和 NestJS 装配保持既有声明式边界，不增加重复校验或 fallback。
- 用户输入仍由既有 `registerRequestSchema`/`loginRequestSchema` 作为唯一解析 owner；页面只负责呈现错误和清除已过时的展示状态。

## 阶段任务

- [x] 收敛产品交互合同和实现边界。
- [x] 修复登录页辅助入口、单点登录空态和错误文案；密码找回链路见独立 L1 阶段计划。
- [x] 修复注册页上下文、错误清理和初始化状态说明。
- [x] 更新同合同组件测试和浏览器验证入口。
- [x] 完成集中 code-review 后运行类型检查、组件测试、构建和亮暗色/窄屏浏览器验证。

## 集中测试门禁

实现阶段只编写与调整测试，不执行正式验收命令。所有生产代码、测试和文档完成并通过 code-review 后，统一运行：

1. `corepack pnpm@11.9.0 --dir enterprise/apps/web typecheck`
2. `corepack pnpm@11.9.0 --dir enterprise/apps/web test -- src/app/App.test.tsx src/auth/ProvisioningPage.test.tsx`
3. `corepack pnpm@11.9.0 --dir enterprise/apps/web build`
4. `corepack pnpm@11.9.0 --dir enterprise/apps/web test:browser-integration`

API 身份合同使用项目标准 integration config；固定 PostgreSQL 只使用 `singularity-postgres-test`，不创建临时库。

## 验证证据

- 代码评审：已修正测试夹具中的 requestId 为合法 UUID；目标文件 ESLint 与 `git diff --check` 通过。
- 类型与构建：Web typecheck、Web build、API build 通过。
- 组件测试：`ProvisioningPage` 与 `LoginPage` 相关测试共 35 项全部通过。
- 运行时：固定 PostgreSQL `singularity-postgres-test`（`127.0.0.1:55432/singularity_test`）健康检查 200；API `3013`、Web HTTPS `4175`、Go Kernel `6807` 均正常监听；`/api/v1/auth/setup` 返回 `{"initialized":true}`。
- 单点登录空态：`/api/v1/auth/oidc/providers` 返回 `{"providers":[]}`，登录页不渲染企业单点登录区域。
- 浏览器验证：亮色/暗色、桌面 1440px 和窄屏 320px 共 12 个页面组合全部 HTTP 200；无 console error、pageerror、requestfailed；`document.scrollWidth === viewportWidth`。
- 截图：`verification/screenshots/auth-{login,register,setup}-{light,dark}-{desktop,mobile}.png`。
