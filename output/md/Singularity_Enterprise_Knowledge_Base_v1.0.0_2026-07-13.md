---
title: "奇点企业知识库完整方案"
description: "定义奇点云端企业知识库的产品边界、目标架构、长期路线与本期交付计划"
author: "Codex"
date: "2026-07-13"
version: "1.4.2"
status: "approved"
tags: ["singularity", "knowledge-base", "architecture", "roadmap"]
---

# 奇点企业知识库完整方案

> 本方案是奇点产品、架构和实施工作的权威依据；实现与本方案冲突时，先修订并重新审阅方案。

## Change Log

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0.0 | 2026-07-13 | Codex | 建立云端权威架构、L0-L6路线和L0/L1实施合同 |
| 1.1.0 | 2026-07-14 | Codex | 前移真实企业空间Session组合根与Kernel Gateway启动切片，修正Protyle迁移顺序 |
| 1.2.0 | 2026-07-14 | Codex | 闭合Kernel服务认证、空间资源、撤权、CSRF、S3/B4依赖与S0-S3测试门禁 |
| 1.2.1 | 2026-07-14 | Codex | 明确Protyle WebSocket只接收推送，所有正式写入统一走HTTP策略 |
| 1.3.0 | 2026-07-14 | Codex | 固定两级成员完整性、mTLS、主动内容隔离、撤权竞态、错误映射与分阶段非空门禁 |
| 1.3.1 | 2026-07-14 | Codex | 架构、安全与测试治理复评通过，批准作为后续实施权威依据 |
| 1.3.2 | 2026-07-14 | Codex | 固定S0数据库readiness HTTP路径、成功与不可用响应语义 |
| 1.3.3 | 2026-07-14 | Codex | 固定数据库配置脱敏、有限连接/查询时限与公开枚举单一事实源 |
| 1.3.4 | 2026-07-14 | Codex | 统一企业工作区Node 24工具链，并对齐数据库集成测试与迁移watchdog时限 |
| 1.4.0 | 2026-07-14 | Codex | 闭合S1受控运维、身份会话、空间发现、React路由与浏览器测试门禁 |
| 1.4.1 | 2026-07-14 | Codex | 闭合S1 Kernel三态生产写入、代理安全、撤权并发、KDF资源与非空测试门禁 |
| 1.4.2 | 2026-07-14 | Codex | S1产品与架构增量复评通过，批准按受控运维、身份会话和空间路由方案实现 |

## Table of Contents

- [1. 背景与目标](#1-背景与目标)
- [2. 已锁定决策](#2-已锁定决策)
- [3. 产品模型](#3-产品模型)
- [4. 技术基线](#4-技术基线)
- [5. 目标架构](#5-目标架构)
- [6. 数据与权限合同](#6-数据与权限合同)
- [7. 长期路线](#7-长期路线)
- [8. L0基础工程](#8-l0基础工程)
- [9. L1企业基础版](#9-l1企业基础版)
- [10. 实施顺序](#10-实施顺序)
- [11. 验证策略](#11-验证策略)
- [12. 安全与合规](#12-安全与合规)
- [13. 风险与控制](#13-风险与控制)
- [14. 架构决策](#14-架构决策)
- [15. 完成定义](#15-完成定义)
- [References](#references)

## 1. 背景与目标

思源具备块引用、属性视图、图谱、搜索和本地内容引擎，但缺少完整的企业组织、权限、分享、审计与协作能力。奇点以思源内容能力为基础，建设服务器权威的企业知识库。

奇点目标如下：

- 保留思源成熟的文档、块、引用、属性视图和搜索语义。
- 建立组织、成员、用户组、空间和角色权限。
- 建立受控分享、审计、备份和恢复能力。
- 使用现代React前端与NestJS企业控制面。
- 保持Go Kernel与思源上游可持续同步。
- 为评论、实时协作、治理和智能检索保留清晰演进路径。

## 2. 已锁定决策

以下决策未经方案变更不得偏离：

1. 内容仅存Linux云端，浏览器仅承担交互与展示。
2. 不提供本地内容事实源、离线编辑和端侧同步。
3. 前端采用React 19、TypeScript、Vite 8与Tailwind CSS 4。
4. 新界面使用shadcn官方组件，并遵循奇点设计系统。
5. Protyle继续作为内容编辑器，通过React生命周期边界挂载。
6. 企业控制面采用NestJS、Fastify、Prisma与PostgreSQL。
7. 思源Go Kernel继续作为内容引擎，不重写为TypeScript或Rust。
8. 一个空间对应一个隔离Kernel实例，内核不直接暴露公网。
9. PostgreSQL不复制文档、块和索引；`.sy`与SQLite仍是内容事实源。
10. 本期完成L0基础工程与L1企业基础版，不实现实时协作。
11. 不引入Electron、`gomobile`、Rust客户端内核或原生移动客户端。
12. 生产`ProtyleSession`只能由授权后的企业空间启动响应创建；不得以工作区路径、设备ID、随机App ID或其他本地标识近似`spaceId`。
13. Gateway到Kernel的HTTPS、WSS和readiness统一使用mTLS与短期Ed25519服务JWT；验证精确证书身份，禁止明文与`InsecureSkipVerify`，浏览器Cookie、用户API token和空锁屏密码不得承担私网服务认证。
14. 应用源只内联安全MIME allowlist中的惰性资源；HTML、JavaScript、SVG、XML、PDF、未知类型和导出HTML强制下载并使用`nosniff`与sandbox CSP。
15. S1账号、组织、空间、成员与Kernel三态事实只由部署主机非TTY受控运维入口创建或变更；浏览器不提供初始化/成员管理入口，密码、会话凭据和部署信息不进入argv、环境变量、日志或非必要输出。

## 3. 产品模型

### 3.1 内容层级

```text
组织
└── 空间
    └── 笔记本
        └── 文档
            └── 内容块
```

- **组织**是企业成员与治理边界。
- **空间**是协作、权限和Kernel隔离边界。
- **笔记本**是思源内容分类容器。
- **文档**是主要编辑与分享对象。
- **内容块**由思源内容引擎管理。

### 3.2 用户故事

- 组织所有者创建组织、邀请成员并委派管理员。
- 组织管理员建立用户组和空间，配置成员角色。
- 空间编辑者创建、编辑、引用和搜索知识内容。
- 空间阅读者只能读取被授权空间的内容。
- 空间管理员生成有密码和有效期的只读分享链接。
- 审计人员查询登录、编辑、导出、分享和权限变更记录。

### 3.3 关键路径

```text
管理员创建组织
→ 邀请成员
→ 创建用户组与空间
→ 分配空间角色
→ 成员打开并编辑文档
→ 管理员分享文档
→ 审计人员查看操作记录
```

## 4. 技术基线

### 4.1 思源基线

锁定上游提交：`41f2861c87575ff5ac4b50a0520b1a4fe55b4a70`。

已确认的思源技术特征：

- Go 1.25内容内核与Gin HTTP API。
- `.sy`文档文件、SQLite索引和FTS5搜索。
- Lute AST、块事务、历史、引用和属性视图。
- 原生TypeScript DOM应用与Protyle编辑器。
- Webpack多入口构建与Sass样式。
- 约361个Go文件、约13万行Go代码和516个API路由。

### 4.2 目标技术栈

| 领域 | 目标方案 |
|------|----------|
| 运行时与包管理 | Node 24（`>=24 <25`且严格执行）、`@types/node` 24.13.3、pnpm 11.9.0 |
| Web UI | React 19、TypeScript、Vite 8 |
| 样式 | Tailwind CSS 4、Design Tokens |
| 组件系统 | shadcn、Radix UI、Lucide React |
| 路由 | React Router |
| 客户端状态 | Zustand |
| 服务端状态 | TanStack Query |
| 表单与校验 | React Hook Form、Zod |
| 企业API | NestJS、Fastify、OpenAPI 3.1 |
| 企业数据 | Prisma、PostgreSQL |
| 缓存与任务 | Redis、BullMQ |
| 日志与追踪 | Pino、OpenTelemetry |
| 内容引擎 | 思源Go Kernel |
| 单元与组件测试 | Vitest、Testing Library、MSW |
| 端到端测试 | Playwright |

## 5. 目标架构

### 5.1 总体结构

```text
浏览器 / PWA
React + TypeScript + Vite + Tailwind
                 |
          HTTPS / WebSocket
                 |
           Ingress / TLS
                 |
        NestJS企业控制面
        ├── Identity
        ├── Organization
        ├── Group
        ├── Space
        ├── Authorization
        ├── Share
        ├── Audit
        ├── Worker
        └── Kernel Gateway
                 |
          Go Kernel实例池
                 |
        PVC云盘：.sy + SQLite
```

PostgreSQL保存企业事实，Redis保存短生命周期状态，对象存储保存备份、导出包与分享快照。在线附件仍由Kernel工作空间持有，避免引入双写内容路径。

### 5.2 前端边界

React拥有应用壳、路由、导航、标签页、认证、组织、空间、权限、分享、审计和所有新增页面。Protyle拥有编辑器DOM、块事务、编辑历史、编辑器快捷键和内容插件交互。

`ProtyleEditor` React边界仅承担创建、切换、只读状态、销毁和事件释放，不把编辑器内部文档状态复制进Zustand。TanStack Query拥有服务端数据；Zustand仅拥有跨页面客户端应用状态。

Tailwind只用于新React页面。Protyle保留现有Sass，并通过Design Tokens桥接颜色、字体、间距和层级；Tailwind不得用全局Preflight破坏Protyle及插件DOM。

### 5.3 企业控制面边界

NestJS采用模块化单体。`api`处理HTTP与WebSocket，`worker`处理备份、通知与审计归档；未出现独立扩缩容需求前不拆微服务。

S0固定提供未认证的`GET /api/v1/health/database`作为数据库readiness合同。配置边界只接受`postgres:`和`postgresql:`，缺失、畸形或错误协议不会保留原始URL或阻止readiness HTTP建立，而是统一返回`503 {"status":"unavailable"}`。有效配置对PostgreSQL执行真实轻量查询：可用时返回`200 {"status":"ready"}`；单副本连接池上限5，连接建立与池等待上限3秒，客户端查询上限5秒，PostgreSQL语句上限4秒。两种响应均使用`Cache-Control: no-store`，且不暴露数据库地址、名称、schema、异常文本或凭证。该接口只表达数据库readiness，不兼作进程liveness、迁移状态或业务健康汇总。

组织与空间角色由`authorization` package拥有，浏览器可见Kernel状态由`contracts` package拥有，公开值统一使用小写字符串。Prisma标识符和PostgreSQL枚举值必须与公开合同相同；database package不再公开同名大写枚举，持久化测试直接消费上述公开常量验证往返结果。

建议目录：

```text
enterprise/
├── apps/
│   ├── web/
│   ├── api/
│   └── worker/
├── packages/
│   ├── ui/
│   ├── contracts/
│   ├── database/
│   ├── authorization/
│   ├── platform/
│   ├── protyle-browser/
│   └── kernel-client/
└── pnpm-workspace.yaml
```

### 5.4 Kernel Gateway边界

Kernel Gateway承担真实边界职责：

- 根据`spaceId`解析唯一Kernel实例。
- 验证组织成员与空间角色。
- 为每次HTTPS、WSS握手和readiness建立mTLS并签发最长30秒的Ed25519内部服务JWT。
- 转发空间化Kernel API、资源、上传、导出与WebSocket并转换错误语义。
- 按`HTTP method + canonical route template`重建允许头，拒绝任意浏览器头透传、重定向、环境代理和内部地址泄露。
- 强制主动内容下载或通过受信渲染器安全预览，不在应用源执行上传与导出内容。
- 隐藏内核端口、工作空间路径和内部地址。
- 记录`organizationId`、`spaceId`、`userId`、路由、结果与耗时。
- 提供启动状态、健康检查、容量和连接诊断。

## 6. 数据与权限合同

### 6.1 数据所有权

| 数据 | 唯一所有者 | 存储 |
|------|------------|------|
| 组织、成员、用户组 | NestJS | PostgreSQL |
| 空间、角色、邀请 | NestJS | PostgreSQL |
| 分享、审计、会话 | NestJS | PostgreSQL/Redis |
| 笔记本、文档、块 | Go Kernel | `.sy` |
| 引用、图谱、搜索索引 | Go Kernel | SQLite |
| 在线附件 | Go Kernel | PVC云盘 |
| 备份、导出、分享快照 | Worker | S3/MinIO |

禁止在PostgreSQL与`.sy`之间双写文档内容。浏览器缓存不构成内容事实源，退出登录后应清除敏感查询缓存。

`SpaceMembership`同时保存`organizationId`、`spaceId`和`userId`，以复合外键分别引用同一组织的`Space`与`OrganizationMembership`；该低频所有权字段用于数据库参照完整性，不能仅靠Service先查后写。

### 6.2 权限模型

组织角色：`owner`、`admin`、`member`。

空间角色：`admin`、`editor`、`viewer`。

本期权限规则：

- `owner`管理组织全部资源并移交所有权。
- `admin`管理成员、用户组和空间，不删除组织。
- `space.admin`管理空间成员与分享。
- `space.editor`读取并修改空间内容。
- `space.viewer`仅可读取空间内容。
- 笔记本、文档和块继承空间权限。
- 被禁用用户的HTTP和WebSocket会话立即失效。

### 6.3 权威字段

跨边界只传唯一语义字段：`organizationId`、`spaceId`、`userId`、`kernelInstanceId`、`role`、`resourceId`。不得同时维护`tenantId/orgId`、`workspaceId/spaceId`等同义字段。

## 7. 长期路线

| 阶段 | 目标 | 核心能力 |
|------|------|----------|
| L0 | 建立可持续二开基础 | Fork、品牌、React/Vite基座、CI/CD、上游同步、许可证 |
| L1 | 建立企业基础版 | 组织、用户组、空间、RBAC、分享、审计 |
| L2 | 完善异步协作 | 评论、@提及、通知、版本历史、文档权限 |
| L3 | 验证并交付实时协作 | CRDT、在线状态、光标、冲突合并 |
| L4 | 建立知识治理 | 审批、归档、密级、水印、保留策略 |
| L5 | 支持规模化部署 | 调度、扩缩容、跨空间搜索、灾备 |
| L6 | 建立智能知识库 | 权限感知检索、问答、摘要、知识关联 |

L3必须先通过普通块、块引用、嵌入块、属性视图、历史和撤销语义的无损原型验证。未通过时不得进入生产实现。

## 8. L0基础工程

### 8.1 范围

1. 建立奇点源码仓库和官方`upstream`远程。
2. 固定思源上游基线和可机器校验的版本记录。
3. 建立品牌、许可证、构建与发布元数据。
4. 建立React、Vite 8、Tailwind CSS 4与TypeScript严格模式基座。
5. 建立部署主机受控运维、真实身份、组织、空间与Kernel Gateway最小启动切片，为浏览器提供授权后的`spaceId`。
6. 建立Protyle React生命周期边界、唯一空间Session组合根并迁移Web入口。
7. 建立前端类型检查、Lint、测试与生产构建。
8. 建立Go Kernel编译、测试和兼容测试入口。
9. 建立Docker构建、SBOM、漏洞与许可证扫描。
10. 建立上游影响报告、merge流程和回归门禁。

### 8.2 上游同步策略

- Go Kernel保持最小补丁，定期merge思源上游。
- Protyle保留明确目录和公共边界，按上游变更同步。
- React应用壳迁移完成后不直接合并上游旧壳，由影响报告指导人工移植。
- 企业模块全部位于独立目录，不写入思源核心业务目录。
- 每次上游同步记录旧基线、新基线、变更模块、冲突和验证结果。

### 8.3 L0验收

- 可从干净Linux环境重复构建奇点产物。
- React壳可打开、编辑、保存和搜索文档。
- React壳从真实组织/空间路由和授权启动响应创建Session，不存在硬编码或本地近似`spaceId`。
- 块引用、属性视图、图谱、插件和快捷键无功能回退。
- Vite生产构建不依赖旧Webpack Web入口。
- 构建产物可追溯到奇点提交和思源上游提交。
- 奇点品牌与AGPL法律声明同时正确展示。
- 可完成一次上游merge演练并通过自动回归。

## 9. L1企业基础版

### 9.1 范围

- 组织初始化、成员邀请、禁用与角色调整。
- 用户组创建、更新、成员增减与停用。
- 空间创建、归档、成员与用户组授权。
- 本地账号和OIDC登录、会话撤销与强制下线。
- 一个空间一个隔离Kernel实例。
- 文档只读分享、密码、有效期、撤销与禁止索引。
- 登录、编辑、导出、分享、删除和权限变更审计。
- 空间备份、恢复、容量和健康状态。

### 9.2 不在本期

- 实时多人编辑、评论、@提及和通知。
- 文档级或块级权限。
- LDAP、SCIM和复杂组织同步。
- 本地内容、离线编辑和端侧同步。
- Electron、原生移动客户端、Rust或`gomobile`。
- 跨空间全文搜索和Docmost双向同步。

### 9.3 L1验收

- 不同空间不能通过API、搜索、引用或附件互访。
- `viewer`不能通过HTTP或插件入口提交写事务；Protyle WebSocket对所有角色都只接收服务端推送并拒绝浏览器数据帧。
- 内核端口无法从公网访问。
- 会话撤销/到期、用户禁用、组织/空间停用以及组织/空间成员撤销或角色变化会关闭pending/active连接；关闭前后无迟到推送。
- 认证或权限失效后等待Session有序销毁并清除编辑器DOM；Kernel或网络故障保留当前内容。
- HTML、JavaScript、SVG、XML、PDF、未知附件和导出HTML不能在应用源执行。
- 过期或撤销的分享立即不可访问。
- 分享页不泄露内核地址、文件路径和未授权引用。
- 权限变更、导出、分享和删除均产生审计事件。
- 备份可恢复到独立测试空间并通过一致性检查。

## 10. 实施顺序

1. 完成L0仓库、基线、文档、设计系统和上游同步工具。
2. 建立pnpm workspace与React/Vite/Tailwind最小应用。
3. 建立S0 NestJS/Fastify、Prisma/PostgreSQL和OpenAPI基础工程，并在同批落非空数据库/API证据与S0形态的`verify:s0-s3` production build。
4. 实现S1受控运维、本地账号会话、可信代理与公开Origin、授权空间列表、两级成员授权、Kernel三态生产写入与真实空间启动合同；同批扩展API unit、operations/database integration、HTTP contract、React路由component、desktop/mobile/320px browser integration和Web build，并删除静态“默认空间”及空E2E runner。
5. 实现S2 Kernel实例解析、mTLS与服务JWT、显式Kernel路径/头策略、主动内容隔离及同源HTTP/WebSocket Gateway，并在同批扩展真实HTTPS/WSS和Go服务认证测试。
6. 实现S3无Core唯一Session组合根，装配生产HostPort、正式零插件PluginPort、Registry、Transport、ResourcePort、Menu、Overlay和完整Runtime，并在同批扩展Session component与Web build。
7. 原子接通公共Factory与Protyle Core，迁移L0所需嵌入式所有者并完成Vite Web生产入口切换。
8. 以P3/P4 browser integration验证真实DOM、编辑、插件和复杂内容，再以P5全链E2E删除旧Web入口、Adapter和重复runner。
9. 补齐用户组、OIDC、完整空间管理、分享、审计、备份和恢复。
10. 完成集中代码评审、安全审查、许可证审查和批量验证。

L0与L1是能力范围而非严格串行编号。Protyle生产迁移依赖最小企业空间启动切片；不得保留旧入口、新入口双运行、本地Session变体或同义字段兼容层。

## 11. 验证策略

### 11.1 自动验证

- 前端：类型检查、ESLint、Vitest、Testing Library、Playwright desktop/mobile browser integration与生产构建。
- 后端：NestJS单元/真实HTTPS/WSS集成、API合同、Prisma随机schema迁移回放与production build。database与API的普通case继续使用15秒上限；仅完整迁移回放case使用60秒上限，以容纳20秒迁移watchdog、1秒强制终止宽限及有界schema创建、探测和清理。
- Kernel：`kernel/serviceauth`由`verify:s0-s3`直接运行Go测试，广泛Kernel基线继续覆盖核心API黄金样例、`.sy`与SQLite一致性。
- E2E：使用独立Playwright配置覆盖登录、空间、编辑、分享与越权；只有至少两个稳定合同共享技术生命周期时才抽取fixture或page object。
- 构建：Docker冷构建、SBOM、依赖漏洞和许可证扫描。

### 11.2 浏览器验证

验证桌面与移动视口下的React壳、Protyle编辑、权限状态、分享页面和文本溢出。采集控制台错误、页面错误、失败请求、WebSocket断连和非预期API响应。

### 11.3 可观测性

长期保留以下稳定日志标签：

- `auth.session`：`userId`、`authSessionId`、结果、`requestId`，不记录令牌。
- `auth.rate-limit`：哈希键类别、恢复时间、结果、`requestId`，不记录账号、密码和原始来源。
- `access.operation`：`operationId`、动作、目标ID和结果，不记录stdin原文、密码、token或摘要。
- `authorization.decision`：`organizationId`、`spaceId`、角色、动作、结果、`requestId`。
- `kernel.route`：`kernelInstanceId`、路由、耗时、状态、`requestId`，不记录文档正文。
- `kernel.lifecycle`：实例状态转移、原因、耗时和触发`requestId`。
- `protyle.lifecycle`：`spaceId`、`documentId`、阶段、结果和`requestId`，不记录正文或选区。
- `share.access`：`shareId`、结果、来源摘要和`requestId`，不记录密码。
- `backup.job`：`spaceId`、任务状态、对象键、校验结果和触发`requestId`。

NestJS边缘为每个HTTP请求和WebSocket升级生成不可由浏览器覆盖的`requestId`，并把同一值写入Problem、响应头、服务JWT `jti`与Kernel日志。`authSessionId`、浏览器`ProtyleSession`和WebSocket `connectionId`保持不同字段名，不使用同义`sessionId`。

## 12. 安全与合规

- Go Kernel仅监听私有网络，拒绝外部直连。
- 浏览器采用同源安全Cookie；敏感令牌不进入`localStorage`。
- 生产会话使用`__Host-` Cookie、精确Origin和CSRF token保护；WebSocket升级同样校验Origin。
- 所有企业实体查询必须带`organizationId`或`spaceId`所有权约束。
- 文件路径、对象键和内核地址不得作为公共API字段。
- Kernel部署只保存可信部署句柄，私网客户端强制mTLS、禁用重定向与环境代理，并按路由白名单重建请求/响应头。
- 应用源禁止执行上传或导出的主动内容；PDF只通过PDF.js绘制，不以内联原文件预览。
- 分享使用独立凭证与只读路径，不复用成员会话。
- 日志、测试产物和快照不得包含密码、令牌、正文或内部提示信息。
- 保留思源AGPL-3.0许可证和适当法律声明。
- Docmost企业许可目录不得复制进入奇点。

## 13. 风险与控制

| 风险 | 控制措施 |
|------|----------|
| React迁移破坏Protyle | 生命周期边界、黄金样例与浏览器回归 |
| Tailwind污染旧样式 | 禁用全局Preflight、Design Tokens桥接 |
| Kernel非多租户导致越权 | 一空间一实例、私网隔离、Gateway授权 |
| 上传或导出主动内容劫持成员会话 | MIME allowlist、强制下载、`nosniff`、sandbox CSP与受信PDF渲染 |
| 撤权与WebSocket注册竞态产生迟到推送 | pending登记、最终复验、四索引Registry和关闭后零推送合同 |
| 私网Bearer凭证被窃听或重放 | mTLS传输身份、短期服务JWT、网络策略和精确证书校验 |
| 上游合并成本增加 | Kernel最小补丁、影响报告、固定基线 |
| 内容与企业数据双事实源 | 严格数据所有权、禁止内容双写 |
| 测试覆盖不足 | 先补核心API与内容兼容黄金样例 |
| 空suite或分散CI误报绿色 | 分阶段原子扩展非空`verify:s0-s3`，统一收集build、Go与服务证据 |
| 浏览器静态壳误报身份链可用 | S1删除静态shell runner，browser integration纳入`verify:s0-s3`并保留真实HTTP独立证据 |
| 实时协作破坏块语义 | L3独立原型门禁，不提前承诺实现 |
| AGPL或商标风险 | 法律声明、源码提供机制、商标审查 |

## 14. 架构决策

本方案要求形成并维护以下ADR：

1. 服务器权威，不支持本地内容事实源。
2. React接管应用壳，Protyle保留为编辑器内核。
3. NestJS管理企业域，Go Kernel管理内容域。
4. 一个空间对应一个隔离Kernel实例。
5. PostgreSQL与`.sy`不双写内容。
6. 实时协作必须经过独立技术验证。
7. Go Kernel不进行TypeScript或Rust重写。
8. Kernel与Protyle采用差异化上游同步策略。
9. 企业空间Session组合根与Kernel Gateway启动切片先于生产Protyle迁移。
10. 企业工作区、L0 CI与正式CD统一使用严格的Node 24主版本基线。
11. S1使用部署主机非TTY受控运维、数据库单例初始化、Kernel三态唯一写入口、有界密码验证、线性化服务器会话和授权空间路由；S2与首个WebSocket消费者同批建立AccessChanged事件。

## 15. 完成定义

L0完成须满足第8.3节全部验收，且代码评审、测试和许可证审查通过。L1完成须满足第9.3节全部验收，且不存在已知跨空间数据泄露、未授权写入或不可恢复备份。

任何交付文档、报告、日志、fixture、snapshot和debug面板只包含结论、决策、假设、证据与必要理由，不包含隐藏推理、内部提示或敏感内容。

## References

1. [SiYuan official repository](https://github.com/siyuan-note/siyuan)
2. [GNU Affero General Public License v3.0](https://www.gnu.org/licenses/agpl-3.0.html)
3. [Docmost official repository](https://github.com/docmost/docmost)
4. [React documentation](https://react.dev/)
5. [NestJS documentation](https://docs.nestjs.com/)
6. [Prisma documentation](https://www.prisma.io/docs/)
7. [Vite documentation](https://vite.dev/)
8. [Tailwind CSS documentation](https://tailwindcss.com/docs)
9. [奇点设计系统](./Singularity_Design_System_v1.0.0_2026-07-13.md)
10. [企业空间Session组合根与Kernel Gateway启动方案](../../docs/architecture/space-session-composition-root.md)
11. [ADR-011：企业空间Session组合根前移](../../docs/adr/0011-space-session-composition-root.md)
12. [ADR-012：企业Node工具链与集成测试时限基线](../../docs/adr/0012-enterprise-node-toolchain-baseline.md)
13. [S1身份与空间启动产品需求](../../docs/product/s1-identity-space-startup.md)
14. [ADR-013：S1受控运维、身份会话与空间发现](../../docs/adr/0013-s1-identity-space-access.md)
