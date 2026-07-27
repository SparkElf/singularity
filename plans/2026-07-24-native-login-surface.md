---
title: "思源原生登录表面收敛计划"
description: "明确奇点登录页复用思源账号表单但不引入云端区域选择"
author: "Codex"
date: "2026-07-24"
version: "1.0.0"
status: "completed"
tags: ["plan", "l1", "identity", "login", "siyuan-ui"]
---

# 思源原生登录表面收敛计划

> 目标是保持思源账号页的密度、DOM/CSS 和主题表现，同时让登录请求只服务于奇点本地身份。

## 变更依据

- 产品合同：[`docs/product/l1-identity-bootstrap-registration.md`](../docs/product/l1-identity-bootstrap-registration.md)
- 架构决策：[`docs/adr/0036-l1-identity-bootstrap-registration.md`](../docs/adr/0036-l1-identity-bootstrap-registration.md)
- 原生参考：[`app/src/config/tabs/accountUi.ts`](../app/src/config/tabs/accountUi.ts)

## 1. 产品合同

### 1.1 用户故事

登录用户看到思源原生的账号、密码、条款、登录、注册和忘记密码入口；输入提交到奇点本地身份 API，不需要理解或选择云端区域。密码找回使用独立的一次性邮件令牌合同。

### 1.2 交互与状态

- 表单字段只有账号和密码；区域选择、区域状态和区域切换事件不属于奇点登录状态。
- 登录按钮遵循条款勾选、限流和请求中的状态；错误反馈不泄露账号是否存在。
- MFA challenge 继续在同一页面完成，成功后复用普通登录的会话落地。
- 已配置的企业单点登录和邀请路径继续由既有 L1 身份合同负责；未配置单点登录时隐藏空态；注册和忘记密码入口始终可见，不读取或等待安装状态接口。

### 1.3 验收标准

| ID | 可观察结果 | 证据层级 |
| --- | --- | --- |
| LOGIN-SURFACE-01 | 亮色、暗色和窄屏登录页保持思源表单密度，无横向溢出或内容重叠 | component + visual |
| LOGIN-SURFACE-02 | 页面没有云端区域选择，登录请求仅包含账号和密码 | component + HTTP contract |
| LOGIN-SURFACE-03 | 登录、限流、MFA、OIDC 和始终可见的注册入口保持可用 | component + browser integration |
| LOGIN-SURFACE-04 | 页面异常路径保留可检索的原始错误堆栈，用户只看到脱敏后的提示 | component + logging review |

## 2. 架构与数据流

### 2.1 唯一身份链路

`账号/密码输入 -> loginRequestSchema -> POST /api/v1/auth/login -> IdentityService -> AuthSession + CSRF -> /spaces`

区域选择只存在于思源云账号链路；奇点登录的 schema、API、数据库和会话都不消费该字段，因此不在下游增加兼容字段、推断或重复校验。

### 2.2 文件归属

- 页面：`enterprise/apps/web/src/auth/LoginPage.tsx`
- 登录合同测试：`enterprise/apps/web/src/app/App.test.tsx`
- 身份 API：`enterprise/apps/web/src/auth/api.ts`（本轮只读）
- 产品/架构事实源：`docs/product/l1-identity-bootstrap-registration.md`、`docs/adr/0036-l1-identity-bootstrap-registration.md`

### 2.3 大阶段与集中测试门禁

本轮为一个大阶段“登录表面收敛”。实现、测试合同和文档全部完成后统一 code-review；复评通过后集中运行以下矩阵：

1. `pnpm --dir enterprise/apps/web typecheck`
2. `pnpm --dir enterprise/apps/web test -- src/app/App.test.tsx`
3. `pnpm --dir enterprise/apps/web build`
4. 已有浏览器入口的亮色、暗色、320px 视觉与 console/network 健康检查

服务不可用时不启动或重配依赖；浏览器验证记录为环境阻塞，不伪造通过证据。

## 3. 实现清单

- [x] 明确云端区域选择是非目标，并从页面合同中排除。
- [x] 保留思源表单类名和奇点本地登录 API。
- [x] 扩展既有登录路径测试，证明区域字段不出现在表单和请求中。
- [x] 完成整阶段 code-review 和 test-governance 复评。
- [x] 通过集中验证并记录亮暗主题、窄屏、console/network 结果。

## 4. 完成条件

登录页继续使用思源原生表单表面；云端区域不再作为 UI、状态或 API 合同出现；既有 OIDC、MFA、注册和邀请身份路径没有回归；集中验证证据完整且未修改其他未相关工作树改动。

## 验证证据

- `app/src/config/tabs/accountUi.ts` 的原生结构确认：登录按钮后通过 `fn__hr--b` 进入 `ft__center` footer，注册链接位于登录按钮下方；中文原生文案为“用户名/邮箱”和“注册新账号”。
- 当前 `/login` 使用相同表单密度、类名和 footer 位置；忘记密码入口进入独立的邮箱令牌恢复页，不携带云端区域或内部身份状态。
- Web typecheck、35 项组件测试和生产构建通过。
- 亮色/暗色、1440px/320px 共 8 个登录与注册组合均返回 200；注册链接的纵坐标严格大于登录按钮，所有视口 `scrollWidth === viewportWidth`，无 console error、pageerror 或 requestfailed。

## References

1. [思源原生账号表单](../app/src/config/tabs/accountUi.ts)
2. [L1 身份初始化与注册产品合同](../docs/product/l1-identity-bootstrap-registration.md)
3. [ADR-036 首次管理员初始化与受控注册](../docs/adr/0036-l1-identity-bootstrap-registration.md)
