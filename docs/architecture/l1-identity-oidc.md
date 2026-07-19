---
title: "L1身份、OIDC与会话失效"
description: "奇点企业版本地身份、OIDC登录、会话撤销与强制下线的实现合同"
author: "Codex"
date: "2026-07-19"
version: "1.2.0"
status: "working"
tags: ["l1", "identity", "oidc", "session", "security"]
---

# L1身份、OIDC与会话失效

> 本文记录奇点 L1 身份纵向切片的实现合同、数据流、边界 owner 和永久证据。

## 变更记录

| 版本 | 日期 | 作者 | 变更 |
| --- | --- | --- | --- |
| 1.2.0 | 2026-07-19 | Codex | 收敛浏览器 CSRF 获取、缓存、并发与会话失效边界的唯一 owner |
| 1.1.0 | 2026-07-19 | Codex | 固定既有 OIDC identity 显式邀请消费、并发唯一性与 React 会话失效清理 owner |
| 1.0.0 | 2026-07-19 | Codex | 建立身份与 OIDC 实现合同 |

## 目录

- [1. 范围与事实源](#1-范围与事实源)
- [2. 数据流与模块边界](#2-数据流与模块边界)
- [3. 本地身份与会话](#3-本地身份与会话)
- [4. OIDC协议](#4-oidc协议)
- [5. 失效传播与敏感信息](#5-失效传播与敏感信息)
- [6. 永久证据与验证状态](#6-永久证据与验证状态)
- [参考](#参考)

## 1. 范围与事实源

本切片拥有本地账号登录、OIDC Provider 管理、授权码登录、会话撤销和强制下线的 API、React 消费者、永久合同与文档。组织、用户组、空间和跨进程通知基础设施由各自 feature owner 拥有；身份模块只调用它们公开的事务合同。

PostgreSQL Prisma 模型是用户、Provider、OIDC identity、授权尝试和 AuthSession 的唯一持久化事实源。浏览器不把密码、Provider secret、OIDC code、PKCE verifier 或会话 token 写入可读持久化和应用缓存；OIDC code 只存在于 IdP 回调 query，服务端消费后立即同源重定向。

## 2. 数据流与模块边界

身份请求沿一条明确链路流动：

```text
浏览器表单或 IdP 回调
  -> Nest HTTP 路由与 ZodValidationPipe
  -> IdentityService / OidcService
  -> Prisma 事务与唯一约束
  -> Cookie、Problem 响应或 AccessChanged 事件
  -> React Query、CSRF store 与登录/管理页面
```

HTTP 访问模式由 `@SameOrigin()`、`@Authenticated()` 和 `@SessionMutation()` 声明；Controller 不自行读取会话或重复解析 body。输入 schema 在 HTTP 参数边界解析一次，Service 只接收规范化值。

外部 OIDC 字节的唯一解析 owner 是 `FetchOidcProviderClient`：discovery/JWKS 的网络或格式故障映射为 `service-unavailable`，IdP 返回的无效 token、nonce 或签名映射为 `unauthenticated`。下游不重复解析同一响应。

## 3. 本地身份与会话

本地登录使用 Argon2 校验、账号/IP 限流和不可枚举的 401。成功响应签发 `__Host-singularity_session` Cookie，并返回一次性 CSRF token；Cookie 固定 `Secure`、`HttpOnly`、`Path=/`、无 `Domain`、`SameSite=Lax` 属性。

浏览器 CSRF 的唯一获取 owner 是认证边界的 `getOrFetchCsrfToken(signal)`：它从内存 store 读取当前 token，首次 cache miss 只创建一个共享 HTTP 请求，各 caller 独立响应自己的取消信号，响应由 `csrfResponseSchema` 解析一次后写回 store。清理会话或写入新登录 token 都推进同一 revision；进行中请求只允许在 revision 仍匹配时写回，因此旧会话的迟到响应会失败且不能恢复已清除的 token。企业 mutation、空间 Session transport、Discovery、退出和邀请消费者只调用该入口，不再自行 fetch、解析或缓存 CSRF。

AuthSession 具有 30 分钟 idle 期限和 12 小时 absolute 期限。`Clock` 是 API 唯一时间端口，登录、续期、撤销、OIDC 授权尝试和 JWT claim 校验使用同一时钟事实，不直接调用 `Date.now()`。

主动退出只撤销当前会话。受控运维可撤销用户全部会话或停用用户；后续 HTTP 认证统一返回 `unauthenticated`，React 清除 QueryClient 与 CSRF 状态并回到登录页。会话 token、摘要和密码不会进入日志。

`SpacesPage`、`SpacePage` 与企业管理壳统一消费 `useLogout`。退出成功或服务端返回 `unauthenticated` 时，该 hook 在替换路由前调用唯一的 `clearClientSession(queryClient)`，同步清除内存 CSRF 和全部 Query 数据；其他错误保留当前状态并显示可重试失败，不把网络故障推断为会话结束。

受保护页面的 HTTP 查询返回 `unauthenticated` 时统一渲染 `SessionRedirect`。该组件是被动会话失效的唯一 React 清理 owner，在替换为登录路由前调用同一 `clearClientSession(queryClient)`；页面、Query hook 和路由不重复清理。邀请接受页不会进入受保护路由边界，因此其当前账号 mutation 只在真实 `unauthenticated` 结果上调用同一清理合同，并保留邀请返回目标；`forbidden`、`conflict` 与网络故障不触发登出。

## 4. OIDC协议

Provider 管理在组织 owner HTTP 路由完成。名称及 `(organizationId, issuer, clientId)` 的数据库唯一冲突统一返回 409，更新和创建保持相同错误合同。Provider secret 只保存引用，不由 API 或浏览器回显 secret 内容。

登录启动生成随机 `state`、`nonce`、PKCE verifier 和浏览器绑定 flow token。数据库只保存 state、nonce 和 flow token 的域隔离摘要，以及短期授权尝试；flow token 通过 `__Host-singularity_oidc_flow` HttpOnly Cookie 绑定浏览器。

回调先在事务中锁定并消费授权尝试，再向 IdP 换取 code。即使 token endpoint 或 JWKS 暂时不可用，已消费的 state 也不能 replay。签名校验支持 RS256/ES256，并检查 issuer、audience、azp、nonce、exp 与 iat。回调 query 允许 IdP 附加标准参数，但只把 `code` 和 `state` 传入领域服务。

邀请 OIDC 首次登录按 `User -> Organization -> OrganizationMembership -> Invitation` 顺序锁定并重新检查组织、用户、邀请和 Provider 状态；创建用户、接受邀请和创建 OIDC identity 在同一事务中完成。已有 identity 且授权尝试未绑定邀请时只完成登录；已有 identity 且授权尝试显式绑定邀请时，必须在同一事务中确认邀请登录标识与 identity 用户一致，再消费邀请并激活或更新组织成员关系。并发回调由同一邀请行锁和终态拥有唯一成功者，其他回调返回稳定 `409 conflict`，不得跳过邀请、创建第二个会话或重复审计。

## 5. 失效传播与敏感信息

身份和组织授权变化在业务事务内发布最小 `AccessChanged` selector。PostgreSQL 提交后 API 连接注册表关闭受影响的 pending/active WebSocket；身份服务不建立第二套通知缓存，也不在 HTTP 路径用通知推断授权。

结构化日志只记录 `requestId`、`authSessionId`、结果和必要的 selector 类型/值。以下内容禁止进入日志、普通 API 响应、React Query 缓存和浏览器持久存储：密码、密码摘要、会话 token、CSRF token、OIDC code、PKCE verifier、nonce、Provider secret、工作区路径和服务凭证。

## 6. 永久证据与验证状态

身份永久证据由已有标准 runner 发现：

| 合同 | 文件 | 层级 |
| --- | --- | --- |
| 本地登录、Cookie、CSRF、限流、期限、撤销 | `enterprise/apps/api/test/identity.http.test.ts` | HTTP contract |
| CSRF 首次请求合并、cache 命中、caller 取消与清理后迟到响应隔离 | `enterprise/apps/web/src/auth/api.test.ts` | Web API client unit |
| OIDC Provider CRUD、PKCE、state/nonce、JWKS、邀请 | `enterprise/apps/api/test/identity.http.test.ts` | HTTP contract |
| 登录页 OIDC provider 加载与启动错误 | `enterprise/apps/web/src/app/App.test.tsx` | React component |
| 主动退出成功或 401 后的 Query/CSRF 清理 | `enterprise/apps/web/src/auth/use-logout.test.tsx` | React hook/component |
| 被动 401 跳转前的 Query/CSRF 清理 | `enterprise/apps/web/src/auth/SessionRedirect.test.tsx` | React component |
| 邀请页本地、当前账号与 OIDC 消费 | `enterprise/apps/web/src/enterprise/InvitationAcceptPage.test.tsx` | React component |
| Provider 更新 schema 错误可见 | `enterprise/apps/web/src/enterprise/OidcPage.test.tsx` | React component |
| 登录失效后的缓存与路由清理 | `enterprise/apps/web/tests/browser-integration/runtime-session.spec.ts` | Browser integration |

本轮 implementation 只完成代码、合同测试和静态语法/差异检查；正式 code-review 及整阶段 verification（数据库、HTTP、React、浏览器和跨进程矩阵）尚未运行，不能据此宣告 L1 验收通过。

## 参考

1. [L1实现重启交接](./l1-implementation-handoff.md)
2. [ADR-013：S1受控运维、身份会话与空间访问](../adr/0013-s1-identity-space-access.md)
3. [ADR-018：PostgreSQL跨进程访问失效通知](../adr/0018-cross-process-access-change.md)
4. [ADR-019：NestJS声明式控制面装配](../adr/0019-declarative-nest-control-plane.md)
5. [S1身份与空间启动产品需求](../product/s1-identity-space-startup.md)
