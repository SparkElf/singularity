---
title: "奇点企业知识库完整方案"
description: "定义奇点云端企业知识库的产品边界、目标架构、长期路线与本期交付计划"
author: "Codex"
date: "2026-07-13"
version: "1.0.0"
status: "approved"
tags: ["singularity", "knowledge-base", "architecture", "roadmap"]
---

# 奇点企业知识库完整方案

> 本方案是奇点产品、架构和实施工作的权威依据；实现与本方案冲突时，先修订并重新审阅方案。

## Change Log

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0.0 | 2026-07-13 | Codex | 建立云端权威架构、L0-L6路线和L0/L1实施合同 |

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
│   ├── protyle-react/
│   └── kernel-client/
└── pnpm-workspace.yaml
```

### 5.4 Kernel Gateway边界

Kernel Gateway承担真实边界职责：

- 根据`spaceId`解析唯一Kernel实例。
- 验证组织成员与空间角色。
- 签发最小生命周期的内部服务凭证。
- 转发HTTP与WebSocket并转换错误语义。
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
5. 建立Protyle React生命周期边界并迁移Web入口。
6. 建立前端类型检查、Lint、测试与生产构建。
7. 建立Go Kernel编译、测试和兼容测试入口。
8. 建立Docker构建、SBOM、漏洞与许可证扫描。
9. 建立上游影响报告、merge流程和回归门禁。

### 8.2 上游同步策略

- Go Kernel保持最小补丁，定期merge思源上游。
- Protyle保留明确目录和公共边界，按上游变更同步。
- React应用壳迁移完成后不直接合并上游旧壳，由影响报告指导人工移植。
- 企业模块全部位于独立目录，不写入思源核心业务目录。
- 每次上游同步记录旧基线、新基线、变更模块、冲突和验证结果。

### 8.3 L0验收

- 可从干净Linux环境重复构建奇点产物。
- React壳可打开、编辑、保存和搜索文档。
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
- `viewer`不能通过HTTP、WebSocket或插件入口提交写事务。
- 内核端口无法从公网访问。
- 禁用用户的现有会话立即失效。
- 过期或撤销的分享立即不可访问。
- 分享页不泄露内核地址、文件路径和未授权引用。
- 权限变更、导出、分享和删除均产生审计事件。
- 备份可恢复到独立测试空间并通过一致性检查。

## 10. 实施顺序

1. 完成L0仓库、基线、文档和上游同步工具。
2. 建立pnpm workspace与React/Vite/Tailwind最小应用。
3. 提取Protyle生命周期边界并完成Web入口切换。
4. 建立NestJS/Prisma模块化单体与OpenAPI合同。
5. 实现组织、用户组、空间和授权合同。
6. 实现Kernel Gateway与空间实例隔离。
7. 实现分享、审计、备份和恢复。
8. 完成集中代码评审、安全审查和批量验证。

每个阶段完成后更新执行计划；不得保留旧入口、新入口双运行或同义字段兼容层。

## 11. 验证策略

### 11.1 自动验证

- 前端：类型检查、ESLint、Vitest、Testing Library、生产构建。
- 后端：NestJS单元测试、API集成测试、Prisma迁移回放。
- Kernel：Go测试、核心API黄金样例、`.sy`与SQLite一致性验证。
- E2E：复用Playwright helper、fixture和page object覆盖登录、空间、编辑、分享与越权。
- 构建：Docker冷构建、SBOM、依赖漏洞和许可证扫描。

### 11.2 浏览器验证

验证桌面与移动视口下的React壳、Protyle编辑、权限状态、分享页面和文本溢出。采集控制台错误、页面错误、失败请求、WebSocket断连和非预期API响应。

### 11.3 可观测性

长期保留以下稳定日志标签：

- `auth.session`：`userId`、`sessionId`、结果，不记录令牌。
- `authorization.decision`：`organizationId`、`spaceId`、角色、动作、结果。
- `kernel.route`：`kernelInstanceId`、路由、耗时、状态，不记录文档正文。
- `kernel.lifecycle`：实例状态转移、原因和耗时。
- `share.access`：`shareId`、结果和来源摘要，不记录密码。
- `backup.job`：`spaceId`、任务状态、对象键和校验结果。

## 12. 安全与合规

- Go Kernel仅监听私有网络，拒绝外部直连。
- 浏览器采用同源安全Cookie；敏感令牌不进入`localStorage`。
- 所有企业实体查询必须带`organizationId`或`spaceId`所有权约束。
- 文件路径、对象键和内核地址不得作为公共API字段。
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
| 上游合并成本增加 | Kernel最小补丁、影响报告、固定基线 |
| 内容与企业数据双事实源 | 严格数据所有权、禁止内容双写 |
| 测试覆盖不足 | 先补核心API与内容兼容黄金样例 |
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
