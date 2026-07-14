---
title: "ADR-011: 企业空间Session组合根前移"
description: "确定生产Protyle迁移前必须先建立真实空间身份、Gateway和唯一浏览器Session组合根"
author: "Codex"
date: "2026-07-14"
version: "1.4.1"
status: "accepted"
tags: ["adr", "space", "session", "gateway", "composition-root"]
---

# ADR-011: 企业空间Session组合根前移

## Change Log

| Version | Date | Author | Changes |
| --- | --- | --- | --- |
| 1.0.0 | 2026-07-14 | Codex | 前移真实企业空间与Session组合根 |
| 1.1.0 | 2026-07-14 | Codex | 闭合服务认证、安全代理、空间资源、撤权链路、S3/B4依赖与测试门禁 |
| 1.2.0 | 2026-07-14 | Codex | 固定两级成员外键、mTLS、主动内容、pending撤权、错误映射和分阶段非空门禁 |
| 1.2.1 | 2026-07-14 | Codex | 架构、安全与测试治理复评通过并接受决策 |
| 1.2.2 | 2026-07-14 | Codex | 固定S0数据库readiness HTTP公开合同 |
| 1.2.3 | 2026-07-14 | Codex | 固定数据库配置脱敏、有限等待与公开枚举单一事实源 |
| 1.3.0 | 2026-07-14 | Codex | 增补S1受控运维、身份与空间发现前置切片，并延后无消费者事件总线 |
| 1.4.0 | 2026-07-14 | Codex | 闭合S1 Kernel三态生产路径、代理安全、撤权并发与非空浏览器门禁 |
| 1.4.1 | 2026-07-14 | Codex | S1增量经架构、安全、Schema与测试治理复评通过并接受 |

## Status

Accepted

## Context

公共`ProtyleSession`要求唯一真实`spaceId`，但当前企业Web只有固定`/workspace`路由，旧思源Web入口也没有组织或空间身份。工作区路径、设备ID、`SIYUAN_APPID`、同步`KernelID`和`cloudName`均属于不同语义，不能近似替代企业空间主键。

原实施顺序先迁移Protyle、后建立NestJS企业控制面和Kernel Gateway，会迫使旧App创建一个无法合法构造的Session。保留可选空间、local Session、占位ID或旧Kernel直连都会形成第二条生产路径，并破坏服务器权威与一空间一Kernel的安全边界。

## Decision

1. 在生产Protyle Core迁移前，先实现NestJS、Prisma和PostgreSQL最小垂直切片：本地账号会话、组织、组织成员、空间、空间成员、Kernel实例和空间启动接口。SpaceMembership以组织、空间、用户复合外键保证两级成员不能跨所有者。
2. React路由参数只作为查询键；只有经过认证、组织成员和空间成员验证的`SpaceRuntimeBootstrap.spaceId`可以创建`ProtyleSession`。
3. React空间路由是唯一浏览器组合根。S3按`Bootstrap -> HostPort/PluginPort/Registry/Transport/ResourcePort/Menu/Overlay -> Runtime -> Session`装配无Core完整会话，B4再在一个原子批把公共Factory、React Host和Core接到该Session，不重建Runtime能力；空间变化时先销毁旧Session。
4. 旧思源Web壳不创建生产企业Session，不增加local Session联合类型，不以任何旧标识近似`spaceId`；它只保留为上游行为参考，真实React链路具备后退出Web生产闭包。
5. Kernel Gateway使用显式`HTTP method + canonical route template`策略分类read、write和admin，并为每项声明请求/响应头允许集与内容模式。动作和头集合不能由方法、名称或Kernel中间件推断，未知组合在读取正文和解析实例前拒绝；公共Transport不暴露任意header字典。
6. Gateway到每个Kernel的HTTPS、WSS握手和`/internal/readyz`统一使用mTLS与最长30秒的Ed25519服务JWT。NestJS拥有Secret客户端证书与JWT私钥，Kernel企业模式持有受信CA、公钥环和预期空间/实例身份；禁止明文、`InsecureSkipVerify`或缺失凭证启动。
7. Kernel实例只保存可信部署句柄，私网客户端禁用重定向与环境代理并按策略重建头。assets、upload和exports使用唯一组织/空间Gateway前缀，Runtime以ResourcePort解析；应用源只内联安全MIME allowlist，HTML/JS/SVG/XML/PDF/未知类型和导出HTML强制下载并使用`nosniff`与sandbox CSP，不保留全局兼容路径。
8. 生产Cookie固定使用`__Host-singularity_session; Secure; HttpOnly; Path=/; SameSite=Lax`且无`Domain`，登录后轮换并具有绝对/空闲期限；所有非安全HTTP方法校验CSRF token与精确Origin，WebSocket升级校验精确Origin。
9. Protyle WebSocket只承载授权后的服务端推送；浏览器发送任意数据帧以4408关闭。单副本Gateway先以pending状态按`authSessionId/userId/organizationId/spaceId`登记，再复验并原子激活；会话到期、用户/组织/空间及两级成员变化均以4401/4403关闭，激活前和关闭后都不得转发推送。
10. Gateway外层用户401、403/隐藏式404、Kernel mTLS/JWT失败、502/503/504、浏览器网络失败和Kernel业务Problem具有固定映射；Kernel服务认证失败只能成为`kernel-unavailable`，不能误映射为用户认证或角色错误。
11. S0合同与数据库、S1身份与空间启动、S2 Gateway、S3无Core浏览器组合根完成后，才能恢复B4 Core迁移。`verify:s0-s3`按阶段原子增加非空suite，最终含production build与`kernel/serviceauth` Go unit；B4是Host/正式PluginPort/Factory/Core唯一生产接线，P3/P4只保留浏览器行为证据，P5完成真实E2E和旧Web文件删除。
12. S0数据库readiness使用未认证的`GET /api/v1/health/database`，真实查询成功返回`200 {"status":"ready"}`，数据库配置、连接或查询不可用返回`503 {"status":"unavailable"}`。配置只接受PostgreSQL协议，错误结果不保留原始URL；单副本连接池上限5，连接建立与池等待上限3秒，客户端查询上限5秒，PostgreSQL语句上限4秒。响应禁止缓存且不暴露连接信息；它不兼作进程liveness或后续Kernel健康聚合。
13. 组织/空间角色以`authorization`的小写合同为唯一事实源，浏览器可见Kernel状态以`contracts`的小写合同为唯一事实源；Prisma标识符和PostgreSQL枚举值保持一致，database package不再公开同名大写枚举。
14. S1以API package内受控运维组合根从部署主机非TTY pipe创建账号、组织、空间、成员及Kernel三态事实；首次初始化使用数据库固定单例行，React从授权空间列表与启动响应建立真实路由。身份使用有界Argon2id、可信来源双键限流、必填公开Origin、HttpOnly Cookie、内存CSRF、条件会话续期和固定行锁顺序，具体合同由ADR-013拥有。
15. S1所有撤权变更集中到Identity/SpaceAccess Service并由真实HTTP读取新事实，不预建无人消费的`AccessChanged` publisher；S2在SpaceConnectionRegistry首个生产消费者落地时同批增加事务提交后事件和WebSocket证据。

## Alternatives

- **用旧工作区路径或随机ID**：拒绝。字段语义错误，无法形成企业隔离与审计。
- **增加local Session模式**：拒绝。用户已锁定云端权威，会永久增加分支和测试矩阵。
- **直接信任路由`spaceId`**：拒绝。路由是非可信输入，不能替代服务端成员授权。
- **只在Service中检查两级成员关系**：拒绝。并发或绕过写入口时不能保证SpaceMembership属于同一组织。
- **私网只使用短期JWT**：拒绝。Bearer token不提供传输机密性或双向证书身份，无法替代mTLS。
- **在应用源内联原始附件和导出**：拒绝。现有Kernel允许主动类型，会形成持久化XSS。
- **完成全部L1后再迁移**：拒绝。分享、审计和备份不是Session身份的前置，最小垂直切片更短。
- **每实例长期API token**：拒绝。现有HTTP可用但WebSocket合同不统一，长期凭证轮换与泄露半径不满足企业私网边界。
- **使用通用`GET /health`聚合所有依赖**：拒绝。S0只有数据库一个真实依赖，提前聚合会混淆进程、数据库与后续Kernel故障来源。
- **配置错误直接终止readiness进程**：拒绝。编排系统无法取得稳定503，且URL解析异常可能把原始连接串带入启动日志。
- **依赖驱动默认无限等待**：拒绝。黑洞连接或池耗尽会让探针堆积，无法可靠驱动流量摘除。

## Consequences

- L0编辑器迁移依赖L1中的最小身份、空间和Gateway骨干，L0/L1不再按编号严格串行。
- 已完成的公共Session、Factory和React Host合同继续有效，但在真实组合根前只构成局部证据。
- 14个浏览器旧壳`new Protyle(...)`调用点不再机械注入伪Session；主编辑器由React替代，嵌入式所有者随功能迁移，旧所有者退出生产闭包。另1个原生移动点保持范围外。
- 后端须新增PostgreSQL集成、真实HTTP和真实WebSocket测试；浏览器静态壳不能冒充空间或Gateway证据。
- 生产系统只有一个活动空间Session、一个同源Gateway路径和一个内容事实源，不保留旧直连或自动fallback。
- 本期API部署限制单副本；横向扩展前必须把进程内撤权事件替换为跨副本消息总线并新增合同测试。
- S1受控运维是正式生产入口但不暴露公网；普通成员管理UI、邀请与自助密码能力仍留在L1后续批次。
- 认证或权限失效会等待Session销毁并清除编辑器DOM；Kernel或网络故障保留当前内容且只允许显式重试。
- 私网需同时运维mTLS证书与JWT密钥，换取传输机密性、服务身份和请求级授权的独立边界。

## References

1. [企业空间Session组合根与Kernel Gateway启动方案](../architecture/space-session-composition-root.md)
2. [奇点企业知识库完整方案](../../output/md/Singularity_Enterprise_Knowledge_Base_v1.0.0_2026-07-13.md)
3. [ADR-003：NestJS企业控制面与Go内容内核](0003-enterprise-control-plane-and-go-kernel.md)
4. [ADR-004：空间级Kernel实例隔离](0004-space-kernel-isolation.md)
5. [ADR-009：Protyle浏览器运行时边界](0009-protyle-browser-runtime-boundary.md)
6. [ADR-010：Protyle宿主动作与合同所有权](0010-protyle-host-actions-and-contract-ownership.md)
7. [S1身份与空间启动产品需求](../product/s1-identity-space-startup.md)
8. [ADR-013：S1受控运维、身份会话与空间发现](0013-s1-identity-space-access.md)
