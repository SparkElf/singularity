---
title: "ADR-013: S1受控运维、身份会话与空间发现"
description: "确定奇点S1如何安全建立企业账号与空间事实，并以同源会话驱动React授权路由"
author: "Codex"
date: "2026-07-14"
version: "1.2.0"
status: "accepted"
tags: ["adr", "s1", "identity", "session", "operations", "space"]
---

# ADR-013: S1受控运维、身份会话与空间发现

## Change Log

| Version | Date | Author | Changes |
| --- | --- | --- | --- |
| 1.0.0 | 2026-07-14 | Codex | 固定S1受控运维、身份会话、空间发现与浏览器门禁 |
| 1.1.0 | 2026-07-14 | Codex | 补三态生产写入、代理与Origin、行锁、KDF准入、迁移及非空测试合同 |
| 1.1.1 | 2026-07-14 | Codex | 架构、安全、Schema与测试治理复评通过并接受决策 |
| 1.2.0 | 2026-07-15 | Codex | 按代码复评收紧OpenAPI、撤权锁、登录代次、授权缓存、429冷却与浏览器诊断合同 |

## Status

Accepted

## Context

S0已经建立NestJS/Fastify、Prisma/PostgreSQL、用户、会话、组织、空间、两级成员与Kernel实例模型，但生产系统仍没有创建这些事实的受控入口，也没有登录Cookie、CSRF、空间列表或真实空间路由。React仍固定跳转`/workspace`并显示“默认空间”，无法给后续`ProtyleSession`提供服务器授权的真实`spaceId`。

批准的S1 PRD要求形成多账号、多空间、不同角色与撤权的正式生产路径，同时不提前实现公开注册、邀请或完整成员管理UI。S1还必须证明退出后浏览器历史不恢复敏感界面，并把首个真实browser integration纳入强制门禁。

## Decision

1. `apps/api`保留单副本模块化单体，并拥有HTTP与受控运维两个组合根。运维组合根只从部署主机stdin读取一个结构化操作，不监听端口、不进入OpenAPI、不接受argv或环境变量密码，并复用HTTP侧相同的Identity与SpaceAccess Service。
2. Prisma新增`SystemInstallation`固定单例行。初始化事务第一条插入单例键`1`，数据库以主键和`CHECK (id = 1)`保证最多一行；同一事务创建owner、组织、组织成员、空间、空间管理员与`starting` Kernel实例。普通失败整体回滚，并发败者只返回`already-initialized`。
3. S1创建的Kernel实例固定为`status: starting`且部署句柄、版本为空。数据库条件约束要求`starting`两字段为空，`ready/unavailable`两字段非空；部署主机运维命令`set-kernel-state`是S1与S2共用的唯一状态写入口，S2注册表只消费该事实，不使用测试直写、伪URL、`pending`字符串或缺失关联推断状态。
4. 运行时依赖固定为`@node-rs/argon2@2.0.2`、`@fastify/cookie@11.1.1`、`rate-limiter-flexible@11.2.0`与`zod@3.25.76`。不采用Node内置experimental Argon2，不增加版本探测或fallback。
5. 密码使用Argon2id PHC、64MiB memoryCost、3次timeCost、parallelism 1与32字节输出。未知账号执行dummy verify，停用账号验证真实摘要后统一返回401。全进程只允许2个KDF并发和8个等待项，等待最多5秒，容量不足统一429；登录标识统一`trim -> NFKC -> lowercase`，密码与名称只在低频不可信输入边界验证。
6. 登录前并行消费可信客户端来源与规范化账号摘要两个内存限流键，分别限制30次/15分钟与10次/15分钟。任一超限返回相同`429 + rate-limited`与`Retry-After`。客户端来源只按可选明确代理CIDR解析，未配置时忽略全部转发头；多副本部署前必须切换共享限流存储。
7. 会话Cookie固定为`__Host-singularity_session; Secure; HttpOnly; Path=/; SameSite=Lax`且无`Domain`。token为32字节随机base64url，数据库只保存域分隔SHA-256摘要、30分钟空闲期限、12小时绝对期限及撤销时间。
8. 会话与CSRF使用32字节值、SHA-256/HMAC-SHA-256、版本化域字符串和无padding base64url固定字节合同，数据库只保存域分隔摘要。每个认证请求以单条条件更新同时验证会话和续期，零行返回401；登录签发、用户停用、会话撤销及成员撤权使用固定PostgreSQL行锁顺序。登录响应与`GET /api/v1/auth/csrf`返回同一token，浏览器仅在Zustand内存保存。
9. S1公开HTTP只增加登录、CSRF、退出、当前用户授权空间列表和空间启动五个端点。`packages/contracts`拥有Zod schema、TypeScript类型与OpenAPI schema，空间角色直接消费`authorization`，不复制角色数组或增加`workspaceId`。
10. React路由固定为`/login`、`/spaces`和`/organizations/:organizationId/spaces/:spaceId`。URL拥有当前空间身份，TanStack Query以零陈旧期拥有空间列表与启动响应，Zustand只拥有内存CSRF；路由参数只发起查询，只有响应中的相同`organizationId/spaceId`可以进入可用态。starting仅在可见页面中以2秒间隔最多检查30次。
11. S1使用现有radix-nova、Tailwind CSS 4语义token与奇点设计系统，通过锁定shadcn CLI增加Field/Label、Alert、Badge与Spinner。页面不新增颜色、圆角或平行组件系统，空间搜索复用InputGroup。
12. S1不预建无人消费的`AccessChanged`事件总线。所有撤权写入先集中到Identity/SpaceAccess Service并由真实HTTP证明新事实立即生效；S2在SpaceConnectionRegistry首个消费者落地时，同批加入事务提交后的事件发布和真实WebSocket合同。
13. 运维入口拒绝TTY，只从受保护pipe/文件描述符读取一个16KiB内严格JSON命令；`AccessOperationsService`拥有唯一事务并复用Identity/SpaceAccess事务内方法。stdout只有一个脱敏结果JSON行，stderr与日志不得输出原始输入、异常cause/stack、密码、token、摘要或部署信息。
14. `SINGULARITY_PUBLIC_ORIGIN`是必填无路径HTTPS origin，不能从Host或转发头推导且不启用credentialed CORS；登录与全部已认证非安全HTTP方法校验该Origin，后者同时校验`X-CSRF-Token`。
15. S1迁移只支持无生产写入口的空S0领域表；非空时以固定脱敏错误停止。迁移新增整数SystemInstallation单例，放宽Kernel部署字段并增加三态条件约束，不静默改写未知手工数据。
16. `verify:s0-s3`在S1原子增加API unit、运维/数据库integration、Auth/Space真实HTTP、React component、desktop/mobile/320px browser integration与Web build。browser integration删除`--pass-with-no-tests`并替代静态shell；空E2E脚本、配置和目录同批删除，P5首个真实合同落地时才恢复。
17. 固定HTTP状态只声明该状态真实可能出现的Problem code与status，不复用全局Problem联合。OpenAPI注册`__Host-singularity_session` Cookie security scheme，并逐端点声明必填`Origin`、`X-CSRF-Token`、`Retry-After`和数据库不可用`503`；生成文档由独立HTTP contract case验证。
18. 撤销组织成员已锁定User、Organization和目标OrganizationMembership后，只读取并按`spaceId`稳定顺序锁定该用户实际拥有SpaceMembership的空间，再锁对应成员记录。不得锁组织全部空间；同一OrganizationMembership锁会阻止并发新增目标成员关系越过撤权。
19. Kernel `ready/unavailable`的部署句柄和版本在数据库层同时要求非空且包含非空白字符，不能只依赖运维输入schema。会话派生结果不跨函数返回原始`tokenBytes`，公开contracts不导出仅供Service构造基础结果的同形类型。
20. 登录请求由当前Login页面实例拥有`AbortController`与单调attempt generation。新尝试和卸载取消旧请求，只有仍存活的当前代次可写内存CSRF、清查询缓存或导航；`429`必须消费正整数`Retry-After`并在到期前禁用提交，缺失或非法头属于响应合同错误，不猜测等待时间。
21. TanStack Query仍是授权列表与runtime的唯一缓存，但页面只消费当前重验已成功且不在fetch中的数据。runtime隐藏式404立即隐藏当前空间名、角色和侧栏入口并失效授权列表；单空间自动进入只用于普通`/spaces`访问，显式返回通过Router navigation state展示单条列表。浏览器诊断support以Playwright Request对象记录原始开始、完成/失败、状态与持续时间，不接受业务allowlist；每个spec拥有预期401、网络失败和时限判断。

## Data Flow

```text
protected deployment pipe -> operations composition root -> AccessOperationsService -> Identity/SpaceAccess transaction methods -> PostgreSQL

login -> configured Origin + trusted client source + dual limiter + bounded Argon2id -> locked AuthSession issue -> HttpOnly Cookie + memory CSRF
     -> authorized spaces -> organization/space route key -> authorized runtime response
     -> React workspace state
```

跨边界只传必要ID、名称、角色、Kernel状态与Problem。密码、Cookie、token、摘要、Kernel内部地址、工作空间路径和Prisma模型不进入浏览器、stdout、日志或测试快照。

## Test Matrix

| Stable contract | Minimum layer | Required evidence |
| --- | --- | --- |
| 初始化并发最多一个成功且无半成品 | operations/database integration | 真实PostgreSQL、并发调用、成功重试及空S0迁移门禁 |
| 全部运维操作不经HTTP且不泄露秘密 | operations integration | 非TTY stdin、stdout/stderr/logger、三态生产写入、真实事务与敏感哨兵 |
| 登录防枚举、代理来源、KDF容量、Cookie、时效与CSRF | unit + HTTP contract | 真实Nest/Fastify、PostgreSQL、Argon2、外部Clock及受信代理链 |
| 固定状态OpenAPI与安全headers不漂移 | HTTP contract | 真实Nest生成OpenAPI，逐状态断言唯一Problem code/status、Cookie security、Origin、CSRF、Retry-After与503 |
| 登录/续期与停用撤权并发后无失效事实 | database/HTTP integration | 真实PostgreSQL行锁与受控交错 |
| 撤销组织成员不阻塞无关空间且等待相关空间 | database integration | 真实PostgreSQL外部事务分别持有无关/相关Space锁，断言完成边界与最终撤权 |
| 空间列表与启动响应只含授权事实 | HTTP contract | 真实两级成员、三种Kernel状态、隐藏式404 |
| React深链、登录卸载、缓存重验、状态与切换不接受迟到结果 | component | 真实Router、QueryClient、Zustand与fake timer，HTTP为外部边界；登录代次、429冷却、404隐藏与显式单空间返回独立case |
| 退出后历史不恢复且最窄布局与可访问性成立 | browser integration | Vite、Chromium desktop/mobile/320px，HTTP route替身；原始Request诊断、深色token、键盘顺序、侧栏关闭和40px触控目标 |
| API与Web生产闭包可生成 | build/static | Node 24、锁定依赖、无测试专用生产导入 |

## Alternatives

- **浏览器首次初始化与管理UI**：拒绝。扩大公开攻击面并超出S1批准范围。
- **直接Prisma seed或临时SQL**：拒绝。绕过领域事务、密码处理、最后owner保护和安全日志。
- **测试或人工SQL直接制造Kernel三态**：拒绝。S1会永远缺少状态生产路径，测试也不能证明部署结果。
- **独立运维微服务**：拒绝。新增部署单元、认证面和重复Service，不减少S1复杂度。
- **Node内置Argon2**：拒绝。Node 24.0不存在，24.7后仍为experimental，与现有引擎范围冲突。
- **JWT用户会话**：拒绝。立即撤销、空闲期限和用户停用仍需数据库，反而形成双事实源。
- **反向代理下保持`trustProxy: false`的30次来源桶**：拒绝。代理peer会成为全站共享桶；只允许明确CIDR形成可信转发链。
- **依赖原生线程池限制Argon2资源**：拒绝。64MiB工作项缺少显式并发上限会使内存峰值不可审计。
- **CSRF放localStorage或可读Cookie**：拒绝。扩大XSS持久化面并违反内存令牌合同。
- **S1先发AccessChanged到no-op consumer**：拒绝。没有生产结果，只能形成白盒mock测试与死抽象。
- **保留静态shell与新增browser integration并行**：拒绝。重复相同设计token与页面健康证据，增加runner维护成本。
- **保留空E2E并用`--pass-with-no-tests`返回成功**：拒绝。未实现能力不应拥有绿色永久入口。

## Consequences

- S1具备可部署、可重复审计的账号与空间配置路径，但普通成员管理UI、邀请和自助密码能力仍按L1后续批次交付。
- API单副本继续拥有内存限流；横向扩展前必须把限流和AccessChanged传播一起迁移到共享基础设施。
- Kernel三态由部署主机正式写入，S2直接消费同一部署句柄与状态，不需要伪造、测试直写或第二条注册路径。
- React从S1开始不再拥有`/workspace`或“默认空间”生产路径，后续S3/B4直接复用相同组织/空间路由。
- `verify:s0-s3`开始依赖Playwright Chromium；space-session CI负责安装并统一报告，enterprise-web不再重复运行静态shell。
- OpenAPI、授权缓存和浏览器诊断不再拥有宽泛兼容分支；服务端合同异常以明确错误暴露，客户端不猜测旧授权或限流等待时间。

## References

1. [S1身份与空间启动产品需求](../product/s1-identity-space-startup.md)
2. [企业空间Session组合根与Kernel Gateway启动方案](../architecture/space-session-composition-root.md)
3. [ADR-011：企业空间Session组合根前移](0011-space-session-composition-root.md)
4. [ADR-012：企业Node工具链与集成测试时限基线](0012-enterprise-node-toolchain-baseline.md)
5. [奇点企业知识库完整方案](../../output/md/Singularity_Enterprise_Knowledge_Base_v1.0.0_2026-07-13.md)
