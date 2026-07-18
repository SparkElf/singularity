---
title: "ADR-019: NestJS声明式控制面装配"
description: "以Nest模块元数据、Guard、Pipe和处理器声明统一控制面认证、校验、依赖注入与运维分派"
author: "Codex"
date: "2026-07-18"
version: "1.0.0"
status: "accepted"
tags: ["adr", "nestjs", "control-plane", "declarative"]
---

# ADR-019: NestJS声明式控制面装配

## Status

Accepted

## Context

L1控制面已经使用Nest Controller和Prisma schema，但会话认证、Origin/CSRF、Zod解析及Service工厂仍散落在多个Controller与`CoreModule`中，受控运维还以中央`switch`分派判别联合。新增企业端点时需要重复安全代码和修改中央分发表，声明事实与执行事实容易漂移。

本仓已锁定Nest 11、`Reflector`、模块DI和Zod，无需网页搜索或新增框架依赖即可使用原生声明式能力。

## Decision

1. Controller、Service、Guard和Pipe分别使用`@Controller`、`@Injectable`及Nest路由/参数装饰器；Prisma schema和迁移仍是持久化结构、枚举、复合外键与约束的唯一声明。
2. 端点访问只通过三个组合装饰器声明：`@SameOrigin()`用于公开同源写入口，`@Authenticated()`用于Cookie会话读取，`@SessionMutation()`用于Cookie、Origin和CSRF联合校验。装饰器只写Nest metadata、Guard和OpenAPI安全输入，不执行I/O或领域分支。
3. `SessionAccessGuard`按端点metadata调用`IdentityService`，并把唯一`AuthenticatedSession`附到当前请求；`@CurrentSession()`只读取该值。401时Guard清除会话Cookie。Controller不再保留认证helper或自行读取CSRF头。
4. HTTP body、path和query继续消费`@singularity/contracts`的同一Zod schema，但统一由`ZodValidationPipe`在参数边界解析；Controller只接收已规范化类型，不再手写`safeParse`分支。
5. 除配置值、异步密码哈希初始化和接口令牌外，Core provider直接由Nest构造器注入。`CLOCK`、OIDC客户端和Secret resolver等接口以`@Inject`声明唯一token；`CoreModule`不重复列构造参数与工厂转发。
6. 每个受控运维处理方法用`@HandlesAccessOperation(name)`声明唯一命令。`AccessOperationsService`在Nest初始化时通过`DiscoveryService.createDecorator`生成的声明、`getProviders`和`getMetadataByDecorator`从已装配provider发现处理方法，并从声明自动派生只读分派索引；不存在人工注册表或中央`switch`。公开`accessOperationNames`仍是输入联合的唯一名称集合。
7. 运维处理器均为`AccessOperationsService`单例方法，无优先级。重复声明、未知名称、缺失任一公开命令或非函数声明均视为配置错误，初始化立即失败；不会选择首个处理器或运行时回退。
8. API声明或DI失败时`app.init()`拒绝，进程不得监听HTTP/WSS。运维组合根声明失败时不读取或执行命令，按既有脱敏`failed`结果退出。数据库URL无效仍只按既有readiness合同启动`503`端点；该行为不是声明发现fallback。
9. 声明正确性由真实Nest初始化、OpenAPI、HTTP合同及运维integration证明。源码扫描、装饰器名称字符串和私有方法白盒断言不能作为运行时证据。

## Discovery Scope

| 声明 | 发现范围 | 冲突规则 | 实例作用域 | 启动失败 |
| --- | --- | --- | --- | --- |
| HTTP访问metadata | Nest路由处理方法 | 每个受保护方法唯一模式 | Guard单例 | Guard或DI无法构造时`app.init()`失败 |
| Zod Pipe | 被装饰的body/path/query参数 | 每个参数一个权威schema | 参数边界实例 | schema依赖无法构造时`app.init()`失败 |
| 运维处理器metadata | Nest `DiscoveryService`已装配provider及其方法声明 | 每个公开命令恰好一个 | Service单例 | 缺失、重复、未知或非函数声明时组合根失败 |
| Prisma模型 | `schema.prisma`与顺序迁移 | 数据库约束唯一 | 数据库级 | 迁移失败，应用不得声称就绪 |

## Alternatives

- **保留Controller认证helper**：拒绝。安全规则重复且OpenAPI与执行逻辑可能漂移。
- **全局默认放行Guard**：拒绝。未声明的新端点会隐式公开；本期使用端点组合装饰器明确安全输入，后续全局默认拒绝须覆盖Kernel与分享公开路径后另行收口。
- **中央`switch`分派运维命令**：拒绝。新增命令必须改中央分发表，不符合声明式扩展。
- **手写provider名称注册表或扫描源码文件**：拒绝。形成第二事实源并依赖构建产物布局。
- **新增`@nestjs/cqrs`**：本期拒绝。当前单命令组合根只需Nest原生metadata发现；新增依赖和CommandBus不会减少领域事务复杂度。

## Consequences

- 安全、校验和OpenAPI输入在端点声明处可见，领域Service继续显式拥有事务和状态转移。
- 运维分派索引是启动时从metadata派生的内部加速结构，不是需要人工维护的注册表；运行期间不扫描源码或文件系统。
- Controller和`CoreModule`显著减少重复wiring；新增控制面能力主要增加自身Controller方法、Service方法和声明。
- 分享、审计、备份与观测Controller必须消费同一Guard/Pipe，不能保留平行认证helper。

## Implementation Checklist

- [x] 落`HttpAccessGuard`、访问组合装饰器、`@CurrentSession()`与`ZodValidationPipe`。
- [x] 迁移Identity、OIDC、Organization、Group、Space及后续L1 Controller。
- [x] 将Core Service改为Nest构造器注入，只保留有真实创建职责的provider factory。
- [x] 以运维处理方法metadata替换中央`switch`，启动时校验完整性与冲突。
- [ ] 完成全部L1生产和测试代码后集中评审、批量验证声明发现与失败语义。

## References

1. [企业空间Session组合根与Kernel Gateway启动方案](../architecture/space-session-composition-root.md)
2. [ADR-013：S1受控运维、身份会话与空间发现](0013-s1-identity-space-access.md)
3. [ADR-018：PostgreSQL跨进程访问失效通知](0018-cross-process-access-change.md)
