---
title: "企业空间Session组合根与Kernel Gateway启动方案"
description: "定义真实spaceId的权威来源、NestJS启动切片、浏览器Session装配和Protyle迁移前置门禁"
author: "Codex"
date: "2026-07-14"
version: "1.9.5"
status: "approved"
tags: ["architecture", "space", "session", "nestjs", "prisma", "kernel-gateway"]
---

# 企业空间Session组合根与Kernel Gateway启动方案

> 在任何生产Protyle实例创建前建立真实企业身份、空间授权和Kernel路由，禁止用旧思源本地标识近似企业`spaceId`。

## Change Log

| Version | Date | Author | Changes |
| --- | --- | --- | --- |
| 1.0.0 | 2026-07-14 | Codex | 前移企业空间启动切片，固定Session组合根、Gateway路由与恢复后的B4顺序 |
| 1.1.0 | 2026-07-14 | Codex | 闭合服务认证、CSRF、路由策略、资源代理、撤权链路、测试门禁与S3/B4依赖 |
| 1.1.1 | 2026-07-14 | Codex | 明确S3只持有无Core Session，Host、Factory与Core统一留到B4接通 |
| 1.2.0 | 2026-07-14 | Codex | 闭合两级成员外键、撤权竞态、mTLS、主动内容、错误映射、分阶段聚合门禁与并发删除清单 |
| 1.2.1 | 2026-07-14 | Codex | 架构、安全与测试治理复评通过，批准进入S0实现 |
| 1.2.2 | 2026-07-14 | Codex | 补齐S0数据库readiness HTTP路径、响应语义与测试证据 |
| 1.2.3 | 2026-07-14 | Codex | 固定配置脱敏、数据库等待上限与角色/Kernel状态单一事实源 |
| 1.3.0 | 2026-07-14 | Codex | 闭合S1受控运维、身份会话、空间发现、React路由、依赖与浏览器测试门禁 |
| 1.4.0 | 2026-07-14 | Codex | 闭合S1三态生产写入、代理与Origin配置、并发锁、KDF资源、迁移兼容及测试独立性 |
| 1.4.1 | 2026-07-14 | Codex | 架构、安全、Schema与测试治理复评通过，批准进入S1实现 |
| 1.4.2 | 2026-07-14 | Codex | 按配置registry复核依赖元数据，修正限流库许可证为ISC |
| 1.5.0 | 2026-07-15 | Codex | 按实现复评闭合精确OpenAPI、相关行锁、登录代次、授权重验、限流冷却与原始浏览器诊断 |
| 1.5.1 | 2026-07-17 | Codex | 对齐总方案1.4.8，明确S0-S3/B4属于L1而非L0完成前置条件 |
| 1.6.0 | 2026-07-18 | Codex | 修正独立运维进程无法投递进程内撤权事件，改用事务内PostgreSQL通知 |
| 1.7.0 | 2026-07-18 | Codex | 增加Worker恢复端点的持久化事实源、事务通知和API registry hydrate |
| 1.6.1 | 2026-07-18 | Codex | 固定Gateway到Kernel的内容身份头与分层正文上限，防止内容身份在私网边界丢失 |
| 1.7.0 | 2026-07-18 | Codex | 将带CSRF、取消和进度的FormData上传收归Transport，ResourcePort只保留只读URL |
| 1.8.0 | 2026-07-18 | Codex | 固定Nest声明式Guard、Pipe、构造器DI与运维处理器发现，删除中央switch和散落认证wiring |
| 1.9.0 | 2026-07-18 | Codex | 增加声明式空间内容目录，闭合spaceId到notebookId/documentId的唯一选择链 |
| 1.9.1 | 2026-07-18 | Codex | 修正Kernel内部路由身份范围，固定路由与service/content/query身份要求的一体声明 |
| 1.9.2 | 2026-07-18 | Codex | 按ADR-021固定跨链路校验owner，删除浏览器Transport对已收敛内容身份的重复拦截 |
| 1.9.3 | 2026-07-18 | Codex | 以响应级撤权标记区分隐藏式404与Kernel业务404 |
| 1.9.4 | 2026-07-19 | Codex | 对齐服务目录到真实Vite Core的生产接线与尚未执行的P3/P5验证状态 |
| 1.9.5 | 2026-07-19 | Codex | 固定目录选择与唯一SpaceSession的代次能力及render-prop组合合同 |

## Table of Contents

1. [背景与目标](#1-背景与目标)
2. [本地实现审计](#2-本地实现审计)
3. [决策与范围](#3-决策与范围)
4. [模块边界](#4-模块边界)
5. [权威数据与合同](#5-权威数据与合同)
6. [生命周期与数据流](#6-生命周期与数据流)
7. [安全与可观测性](#7-安全与可观测性)
8. [设计评估](#8-设计评估)
9. [测试矩阵](#9-测试矩阵)
10. [实施批次与完成条件](#10-实施批次与完成条件)
11. [架构审查](#11-架构审查)

## 1. 背景与目标

公共`ProtyleSession`要求唯一真实`spaceId`，但当前企业Web只有固定`/workspace`路由，旧思源Web入口也只在模块末尾无参数创建`App`。继续迁移旧Core会迫使实现使用工作区路径、设备ID或随机App ID，这些字段均不具备企业空间语义。

本方案把最小企业空间启动切片前移到Protyle生产迁移之前。目标是让生产数据链固定为`受控运维配置 -> 认证会话 -> 持久化Space -> 授权后的运行时启动响应 -> ProtyleSession -> Runtime -> Core`，并使浏览器永远不知道Kernel内部地址、工作空间路径或服务凭证。S1产品结果以[身份与空间启动产品需求](../product/s1-identity-space-startup.md)为准。

S3实现审计曾确认该链在Runtime与Core之间缺少身份选择：启动响应只含`spaceId`，而Core首次内容请求要求`notebookId + documentId`。当前源码已按[ADR-020](../adr/0020-space-content-directory-bootstrap.md)接通独立空间内容目录，使生产链成为`授权空间 -> 服务目录 -> 完整内容身份 -> Protyle`，且目录不读取正文、不复用或放宽内容Gateway。

本方案不提前实现浏览器成员管理、用户组、分享、审计UI、备份或实时协作。它只前移Protyle生产装配所必需的部署主机受控运维入口、本地账号会话、组织与空间最小模型、空间角色、Kernel实例状态、空间发现和HTTP/WebSocket Gateway。

## 2. 本地实现审计

### 2.1 已有事实

| 证据 | 当前事实 | 架构影响 |
| --- | --- | --- |
| `enterprise/apps/web/src/app/App.tsx` | 仍只有固定`/workspace`和硬编码“默认空间” | S1须一次删除旧路由与文案 |
| `enterprise/packages/protyle-browser/src/session.ts` | 只能消费调用方提供的`spaceId` | 公共包不是身份生产者 |
| `enterprise/apps/api` | S0已有Nest/Fastify应用、请求ID、OpenAPI与数据库readiness | S1在同一模块化单体增加身份与空间模块 |
| `enterprise/packages/database` | S0已有用户、会话、组织、空间、两级成员与Kernel模型 | 缺初始化单例及`starting`实例的合法持久化状态 |
| `enterprise/packages/contracts` | 只有readiness与Kernel状态合同 | 缺Problem、登录、空间列表与启动响应的单一公开合同 |
| `enterprise/apps/web/tests/browser-integration` | 已有两个真实身份/空间browser integration文件，静态shell和空E2E入口已删除 | 复评须修正诊断ownership、同URL并发跟踪及缺失的深色/键盘/触控证据 |
| `enterprise/apps/api/vitest.integration.config.ts` | 只收集`test/**/*.http.test.ts` | S1须显式收集operations，不能把非HTTP合同伪装成HTTP或留成孤儿 |
| S0迁移与数据库case | `KernelInstance`两项部署字段非空，测试允许`starting + 非空部署字段`；所有领域表主键case只接受UUID | S1迁移须以可诊断空表门禁阻止未知手工数据升级，并单独处理整数安装单例 |

思源Kernel的HTTP API大量使用`POST`同时承载读写操作，不能只按HTTP方法判断权限。旧`Model` WebSocket允许浏览器发送任意`cmd`，而当前公共`ProtyleTransport`只需要订阅，因此企业Gateway应把Protyle WebSocket限定为服务端推送，所有内容写入统一走受策略保护的HTTP路径。

本轮优先使用仓库源码、既有ADR、批准PRD、锁文件、项目registry配置及已锁定依赖源码完成审计；仅向配置的npm registry查询拟新增依赖的版本、许可证和公开API，本地证据充分，未做泛化网页搜索。

### 2.2 已确认缺口

- 当前没有受控初始化或访问配置入口，账号、空间和成员关系只能由测试直接写数据库。
- 当前没有认证Cookie、登录限流、CSRF、空间列表或空间启动接口。
- 当前没有将Kernel API路径分类为读取、写入和管理操作的权威策略清单。
- 当前公共包的唯一Core子入口已经接入企业Vite生产图；源码接线或绿色构建仍不能单独证明生产空间隔离，必须等待P3 browser integration与P5真实全链E2E集中验证。
- 当前React空间路由只有`spaceId`，没有合法的笔记本与文档目录来源；不能用DOM、全局状态、首响应或哨兵补齐身份。

## 3. 决策与范围

### 3.1 顺序决策

在恢复Protyle Core迁移前必须完成五项前置能力：

1. 建立NestJS、Fastify、Prisma与PostgreSQL基础工程。
2. 建立真实本地账号会话、组织、空间、空间成员和Kernel实例持久化模型。
3. 建立授权后的空间运行时启动接口及Kernel HTTP/WebSocket Gateway。
4. 建立企业React空间路由和唯一`ProtyleSession`组合根。
5. 建立授权空间内容目录，从真实目录项选择`notebookId + documentId`后再挂载Core。

P1-B4已经完成的公共Session、Factory、Menu、Overlay合同和React Host生命周期继续保留。旧思源Web入口在真实企业链路建立前只作为行为与迁移参考，不创建企业Session、不进入Vite生产闭包，也不获得本地Session变体。

### 3.2 生产入口决策

生产浏览器入口只允许从授权后的`SpaceRuntimeBootstrap`创建Session。路由参数是查询键，不是授权事实；服务端必须以认证会话、组织成员和空间成员记录验证后返回同一个权威`spaceId`。

旧Web壳不做生产过渡入口。React主编辑器通过公共Factory创建，搜索、反链、卡片、历史和浮层在各自迁移批次使用Core内部Factory；原生移动入口保持范围外。旧所有者在对应React能力具备后删除，不保留接收`App`的构造器重载或双运行路径。

### 3.3 S1实现与依赖决策

S1使用API package内两个组合根：HTTP组合根启动Nest/Fastify，受控运维组合根从标准输入读取单个结构化操作并调用同一领域Service，不监听端口。运维入口只随部署主机权限开放，不接受浏览器、远程URL、命令行密码参数或数据库手工脚本；成功结果只输出生成ID与状态，不输出密码、Cookie、token摘要或内部数据库信息。

HTTP组合根新增两个显式部署配置。`SINGULARITY_PUBLIC_ORIGIN`是唯一浏览器Origin事实源，必须是无凭据、查询和片段、pathname恰为`/`的HTTPS origin，校验不得从`Host`、`Forwarded`或请求自身推导；应用保持同源部署且不启用credentialed CORS。`SINGULARITY_TRUSTED_PROXY_CIDRS`可选配置逗号分隔的明确IP/CIDR，缺省为不信任代理，禁止布尔`true`或任意来源；只有socket peer命中该集合时Fastify才从转发链解析客户端地址，部署网络同时只允许这些边缘代理访问API。

依赖先从`enterprise/.npmrc`的`https://registry.npmmirror.com`核对，再固定精确版本：`@node-rs/argon2@2.0.2`承担稳定Argon2id PHC摘要，`@fastify/cookie@11.1.1`承担Cookie解析与序列化，`rate-limiter-flexible@11.2.0`承担单副本内存双键限流，`zod@3.25.76`承担HTTP、运维stdin与浏览器响应信任边界解析。Argon2、Cookie与Zod为MIT，限流库为ISC；`@node-rs/argon2`使用预编译N-API可选包且无`node-gyp`或postinstall。Node 24.18虽已暴露内置Argon2，但该API自24.7才存在、仍标记experimental，而项目引擎允许24.0，故不采用版本探测、抬高patch下限或fallback分支。

`contracts`以运行时依赖消费`authorization.spaceRoles`和Zod，不复制角色数组；其production build关闭源码`paths`并固定在`authorization`之后执行，API再消费已生成的contracts/database产物。Web声明contracts依赖并通过明确的workspace源码条件完成类型检查与Vite打包，`verify:b4`与`verify:s0-s3`均不得依赖另一个并行CI job留下的`dist`。

`@fastify/rate-limit`虽与Fastify一致，但Nest Controller内同时按来源与规范化账号计数需要两个手动limiter并耦合Fastify decorator生命周期；纯内存`rate-limiter-flexible`可在`LoginRateLimiter`内直接组合两个独立键，调用链更短。本期API仍限制单副本；L5横向扩展时一次性替换为共享存储，不同时维护两套限流路径。Argon2另由`PasswordHasher`内的有界执行器限制为全进程最多2个并发KDF和8个等待项，等待超过5秒或队列已满时统一返回`429 + rate-limited`与`Retry-After: 1`；按每项64MiB计算，KDF工作集上限128MiB，API容器内存下限固定为512MiB。

## 4. 模块边界

### 4.1 目标目录

```text
enterprise/
├── apps/
│   ├── api/                    # NestJS + Fastify，同源HTTP与WebSocket
│   └── web/                    # React路由、空间组合根和工作台
├── packages/
│   ├── contracts/              # OpenAPI输入与生成的前端合同
│   ├── database/               # Prisma schema、迁移与数据库客户端
│   ├── authorization/          # 企业角色和Kernel路由策略
│   ├── kernel-client/          # 私网Kernel HTTP/WS协议与错误转换
│   └── protyle-browser/        # Session、Runtime、Factory与浏览器Core入口
```

`apps/api`保持单副本模块化单体，不为启动切片拆微服务。`kernel-client`承担私网协议、短期服务凭证、生命周期、响应清洗和错误语义转换，不暴露到浏览器；`authorization`拥有`HTTP方法 + canonical route template`到授权动作的唯一策略清单，未知组合默认拒绝。内容目录留在现有Kernel Gateway模块内，由一个声明式Controller和一个`@Injectable()` Service复用同一私网客户端与授权Service，不拆出微服务、Repository或目录handler registry。HTTP与独立运维进程在授权事务内发布同一PostgreSQL通知，API以专用`LISTEN`连接驱动连接撤权；HTTP授权仍直接读取数据库，不建立通知缓存。L5横向扩展前必须把该单副本通知链替换为跨副本消息总线，本期不同时维护两套传播路径。

S1在`apps/api/src`内使用三个粗粒度模块：`identity`拥有密码、KDF准入、登录限流、AuthSession、Cookie、Origin与CSRF；`spaces`拥有当前用户空间列表、两级成员授权、Kernel状态登记和启动响应；`operations`是无HTTP组合根。HTTP访问模式由Nest方法metadata、Guard与参数Pipe声明，Core Service由构造器DI装配；Controller不保留平行认证helper或手写Zod分支。目录同样只用原生`@Controller`、`@Get`、Swagger metadata、现有`@Authenticated()`/`@CurrentSession()`、`ZodValidationPipe`和构造器DI；固定三条路由不引入自定义发现层。Controller与Service使用默认singleton，精确路由没有优先级；provider缺失、Fastify路由重复或Kernel策略键冲突使应用启动失败。`AccessOperationsService`是每条运维命令的唯一事务所有者，每个处理方法用命令metadata声明，并由Nest初始化时自动发现；不得保留中央`switch`或人工注册表。它在同一个Prisma交互事务中向`IdentityService`与`SpaceAccessService`的事务内方法传递同一`Prisma.TransactionClient`；领域Service不得开启嵌套事务。Service直接使用Prisma，不增加只做转发的Repository、DTO mapper、Facade或第二套Entity。HTTP与运维输入在边界解析一次，Service只接收规范化命令；数据库模型不流入浏览器。

### 4.2 组合根

React空间路由是浏览器唯一组合根，职责限定为：

- 从路由取得`organizationId`和`spaceId`查询键。
- 通过TanStack Query取得授权后的`SpaceRuntimeBootstrap`。
- 在ready空间内通过TanStack Query读取笔记本、根文档和真实父文档分页目录，只从当前代次的目录项选择完整`notebookId + documentId`。
- 仅在`kernelState: "ready"`时创建生产HostPort、正式零插件PluginPort、Registry、Transport、ResourcePort、Menu与Overlay，并组装完整Runtime和Session。
- S3只创建并持有无Core Session，不调用`ProtyleHost`、公共Factory或Core。
- B4才在同一组合根中把Session、目录选择的唯一`notebookId + documentId`和由角色派生的宿主`readOnly`交给`ProtyleHost`与公共Factory。
- 在路由空间身份变化或组件卸载时按Session合同有序销毁。

Session是带资源生命周期的非序列化对象，由空间路由组件直接拥有并以一个带`ContentSelectionScope`的直接render-prop交给唯一工作台owner，不进入Zustand或全局Context。Scope只属于当前授权空间路由代次，提供`selectDocument`和`clearSelection`能力；旧代次的迟到回调在写入点拒绝。Zustand只保存跨页面且不持久化的当前`spaceId + notebookId + documentId`选择与CSRF token，TanStack Query保存服务端返回的组织、空间、角色、启动状态和目录分页，目录数组、Session和Scope不复制进store。

S1 React路由固定为`/login`、`/spaces`和`/organizations/:organizationId/spaces/:spaceId`。URL是当前空间唯一事实源；S1阶段TanStack Query拥有授权空间摘要与启动响应，Zustand只保存不持久化的CSRF token，S3再按4.2节增加当前三ID选择；退出或401同时清空两者，组织、空间、角色和Kernel状态不复制进store。登录深链以`returnTo`保存同源站内路径，解析后只接受以`/`开头且不以`//`开头的pathname、search与hash组合，拒绝凭据、外部origin和协议相对地址；主动退出不保留`returnTo`。授权空间与启动查询覆盖全局30秒`staleTime`，固定`staleTime: 0`及`refetchOnMount: "always"`，退出或401清空整个QueryClient；独立空间查询按路由键隔离，工作台名称从当前授权空间摘要就近派生，启动响应继续只承载ID、角色与状态。

TanStack Query在后台重验失败后会保留旧`data`，因此页面只消费当前查询已成功且`isFetching`为false的数据；重验中、错误后或路由不匹配时，旧角色、空间名、Badge和ready状态都不参与渲染。runtime隐藏式404是当前空间授权失效的权威证据：页面立即从本轮派生列表隐藏该空间并invalidate授权空间query，等待列表重读，不把404改写成旧缓存可用态。单空间自动进入只发生在普通访问`/spaces`时；工作台显式“返回空间列表”通过Router navigation state保留选择页并显示唯一空间，不建立第二个持久化状态源。

启动响应为`starting`时只在页面可见期间每2秒重新读取，最多30次；页面隐藏、路由离开、得到`ready/unavailable`或网络失败立即停止，达到上限后保留启动中状态并只允许显式重试。TanStack Query的默认自动重试保持关闭，显式重试只重新执行安全GET，不提交写入或切换备用地址。

Login页面实例拥有当前请求的`AbortController`和单调attempt generation。新提交先取消旧请求，卸载时取消当前请求，只有仍挂载且代次匹配的响应可以清QueryClient、写CSRF或导航；取消和迟到响应不转成另一次登录或兼容fallback。`429`响应必须带正整数`Retry-After`，页面以受控倒计时禁用提交直至到期；输入变化不能清除冷却，缺失或非法头作为公开响应合同错误暴露。

设计系统继续以`components.json`的`radix-nova`、Tailwind CSS 4语义token和`src/styles.css`为事实源。S1通过已锁定shadcn CLI新增官方`field`/`label`、`alert`、`badge`和`spinner`源码；`spinner` registry占位图标改为现有`lucide-react`的Loader图标。登录使用`FieldGroup/Field`，状态用`Empty/Alert`，角色用中性`Badge`，加载按钮组合`Spinner`；页面只写布局class，不新增原始颜色、平行圆角、Card嵌套或局部视觉覆盖。空间搜索复用现有`InputGroup`并在授权数组内过滤，不引入Command/cmdk。

## 5. 权威数据与合同

### 5.1 最小持久化模型

| 模型 | 权威字段 | 目的 |
| --- | --- | --- |
| `User` | `id`、登录标识、密码摘要、状态 | 本地账号身份 |
| `SystemInstallation` | 固定单例键、初始化时间 | 首次初始化数据库互斥与持久状态 |
| `AuthSession` | `id`、`userId`、令牌摘要、CSRF摘要、绝对/空闲到期、撤销时间 | 同源Cookie会话 |
| `Organization` | `id`、名称、状态 | 企业成员边界 |
| `OrganizationMembership` | `id`、`organizationId`、`userId`、角色、状态 | 组织授权 |
| `Space` | `id`、`organizationId`、名称、状态 | 企业空间事实源 |
| `SpaceMembership` | `id`、`organizationId`、`spaceId`、`userId`、角色、状态 | 空间读写授权与组织归属约束 |
| `KernelInstance` | `id`、`spaceId`、状态、可空可信部署句柄、可空版本 | 一空间一Kernel启动与路由状态 |
| `KernelRuntimeEndpoint` | `kernelInstanceId`、`spaceId`、`hostname`、`port`、`serverName`、`tlsProfile` | Worker恢复实例的跨进程网络端点；TLS字节不入库 |

`SystemInstallation`固定为`id: Int`与`initializedAt: Timestamptz(3)`，不伪装成领域UUID；其余主键由PostgreSQL生成UUID。初始化在完成输入校验和密码摘要后开启事务，第一条数据库写入固定单例键`1`，迁移以主键和`CHECK (id = 1)`保证全库至多一行；同一事务再创建owner、组织、组织成员、空间、空间管理员与`starting` Kernel实例。普通失败整体回滚并可重试，并发败者在唯一冲突后只重读单例并返回`already-initialized`，不重跑创建逻辑或泄露首租户字段。`User.loginIdentifier`、`AuthSession.tokenDigest`和`KernelInstance.spaceId`唯一；`OrganizationMembership(organizationId, userId)`、`Space(id, organizationId)`与`SpaceMembership(spaceId, userId)`使用复合唯一约束。`SpaceMembership(spaceId, organizationId)`复合外键指向`Space(id, organizationId)`，`SpaceMembership(organizationId, userId)`复合外键指向`OrganizationMembership(organizationId, userId)`，因此空间成员不能绕过所属组织成员关系。`AuthSession.userId`、`OrganizationMembership`两端、`Space.organizationId`和`KernelInstance.spaceId`也使用显式`onDelete: Restrict`外键，不把所有权只留给Service约定；业务实体通过状态停用，不依赖级联硬删除。

`SpaceMembership.organizationId`是为数据库复合参照完整性保留的低频所有权字段，不是`spaceId`或`userId`的同义字段。每条成员记录只增加一个UUID，写入仅发生在成员管理事务；更简单的Service先查后写无法阻止并发或绕过唯一写入口的错误数据，因此不采用。开发种子和测试fixture必须创建真实数据库记录并使用生成的ID；生产源码、路由和快照不得硬编码`default`、`legacy`或固定空间ID。

S1迁移先执行可诊断的空表门禁：若S0七张领域表存在任何行，迁移以固定脱敏错误停止，不猜测手工数据归属、不清空部署字段。该前置条件成立，因为S0只有readiness与测试写入，没有生产数据创建入口；需要保留的手工数据必须先由后续专门迁移方案显式接管。门禁通过后，迁移把`KernelInstance.deploymentHandle/version`改为可空并增加条件约束：`starting`只能使用空句柄与空版本，`ready/unavailable`必须同时具有非空句柄和版本；现有UUID默认值case继续只覆盖七张领域表，并为整数安装单例增加独立约束case。

S1创建空间时原子创建`KernelInstance(status: "starting", deploymentHandle: null, version: null)`，不写`pending`字符串或伪URL。受控运维的`set-kernel-state`是S1和S2共用的唯一部署状态写入口：`starting`清空两项部署字段，`ready/unavailable`必须同时提交受信部署句柄与版本；S2的运行时注册表只消费该事实，不再增加第二个状态写入口。浏览器启动状态始终来自该行，不以缺失关联、路径、本地标识或测试直写推断。

恢复Kernel的网络坐标不塞进`KernelInstance`或`SpaceRuntimeBootstrap`。Worker在恢复状态、`KernelRuntimeEndpoint`行和`singularity_kernel_deployment_changed`通知同一事务提交；API启动先建立LISTEN再读取`ready`行，`KernelRuntimeDeploymentSynchronizer`把持久化端点装入同一个`RuntimeKernelDeploymentRegistry`，事件只承担增量失效。`tlsProfile`是显式配置键，证书和私钥只留在消费进程的Secret边界；API不得从句柄、首个部署或地址推断TLS或空间身份。完整决策见[ADR-022](../adr/0022-cross-process-kernel-endpoint-source.md)。

S0固定提供未认证的`GET /api/v1/health/database`作为数据库readiness合同。数据库package在应用组合时只解析一次配置，只接受`postgres:`和`postgresql:`；缺失、畸形或错误协议收敛为不含原始输入和cause的脱敏配置错误，不阻止readiness HTTP建立。Controller通过同一数据库Runtime的真实Prisma客户端执行轻量查询，不引入第二套连接或健康状态缓存；成功返回`200 {"status":"ready"}`，配置、连接或查询不可用返回`503 {"status":"unavailable"}`。单副本连接池上限为5，连接建立与池等待上限为3秒，客户端查询上限为5秒，PostgreSQL `statement_timeout`为4秒；两种响应均设置`Cache-Control: no-store`，不返回数据库地址、名称、schema、异常文本或凭证。该接口只表达数据库readiness，不与进程liveness、迁移状态或后续Kernel健康复用同一状态字段。

更简单的`GET /health`被拒绝，因为它会把进程、数据库和后续Kernel健康折叠为一个无法定位故障的布尔结果；提前引入完整health聚合器同样被拒绝，因为S0只有一个真实依赖。当前合同保持单一查询、单一状态字段和一个HTTP边界，后续健康项使用各自资源路径，不扩展同一响应对象。

公开角色值由`authorization`拥有，浏览器可见`kernelState`由`contracts`拥有，均固定使用小写字符串；Prisma枚举标识符和PostgreSQL枚举值必须与其一致。数据库package不得再次公开同名大写枚举，持久化往返测试直接消费公开常量，防止`@map`只改存储值而让TypeScript事实源分叉。

### 5.2 S1运维、身份与空间发现合同

受控运维进程只读取非TTY stdin上的一个UTF-8 JSON对象，最多16KiB并以EOF结束；TTY、额外JSON、超限、无效UTF-8和未知字段统一拒绝。部署只允许专用Unix账号或受限容器RBAC通过匿名pipe/继承文件描述符调用，不允许把账号密码放入argv、环境变量、shell命令文本或可读临时文件。stdin解析后立即释放原始缓冲区引用，密码只保留在短生命周期命令对象中。stdout恰好输出一个JSON行且不写日志；stderr只写脱敏稳定诊断，不输出原始输入、异常message/cause/stack、连接串、密码、Cookie、token、摘要、部署句柄或版本。

Zod严格判别联合固定为下表；所有ID为UUID，`set-space-member`从Space读取唯一`organizationId`，不得让调用方重复提交同义所有权字段：

| `operation` | 必要字段 | 原子结果 |
| --- | --- | --- |
| `initialize` | `loginIdentifier`、`password`、`organizationName`、`spaceName` | 建owner、组织、空间、管理员和starting实例；返回三个生成ID |
| `create-user` | `organizationId`、`loginIdentifier`、`password` | 建active用户及固定`organization.member`；返回`userId` |
| `create-space` | `organizationId`、`name`、`adminUserId` | 建active空间、指定active组织成员的`space.admin`和starting实例；返回`spaceId` |
| `set-kernel-state` | `spaceId`、`kernelState`；ready/unavailable另需`deploymentHandle/version` | 原子迁移三态及部署字段；返回updated |
| `set-space-member` | `spaceId`、`userId`、`role` | 创建、重新激活或调整active成员；返回created或updated |
| `revoke-space-member` | `spaceId`、`userId` | 幂等置inactive；返回revoked |
| `disable-organization` | `organizationId` | 幂等置disabled；返回updated |
| `disable-space` | `spaceId` | 幂等置disabled；返回updated |
| `revoke-organization-member` | `organizationId`、`userId` | 幂等置组织成员及其本组织空间成员inactive；返回revoked |
| `disable-user` | `userId` | 幂等置disabled并撤销其全部会话；返回updated |
| `revoke-user-sessions` | `userId` | 幂等撤销全部会话；返回revoked |

`deploymentHandle`固定为1至128位ASCII标识`[A-Za-z0-9][A-Za-z0-9._-]*`，不是URL；`version`为1至64位ASCII版本`[A-Za-z0-9][A-Za-z0-9.+_-]*`。输入schema和PostgreSQL条件约束共同保证`ready/unavailable`两字段非空且非纯空白；`starting`仍要求两字段为null。每个结果含进程生成的`operationId`和唯一`outcome`；成功只取`created|updated|revoked`及上表必要ID，业务拒绝只取`already-initialized|conflict|not-found`，配置、输入、数据库或内部失败只取`failed`且不带原始原因。退出码固定为成功`0`、业务拒绝`2`、失败`1`。owner账号及其活动owner组织成员关系在S1不可停用或撤销；创建空间只保证创建时有管理员，后续空间角色仍由基础设施运维控制，不提前引入最后空间管理员计数协议。

所有冲突写入遵循`User -> Organization -> OrganizationMembership -> Space -> SpaceMembership -> AuthSession -> KernelInstance`的行锁顺序；只锁当前命令实际涉及的行，并以参数化`SELECT ... FOR UPDATE`取得锁。登录在Argon2验证后锁User、重新确认active，再在同一事务撤销请求携带的当前会话并创建新会话；停用用户和撤销其会话先锁同一User。空间成员授予/调整/撤销先锁目标User、Organization、OrganizationMembership与Space。撤销组织成员在锁定目标OrganizationMembership后查询该用户实际拥有成员记录的`spaceId`，按ID稳定顺序锁这些Space及对应SpaceMembership，不锁组织内无关空间；同一OrganizationMembership锁阻止并发授予越过撤权。这样并发登录不能越过停用，并发授予不能落在已撤销的组织成员之后，无关空间事务也不会被扩大锁范围阻塞；真实PostgreSQL交错测试验证最终不变量。

登录标识在HTTP与运维边界统一执行`trim -> NFKC -> toLowerCase`并限制为3至254个字符；组织和空间名称trim后限制为1至120个字符。密码限制为12至128个Unicode字符，不要求脆弱的字符种类组合。上述校验只发生在低频不可信输入边界，业务字段小于4KiB且运维总输入另受16KiB硬上限；它不能替代数据库唯一键、复合外键、单例约束或Service授权。

S1同源HTTP合同固定为：

```text
POST /api/v1/auth/login
GET  /api/v1/auth/csrf
POST /api/v1/auth/logout
GET  /api/v1/spaces
GET  /api/v1/organizations/{organizationId}/spaces/{spaceId}/runtime
```

`POST /auth/login`只接受`loginIdentifier/password`，先拒绝缺失、`null`、数组、多值或与`SINGULARITY_PUBLIC_ORIGIN`不一致的Origin，再进入账号规范化、双键限流与Argon2；成功返回`200 { csrfToken }`并设置生产Cookie。任一账号不存在、密码错误或用户停用都返回同一`401 + unauthenticated`。`GET /auth/csrf`为有效会话重新返回同一派生token，支持刷新与多标签页；`POST /auth/logout`同时要求精确Origin与`X-CSRF-Token`，只撤销当前会话、清Cookie并返回204。无效、到期或撤销Cookie产生401时同时发送同属性过期Cookie。所有身份、空间与Problem响应固定`Cache-Control: no-store`，应用不启用跨源凭据请求。

会话token为32个CSPRNG字节，Cookie值为无padding的43位base64url。数据库`tokenDigest`固定存储`SHA-256(UTF8("singularity.session.v1") || 0x00 || tokenBytes)`的64位小写hex。CSRF字节固定为`HMAC-SHA-256(key=tokenBytes, message=UTF8("singularity.csrf.v1"))`，返回值为无padding的43位base64url；数据库`csrfDigest`固定存储`SHA-256(UTF8("singularity.csrf-digest.v1") || 0x00 || csrfBytes)`的64位小写hex。登录响应与`GET /auth/csrf`可从HttpOnly Cookie原值重算同一token，不保存可还原CSRF值、不因标签页刷新轮换并误伤其他标签页。Cookie格式错误统一401；CSRF header缺失、超长、非base64url或解码后非32字节统一403，均不得抛500。比较固定长度摘要时使用`timingSafeEqual`。登录若携带现有会话Cookie，成功后在User行锁保护的同一事务撤销其命中的当前会话并创建新会话；其他设备会话不受影响。

每个认证请求用一条参数化PostgreSQL条件更新完成会话验证和空闲续期：仅当token摘要命中、`revokedAt`为空、User为active、当前时刻严格早于空闲与绝对期限时，才把`idleExpiresAt`更新为`min(now + 30分钟, absoluteExpiresAt)`并返回`authSessionId/userId`；零行返回统一401。`now`由单一`Clock`端口提供并作为查询参数，避免数据库时钟与测试时钟分叉。退出、撤销全部会话和停用用户按上述锁顺序与该更新线性化，任何提交后的后续请求都不能重新延长失效会话。

密码由`PasswordHasher`使用`@node-rs/argon2`的Argon2id、`memoryCost: 65536`KiB、`timeCost: 3`、`parallelism: 1`与32字节输出生成PHC字符串。未知账号使用相同参数的进程级dummy PHC执行完整verify；停用账号也验证其真实摘要后统一拒绝。双键登录限流先于KDF，有界执行器再按3.3节限制全局并发、队列和等待时间；真实与dummy验证共用同一准入，不依赖N-API或线程池的隐式资源上限。

`LoginRateLimiter`使用两个`rate-limiter-flexible`内存实例并行消费：Fastify按受信代理CIDR解析出的客户端来源30次/15分钟、规范化账号的域分隔SHA-256摘要10次/15分钟。任一超限统一返回`429 + rate-limited`、通用正文与两者剩余时间较大值对应的`Retry-After`；未知与真实账号走同一键生成和响应，成功登录不清空计数。未配置受信代理时所有`X-Forwarded-*`都被忽略；配置后只接受由受信socket peer形成的转发链。L5多副本前再改共享限流存储。

`GET /api/v1/spaces`与runtime查询都显式约束User、Organization、OrganizationMembership、Space和SpaceMembership五层状态为active；只返回当前用户同时具有活动组织成员和活动空间成员关系的活动组织内活动空间：

```typescript
interface AuthorizedSpaceSummary {
  organizationId: string;
  organizationName: string;
  spaceId: string;
  spaceName: string;
  role: "admin" | "editor" | "viewer";
}

interface AuthorizedSpacesResponse {
  spaces: AuthorizedSpaceSummary[];
}
```

结果按规范化组织名、空间名和`spaceId`稳定排序；搜索只在浏览器已取得的授权数组内执行，不增加可枚举的服务端全局搜索。API不返回用户ID、成员记录ID、Kernel实例、内容数量或同义`workspaceId`。

`ApiProblem.code`在既有值上增加`rate-limited`，其唯一状态为429并配`Retry-After`。Zod schema、TypeScript类型、OpenAPI 3.1 schema、API解析与浏览器解析均由`packages/contracts`同一公开常量产生或消费；空间角色继续直接消费`authorization`唯一事实源，不在contracts复制同名数组。OpenAPI固定状态响应使用`code + HTTP status`精确schema，不把七类Problem联合复用到单一401/403/404/429/503；文档注册会话Cookie security scheme，并逐端点声明真实必填Origin、CSRF header、Retry-After和503。

### 5.3 浏览器启动合同

浏览器调用同源接口：

```http
GET /api/v1/organizations/{organizationId}/spaces/{spaceId}/runtime
Cookie: __Host-singularity_session=<opaque-token>
```

成功响应只返回浏览器需要的权威状态：

```typescript
interface SpaceRuntimeBootstrap {
  organizationId: string;
  spaceId: string;
  role: "admin" | "editor" | "viewer";
  kernelState: "starting" | "ready" | "unavailable";
}
```

响应不包含`kernelInstanceId`、Kernel地址、工作空间路径、服务凭证、文档内容或同义`workspaceId`。`viewer`在消费点派生宿主`readOnly: true`，Gateway仍对每次Kernel请求独立授权，浏览器只读状态不构成安全边界。

启动HTTP与Protyle运行时使用两个不同边界。尚未创建Session时，API返回统一Problem：

```typescript
interface ApiProblem {
  code:
    | "unauthenticated"
    | "forbidden"
    | "not-found"
    | "validation-failed"
    | "conflict"
    | "rate-limited"
    | "service-unavailable";
  status: number;
  requestId: string;
}
```

不存在和调用者不可见的组织或空间统一返回`404 + not-found`，避免泄露资源存在性；未登录返回`401 + unauthenticated`，已能看到空间但动作不允许时返回`403 + forbidden`。启动接口与普通业务操作继续使用`ApiProblem`，四类Runtime错误只表达活动Session的认证、授权、内容服务可用性和浏览器网络状态，不吞掉Kernel业务错误。

确定性映射如下：

| 来源 | 浏览器可见HTTP/WS结果 | Transport与Session结果 |
| --- | --- | --- |
| Gateway用户会话失效 | `401 + unauthenticated`或`4401` | `unauthenticated`；停止新命令并销毁当前Session |
| Gateway已知资源的动作拒绝 | `403 + forbidden`或`4403` | `forbidden`；停止新命令并销毁当前Session |
| 组织或空间变为不可见 | `404 + not-found`；Gateway授权边界附`X-Singularity-Runtime-Access-Lost: true` | 启动前不创建Session；活动Session中的后续请求映射为`forbidden`并销毁 |
| Kernel mTLS或服务JWT失败 | Gateway吞掉上游401/403，返回`502 + service-unavailable` | `kernel-unavailable`；不误改用户认证或角色 |
| Kernel实例未就绪、连接失败或超时 | `502/503/504 + service-unavailable` | `kernel-unavailable`；保留已渲染内容并允许显式重试 |
| 浏览器无HTTP响应、DNS或连接失败 | 无可信Problem | `network-failure`；保留已渲染内容并允许显式重试 |
| Kernel业务校验、内容不存在或冲突 | 对应`400/404/409/422 ApiProblem` | 作为当前操作失败返回，不转换为四类Runtime错误，不销毁Session |

`4408 + client-messages-forbidden`表示浏览器代码违反只接收推送的协议不变量，Transport按不可重试的`forbidden`终止连接并记录诊断。隐藏式404与Kernel业务404具有相同公开Problem形状，单靠状态和正文无法判别；产生撤权事实的Gateway授权边界因此独占写入`X-Singularity-Runtime-Access-Lost: true`，受信Kernel业务响应不得携带或伪造该头。Transport只消费该标记，不从路由、当前DOM、已有内容或状态码推断。该头不进入Problem payload，不增加同义`retryable`或通用`source`字段，也不缓存授权状态。

### 5.4 空间内容目录合同

浏览器只访问三个同源安全GET：

```text
/api/v1/organizations/{organizationId}/spaces/{spaceId}/content-directory/notebooks
/api/v1/organizations/{organizationId}/spaces/{spaceId}/content-directory/notebooks/{notebookId}/documents?offset=N
/api/v1/organizations/{organizationId}/spaces/{spaceId}/content-directory/notebooks/{notebookId}/documents/{documentId}/children?offset=N
```

第一条返回按Kernel权威顺序排列的`{ notebookId, name, icon, locked }`。后两条每页固定最多128项，返回`{ locked, documents, nextOffset }`；每个文档项为`{ notebookId, documentId, title, icon, hasChildren }`。`nextOffset`只取下一页非负整数或`null`，请求缺省offset为0。根层由第二条路由表达，第三条只接受真实父文档ID；不传空ID、路径、正文、摘要、内部地址、文档数量或同义身份字段。锁定加密笔记本返回`locked: true`和空documents，普通空目录返回`locked: false`和空documents，两者不可混淆。

目录Controller先通过现有HTTP Guard取得当前AuthSession，再由`KernelAccessService`以`action: read`复验User、Organization、OrganizationMembership、Space及直接/用户组空间角色和ready Kernel部署。目录Service经`KernelPrivateClient`调用`/internal/enterprise/directory/notebooks`或`/internal/enterprise/directory/documents`；这两项在唯一`kernelRoutePolicies`中声明`identity: service`且仍使用mTLS、服务JWT、禁代理/重定向和响应头允许集。Go Kernel由同一声明同时注册Gin路由和身份要求：readyz、directory、backup与observation使用服务身份，share路由继续要求内容身份，未知路由默认要求内容身份；目录不会出现在浏览器Gateway策略中。

Kernel只复用现有笔记本排序与一层文档排序，在模型边界把路径记录投影为最小项。父文档必须在声明的内容库中解析为root且属于同一笔记本；普通库使用全局内容store，加密库使用该笔记本store，禁止全局扫描猜所属库。加密目录响应持有对应响应读门直到JSON写完；锁定竞态不输出旧标题。Nest对Kernel JSON设置1 MiB上限并用contracts Zod schema解析，浏览器再解析公共响应；校验位于低频网络边界且每页有界，不进入编辑热路径。

目录Query key完整包含组织、空间、笔记本、根/父文档和offset，AbortSignal贯穿请求。首次没有有效选择时按笔记本和文档权威顺序选择首个完整目录项；选择必须经当前`ContentSelectionScope`提交。切空间、认证/授权失效、锁态变化或generation变化立即使旧页和选择失去提交资格，迟到的同空间旧代也不能写入当前选择。初次失败不创建Protyle，展开失败保留既有节点并显示未完成，不把错误当空数组或切换备用文档。

### 5.5 Kernel Gateway合同

浏览器只访问以下同源前缀：

```text
/api/v1/organizations/{organizationId}/spaces/{spaceId}/kernel/api/*
/api/v1/organizations/{organizationId}/spaces/{spaceId}/kernel/ws
/api/v1/organizations/{organizationId}/spaces/{spaceId}/assets/*
/api/v1/organizations/{organizationId}/spaces/{spaceId}/upload
/api/v1/organizations/{organizationId}/spaces/{spaceId}/exports/*
```

Gateway按固定顺序执行认证会话、CSRF/Origin、组织成员、空间成员、Kernel路由策略和实例解析。数据库只保存可信部署句柄及独立的动态端点坐标，不保存任意URL、证书内容或工作区路径；句柄与端点必须由同一受信运行时注册表解析为固定`https/wss`协议、服务证书身份和端口。浏览器提交的URL、Host、工作区路径、代理地址和实例ID一律不参与路由。

`KernelRoutePolicy`以`HTTP method + canonical route template`为键，动作只取`read`、`write`或`admin`，同一条策略同时声明请求头允许集、响应头允许集和内容模式。`viewer`只允许`read`，`editor`允许`read/write`，`admin`允许三类动作。动作和头集合必须显式填写，不能由HTTP方法、函数名、Kernel中间件或请求正文猜测；未知组合在读取正文和解析实例前拒绝并记录稳定诊断。B4迁移每个Core请求时同步登记策略，并由AST门禁证明请求闭包不存在未分类组合。

路由匹配前拒绝绝对URL、协议相对URL、反斜杠、点段、重复分隔符和编码后的路径分隔符。私网客户端禁用重定向和环境代理，只连接注册表给出的mTLS身份。Gateway从策略允许集重新构造请求与响应头，不透传任意浏览器头；无论策略如何都丢弃客户端服务令牌、`Host`、`Cookie`、`Authorization`、`X-Auth-Token`、`Connection`及其命名头、`Forwarded`、`X-Forwarded-*`、`Proxy-*`、`TE`、`Trailer`、`Transfer-Encoding`和`Upgrade`，并丢弃上游`Set-Cookie`及未转换的内部`Location`。导出等响应若包含Kernel本机URL，必须转换为同空间`exports`地址或拒绝返回。

浏览器内容请求必须在读取正文前提供唯一`X-Singularity-Notebook-Id`和`X-Singularity-Document-Id`，Gateway按思源内容ID合同解析后只把结构化身份交给私网客户端。私网客户端始终丢弃浏览器同名头，再以受信结构化身份重建两个头；Go Kernel企业服务认证只允许显式声明为`service`的readyz、directory、backup和observation省略内容身份，share与普通HTTP内容请求要求两个头各出现一次并写入请求上下文，`/ws`使用独立`query`声明并校验查询身份。WebSocket只从已校验的`notebookId + documentId + type=protyle`查询参数建立推送身份，不增加第二套字段或从正文、首个响应、DOM和全局状态推断。

Fastify正文解析按已准入路由分层设限：控制面与未知路由最多`16 KiB`，Kernel JSON最多`16 MiB`，上传最多`64 MiB`。准入仍在正文读取前完成；`preParsing`对有`Content-Length`和分块传输使用同一累计字节上限，不能通过扩大Fastify全局限制放宽登录、成员、分享或运维HTTP输入。

B4同步从公共`ProtyleRequestOptions`删除任意`headers`字典，改为按请求类型表达`signal`、响应模式和必要的Range等结构化选项。ResourcePort负责资源Range与条件请求，普通Protyle调用方不能自行制造身份头、代理头或服务头。

Protyle WebSocket只允许完成订阅握手并接收Kernel推送，不向公共订阅合同增加`send`。内容事务、上传和元数据修改全部走HTTP策略；插件需要的独立双向通道必须以后续显式合同和权限审查进入，不复用Protyle订阅。

### 5.6 Kernel私网传输与服务认证

Gateway与Kernel之间同时使用mTLS和短期Ed25519 JWT，不复用浏览器Cookie、用户API token、空锁屏密码或命令行明文。mTLS证明受信服务与传输机密性，JWT证明本次请求的空间、实例和时效；任一失败都拒绝请求。`KernelCredentialService`由NestJS Kernel Gateway模块拥有，JWT私钥、客户端证书和私钥只从Secret文件或文件描述符读取；PostgreSQL不保存私钥、完整token或可还原凭证。

Gateway为每次HTTP请求、WebSocket上游握手和`/internal/readyz`检查签发最长30秒的JWT，通过`X-Singularity-Service-Token`发送。claims固定包含`iss: "singularity-api"`、`aud: kernelInstanceId`、`spaceId`、`jti: requestId`、`iat`和`exp`。Kernel企业模式从Secret文件读取公钥环及预期`kernelInstanceId/spaceId`，校验签名、`kid`、issuer、audience、空间和时效后才授予内部管理员上下文；缺少企业凭证或预期身份时拒绝启动。

Kernel仅监听HTTPS/WSS企业端口并要求Gateway客户端证书；Gateway使用部署注册表给出的受信CA与精确DNS SAN验证Kernel证书，禁止明文HTTP/WS、自签名绕过和`InsecureSkipVerify`。JWT密钥轮换采用单一公钥环：先向Kernel发布新公钥，再让Gateway使用新`kid`，等待最大token寿命后删除旧公钥。mTLS证书与CA轮换由部署层采用重叠信任窗完成，旧证书退出后从Secret移除。WebSocket只在上游握手时验证短期token，外层用户授权仍由Gateway连接注册表持续控制。网络策略只允许Gateway访问Kernel服务，`/internal/readyz`也要求相同mTLS和JWT，并只在`util.IsBooted()`通过后返回ready状态；监听端口但仍在启动中的Kernel统一返回503。

### 5.7 空间资源与上传

Runtime新增有真实协议职责的`ProtyleResourcePort`，把文档中的相对`assets/...`、自定义Emoji、上传FormData和导出下载转换为当前组织/空间的Gateway地址。它不保存资源列表，也不接受任意基址：

```typescript
interface ProtyleResourcePort {
  resolveAsset(identity: ProtyleContentIdentity, path: string): string;
  resolveEmoji(identity: ProtyleContentIdentity, path: string): string;
  resolveExport(identity: ProtyleContentIdentity, path: string): string;
}
```

上传不通过ResourcePort返回裸URL。`ProtyleTransport.upload(FormData, ProtyleUploadOptions)`绑定当前空间与内容身份，使用与JSON请求相同的内存CSRF、终止状态和错误分类，并以XHR只承担浏览器上传进度与取消这一真实协议差异；调用方不能传URL、header、Cookie或CSRF。FormData中的File/Blob和插件额外字段按引用原样交给浏览器，不做文件复制、字段白名单或同形转换，Gateway与Kernel在信任边界校验显式notebook/document身份。

版本化Lute、图表、数学公式和Web Component脚本由构建期只读资源清单拥有，不挂到Session。在线附件、上传和导出属于空间Runtime，禁止保留全局`/assets`、`/upload`、`/export`兼容入口。资源Gateway与Kernel API使用同一认证、空间授权、实例解析、mTLS、服务JWT和响应清洗边界。

应用源只允许经明确MIME allowlist判定的惰性内容内联，例如受信Content-Type的PNG、JPEG、GIF、WebP、AVIF、音频和视频；所有响应固定`X-Content-Type-Options: nosniff`并由Gateway重写Content-Type。HTML、JavaScript、SVG、XML、PDF、未知类型和导出HTML一律使用安全文件名及`Content-Disposition: attachment`，同时发送`Content-Security-Policy: sandbox; default-src 'none'; base-uri 'none'; form-action 'none'`，不得在应用源通过`iframe`、`object`或新窗口执行。PDF预览只能由PDF.js读取已授权字节并绘制到canvas；SVG清洗能力未单独批准前只允许下载。

上传接口可以保存主动内容，但返回值只包含资源路径与元数据，不返回Kernel内部URL或可执行预览HTML。后续若需要原样内联SVG、PDF或HTML，必须采用不携带应用Cookie的独立内容源和独立ADR，不能放宽当前应用源策略或增加兼容分支。

## 6. 生命周期与数据流

### 6.1 启动数据流

```text
部署主机stdin
  -> S1运维组合根
  -> SystemInstallation + User/Organization/Space/Membership
  -> starting KernelInstance

同源登录
  -> Argon2id + 双键限流
  -> AuthSession + HttpOnly Cookie + 内存CSRF
  -> 授权空间列表
  -> 组织/空间URL查询键
  -> NestJS AuthSession
  -> OrganizationMembership + SpaceMembership
  -> Space + KernelInstance
  -> SpaceRuntimeBootstrap
  -> React空间路由组合根
  -> ProtyleSession
  -> 授权空间内容目录
  -> 当前notebookId + documentId选择
  -> ProtyleRuntime
  -> Protyle Core
```

每个事实只有一个所有者。SystemInstallation只表达初始化是否完成，PostgreSQL拥有账号、会话、空间和角色，路由参数只定位查询，TanStack Query拥有浏览器服务端目录视图，Zustand只拥有内存CSRF和当前三ID选择，ContentSelectionScope拥有该选择的可提交代次，Kernel实例注册表拥有内部路由，Session拥有浏览器运行时资源，Kernel拥有内容。

### 6.2 状态与失效

- Gateway维护进程内`SpaceConnectionRegistry`，按`authSessionId`、`userId`、`organizationId`和`spaceId`四个索引登记浏览器WebSocket；连接状态只取`pending`、`active`或`closed`，Registry不保存正文或消息副本。本期部署合同明确限制单个API副本，L5横向扩展前必须以消息总线替换单监听者通知链并通过跨副本合同测试。
- WebSocket升级先验证Cookie与Origin，再把连接登记为`pending`，随后重新读取AuthSession、User、Organization、OrganizationMembership、Space和SpaceMembership的最新授权事实。Registry只在复验通过且连接未被同期`AccessChanged`标记后原子激活；激活前不得连接上游Kernel或转发任何推送。该顺序关闭“授权后撤权、注册前漏事件”的窗口。
- S1的运维写入口必须通过`IdentityService`与`SpaceAccessService`执行，会话撤销/到期、用户禁用、组织/空间停用及两级成员变化在业务事务内调用`pg_notify`，由PostgreSQL提交后投递。API专用`LISTEN`连接把事件交给首个生产消费者`SpaceConnectionRegistry`；后续HTTP查询仍只读取新事实，不保留进程内授权缓存。监听异常时关闭全部连接并拒绝新升级，不在可能漏事件的窗口内继续服务或静默重连。
- S1每个认证HTTP请求按5.2节条件更新空闲期限；S2起，会话自然到期由Registry按绝对/空闲期限定时关闭，条件更新成功后AuthSessionService发布同一会话的到期更新时间，Registry只重排该计时器。
- 连接注册表收到会话到期/撤销或用户失效时以`4401 + unauthenticated`关闭，收到组织/空间停用、组织成员或空间成员撤销及角色变化时以`4403 + forbidden`关闭。事件同时覆盖`pending`和`active`连接，关闭后上游订阅先终止，任何排队推送都不得再进入浏览器。
- 浏览器Transport把4401/4403及活动Session中的401/403/隐藏式404转换为对应Runtime错误并通知空间路由。角色降级后只有新的授权响应可以创建`viewer` Session，成员撤销或不可见空间得到`404 not-found`且不创建后继Session。
- Gateway收到任意浏览器WebSocket数据帧时以`4408 + client-messages-forbidden`关闭；只有Gateway生成固定上游订阅握手，Kernel的任意命令处理器不暴露给浏览器。
- `kernelState`不是Session内部可写状态；只有启动响应为`ready`时创建Session。
- 切空间先销毁旧Session，再请求并创建新空间Session，不同时持有两个活动空间Runtime。
- Kernel不可用只阻断提交并允许用户显式重新查询启动状态，不切换备用地址、不自动重复写入。
- 目录请求按空间Scope generation、目录请求generation和完整Query key隔离；切空间、401、隐藏式404或锁态变化清除当前选择并取消旧页，迟到结果不能恢复旧树或创建Core。503和网络失败不伪装为空目录，已打开内容按既有Kernel故障规则保留。

撤权或认证失效后的浏览器状态机固定为：递增路由代次并停止新命令；立即收紧宿主只读与提交状态；等待当前`Session.dispose()`完成；卸载并清除编辑器DOM且不复制正文快照；再失效认证或Bootstrap查询。只有与当前路由代次一致的新授权响应才能创建后继Session。已渲染内容只保留到有序销毁完成，认证或权限失效后不留下惰性内容副本；Kernel不可用和网络失败不销毁Session，继续保留当前内容并等待用户显式重试。

唯一撤权数据流如下：

```text
Auth/Authorization mutation commit
  -> AccessChanged
  -> pending/active SpaceConnectionRegistry close
  -> Transport runtime-error
  -> route generation increment + command freeze
  -> await route-owned Session dispose + clear editor DOM
  -> TanStack Query invalidation
  -> authorized bootstrap before any replacement Session
```

## 7. 安全与可观测性

### 7.1 安全边界

- 生产会话Cookie固定为`__Host-singularity_session`，属性为`Secure; HttpOnly; Path=/; SameSite=Lax`且禁止`Domain`。登录成功时只轮换当前浏览器已有会话的不透明令牌；其他设备会话不因普通登录或角色变化撤销。数据库只保存令牌/CSRF摘要、30分钟空闲到期和12小时绝对到期，时钟由认证服务统一消费。
- `GET /api/v1/auth/csrf`返回由当前Cookie原值按5.2节确定性派生并绑定AuthSession的CSRF token，浏览器只保存在Zustand内存且不持久化。登录要求匹配必填公开HTTPS Origin；全部已认证非安全HTTP方法同时校验`X-CSRF-Token`和该Origin。应用不从Host或转发头推导Origin、不启用credentialed CORS；WebSocket升级校验同一Origin和会话Cookie，不接受查询参数凭证。
- 本地密码使用固定参数Argon2id PHC摘要，未知账号执行dummy verify，登录错误不区分账号不存在、密码错误与用户停用；来源/账号双键限流与全局KDF准入先于摘要验证并统一429语义，最多消耗128MiB KDF工作集。会话撤销和用户禁用按6.2节关闭现有连接。
- 受控运维入口不监听端口、不出现在OpenAPI，拒绝TTY并只接受受保护pipe/文件描述符；argv、环境变量、shell历史、可读临时文件、stderr、日志、fixture快照和stdout禁止承载密码或token，部署信息只允许进入对应数据库字段。
- 所有组织与空间查询同时约束active User、Organization、OrganizationMembership、Space和SpaceMembership，不接受客户端声明的角色。
- Gateway未知Kernel路径默认拒绝，内部地址与服务凭证不进入OpenAPI或浏览器日志；请求和响应只使用策略头白名单。
- WebSocket激活前完成pending登记与最终授权复验，连接期间会话到期、用户禁用、组织/空间停用或两级成员变化时主动关闭。
- Gateway到Kernel强制mTLS与短期服务JWT，主动内容按5.7节强制下载或安全渲染；应用源不执行上传或导出的HTML、JavaScript、SVG、XML和PDF。
- 内容目录只公开最小选择字段；锁定库不返回文档标识、标题、层级和数量，任何目录项都不包含服务器路径或正文。
- 浏览器不得直连Kernel，不提供备用内网地址、旧`/api/*`直连或旧`/ws` fallback。

### 7.1.1 校验所有权与下游合同

边界判断必须沿完整链路进行。输入schema、类型、DI或数据库约束已经收敛的值，后续层只消费其合同，不再重复做同义解析或拦截；只有跨越新的HTTP、跨进程、外部字节、持久化或安全生命周期边界时，才重新验证该边界自己的合同。具体owner与下游假设由[ADR-021](../adr/0021-trust-boundary-validation-ownership.md)固定。

| 数据流 | 唯一校验owner | 下游只消费 |
| --- | --- | --- |
| 目录HTTP路径、查询和响应 | `ZodValidationPipe`、`ContentDirectoryService`与Web `requestJson`，分别对应各自网络边界 | 规范化路径参数、Kernel目录合同和公开目录项 |
| 目录项到ProtyleTransport | 当前`ContentSelectionScope`与Factory绑定完整三ID | Transport只序列化请求，不重新拦截内容身份；旧Scope提交在组合根拒绝 |
| 浏览器Gateway到Kernel | `KernelGatewayAdmission`、`KernelPrivateClient`和Go `serviceauth.Middleware`，分别对应三段传输 | 结构化身份、受策略重建的请求头和请求上下文 |
| 内容库所有权与生命周期 | Kernel model及加密响应读门 | 已解析的库、root和父文档归属，不重新解析HTTP格式 |

状态机检查（例如代次、撤权、锁态和分页前进）属于状态合同，不等同于输入格式校验；它们只在发生状态转移的owner处执行，消费者不复制同义守卫。

### 7.2 稳定诊断

| 标签 | Owner与logger | 级别 | 触发条件 | 允许字段 | 禁止字段 |
| --- | --- | --- | --- | --- | --- |
| `auth.session` | NestJS `AuthSessionService` / `Logger` | 成功`info`，拒绝/到期`warn` | 登录、轮换、撤销、失效 | `userId`、`authSessionId`、结果、`requestId` | Cookie、令牌、密码摘要 |
| `auth.rate-limit` | NestJS `LoginRateLimiter` / `Logger` | 超限`warn` | 来源键或账号键超限 | 哈希键类别、`Retry-After`、`requestId` | 原始账号、密码、Cookie、原始IP |
| `access.operation` | 运维`AccessOperationsService` / `Logger` | 成功`info`，拒绝`warn`，配置/数据库失败`error` | 初始化与访问配置 | `operationId`、动作、目标ID、结果 | 密码、token、摘要、stdin原文、部署句柄、版本、异常cause/stack |
| `space.runtime` | NestJS `SpaceRuntimeService` / `Logger` | 成功`info`，不可用`warn` | 启动查询与状态变化 | `organizationId`、`spaceId`、状态、`requestId`、耗时 | 内部地址、正文 |
| `content.directory` | NestJS `ContentDirectoryService`与Web目录owner / `Logger` | 成功`info`，拒绝/迟到`warn` | 笔记本读取、分层分页、选择与换代 | `organizationId`、`spaceId`、可选`notebookId`/`parentDocumentId`、`offset`、generation、结果、`requestId`、耗时 | 名称、标题、路径、正文、页内容、凭证 |
| `authorization.decision` | `AuthorizationService` / `Logger` | 允许`debug`，拒绝`warn` | 空间与Kernel动作判断 | `userId`、`organizationId`、`spaceId`、动作、结果、`requestId` | 请求正文、凭证 |
| `kernel.route` | NestJS `KernelGateway`与Go `logging` | 成功`info`，策略/上游失败`warn`，mTLS/JWT失败`error` | HTTP/WS转发与失败 | `spaceId`、`kernelInstanceId`、canonical路由、状态、耗时、`requestId` | payload、工作区路径、证书私钥 |
| `protyle.lifecycle` | Web空间组合根诊断端口 | 创建/销毁`info`，迟到结果`warn` | Session创建、切换、销毁 | `spaceId`、`documentId`、阶段、结果、`requestId` | 正文、选区、插件私有数据 |

NestJS边缘为每个HTTP请求或WebSocket升级生成不可由浏览器覆盖的`requestId`。Gateway用同一个值写入`ApiProblem.requestId`、响应`X-Request-Id`、服务JWT `jti`和受信上游`X-Singularity-Request-Id`；Kernel日志与响应继续透传该值。WebSocket另有内部`connectionId`，Registry同时保存`connectionId`与握手`requestId`，二者不得与`authSessionId`或`ProtyleSession`混用。

## 8. 设计评估

### 8.1 采用的模式

- **Dependency Injection / Composition Root**：空间路由只在一个位置组装Session，Core不能从全局对象寻找身份或能力。
- **Dependency Injection + Declarative Controller**：目录固定路由只由Nest原生Controller、Guard metadata、Pipe与singleton Service声明；没有自定义扫描器、命令分发表或第二套注册事实。
- **Command + Dependency Injection**：运维stdin解析为判别联合命令；领域处理方法以Nest `DiscoveryService.createDecorator` metadata声明，启动时由`getProviders`和`getMetadataByDecorator`从已装配provider派生唯一分派索引。缺失、重复或未知声明使组合根启动失败，不建立类层级、人工registry或中央`switch`。
- **Adapter**：`PasswordHasher`隔离`@node-rs/argon2`的PHC协议和参数，`kernel-client`隔离思源HTTP/WS、内部认证与错误语义；二者均承担真实协议差异，不是改名转发。
- **Policy / Strategy**：`KernelRoutePolicy`显式分类`HTTP方法 + canonical route template`，避免按方法、名称或Kernel中间件推断授权。
- **Factory**：公共Factory固定`workspace + live`并只做一次`documentId -> blockId`映射，React不能构造无效Core组合。
- **State**：连接Registry只允许`pending -> active -> closed`，路由Session只允许当前代次创建后继实例，消除撤权与异步创建竞态。
- **Event-Driven**：S2在首个Registry消费者落地时，以事务内`pg_notify`和API专用`LISTEN`形成跨HTTP/运维进程的唯一`AccessChanged`路径，驱动连接关闭与到期更新；不保留进程内并行publisher或no-op路径。

不新增浏览器全局Singleton、第二个Session store、DTO同形mapper或旧App兼容桥。网络边界只解析合同必要字段，不在编辑热路径重复校验或拷贝内容payload；重复校验判定遵循ADR-021。

### 8.2 更简单方案比较

| 方案 | 结论 | 原因 |
| --- | --- | --- |
| 用workspace路径或随机ID创建旧壳Session | 拒绝 | 身份语义错误，无法提供企业隔离 |
| 增加`local` Session联合类型 | 拒绝 | 用户已锁定云端权威，会永久扩大状态空间 |
| 直接信任React路由参数 | 拒绝 | 路由是非可信输入，缺少会话和成员授权 |
| 由SpaceRuntimeBootstrap顺带返回首文档 | 拒绝 | 企业状态与易变目录、锁态、分页耦合，仍不能支撑完整文档树 |
| 放宽Gateway或公开旧文件树API | 拒绝 | 内容身份不再完整，且浏览器会接触路径、全局状态与Kernel直连语义 |
| 授权后经服务目录选择完整身份 | 采用 | 目录与正文边界分离，数据按层分页，三ID只在选择完成后进入内容链 |
| 浏览器公开初始化或成员管理HTTP | 拒绝 | 扩大S1攻击面与页面范围，违背批准PRD的受控运维边界 |
| 独立运维微服务或直接Prisma脚本 | 拒绝 | 增加部署单元或绕过同一领域事务与安全日志 |
| Node内置Argon2 | 拒绝 | 项目允许的Node 24.0不存在该API，24.7后仍为experimental |
| 自写密码KDF或双键限流器 | 拒绝 | 安全原语和时间窗状态已有锁定依赖，手写只增加审计风险 |
| 把CSRF token放localStorage或可读Cookie | 拒绝 | 扩大XSS持久化与跨标签状态面；会话token可确定性派生内存token |
| 在S1先建无消费者AccessChanged总线 | 拒绝 | 只能测试mock调用且形成no-op生产路径，S2与真实Registry同批更清楚 |
| 只在Service中先查组织成员再写空间成员 | 拒绝 | 并发或绕过唯一写入口时不能形成数据库参照完整性 |
| 私网只使用短期JWT | 拒绝 | Bearer token不能提供传输机密性和双向服务证书身份 |
| 在应用源内联所有附件与导出 | 拒绝 | HTML/JS/SVG/XML/PDF会形成持久化XSS与会话滥用面 |
| 先完成全部L1再迁移Protyle | 拒绝 | 范围过大；最小启动切片已足以提供真实身份 |
| 前移身份、空间、Gateway垂直切片 | 采用 | 最短真实数据链，同时不提前实现分享、审计等外围能力 |

最终方案比伪造旧壳Session多出服务端启动切片，但删除了本地模式、兼容Session和双入口三类长期复杂度。生产心智模型始终只有一条身份链和一个活动空间Session。

## 9. 测试矩阵

### 9.1 标准入口与CI

S0至S3固定由`enterprise/package.json`拥有唯一聚合命令名`pnpm verify:s0-s3`，命令内容随S0、S1、S2、S3代码与永久测试一同补齐。自2026-07-18起，剩余L1视为一个集中评审与验证大阶段：目录、控制面、企业UI、分享、审计、备份恢复、Worker、B4及P3-P5全部生产代码、迁移、测试代码、调用方、旧路径清理和文档完成前不执行阶段runner；全部实现完成后先进行一次集中代码/安全/许可证复评，复评通过才在verification统一运行`verify:s0-s3`、`verify:b4`、Kernel、浏览器、E2E与供应链矩阵。实现中只允许为解除明确阻塞执行一次最小格式、类型、迁移或编译诊断，不作为通过证据，也不替代最终全矩阵。

下表的S0-S3标签只表示能力与测试代码归属，不是逐批执行门禁。不得提前注册未来空suite，也不得使用`passWithNoTests`让缺失能力绿色；任何新package、Vitest project或Go package进入聚合命令时，必须同时带稳定合同case，并只在L1末统一执行。

S3完成后的最终命令形态如下：

```text
verify:s0-s3
  -> lint:s0-s3
  -> typecheck:s0-s3
  -> test:s0-s3
     -> @singularity/database test:integration
     -> @singularity/api test
        -> Vitest unit project
        -> Vitest http-contract/operations integration project
     -> @singularity/web test:space-access
     -> @singularity/web test:browser-integration
     -> go -C ../kernel test -vet=off ./serviceauth
  -> build:s0-s3
     -> authorization -> contracts -> database/kernel-client production builds
     -> @singularity/api production build
     -> @singularity/web production build
```

| 批次 | 聚合命令原子增加的证据 | 禁止状态 |
| --- | --- | --- |
| S0 | database迁移/约束integration、真实Nest数据库健康HTTP case、contracts/database/authorization/kernel-client/api构建 | 空API project、仅类型无build、数据库脚本人工补跑 |
| S1 | 运维/初始化integration、Auth/Space真实HTTP、KDF准入与会话时钟、React路由component、桌面/移动/320px browser integration、Web build | `--pass-with-no-tests`、静态shell冒充、保留空E2E入口、预注册S2/S3空suite |
| S2 | authorization与kernel-client unit/integration、真实HTTPS/WSS Gateway、`kernel/serviceauth` Go unit、mTLS测试证书 | 依赖独立`kernel-baseline`冒充服务认证证据 |
| S3 | Kernel服务目录、Nest目录HTTP、React目录选择与无Core Session组合根、Web生产build | 用测试Factory、静态shell、全量树、旧文件路径或空Playwright目录冒充 |

`lint:s0-s3`覆盖`apps/api`、Web身份/空间入口、contracts、database、authorization和kernel-client；`typecheck:s0-s3`调用这些package各自的`typecheck`；`test:s0-s3`在S1增加Web Vitest与Playwright browser integration；`build:s0-s3`按authorization先于contracts的依赖序增加Web生产构建，并证明运维main包含在API产物中。`@singularity/api test`固定顺序调用无数据库globalSetup的`vitest.unit.config.ts`与现有PostgreSQL `vitest.integration.config.ts`；后者显式收集`test/**/*.http.test.ts`和`test/**/*.operations.test.ts`，不得用HTTP后缀伪装运维测试。所有命令只调用package声明且lockfile锁定的runner。现有`kernel-baseline`继续承担上游Kernel广泛回归，但S2服务认证package测试必须同时由`verify:s0-s3`直接发现。

`.github/workflows/singularity-l0.yml`的`space-session` job使用`postgres:17-alpine` service，固定测试值`POSTGRES_USER=singularity_test`、`POSTGRES_PASSWORD=singularity_test`、`POSTGRES_DB=singularity_test`，并以`pg_isready -U singularity_test -d singularity_test`作为healthcheck。job注入`SINGULARITY_TEST_DATABASE_URL=postgresql://singularity_test:singularity_test@127.0.0.1:55432/singularity_test`，冻结安装`enterprise/pnpm-lock.yaml`；本地固定服务由`enterprise/docker-compose.test.yml`与`scripts/singularity/test-postgres.sh`拥有，使用持久化`singularity-postgres-test-data`卷并绑定`127.0.0.1:55432`。S1在调用唯一`pnpm verify:s0-s3`前安装锁定Playwright Chromium，使浏览器合同不是另一个可跳过job。`enterprise-web`删除重复的静态shell安装与步骤。S2在同一job原子增加`actions/setup-go`、`kernel/go.mod`版本和临时测试CA/证书生成，再继续只调用聚合命令；不得把Go服务认证留在另一个required check中。测试入口不会自动启动或停止数据库；未运行的本地服务应由操作者按[固定PostgreSQL runbook](../runbooks/singularity-test-postgres.md)启动，数据库、真实HTTPS/WSS integration不得在服务未启动时标记为通过。

### 9.2 PostgreSQL与服务生命周期

数据库隔离的唯一低层owner是`packages/database/test/support/postgres.ts`，通过直接测试子路径`@singularity/database/testing/postgres`供`packages/database/vitest.integration.config.ts`与`apps/api/vitest.integration.config.ts`消费。S0同时落数据库迁移/约束合同和Nest数据库健康HTTP合同，因此该support从创建时即有两个稳定消费者；生产源码由ESLint/exports边界禁止导入该测试子路径。

support默认使用固定`postgresql://singularity_test:singularity_test@127.0.0.1:55432/singularity_test`，显式设置`SINGULARITY_TEST_DATABASE_URL`时才使用覆盖值；它使用标准`URL`解析协议、数据库名和现有查询参数，并要求数据库路径以`_test`结尾。每个Vitest project的`globalSetup`创建自己的随机安全schema名，把它结构化写入PostgreSQL URL的`schema`参数，使用该URL执行`prisma migrate deploy`并返回`isolatedDatabaseUrl`。若建schema、迁移或Prisma连接任一步失败，setup在重新抛错前关闭已建连接并通过基础测试库连接删除schema；正常teardown同样先断开所有客户端，再幂等删除schema。

一个Vitest project运行期间共享一个随机schema，worker和case使用独立UUID数据并在`afterEach`按外键顺序清理，不依赖兄弟case或执行顺序；database与API project本身使用不同schema，因此可并行。迁移回放另建独立schema，不依赖业务case先执行。`_test`名称保护和内部schema格式检查每个project只在globalSetup执行一次，只增加URL解析与常数级字符串判断，不在产品热路径；只依赖独立数据库凭据不能防止环境变量误指生产库，因此保留该运行时安全门禁。

Nest测试应用和受控Kernel HTTPS/WSS服务都由runner hook在随机端口启动与关闭；S1的`apps/api/test/support/test-app.ts`由identity HTTP、spaces HTTP、access concurrency和OpenAPI HTTP直接消费，只返回app、base URL和幂等dispose，不判断登录或授权成功。无可变进程状态的space/OpenAPI suite可用`beforeAll/afterAll`，每个Identity case必须用`beforeEach/afterEach`创建全新Nest容器、真实内存limiter和KDF队列，确保整套运行与按名称单跑等价。临时CA、服务端证书、客户端证书和JWT密钥由后续测试生命周期创建并在失败路径删除。固定sleep禁止用于同步，HTTP等待响应，WebSocket等待open/message/close事件。

### 9.3 稳定合同矩阵

| 稳定合同 / 主要失败原因 | 最低层级 | 真实与模拟边界 | 独立证据 |
| --- | --- | --- | --- |
| Prisma迁移可从空schema回放，S0非空领域表被可诊断拒绝 | database integration | 真实PostgreSQL执行迁移 | 空schema成功、S0手工行失败且不被改写、整数安装单例独立case |
| 数据库配置错误仍建立readiness HTTP且不泄露原始URL | HTTP contract | 真实Nest Fastify HTTP；缺失/畸形/错误协议配置使用含敏感哨兵的原始值，Logger为外部观测端口 | 三类`503`独立case，响应头、响应体和捕获日志均不含哨兵 |
| 数据库连接与池耗尽在3秒边界内失败 | HTTP contract + database integration | 接受TCP连接但不完成PostgreSQL握手的受控服务；真实PostgreSQL中占满5个池连接 | 黑洞连接`503`与池等待拒绝独立case |
| 客户端查询5秒与PostgreSQL语句4秒限制分别生效 | database integration | 真实PostgreSQL `pg_sleep`；客户端case在同一事务显式关闭server statement timeout | 客户端query timeout与server `statement_timeout`独立case |
| 登录标识、token摘要、空间Kernel及两类成员复合键唯一 | database integration | 真实PostgreSQL | 每项约束独立命名case |
| 空间成员必须同时引用同一组织的Space与OrganizationMembership，Session和Kernel也不能跨所有者 | database integration | 真实PostgreSQL | 两个SpaceMembership复合外键及其他所有权各自独立case |
| 组织/空间角色与Kernel状态持久化值不偏离公开小写合同 | database integration | 真实PostgreSQL与公开authorization/contracts常量 | 独立round-trip case |
| ready/unavailable部署字段不能是空串或纯空白 | database integration | 真实PostgreSQL条件约束 | 句柄和版本分别以空串/空白写入并被拒绝 |
| 运维严格stdin/stdout/退出码、全部命令与事务回滚 | operations + database integration | 真实PostgreSQL、真实stream parser与Service；敏感哨兵覆盖stdout/stderr/Logger | TTY/超限/未知字段、初始化竞态、账号/空间/成员/停用/会话撤销/三态登记、owner保护、重复操作、数据库失败和未捕获异常独立case；OpenAPI无运维路径；覆盖S1-P-01/02 |
| 运维、登录与撤权并发后不产生失效用户会话或失效组织下active空间成员 | database/HTTP integration | 真实PostgreSQL行锁；受控外部事务持锁形成交错 | 登录对停用、授予对组织成员撤销、空闲续期对退出/全撤销/停用的最终不变量独立case |
| 组织成员撤权只等待相关空间 | database integration | 真实PostgreSQL外部事务持有Space锁 | 无关Space锁下撤权及时完成；相关Space锁下等待释放后撤权 |
| KDF最多2并发、8等待、5秒有界且真实/dummy同准入 | unit + HTTP contract | unit只替换外部Argon2调用为可控deferred；HTTP使用真实Argon2 | 并发峰值、队列满/超时统一429、真实成功与三类统一401独立case |
| 双键限流在直连与受信反向代理后都按真实客户端隔离 | HTTP contract | 真实Nest/Fastify request IP解析与rate-limiter；真实Argon2 | 伪造转发头被忽略、受信CIDR多客户端不共享来源桶、账号桶和Retry-After独立case |
| Cookie、绝对/空闲到期、原子续期及CSRF/Origin拒绝 | HTTP contract | 真实Nest HTTP与PostgreSQL；Clock为外部替身 | Cookie属性、固定token/CSRF输入输出向量、200/204、401/403、无效头不500、公开Origin/无CORS独立case；覆盖S1-P-05/06/14/15/17 |
| OpenAPI只声明真实安全输入与固定Problem | HTTP contract | 真实Nest生成OpenAPI 3.1文档 | Cookie security、Origin、CSRF、Retry-After、503及每个status唯一code/status独立断言 |
| 授权空间列表只含五层active事实 | HTTP contract | 真实Nest HTTP、授权和PostgreSQL | 单/多/空列表及User/Organization/两级成员/Space各停用过滤独立case；覆盖S1-P-07 |
| 启动响应只含运维生产路径建立的权威三态 | operations + HTTP contract | 先经真实运维Service登记，再经真实HTTP读取；禁止测试直写状态 | starting/ready/unavailable、部署字段不出响应及条件约束独立case；覆盖S1-P-09至12 |
| 不存在、不可见、停用或撤权空间统一不泄露 | HTTP contract | 真实HTTP、运维Service与数据库 | `404 + not-found`及角色变化独立case；覆盖S1-P-08、11、16 |
| React登录、深链、单/多/空空间和状态切换 | component | 真实Router、QueryClient、Zustand与组件；HTTP为外部边界 | 登录卸载代次、429受控时钟、单空间自动进入/显式返回、starting/unavailable/network/not-found及轮询上限各自独立case；覆盖S1-P-03、07至13、16至18 |
| 授权后台重验不暴露缓存旧角色或空间 | component | 真实QueryClient预置缓存与deferred HTTP替身 | fetch中隐藏旧ready；404后隐藏名称/Badge/侧栏并触发授权重读 |
| 退出后历史/缓存不恢复，长名称、可访问性与最窄布局成立 | browser integration | 真实Vite/Chromium；HTTP由`page.route`替换并明确标为browser integration | 1440x900、390x844、320x568三项目；back/forward、深浅色token、键盘顺序、侧栏折叠/移动关闭、40px触控、水平溢出及Request对象原始诊断；覆盖S1-P-14/18 |
| Kernel策略未知即拒绝，viewer不能write/admin | unit + HTTP integration | 真实策略表与Gateway；受控外部Kernel | method/template和角色独立case |
| mTLS、服务JWT issuer/audience/空间/时效及轮换 | Go unit + HTTPS/WSS integration | 真实Kernel验证器和临时测试CA/密钥 | HTTP、WS、readyz、证书身份及无效claims独立case |
| 实例解析拒绝任意URL、重定向、代理、非法头和内部Location | integration | 真实kernel-client与受控恶意HTTPS响应 | 每个SSRF、头走私和泄露路径独立case |
| 用户授权、隐藏式404、Kernel服务认证、502/503/504和业务Problem确定性映射 | HTTPS/WSS integration | 真实Gateway映射；受控Kernel返回各来源错误 | 每个来源独立case，证明不误改用户身份 |
| assets、upload和exports始终绑定当前空间且主动内容不在应用源执行 | HTTP integration | 真实Gateway与受控Kernel资源服务 | PNG内联；HTML/JS/SVG/XML/PDF/未知类型和导出HTML强制下载、nosniff、sandbox CSP独立case |
| 会话到期、用户/组织/空间/两级成员变化关闭WebSocket且无竞态或迟到推送 | integration | 真实Nest WS、数据库事件和pending/active Registry | 4401、4403、4408、授权与注册交错、激活前零推送及关闭后零推送独立case |
| React只用授权启动响应创建和销毁Session | component | 真实路由组件、QueryClient和Session；HTTP为外部边界 | ready创建、starting不创建、切空间销毁、撤权等待dispose/清DOM/代次拒绝独立case |
| Kernel目录只列开放笔记本并按真实父文档分页，锁定库不泄漏 | Go integration | 真实普通/加密内容库、响应门与目录排序；服务JWT/mTLS在独立边界证明 | 笔记本排序/关闭过滤、根页、子页、nextOffset、父文档跨库拒绝、锁前响应完成与锁后零标题独立case |
| Nest目录先复验空间读取权限且只接受有界schema | HTTP + HTTPS integration | 真实Nest HTTP、PostgreSQL授权、KernelPrivateClient与受控mTLS Kernel；不mock内部Service链 | viewer/editor/admin、隐藏式404、ready状态、超限/非JSON/schema错误、上游401/503映射独立case |
| React目录从当前代次的完整项自动选首文档，分页与迟到结果不串树 | component | 真实Router、QueryClient、Zustand选择store和工作台owner；HTTP为外部边界 | 空/锁定/多笔记本、首项选择、加载更多、父层并发、切空间/401/404清选择、503保留已载节点独立case |
| S0-S3 Node packages、Nest API与Web均可生成生产产物 | build | 真实package依赖图和编译器 | `build:s0-s3`聚合且无测试专用导入 |
| 真实登录、选空间、打开文档和越权写拒绝 | e2e | 真实React、NestJS、PostgreSQL、Gateway与Kernel | P5专用Playwright入口 |

API合同由真实HTTP驱动，WebSocket合同使用真实升级链；只允许替换外部Kernel、时钟和密钥。测试不得访问Controller私有方法、mock完整内部链或用源码字符串证明运行时结果。

### 9.4 测试support所有权

以下support只在第二个直接消费者落地的同一批次抽取；数据库support因S0已有数据库与API两个消费者而在S0成立：

| Owner与路径 | 直接消费者 | 承担职责 | 不承担职责 | 生命周期与退役 |
| --- | --- | --- | --- | --- |
| `packages/database/test/support/postgres.ts`，导入`@singularity/database/testing/postgres` | database integration config、API integration config | 结构化测试URL、随机schema、迁移、连接释放、setup失败清理与teardown | 业务用户/空间数据、业务断言和服务启动 | globalSetup/teardown；只剩一个runner消费者时内联并删除测试export |
| `apps/api/test/support/test-app.ts` | identity HTTP、spaces HTTP、access concurrency、OpenAPI HTTP | 随机端口启动/关闭Nest应用，返回app、基址与幂等dispose | 登录、授权或业务成功判断 | owner suite选hook；Identity每case新实例，其他无进程状态suite可共享；消费者少于两个时内联删除 |
| `apps/api/test/support/capturing-logger.ts` | database health、identity、spaces、operations integration | 原样捕获Nest logger参数供各case检查脱敏边界 | 解释业务结果、过滤秘密或判断允许事件 | 每case新实例；消费者少于两个或Nest提供等价捕获时内联删除 |
| `apps/api/test/support/kernel-gateway.ts` | Gateway策略/错误映射、资源主动内容、WS撤权、内容目录HTTP | 受控外部HTTPS/WSS、临时mTLS身份、原始请求与响应证据 | 预设授权结论、目录业务断言和生产Kernel模型 | beforeAll/afterAll；真实Kernel覆盖同一协议后缩减或删除 |
| `apps/web/tests/browser-integration/support/diagnostics.ts` | `identity-spaces.spec.ts`、`runtime-session.spec.ts` | 以Playwright Request对象原样采集console error/warn、pageerror、requestfailed、HTTP响应、请求起止与持续时间 | “意外”判定、业务allowlist、网络故障预期、页面状态与权限断言 | Playwright case生命周期；各case自行过滤并断言业务预期；消费者少于两个时内联删除 |

support不建立barrel或同形wrapper，消费者直接导入。业务fixture显式创建合同需要的最小字段，cleanup与创建在同一API暴露。

### 9.5 Playwright阶段门禁

S1在`browser-integration`落首个永久测试时，同批删除该目录`.gitkeep`和脚本的`--pass-with-no-tests`，配置增加Vite `webServer`及desktop、mobile和narrow-320三个项目，并进入`verify:s0-s3`。S1同时删除空`test:e2e`脚本、`playwright.e2e.config.ts`、`tests/e2e/**`与所有`--pass-with-no-tests`；P5首个真实全链合同落地时才原子恢复E2E配置和非空入口。

Browser integration允许拦截外部身份/空间HTTP，配置只启动Vite Web并保持`fullyParallel: true`，每个case自备业务route状态并在case内判定预期HTTP/网络失败。诊断support不接收业务allowlist，以Request对象区分同方法同URL并发请求并记录持续时间；正常、预期401和预期网络失败均由对应spec直接断言。已删除的`playwright.shell.config.ts`与`tests/shell/workspace.spec.ts`之设计token、侧栏和控制台证据必须由两个真实browser文件完整接管，包括深色token、侧栏折叠/移动切换、空间列表键盘顺序、40px移动触控和水平溢出。P5真实E2E配置由Playwright `webServer`数组启动API、Web和测试Kernel，`globalSetup`执行专用测试schema迁移；在按worker创建并清理组织/空间的fixture具备两个稳定消费者前使用`fullyParallel: false`。

## 10. 实施批次与完成条件

### S0 合同与数据库基础

1. 建立`apps/api`、`packages/contracts`、`packages/database`、`packages/authorization`和`packages/kernel-client`边界。
2. 固定依赖版本、registry、lockfile、TypeScript基线和统一命令后再安装依赖。
3. 落最小Prisma模型、两条SpaceMembership复合外键、其他唯一键/外键与迁移，开发种子只创建数据库生成的真实ID。
4. 落数据库与API两个真实消费者共用的测试PostgreSQL生命周期、`GET /api/v1/health/database`真实HTTP合同及setup失败清理。
5. 在根脚本和CI落S0形态的`verify:s0-s3`，同时覆盖lint、typecheck、非空测试和Node production build。
6. 完成条件：迁移可在干净PostgreSQL回放，唯一约束、两级所有权、失败清理、真实HTTP健康和生产build有独立证据。

### S1 身份与空间启动

1. 先更新authorization/contracts与S1迁移：增加SystemInstallation单例、S0非空门禁、starting Kernel合法状态、Problem/Auth/Space公开schema，角色继续只有一个事实源。
2. 固定并安装`@node-rs/argon2@2.0.2`、`@fastify/cookie@11.1.1`、`rate-limiter-flexible@11.2.0`及contracts运行时`zod@3.25.76`，统一更新manifest与唯一lockfile后冻结安装验证。
3. 实现API package内受控运维组合根与唯一事务owner，非TTY stdin严格联合复用Identity/SpaceAccess Service，完成初始化、账号/空间/成员、Kernel三态与会话撤销操作；密码和部署信息不进入argv、日志或非必要输出。
4. 实现必填公开Origin与受信代理CIDR、本地账号登录、Argon2id有界准入、防枚举双键限流、同源Cookie、固定字节CSRF、条件原子空闲续期、当前/全部会话撤销、行锁顺序和用户禁用。
5. 实现授权空间列表、两级成员查询及`SpaceRuntimeBootstrap`真实HTTP Problem合同；全部写Service成为S2事件生产者的唯一接入点，但S1不建立no-op事件总线。
6. 通过shadcn CLI预览并新增Field/Label、Alert、Badge、Spinner，随后实现`/login`、`/spaces`、真实组织/空间路由、TanStack Query数据流和内存CSRF store，一次删除硬编码“默认空间”。
7. 原子扩展`verify:s0-s3`加入API unit、operations/database integration、Auth/Space HTTP、路由component、desktop/mobile/320px browser integration与Web build；删除静态shell、空E2E入口及全部`--pass-with-no-tests`。
8. 复评修复精确OpenAPI、相关空间撤权锁、运维组合根/幂等/失败证据、Kernel非空约束、登录取消代次、Retry-After冷却、授权重验、显式单空间返回、移动侧栏和原始Request诊断；按主要失败原因拆分混合case。
9. 完成条件：受控运维可产生真实多账号/多空间/两级成员和Kernel三态数据；浏览器只能从本轮成功授权响应取得真实`spaceId`；并发撤权不变量、401/403/404/429、Cookie、CSRF、会话时效、空间状态、退出后历史清理、320px/WCAG与production build均有标准入口证据。

### S2 Kernel Gateway

1. 实现可信部署句柄解析、强制mTLS、禁重定向/环境代理的私网客户端及策略头白名单。
2. 在NestJS和`kernel/serviceauth`落Ed25519服务JWT、企业模式启动门禁、证书/JWT轮换及受保护`/internal/readyz`。
3. 落`HTTP method + canonical route template`策略并先覆盖Protyle闭包实际使用的全部组合；未知项在读取正文前拒绝。
4. 实现空间化Kernel API、assets、upload、exports和只接收推送的Protyle WebSocket代理；主动内容按5.7节强制下载或安全渲染。
5. 实现事务内PostgreSQL失效通知、API专用监听、pending/active单副本`SpaceConnectionRegistry`、四索引、授权复验、到期计时器、4401/4403/4408关闭语义及全部`AccessChanged`消费；监听异常失败关闭且拒绝新升级。
6. 落用户授权、隐藏式404、Kernel服务认证、上游不可用和业务Problem的确定性映射。
7. 原子扩展`verify:s0-s3`加入真实HTTPS/WSS integration、`kernel/serviceauth` Go unit、Go toolchain与生产build。
8. 完成条件：真实HTTPS/WSS integration证明空间绑定、viewer写拒绝、mTLS/JWT、SSRF/头走私阻断、主动内容隔离、撤销竞态关闭、零迟到推送和内部地址不泄露。

### S3 浏览器组合根

1. 在contracts声明三个目录路径、Zod/OpenAPI schema、128项分页与最小字段；在authorization的唯一策略表声明两个`identity: service` Kernel内部目录路由，重复键启动失败。
2. 在Kernel实现开放笔记本与一层文档目录模型、真实父文档内容库校验、加密响应门、锁态和最小JSON投影；同一声明同时注册内部路由与身份要求，目录使用服务身份，分享继续强制内容身份，WebSocket使用查询身份。
3. 在现有Kernel Gateway模块用原生`@Controller/@Get`、认证metadata、Pipe、singleton Service与构造器DI实现公共目录；先复验空间读取权限，再以mTLS/JWT调用私网目录并有界解析响应，不增加自定义registry。
4. 在Web实现TanStack Query目录分页、最小Zustand三ID选择、树owner与自动首文档选择；`SpaceSessionRoot`激活唯一`ContentSelectionScope`并通过render-prop交付Session、选择和有代次的选择命令，目录数组、Scope、Session和Core不进store。
5. 实现生产HostPort、正式零插件PluginPort、Registry、绑定空间Gateway的Transport、ResourcePort、Menu、Overlay、完整Runtime和Session组合，不接入编辑器Core。
6. 仅在授权启动状态为`ready`时创建Session，切空间和撤权按“冻结命令、等待dispose、清DOM、失效目录与选择、代次校验”顺序销毁。
7. 以非编辑器就绪状态证明完整Runtime和真实Session可由路由持有，并证明目录能产出完整身份；不使用占位能力、测试Session、测试Factory、硬编码空间ID、空文档ID或旧路径。
8. 原子补齐`verify:s0-s3`对Kernel目录、Nest目录HTTP、空间Session与目录选择component、三视口browser integration及Web production build的发现入口；本步只写入和评审测试代码，不在L1其余实现完成前执行。
9. 完成条件：真实目录与组件证据证明ready创建、身份选择、分页/锁态、starting/unavailable不创建、身份变化有序销毁、撤权清DOM/查询失效/迟到代次拒绝和资源基址绑定。

### B4恢复与Web切换

1. 将Protyle Core构造器、Transport消费和ResourcePort一次性切为S3真实Session与目录选择合同，删除`App`、旧`fetchPost`、任意请求头字典、全局资源地址和旧`layout/Model`依赖。
2. 在同一原子批把React Host与真实公共Factory接到S3已经持有的完整Runtime；主编辑器走公共Factory，BlockPanel及已迁移嵌入式能力走Core合同，未迁移旧所有者不进入Vite闭包，不重建Session或替换Runtime能力。
3. 扩展真实公共入口AST/import图和Kernel策略覆盖门禁，不保留测试Factory、构造器重载、双Transport或旧直连。
4. 完成条件：`verify:b4`与`verify:s0-s3`同时通过，真实Core源码闭包无旧App/平台禁用边；P3/P4浏览器能力和P5全链E2E仍是后续门禁，旧Webpack文件在P5完成后物理删除。

### 10.1 并发文件归属与编辑顺序

| 批次/Owner | 独占写范围 | 可并行的无冲突工作 | 共享文件恢复条件 |
| --- | --- | --- | --- |
| S1 database owner | `enterprise/packages/database/**` | contracts与API package本地源码 | S1迁移与约束case定稿后在`/root/projects/mailbox.md`释放 |
| S1 contracts owner | `enterprise/packages/authorization/**`、`enterprise/packages/contracts/**` | database schema、API模块源码 | Problem/Auth/Space字段与schema定稿后释放 |
| S1 API owner | `enterprise/apps/api/**` | contracts稳定后的Web只读开发 | 运维/Auth/Space HTTP case通过后释放 |
| S1-S3 Web owner | `enterprise/apps/web/src/**`、`enterprise/apps/web/tests/**` | API与database源码 | 路由component/browser合同通过后释放 |
| S2 Kernel owner | `kernel/serviceauth/**`及受保护入口的明确文件 | Nest Gateway与Web组合根 | Go package与中间件测试通过后释放 |
| S3目录owner | 新Kernel目录模型/handler、Nest目录Controller/Service、Web目录树与选择store | 企业管理UI和Worker外围 | shared contracts/策略/CoreModule由当前owner释放后，集成owner只做增量合并 |
| 集成owner | `enterprise/package.json`、`enterprise/pnpm-lock.yaml`、`enterprise/eslint.config.mjs`、根tsconfig、CI | 各owner的package本地工作 | 所有manifest稳定后统一安装、更新lockfile和CI；其他owner不得并发编辑 |

编辑顺序固定为合同与schema、package本地实现、package本地测试、manifest汇总、唯一lockfile更新、根命令与CI。发生共享文件冲突时，当前owner在`/root/projects/mailbox.md`记录占用范围和未完成意图；其他线程切换到表中无冲突任务，不覆盖、撤回或顺手重排对方改动。只有owner明确释放或集成owner完成手工合并并记录结果后，才能恢复共享文件修改。

### 10.2 旧路径与测试删除清单

| 批次 | 删除项 | Owner | 验证门禁 |
| --- | --- | --- | --- |
| S1 | `/workspace`与“默认空间”、静态shell及空E2E Playwright config/test/scripts/CI步骤、browser-integration `.gitkeep`与全部`--pass-with-no-tests`、任何argv/TTY密码输入 | Web/API/集成owner | Auth/Space component + desktop/mobile/320px browser + operations integration |
| S2 | 浏览器任意请求头透传、全局企业`/api`/`/ws`/`/assets`/`/upload`/`/export`入口、明文Kernel客户端 | Gateway owner | route policy、mTLS、header allowlist integration |
| S3 | 测试Session/Factory生产装配、路由代次外的迟到Session创建 | Web owner | `verify:s0-s3` component/build |
| S3目录 | 公开旧`lsNotebooks/listDocsByPath`代理、服务器路径字段、空/固定文档ID、DOM/全局/首响应身份推断、全量树快照和目录fallback | 目录owner | Kernel/Nest目录integration + React component/browser integration |
| B4 | Core中的`App`、`fetchPost`、`layout/Model`、任意`headers`字典、构造器重载、双Transport、旧Model重连测试与重复Registry测试 | Protyle owner | `verify:b4` + `verify:s0-s3` |
| P3/P4 | 临时浏览器探索脚本、重复fixture/page object、绕过正式PluginPort的测试插件路径 | Browser owner | 对应browser integration config |
| P5 | 旧Webpack Web入口与文件、旧浏览器runner、旧壳Host/Plugin Adapter、退出生产闭包的旧所有者及重复E2E | 集成owner | 真实P5 E2E、AST闭包和文件不存在断言 |

批次之间不保留新旧请求双路径。S0至S2完成后，S3只建立无Core的真实Session组合；B4再原子接通Host与Core。S0至S3未完成前不得继续把旧App创建点机械改为Session，也不得宣称P1-B4或L1生产Protyle迁移完成；这不影响按完整方案第8.3节已经独立完成的L0基础工程状态。

## 11. 架构审查

- **SOLID**：身份、授权、实例路由、浏览器生命周期和内容Core拥有独立职责，依赖方向指向明确合同。
- **安全**：真实空间来自五层active事实和数据库复合所有权；必填HTTPS Origin、受信代理CIDR、KDF资源上限、行锁顺序、条件会话续期、非TTY运维与固定密码学字节合同闭合S1，未知Kernel路径、mTLS/JWT、头白名单和主动内容策略保护后续私网与应用源。
- **数据流**：路由参数只定位查询，服务端启动响应产生Session，目录项产生完整内容选择；不复制正文、Kernel状态、目录数组或编辑器实例到Zustand。
- **字段唯一性**：`organizationId`、`spaceId`、`userId`、`authSessionId`、`connectionId`和`kernelInstanceId`各自表达唯一语义；SpaceMembership的组织字段只承担复合参照完整性，不引入`workspaceId`或本地近似字段。
- **状态收敛**：没有local Session、旧入口fallback、自动重复写或备用Kernel地址。
- **可观测性**：稳定标签具有owner、级别和统一`requestId`链，覆盖身份、启动、授权、路由和编辑器生命周期，不记录正文、令牌和内部路径。
- **运行时校验**：只在HTTP、Kernel私网JSON、stdin、配置、Cookie/CSRF和数据库状态转换信任边界做有界校验；每类输入在进入内部链路时解析一次，后续层消费已收敛的类型，不重复拦截同一非法值。只有跨进程、外部字节、持久化或安全生命周期边界需要重新验证其自身合同；控制面载荷至多16KiB，目录响应至多1MiB且单页128项，均不进入编辑热路径，静态类型不能替代Go进程、代理和浏览器收到的不可信字节。用户已批准对应安全、运维与目录产品合同。
- **拷贝与转换**：不复制正文或全量Prisma对象；网络边界只把已解析合同转成最小公开载荷，授权搜索在当前数组就近派生。`PasswordHasher`承担PHC、密码学和资源准入差异，`kernel-client`承担私网协议与错误语义，均非改名透传Adapter。
- **前端系统**：radix-nova、Tailwind语义token和shadcn组件是唯一视觉事实源；TanStack Query拥有服务端视图，Zustand只拥有内存CSRF与当前三ID选择，目录数组和Session不进store。
- **测试治理**：数据库、unit、HTTP、HTTPS/WSS、Go unit、组件、production build、browser integration与未来E2E按最低充分层级分离，由分阶段非空`verify:s0-s3`发现；空E2E入口在S1删除，support只复用稳定技术生命周期并返回原始证据。
- **并发协作**：10.1节固定目录owner、编辑顺序、无冲突任务和共享文件恢复条件；冲突只通过`/root/projects/mailbox.md`协调。
- **产物边界**：文档、日志、fixture和快照只保存合同、结果与必要诊断，不写入正文、凭证、内部提示或隐藏推理。

## References

1. [奇点企业知识库完整方案](../../output/md/Singularity_Enterprise_Knowledge_Base_v1.0.0_2026-07-13.md)
2. [Protyle浏览器宿主与Vite抽取方案](protyle-browser-host.md)
3. [ADR-003：NestJS企业控制面与Go内容内核](../adr/0003-enterprise-control-plane-and-go-kernel.md)
4. [ADR-004：空间级Kernel实例隔离](../adr/0004-space-kernel-isolation.md)
5. [ADR-009：Protyle浏览器运行时边界](../adr/0009-protyle-browser-runtime-boundary.md)
6. [ADR-010：Protyle宿主动作与合同所有权](../adr/0010-protyle-host-actions-and-contract-ownership.md)
7. [S1身份与空间启动产品需求](../product/s1-identity-space-startup.md)
8. [ADR-013：S1受控运维、身份会话与空间发现](../adr/0013-s1-identity-space-access.md)
9. [ADR-020：空间内容目录引导](../adr/0020-space-content-directory-bootstrap.md)
10. [Protyle浏览器运行时收口产品需求](../product/protyle-runtime-closure.md)
11. [ADR-021：信任边界校验所有权](../adr/0021-trust-boundary-validation-ownership.md)
