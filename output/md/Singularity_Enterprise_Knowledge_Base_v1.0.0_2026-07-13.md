---
title: "奇点企业知识库完整方案"
description: "定义奇点云端企业知识库的产品边界、目标架构、长期路线与本期交付计划"
author: "Codex"
date: "2026-07-21"
version: "1.6.0"
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
| 1.4.3 | 2026-07-15 | Codex | 固定独立Fork工作流隔离、品牌法律、企业镜像、Trivy供应链与可审计上游merge门禁 |
| 1.4.4 | 2026-07-15 | Codex | 记录S1/L0复评通过证据、离线许可证来源链、生产运行图闭包和22路径上游冲突 |
| 1.4.5 | 2026-07-15 | Codex | 记录本地最终verification通过并保留PostgreSQL CI与正式上游merge为未完成 |
| 1.4.6 | 2026-07-15 | Codex | 记录稳定提交与GitHub Actions全绿，收口PostgreSQL 17和CI供应链证据 |
| 1.4.7 | 2026-07-17 | Codex | 将已完成的思源3.7.2显式merge晋升为当前上游基线 |
| 1.4.8 | 2026-07-17 | Codex | 恢复L0原始基础工程边界，明确S0-S3与生产Protyle迁移属于L1，并记录L0完成状态 |
| 1.4.9 | 2026-07-17 | Codex | 记录L1内容库身份收口、固定PostgreSQL 17测试库与远程全门禁证据 |
| 1.5.0 | 2026-07-18 | Codex | 增加声明式空间内容目录，补齐授权spaceId到真实notebookId/documentId的选择链 |
| 1.5.1 | 2026-07-18 | Codex | 固定跨链路校验的唯一owner，避免对上游已收敛内容身份重复拦截 |
| 1.5.2 | 2026-07-18 | Codex | 固定Worker恢复端点的PostgreSQL事实源、事务通知、API hydrate和单一registry |
| 1.5.3 | 2026-07-19 | Codex | 固定Protyle实例来源句柄、文档事件扇出与Kernel标题canonical合同 |
| 1.5.4 | 2026-07-19 | Codex | 增加授权空间搜索/图谱服务边界与显式内容身份投影合同 |
| 1.5.5 | 2026-07-19 | Codex | 固定跨HTTP、WebSocket与浏览器生命周期的真实请求关联语义 |
| 1.5.6 | 2026-07-19 | Codex | 固定跨Kernel内容审计的PostgreSQL intent、声明式Worker最终化与indeterminate语义 |
| 1.5.7 | 2026-07-19 | Codex | 记录L1全功能implementation收口及集中评审、验证仍待执行的阶段状态 |
| 1.5.8 | 2026-07-20 | Codex | 记录Kernel全量验证通过、Discovery默认类型合同修复及剩余环境阻塞 |
| 1.5.9 | 2026-07-21 | Codex | 闭合供应链许可证证据、固定验证矩阵与Node 24 watchdog目录锁修复 |
| 1.5.10 | 2026-07-21 | Codex | 按第9.3节逐项收口L1验收并同步交接、P5与恢复计划状态 |
| 1.6.0 | 2026-07-21 | Codex | 建立L2异步协作PRD、架构、ADR与可恢复实施计划，保留L3实时协作门禁 |

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
16. 内容请求前的`notebookId + documentId`只能来自当前授权空间的服务目录项；目录经Nest声明式控制面、mTLS与短期服务JWT读取Kernel最小目录，按真实父文档分页，不读取正文、不暴露路径、不使用哨兵，也不放宽所有内容链继续强制三ID的规则。
17. 跨Kernel编辑、删除与导出在调用Kernel前持久化最小PostgreSQL intent；Gateway只记录可信明确结果，声明式Worker在同一事务追加唯一HMAC审计事件并删除intent。超时、断连、私网认证失败、Kernel `5xx`、畸形响应或结果持久化失败最终记为`indeterminate`，不得把已提交内容改写成审计`503`、直接双写事件或从日志推断结果。

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
→ 成员从授权空间目录选择并编辑文档
→ 管理员分享文档
→ 审计人员查看操作记录
```

## 4. 技术基线

### 4.1 思源基线

锁定已集成上游基线：SiYuan 3.7.2提交`c8dcdd0860ef000a14552c619fe19c0dcb5175f5`。

已确认的思源技术特征：

- Go 1.26内容内核与Gin HTTP API。
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

`ProtyleEditor` React边界仅承担创建、切换、只读状态、销毁和事件释放，不把编辑器内部文档状态复制进Zustand。TanStack Query拥有服务端数据与目录分页；Zustand只保存内存CSRF和跨文档树/编辑器共享的当前`spaceId + notebookId + documentId`选择，目录数组、Session与编辑器实例不进入store。

编辑器实现只有一套；页签、分屏与嵌入表面创建绑定各自内容上下文的运行时实例。同一文档允许存在多个实例，Core内部事件跨入Session时由实例Host facade一次附加稳定`sourceEditorId`：选区、块DOM、菜单、全屏和活动状态等实例动作只能命中来源实例，标题与图标等文档动作按显式`notebookId + documentId`同步全部匹配实例。不得从DOM、active实例、注册顺序或首个响应补推来源；`sourceEditorId`不进入Zustand，也不替代内容身份。

文档标题由Kernel单次规范化并持久化。重命名HTTP成功响应返回同一次处理得到的canonical `title + empty`，仅校正发起实例且受提交代次约束；Kernel `rename`推送携带相同结果并驱动工作台目录与其他实例更新。浏览器输入规则只承担单行、长度提示和斜杠输入体验，不得把请求值当成最终持久化标题。

Tailwind只用于新React页面。Protyle保留现有Sass，并通过Design Tokens桥接颜色、字体、间距和层级；Tailwind不得用全局Preflight破坏Protyle及插件DOM。

### 5.3 企业控制面边界

NestJS采用模块化单体。`api`处理HTTP与WebSocket，`worker`处理备份、通知与审计归档；未出现独立扩缩容需求前不拆微服务。

固定HTTP能力优先使用Nest原生`@Module`、`@Controller`、路由装饰器、Guard/Pipe/Interceptor、构造器DI和Prisma schema表达；可扩展处理器以custom metadata和DiscoveryService发现。声明是唯一装配事实源，缺失或冲突在启动期失败；不得保留中央`switch`、散落手工注册或第二套registry。声明只承担装配与跨切面策略，领域状态转换仍由显式Service/handler拥有。

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

空间内容目录是控制面到Kernel的独立服务只读链，不向浏览器暴露Kernel Gateway目录路径。公共GET先复验当前用户空间读取权限，再通过`identity: service`的精确私网策略列开放笔记本、根文档或真实父文档子项；每页最多128项，锁定加密库只返回笔记本锁态。目录项只含选择和展示所需字段，所有正文、资源、上传与WebSocket仍走原Gateway并强制`spaceId + notebookId + documentId`。

内容链路按`source -> transport/API -> schema/parser -> service -> state -> consumer`分配唯一校验owner。上游schema、类型、DI或数据库约束已经收敛的值由下游直接消费；只有进入新的HTTP、跨进程、外部字节、持久化或安全生命周期边界时，才验证该边界自己的合同。具体规则见ADR-021，禁止在编辑热路径重复解析、归一化、拦截或用近似字段推断身份。

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
| L2 | 完善异步协作 | 评论、@提及、通知、版本历史、文档权限（[PRD](../../docs/product/l2-async-collaboration.md)、[架构](../../docs/architecture/l2-async-collaboration.md)） |
| L3 | 验证并交付实时协作 | CRDT、在线状态、光标、冲突合并 |
| L4 | 建立知识治理 | 审批、归档、密级、水印、保留策略 |
| L5 | 支持规模化部署 | 调度、扩缩容、跨空间搜索、灾备 |
| L6 | 建立智能知识库 | 权限感知检索、问答、摘要、知识关联 |

L3必须先通过普通块、块引用、嵌入块、属性视图、历史和撤销语义的无损原型验证。未通过时不得进入生产实现。

L2方案已进入`verification`：产品需求、架构方案、ADR-029和实施计划已冻结，评论、提及、通知、历史和文档ACL的生产实现、迁移、永久测试及唯一P5 E2E已完成，代码复评与test-governance已通过；静态、控制面、构建和P5 E2E已通过，三视口browser integration聚合仍有既有页面元素稳定性失败，在verification完全通过前不得标记L2完成。

## 8. L0基础工程

### 8.1 范围

1. 建立奇点源码仓库和官方`upstream`远程。
2. 固定思源上游基线和可机器校验的版本记录。
3. 建立品牌、许可证、构建与发布元数据。
4. 建立React 19、Vite 8、Tailwind CSS 4、TypeScript严格模式基座及已批准的奇点设计系统。
5. 建立前端类型检查、Lint、测试、生产构建与Go Kernel编译、测试、兼容测试入口。
6. 建立可追溯CI/CD、Docker构建、SBOM、漏洞与许可证扫描。
7. 建立上游影响报告、显式merge流程和自动回归门禁。

部署主机受控运维、真实身份与空间、Kernel Gateway、唯一空间Session组合根、生产Protyle迁移和旧Webpack Web入口移除均属于L1的S0-S3/B4实施切片，不作为L0完成前置条件。

### 8.2 上游同步策略

- Go Kernel保持最小补丁，定期merge思源上游。
- Protyle保留明确目录和公共边界，按上游变更同步。
- React应用壳迁移完成后不直接合并上游旧壳，由影响报告指导人工移植。
- 企业模块全部位于独立目录，不写入思源核心业务目录。
- 每次上游同步记录旧基线、新基线、变更模块、冲突和验证结果。
- 当前已集成基线为SiYuan 3.7.2提交`c8dcdd0860ef000a14552c619fe19c0dcb5175f5`。从旧基线`41f2861c87575ff5ac4b50a0520b1a4fe55b4a70`生成的影响报告覆盖451个变更路径并发现22个冲突路径；这些冲突已在显式merge提交`ebe5e941b6dbdc9c139d76883b2746f9db7fa7fa`中解决，该提交已进入`master`与`origin/master`。在固定下一候选前，`upstreamCandidateCommit`与晋升后的基线保持一致。

### 8.3 L0验收

- 独立Fork具有奇点`origin`、只读思源`upstream`和机器可校验的固定上游基线。
- 可从干净Linux环境重复构建React/Vite企业基座与Go Kernel产物。
- React 19、TypeScript严格模式、Vite 8、Tailwind CSS 4、shadcn和奇点设计令牌由标准入口检查并构建。
- 类型检查、Lint、测试、生产构建、Kernel回归及供应链检查均接入奇点自有CI/CD。
- 构建产物可追溯到奇点提交和思源上游提交。
- 奇点品牌与AGPL法律声明同时正确展示。
- SBOM、漏洞和许可证报告非空，许可证策略不存在拒绝项或未知项。
- 可完成一次上游merge演练并通过自动回归。

状态（2026-07-17）：以上验收已经通过，固定SiYuan 3.7.2候选已由双父显式merge提交`ebe5e941b6dbdc9c139d76883b2746f9db7fa7fa`合入并推送，L0已完成。后续内容隔离、生产编辑器迁移和企业功能均按L1跟踪。

## 9. L1企业基础版

### 9.1 范围

- S0 NestJS/Fastify、Prisma/PostgreSQL企业控制面。
- S1真实身份、组织/空间授权、受控运维与Kernel三态生命周期。
- S2同源HTTP/WSS Kernel Gateway、mTLS、服务JWT、连接登记与撤权关闭。
- S3/B4唯一空间Session组合根、生产Protyle迁移、内容库隔离与旧Webpack Web入口移除。
- 授权空间笔记本目录、按真实父文档分页的文档树、首文档选择与锁定库隐私状态。
- 组织初始化、成员邀请、禁用与角色调整。
- 用户组创建、更新、成员增减与停用。
- 空间创建、归档、成员与用户组授权。
- 本地账号和OIDC登录、会话撤销与强制下线。
- 一个空间一个隔离Kernel实例。
- 文档只读分享、密码、有效期、撤销与禁止索引。
- 登录、编辑、导出、分享、删除和权限变更审计。
- 跨Kernel内容审计以PostgreSQL intent保证调用前耐久线索，由声明式Worker最终追加明确结果或`indeterminate`；审计查询和归档只消费`audit_events`。
- 空间备份、恢复、容量和健康状态。
- 授权空间内的服务端搜索与图谱查询；查询只按空间授权，结果携带源block的
  `notebookId + documentId`，不依赖当前编辑器。
- 文档范围搜索、反链、历史和局部图谱复用唯一Gateway内容链；每个请求携带目录产生的
  `notebookId + documentId`，企业响应只返回canonical最小导航投影。

### 9.2 不在本期

- 实时多人编辑、评论、@提及和通知。
- 文档级或块级权限。
- LDAP、SCIM和复杂组织同步。
- 本地内容、离线编辑和端侧同步。
- Electron、原生移动客户端、Rust或`gomobile`。
- 跨空间全文搜索和Docmost双向同步。

### 9.3 L1验收

- 不同空间不能通过API、搜索、引用或附件互访。
- 空间搜索/图谱只允许访问当前授权空间；公共请求不得携带或推断文档身份，图谱
  节点的`notebookId + documentId`必须来自Kernel源block，不能由path、首节点或
  浏览器状态补齐。
- 文档面板的Gateway请求必须同时携带`spaceId + notebookId + documentId`；局部图谱
  内容节点使用各自源身份，tag等非内容节点不可导航，read policy不得持久化图谱
  浏览器配置。
- React工作台提供不依赖当前编辑器的空间搜索与空间关系图入口；文档搜索、大纲、反链、历史和局部图谱只从当前目录/Session组合取得显式内容身份，路由或文档代次变化后的迟到响应不能覆盖当前面板。
- `viewer`不能通过HTTP或插件入口提交写事务；Protyle WebSocket对所有角色都只接收服务端推送并拒绝浏览器数据帧。
- 内核端口无法从公网访问。
- 会话撤销/到期、用户禁用、组织/空间停用以及组织/空间成员撤销或角色变化会关闭pending/active连接；关闭前后无迟到推送。
- 认证或权限失效后等待Session有序销毁并清除编辑器DOM；Kernel或网络故障保留当前内容。
- 用户只能从当前授权空间目录项取得完整文档身份；空库或锁定库不创建Protyle，迟到目录页不能跨空间覆盖，锁定库不泄露文档标识、标题、层级或数量。
- HTML、JavaScript、SVG、XML、PDF、未知附件和导出HTML不能在应用源执行。
- 过期或撤销的分享立即不可访问。
- 分享页不泄露内核地址、文件路径和未授权引用。
- 权限变更、导出、分享和删除均产生审计事件。
- 内容审计intent写入失败时Kernel不得执行；Kernel明确结果后的intent resolve失败不得覆盖原内容响应，Worker恢复后仍须追加唯一明确或`indeterminate`事件。
- 备份可恢复到独立测试空间并通过一致性检查。

## 10. 实施顺序

1. 完成L0仓库、基线、文档、设计系统、React/Vite/Tailwind基座、CI/CD和上游同步工具。
2. 从L1开始建立S0 NestJS/Fastify、Prisma/PostgreSQL和OpenAPI基础工程，并在同批落非空数据库/API证据与S0形态的`verify:s0-s3` production build。
3. 实现S1受控运维、本地账号会话、可信代理与公开Origin、授权空间列表、两级成员授权、Kernel三态生产写入与真实空间启动合同；同批扩展API unit、operations/database integration、HTTP contract、React路由component、desktop/mobile/320px browser integration和Web build，并删除静态“默认空间”及空E2E runner。
4. 实现S2 Kernel实例解析、mTLS与服务JWT、显式Kernel路径/头策略、主动内容隔离及同源HTTP/WebSocket Gateway，并在同批扩展真实HTTPS/WSS和Go服务认证测试。
5. 实现S3服务目录与无Core唯一Session组合根：以声明式Nest控制面和Kernel服务身份提供笔记本/文档分页，在React中从真实目录项选择三ID，再装配生产HostPort、正式零插件PluginPort、Registry、Transport、ResourcePort、Menu、Overlay和完整Runtime；同批扩展Kernel/Nest/React目录、Session component、三视口browser integration与Web build。
6. 以空间为单位并行交付搜索/图谱、分享、审计、备份恢复、观测和组织控制面等纵向切片；每个切片从contracts到永久测试拥有单一owner，共享组合根只在交接后集成。空间搜索/图谱不得借用当前编辑器的`notebookId/documentId`；文档搜索、反链、历史和局部图谱只走现有Gateway内容链，Kernel投影必须保留每个源节点自己的`Box + RootID`。
7. 原子接通当前目录选择、公共Factory与Protyle Core，以实例来源句柄区分同文档多实例动作，以Kernel canonical响应和推送闭合标题同步，迁移L1所需嵌入式所有者并完成Vite Web生产入口切换。
8. 以P3/P4 browser integration验证真实DOM、编辑、插件和复杂内容，再以P5全链E2E删除旧Web入口、Adapter和重复runner。
9. 补齐用户组、OIDC、完整空间管理、分享、审计、备份和恢复。
10. 完成集中代码评审、安全审查、许可证审查和批量验证。

L0基础工程已经完成。S0-S3/B4均属于L1实施切片；Protyle生产迁移依赖最小企业空间启动切片，不得保留旧入口、新入口双运行、本地Session变体或同义字段兼容层。

自2026-07-18起，剩余L1按一个大阶段推进：先完成目录、组织/邀请/用户组/空间/OIDC、分享、审计、备份恢复、观测、Worker、B4与P3-P5的生产代码、迁移、永久测试代码、调用方、旧路径删除和文档，再进行一次集中代码、安全与许可证复评；复评通过后才统一运行全部测试、浏览器、E2E、Kernel、构建和供应链矩阵。实现期不因单个功能反复运行runner，只允许为解除明确阻塞执行一次最小格式、类型、迁移或编译诊断，且不计入交付证据。

## 11. 验证策略

### 11.1 自动验证

- 前端：类型检查、ESLint、Vitest、Testing Library、Playwright desktop/mobile browser integration与生产构建。
- 后端：NestJS单元/真实HTTPS/WSS集成、API合同、Prisma随机schema迁移回放与production build。database与API的普通case继续使用15秒上限；仅完整迁移回放case使用60秒上限，以容纳20秒迁移watchdog、1秒强制终止宽限及有界schema创建、探测和清理。
- Kernel：`kernel/serviceauth`由`verify:s0-s3`直接运行Go测试，广泛Kernel基线继续覆盖核心API黄金样例、`.sy`与SQLite一致性。
- E2E：使用独立Playwright配置覆盖登录、空间、编辑、分享与越权；只有至少两个稳定合同共享技术生命周期时才抽取fixture或page object。
- 构建：Docker冷构建、原始与canonical SBOM、API运行图PURL双向闭包、依赖漏洞和许可证扫描；漏洞报告必须包含非空Target/Type，空报告不能代表零漏洞。

### 11.2 浏览器验证

验证桌面与移动视口下的React壳、Protyle编辑、权限状态、分享页面和文本溢出。采集控制台错误、页面错误、失败请求、WebSocket断连和非预期API响应。

### 11.3 可观测性

长期保留以下稳定日志标签：

- `auth.session`：`userId`、`authSessionId`、结果、`requestId`，不记录令牌。
- `auth.rate-limit`：哈希键类别、恢复时间、结果、`requestId`，不记录账号、密码和原始来源。
- `access.operation`：`operationId`、动作、目标ID和结果，不记录stdin原文、密码、token或摘要。
- `authorization.decision`：`organizationId`、`spaceId`、角色、动作、结果、`requestId`。
- `kernel.route`：`spaceId`、授权成功后可选`kernelInstanceId`、路由、耗时、状态、`requestId`，不记录文档正文。
- `kernel.lifecycle`：实例状态转移、原因、耗时和触发`requestId`。
- `protyle.lifecycle`：`spaceId`、generation、阶段、结果及事件可达的可选`documentId`/`triggeringRequestId`，不记录正文或选区，不以generation生成请求标识。
- `content.directory`：`organizationId`、`spaceId`、可选`notebookId`/`parentDocumentId`、offset、generation、结果、耗时和`requestId`，不记录名称、标题、路径、正文或页内容。
- `share.access`：`shareId`、结果、来源摘要和`requestId`，不记录密码。
- `backup.job`：`spaceId`、任务状态、对象键、校验结果和触发`requestId`。
- `content.discovery`：`organizationId`、`spaceId`、操作、查询长度、耗时、结果和`requestId`，不记录查询正文或图谱内部结构。

NestJS边缘为每个HTTP请求和WebSocket升级生成不可由浏览器覆盖的`requestId`，并把同一值写入Problem、响应头、服务JWT `jti`与Kernel日志。浏览器后续事件只在存在真实上游来源时使用可选`triggeringRequestId`；网络失败、WebSocket关闭或协议解析失败保持缺省，不生成随机UUID。`authSessionId`、浏览器`ProtyleSession`、生命周期generation和WebSocket `connectionId`保持不同字段名，不使用它们近似请求标识。

### 11.4 当前阶段证据

- S1本地最终verification：`lint:s0-s3`、`typecheck:s0-s3`、`build:s0-s3`、contracts `10/10`、API unit `41/41`、真实Nest失败operations聚焦 `1/1`、Web component `22/22`、三视口Playwright browser integration `21/21`和两个企业镜像构建通过；GitHub Actions run `29410946297`的`space-session`已在PostgreSQL 17上完成真实HTTP、operations与database integration并通过。Worker镜像在L1供应链闭环中与API/Web共同构建、标记、smoke和扫描。
- L0代码复评：Node 24标准入口`84/84`；API原始SBOM与只读断网运行图均为115个唯一npm PURL且双向差集为零，Web运行镜像npm组件为零；本地许可证为源码`2005 allowed / 0 denied / 0 unknown`、总计`2293 allowed / 0 denied / 0 unknown`，run `29410946297`为源码`2006 / 0 / 0`、总计`2294 / 0 / 0`；CI raw SBOM保留`exp-html`的scanner `BSD-2-Clause`，canonical SBOM以完整历史来源链证明`BSD-3-Clause`并记录原值；历史L0三份非空漏洞报告合计`0 fixable / 0 unfixed / 0 total`，L1 Worker 纳入后由同一门禁扩展为四份报告。
- 阶段状态：API/Web、上游治理、供应链复评、本地最终verification、稳定提交与GitHub PostgreSQL 17 CI均已通过；固定候选`c8dcdd0860ef000a14552c619fe19c0dcb5175f5`已由显式merge提交`ebe5e941b6dbdc9c139d76883b2746f9db7fa7fa`合入并推送，基线元数据已晋升。第8.3节L0验收和第9.3节L1验收均已闭合，L0/L1完成；实时协作等第9.2节能力留待后续L2/L3计划。
- L2阶段状态：控制面评论、提及、通知、历史和文档ACL的生产实现、Prisma迁移、TypeScript/React永久测试及唯一P5真实链路已完成；代码复评、test-governance、静态/构建/控制面验证和P5 E2E（12/12）已通过，三视口browser integration聚合报告19 passed、40 failed、64 skipped，当前保持verification，待该聚合稳定性门禁闭合后再标记L2完成。
- L1内容库身份与集中验收：App限定ESLint零告警，`verify:b4`集中发现architecture `25/25`、Protyle Browser `10/10`、Web `33/33`与App `78/78`；固定PostgreSQL 17测试库上的`verify:s0-s3`通过contracts `10/10`、database integration `44/44`、API unit `41/41`、API integration `74/74`、Web component `22/22`和三视口browser integration `21/21`；Kernel聚焦回归为model `144/144`、API `49/49`、filesys `4/4`，高风险身份与锁定合同以`-race -count=3`通过，精确CI入口`go test -vet=off -tags='fts5 sqlcipher' ./...`全绿。GitHub Actions run `29592942152`的repository-governance、enterprise-web、space-session、kernel-baseline和supply-chain均通过；P3/P4真实Protyle浏览器义务、P5全链E2E及企业功能已纳入本轮正式证据。
- L1 Discovery验收：空间/文档查询已从contracts到Kernel、Nest、React工作面板、组件/浏览器合同和ADR-023按一个纵向功能落盘并通过集中验证；空间级请求只带组织/空间身份，文档级请求只带当前组合产生的内容身份，迟到响应和不可导航节点合同均已通过。
- L1全功能implementation与集中复评：组织、邀请、用户组、空间、OIDC、会话生命周期、目录与Session、Gateway与Kernel生命周期、Protyle内容身份、搜索与图谱、分享、主动内容、审计耐久性、备份恢复、容量健康、Worker镜像与供应链、P3-P5永久测试代码及Vite唯一企业入口均已按纵向owner落盘，旧企业Web runner与后置审计双写路径已删除；整阶段代码、安全、许可证复评及正式验证矩阵已完成。
- L1最终验证：固定测试库`postgresql://singularity_test:singularity_test@127.0.0.1:55432/singularity_test`上的`pnpm verify:s0-s3`、标准供应链runner、P5真实E2E、Kernel全量测试、Docker构建、生产SBOM闭包、漏洞与许可证策略均通过；本轮未终止连接、重启或重配服务。许可证、漏洞、运行图和浏览器证据均来自当前提交生成的真实产物，不以旧CI结果替代。

## 12. 安全与合规

- Go Kernel仅监听私有网络，拒绝外部直连。
- 浏览器采用同源安全Cookie；敏感令牌不进入`localStorage`。
- 生产会话使用`__Host-` Cookie、精确Origin和CSRF token保护；WebSocket升级同样校验Origin。
- 所有企业实体查询必须带`organizationId`或`spaceId`所有权约束。
- 文件路径、对象键和内核地址不得作为公共API字段。
- Kernel部署保存可信部署句柄；Worker恢复的网络坐标另由带显式`tlsProfile`的运行端点表持久化，API与Worker各自hydrate同一进程内registry。私网客户端强制mTLS、禁用重定向与环境代理，并按路由白名单重建请求/响应头；证书内容、路径和工作区不入库，不能从句柄或首个部署推断端点。
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
| 空间启动只有spaceId导致文档身份被推断 | 独立服务目录按层分页产生真实notebookId/documentId，禁止DOM、首响应、路径、哨兵与Gateway放宽 |
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
12. 奇点仓库只运行精确绑定本仓的工作流；企业API/Worker/Web镜像、原始与canonical CycloneDX SBOM、只读断网运行图闭包、非空漏洞与许可证报告、固定候选影响报告和显式`--no-ff`上游merge共同构成供应链证据。
13. 授权空间内容目录是Protyle前唯一文档身份选择边界；固定Nest声明式路由、Kernel服务身份、真实父文档分页、锁态与迟到结果合同。
14. 信任边界校验按完整链路分配唯一owner；跨边界只验证自身合同，下游消费已收敛类型。
15. 请求关联以服务端边缘实际生成的HTTP/WS `requestId`为唯一来源；浏览器只投影可选`triggeringRequestId`，授权deployment存在后才记录`kernelInstanceId`。
16. 跨Kernel内容审计使用调用前PostgreSQL intent与声明式Worker最终化；明确结果和`indeterminate`均只形成一条最终HMAC事件，查询与归档不读取intent。

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
8. [L2异步协作产品需求](../../docs/product/l2-async-collaboration.md)
9. [L2异步协作架构方案](../../docs/architecture/l2-async-collaboration.md)
10. [ADR-029：L2异步协作控制面边界](../../docs/adr/0029-l2-async-collaboration-boundary.md)
8. [Tailwind CSS documentation](https://tailwindcss.com/docs)
9. [奇点设计系统](./Singularity_Design_System_v1.0.0_2026-07-13.md)
10. [企业空间Session组合根与Kernel Gateway启动方案](../../docs/architecture/space-session-composition-root.md)
11. [ADR-011：企业空间Session组合根前移](../../docs/adr/0011-space-session-composition-root.md)
12. [ADR-012：企业Node工具链与集成测试时限基线](../../docs/adr/0012-enterprise-node-toolchain-baseline.md)
13. [S1身份与空间启动产品需求](../../docs/product/s1-identity-space-startup.md)
14. [ADR-013：S1受控运维、身份会话与空间发现](../../docs/adr/0013-s1-identity-space-access.md)
15. [ADR-014：Fork治理、供应链与上游同步门禁](../../docs/adr/0014-fork-governance-supply-chain.md)
16. [ADR-020：空间内容目录引导](../../docs/adr/0020-space-content-directory-bootstrap.md)
17. [Protyle浏览器运行时收口产品需求](../../docs/product/protyle-runtime-closure.md)
18. [ADR-021：信任边界校验所有权](../../docs/adr/0021-trust-boundary-validation-ownership.md)
19. [ADR-022：跨进程Kernel端点事实源](../../docs/adr/0022-cross-process-kernel-endpoint-source.md)
20. [ADR-023：空间搜索与图谱服务边界](../../docs/adr/0023-space-discovery-service-boundary.md)
21. [ADR-024：审计与空间观测投影](../../docs/adr/0024-audit-observability-projection.md)
22. [ADR-025：主动内容与PDF预览边界](../../docs/adr/0025-active-content-pdf-preview.md)
23. [ADR-026：Protyle推送事件身份](../../docs/adr/0026-protyle-push-event-identity.md)
24. [ADR-027：跨Kernel内容操作审计耐久性](../../docs/adr/0027-cross-kernel-content-audit-durability.md)
25. [ADR-028：请求关联与稳定可观测性](../../docs/adr/0028-request-correlation-observability.md)
