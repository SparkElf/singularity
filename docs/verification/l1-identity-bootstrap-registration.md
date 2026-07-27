---
title: "奇点 L1 身份初始化与注册验证报告"
description: "记录首个管理员初始化、普通注册和思源风格身份页面的集中验证证据"
author: "Codex"
date: "2026-07-24"
version: "1.0.0"
status: "review"
tags: ["verification", "l1", "identity", "registration"]
---

# 奇点 L1 身份初始化与注册验证报告

> 本报告是 L1「身份初始化与注册」大阶段的集中验证结论。普通注册只创建本地用户和会话，不隐式创建组织、空间、成员关系或 Kernel。

## 1. 结论

本报告原有 L1 证据覆盖首装路径和受控注册；本轮产品合同已改为注册始终开放，旧的“开关关闭/开启”证据不再适用，需按新合同重新集中验证。首装路径仍应创建唯一首个管理员、组织、空间、成员关系和 Kernel；普通注册只创建本地用户和会话，后续通过邀请、管理员分配或身份同步加入组织。

产品方案、架构方案、ADR、实现、代码评审和测试治理均已收口；本轮未提交代码，也未回滚工作树中其他任务的修改。

## 2. 固定环境与正式入口

工作区：`/root/projects/singularity`（WSL2 Linux）。固定测试 PostgreSQL 使用项目既有容器 `singularity-postgres-test`，地址 `127.0.0.1:55432`；本轮未创建临时数据库，也未停止用户已有服务。

正式 runner 与命令：

```bash
cd /root/projects/singularity/enterprise
pnpm --filter @singularity/contracts test
pnpm --filter @singularity/api test
pnpm --filter @singularity/web test
pnpm --filter @singularity/web test:browser-integration
pnpm --filter @singularity/contracts typecheck
pnpm --filter @singularity/api typecheck
pnpm --filter @singularity/web typecheck
git -C /root/projects/singularity diff --check
```

## 3. 结果摘要

| 验证模块 | 结果 |
| --- | --- |
| Contracts runner | 34/34 通过 |
| API unit runner | 16 文件、130/130 通过 |
| API integration runner | 20 文件、246/246 通过 |
| Web component runner | 34 文件、190/190 通过 |
| Browser integration / responsive | 129 case：65 通过、64 跳过（desktop、390px、320px） |
| Contracts/API/Web typecheck | 全部通过 |
| `git diff --check` | 通过 |

旧验证记录曾包含登录页读取 `/api/v1/auth/setup` 的请求；本轮已移除该依赖，重新验证前不得沿用旧请求数量或旧注册开关断言。

浏览器证据同时检查了 console、page error、request failure、意外 HTTP 错误、响应式溢出和亮暗色 token；未发现阻断性异常。

## 4. 验收标准矩阵

| 标准 | 结果 | 证据 |
| --- | --- | --- |
| L1-BOOT-01 空安装可查询 setup 状态 | 通过 | API integration 246/246（含 setup HTTP/OpenAPI 合同） |
| L1-BOOT-02 首次提交创建唯一管理员、组织、空间、成员和 Kernel | 通过 | API integration 246/246（含 bootstrap、数据库持久化与并发合同） |
| L1-BOOT-03 重复首装和并发首装至多一个成功 | 通过 | 重复 setup 与并发唯一性 case |
| L1-REG-01 | 注册入口始终可见，且不读取注册权限开关 | 待复验 | Web component/browser contract |
| L1-REG-02 | 注册始终可用且只创建本地用户和会话 | 待复验 | API integration |
| L1-REG-03 注册用户不隐式加入组织或创建空间/Kernel | 通过 | API 持久化结果与身份合同 |
| L1-HTTP-01 Origin、CSRF、Cookie、Problem 和 no-store 语义保持一致 | 通过 | API unit/integration 376/376 |
| L1-WEB-01 setup/register/login 页面沿用思源式密度与主题 token | 通过 | Web 190/190、浏览器三视口 65/65 |
| L1-WEB-02 成功后写入 CSRF、清理 query 并进入 `/spaces` | 通过 | ProvisioningPage component/browser 合同 |
| L1-OBS-01 异常保留原始 name/message/stack 与关联上下文 | 通过 | API/Web 异常路径与 console/network 健康检查 |

## 5. 测试治理与链路审查

- **层级与 runner**：Contracts 使用 Node 标准 runner；API 使用 Vitest HTTP/integration runner；Web 使用 Vitest component 和 Playwright browser-integration。case 可独立过滤，setup/cleanup 使用 runner 配置或 hook。
- **真实边界**：首装和注册由真实 Nest HTTP 应用、固定 PostgreSQL 和公开 Web 入口驱动；仅外部系统边界使用替身，没有把 mock 链当作 API 证据。
- **唯一边界 owner**：配置由应用 configuration owner 解析；Zod pipe 负责请求 schema；`IdentityProvisioningService` 负责首装/注册事务写入；`IdentityService.issueSessionForCreatedUser` 负责会话签发。下游没有从 DOM、全局状态或首个响应推断身份，也没有重复创建组织或空间。
- **声明式能力**：真实模块装配后验证 Controller、pipe、Problem filter、DI 和 HTTP 结果，而不是通过装饰器字符串或私有 metadata 自证。
- **字段与数据流**：`spaceId`、组织关系和本地用户身份各自只有一个权威字段；普通注册不携带或生成组织/空间写入，未引入同义冗余字段、薄 adapter、fallback 或非必要拷贝。
- **中文关键函数备注**：新增/修改的身份初始化、注册、会话和页面提交关键函数均有与实现语义一致的中文作用说明；复杂事务、并发和副作用边界有额外说明。
- **异常可观测性**：显式 catch、HTTP 转换和浏览器异常保留原始异常信息及关联上下文；敏感凭据不会写入日志。
- **浏览器健康**：三视口均无横向溢出、重叠或阻断性 console/network 异常；截图只作为人工视觉证据，最终结论来自交互、布局和健康断言。
- **边界取值**：没有为上游合同已经排除的不可达非法值增加下游拦截、夹具或永久测试。

## 6. 遗留边界

1. 注册始终开放；生产部署只需确保登录限流、密码策略和组织分配流程可用。
2. 注册用户的组织加入仍由后续邀请、管理员分配或身份同步功能负责，本 L1 不把注册与组织创建耦合。
3. 多副本身份一致性、SCIM/SAML/OIDC 等企业身份治理属于后续 L4 范围。

## References

1. [L1 产品方案](../product/l1-identity-bootstrap-registration.md)
2. [L1 架构方案](../architecture/l1-identity-bootstrap-registration.md)
3. [ADR-0036](../adr/0036-l1-identity-bootstrap-registration.md)
4. [L1 实现计划](../../plans/2026-07-24-identity-bootstrap-registration.md)
