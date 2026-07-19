---
title: "Protyle浏览器宿主与Vite抽取方案"
description: "定义奇点React应用与思源Protyle之间的运行时、传输、插件和生命周期边界"
author: "Codex"
date: "2026-07-13"
version: "2.6.5"
status: "approved"
tags: ["architecture", "protyle", "react", "vite", "testing"]
---

# Protyle浏览器宿主与Vite抽取方案

## Change Log

| Version | Date | Author | Changes |
| --- | --- | --- | --- |
| 1.0.0 | 2026-07-13 | Codex | 初立浏览器宿主、Session、传输与插件边界 |
| 1.1.0 | 2026-07-13 | Codex | 补P1-B调用语义、合同所有权、编辑器注册表与分批验收 |
| 1.1.1 | 2026-07-13 | Codex | 保留独立zoom及focus与highlight组合语义 |
| 1.1.2 | 2026-07-13 | Codex | 区分默认target、上下文context与全量subtree加载 |
| 1.1.3 | 2026-07-13 | Codex | 明确全局搜索查询更新语义而非替换界面语义 |
| 1.1.4 | 2026-07-13 | Codex | 将目标定位与已存滚动恢复拆为正交字段 |
| 1.2.0 | 2026-07-13 | Codex | 补牌组选择、外链、资源disposition与强制重复页签语义 |
| 1.3.0 | 2026-07-13 | Codex | 固定P1-B2插件能力端口、顺序流水线与测试合同 |
| 1.4.0 | 2026-07-13 | Codex | 固定P1-B3编辑器注册表、活动实例与销毁隔离合同 |
| 1.4.1 | 2026-07-13 | Codex | 收紧B3可交互实例、只读预览、旧入口与AST门禁边界 |
| 1.4.2 | 2026-07-13 | Codex | 补Protyle传输终止与反链子编辑器生命周期合同 |
| 1.4.3 | 2026-07-13 | Codex | 补浮层迟到回调、脱离DOM的ghost实例与Kernel move首命中合同 |
| 1.5.0 | 2026-07-14 | Codex | 固定B4显式Runtime、表面语义、传输前置与真实闭包门禁 |
| 1.5.1 | 2026-07-14 | Codex | 对齐B4产品状态机、readOnly与分阶段传输证据 |
| 1.5.2 | 2026-07-14 | Codex | 去除Runtime重复spaceId并补能力端口释放合同 |
| 1.6.0 | 2026-07-14 | Codex | 分离授权只读与提交阻断并统一Session销毁顺序 |
| 1.6.1 | 2026-07-14 | Codex | 将嵌入式、文档和Session销毁统一为严格有序步骤 |
| 1.7.0 | 2026-07-14 | Codex | 闭合Session/Runtime/Factory合同、创建点矩阵、错误重试与测试入口 |
| 1.8.0 | 2026-07-14 | Codex | 分离公共Factory与Core构造合同，收敛只读、菜单所有权和唯一B4门禁 |
| 1.8.1 | 2026-07-14 | Codex | 独立架构复评通过并批准进入实现 |
| 1.9.0 | 2026-07-14 | Codex | 前移真实企业空间Session组合根，取消旧壳伪Session迁移并重排B4生产切换 |
| 2.0.0 | 2026-07-14 | Codex | 消除S3/B4循环与旧独立传输阶段，闭合空间资源、服务认证、撤权和双聚合门禁 |
| 2.0.1 | 2026-07-14 | Codex | 统一传输阶段命名，明确WebSocket只接收推送并补齐Runtime资源能力 |
| 2.1.0 | 2026-07-14 | Codex | 固定B4唯一生产接线、撤权清理、结构化请求选项、主动内容与P3-P5证据职责 |
| 2.1.1 | 2026-07-14 | Codex | 架构、安全与测试治理复评通过，批准后续按S0-S3与B4顺序实施 |
| 2.2.0 | 2026-07-15 | Codex | 对齐S1已落地的browser integration并移除已退役静态shell与空E2E入口 |
| 2.2.1 | 2026-07-15 | Codex | 收紧browser诊断为原始Request证据并把WebSocket诊断留到S2真实消费者落地 |
| 2.2.2 | 2026-07-15 | Codex | 增补编辑器向智能体转交块引用的最小Host事件 |
| 2.3.0 | 2026-07-15 | Codex | 对齐思源3.7.2加密内容库，以显式notebookId闭合文档宿主事件路由 |
| 2.3.1 | 2026-07-15 | Codex | 闭合智能体转交与文档导航折叠预查询的显式内容库路由，并固定创建时身份 |
| 2.3.2 | 2026-07-15 | Codex | 以显式首请求所有权替代空blockId哨兵，并固定反链子编辑器的局部刷新所有权 |
| 2.3.3 | 2026-07-17 | Codex | 对齐总方案1.4.8，将B4及P3-P5生产迁移证据统一归入L1 |
| 2.4.0 | 2026-07-18 | Codex | 修正ResourcePort无法满足CSRF上传，固定Transport的FormData、取消与进度合同 |
| 2.5.0 | 2026-07-18 | Codex | 增加授权空间内容目录，固定notebookId/documentId的唯一前置选择来源 |
| 2.5.1 | 2026-07-18 | Codex | 按ADR-021区分Transport序列化与跨边界校验，删除已收敛内容身份的重复拦截 |
| 2.5.2 | 2026-07-18 | Codex | 删除企业侧临时HTML Core，增加显式真实Protyle入口及未接线失败语义 |
| 2.5.3 | 2026-07-18 | Codex | 经专用公共Core子入口完成企业生产接线，删除未接线标记并启用生产闭包审计 |
| 2.5.4 | 2026-07-18 | Codex | 收口查询嵌入与反链展开的Session传输、迟到响应及自定义脚本请求边界 |
| 2.6.0 | 2026-07-19 | Codex | 固定HostEvent实例来源、文档扇出与Kernel标题canonical回流 |
| 2.6.1 | 2026-07-19 | Codex | 固定breadcrumb与父文档导航的显式内容目标链 |
| 2.6.2 | 2026-07-19 | Codex | 以事务sid精确定位Kernel move源实例，删除Registry首实例推断 |
| 2.6.3 | 2026-07-19 | Codex | 对齐真实Vite Core接线并落盘P3编辑器browser integration合同 |
| 2.6.4 | 2026-07-19 | Codex | 校正上游Adapter保留边界并收口企业错位测试与唯一Vite入口证据 |
| 2.6.5 | 2026-07-19 | Codex | 区分真实请求与后续运行时关联，删除浏览器随机请求标识回退 |

## Table of Contents

1. [目标与范围](#1-目标与范围)
2. [本地实现审计](#2-本地实现审计)
3. [目标模块边界](#3-目标模块边界)
4. [权威合同](#4-权威合同)
5. [浏览器平台与构建](#5-浏览器平台与构建)
6. [状态与数据流](#6-状态与数据流)
7. [设计模式评估](#7-设计模式评估)
8. [更简单方案比较](#8-更简单方案比较)
9. [安全与可观测性](#9-安全与可观测性)
10. [测试矩阵](#10-测试矩阵)
11. [实施批次与完成条件](#11-实施批次与完成条件)
12. [架构审查结论](#12-架构审查结论)

## 1. 目标与范围

本方案细化[ADR-002](../adr/0002-react-shell-protyle-editor.md)，让React 19与Vite 8可以挂载真实Protyle，同时保留块编辑、块引用、属性视图、快捷键和内容插件语义。

本批不重写编辑器，不引入Electron、原生移动端、本地内容或离线同步，也不建立旧Webpack Web入口与Vite入口的双运行路径。

## 2. 本地实现审计

### 2.1 证据

- `app/src/protyle/index.ts`中的`Protyle`才是真实编辑器；`app/src/protyle/method.ts`只导出静态渲染方法。
- `Protyle`构造函数已接收显式应用端口，bound 内容能力从 Session Runtime 取得；其子模块中的残余旧布局、菜单、搜索、卡片和插件依赖仍须按生产闭包报告继续退出。
- 2026-07-14运行现有平台门禁时扫描118个Protyle Core文件和4个边界文件；它只证明这些目录的平台规则，不会从真实公共入口遍历完整运行时闭包。
- 公共包以专用`@singularity/protyle-browser/core`子入口拥有唯一跨源码根接线；静态审计继续从企业`main.tsx`遍历到真实Core，而不是只检查公共合同文件。
- P1-A已移除Protyle目录内的ifdef、Electron、Node内置和原生移动import；闭包中的移动端与旧壳仍由`App`、布局和工作台动作的反向依赖间接带入。
- `app/src/protyle/method.ts`已有UMD导出先例，但该入口不包含编辑器生命周期，不能替代真实Protyle。
- React `ProtyleHost`从企业组合根取得公共Factory，并把当前Session及目录选择的内容身份交给真实编辑器；不再存在临时HTML Core或未接线分支。
- 公共包已经实现Session、Runtime、Factory、Registry、Menu与Overlay合同；生产`main.tsx`创建按授权空间隔离的ApplicationPort与真实Core，空间变化仍由`SpaceSessionRoot`拥有销毁顺序。
- `app/src/protyle/browser-entry.ts`只接受显式应用端口并调用现有`Protyle`构造器和bound生命周期。企业源码只导入`@singularity/protyle-browser/core`；包内`core.ts`到该实现文件是静态审计精确批准的唯一跨根边，不是App shim、fallback或第二个Core。
- `app/src`当前有16个`new Protyle(...)`创建点，全部属于旧壳或原生移动所有者。旧壳没有企业`spaceId`，因此这些点不能机械改为Session；主编辑器由React公共Factory替代，嵌入式所有者随对应功能迁移，旧所有者退出生产闭包。
- 企业Web由认证后的组织/空间路由和`SpaceRuntimeBootstrap`产生Session；工作区路径、设备ID、随机`SIYUAN_APPID`和Kernel同步标识仍不得作为`spaceId`来源。

审计使用本仓源码、现有ADR、正式方案、执行计划和依赖配置完成；本地证据足够，本轮未联网搜索。

### 2.2 P1-B调用归属

| 旧调用 | 所有者 | 目标合同 |
| --- | --- | --- |
| `openFileById`、搜索、图谱、大纲、反链、历史、卡片、资源 | React工作台 | `ProtyleHostEvent` |
| `app.plugins`、`eventBus.emit`、插件菜单、快捷键、斜杠项、paste链 | 编辑器插件运行时 | `ProtylePluginPort` |
| `getAllEditor`、活动编辑器、跨编辑器拖拽/撤销/resize | 单空间Session | `ProtyleEditorRegistry` |
| Protyle菜单、选区、块事务、属性编辑、编辑器对话框与浮层 | Protyle DOM Core | 保留内部实现 |
| HTTP、WebSocket、鉴权错误与Kernel推送 | `KernelTransport` | S2 Gateway与B4 Transport合同 |

`BlockPanel`等依赖编辑器DOM、选区和临时Protyle实例的浮层不迁成React路由事件；其生命周期在浏览器Core内收敛。React只接收工作台拥有的导航和外围视图动作。

### 2.3 结论

直接import现有`Protyle`或伪造旧`App`都会把旧应用壳隐式带入Vite。正确边界不是一个空对象shim，而是明确分离浏览器运行时、Kernel传输、插件端口和离开编辑器的宿主事件。

### 2.4 当前生产边界

真实Core已进入企业生产图；尚未迁移的依赖由闭包审计显式阻断，不包装成第二套企业Runtime：

| 依赖/能力 | 当前处理 | 进入企业Vite前的要求 |
| --- | --- | --- |
| `spaceId`、目录产生的`notebookId + documentId`、surface、participation、AbortSignal | 由Session、公共Factory和Core入口显式传递 | 保持单次绑定；响应不得改写身份 |
| 编辑器DOM、Lute、WYSIWYG、块事务、选择和撤销 | 继续由真实`Protyle`拥有 | 从入口闭包按批准清单迁入，不能由React复制 |
| `App`实例与`window.siyuan`全局配置 | browser entry不再接收或构造App；残余子图引用属于生产违规 | 提取为显式应用设置或Runtime能力；企业入口不得导入旧`App`或创建shim |
| `fetchPost`、旧上传XHR、`layout/Model` WebSocket | 企业生产入口已改用Session Runtime的Transport/Upload/Subscribe；仍在旧壳专属模块中的实现不进入批准闭包 | 闭包审计持续禁止旧传输回流，统一取消、错误和空间身份 |
| `//!js`查询嵌入 | 保留脚本返回块ID的能力，只注入`(path, body)` Session只读请求和冻结的`spaceId + notebookId + documentId`上下文；不暴露旧fetch、header/options或完整Protyle Runtime | 可调用路径由Gateway唯一白名单决定；`/api/query/sql`当前未获企业策略授权，依赖该路径的脚本明确报错且不直连Kernel、不增加fallback |
| 旧layout/editor/search/card/history/menus/mobile与`app.plugins` | 保留为待迁移依赖，不进入企业生产 | 改由HostEvent、Menu/Overlay、Registry和PluginPort承载；未迁移时装配直接失败 |

企业组合根在`main.tsx`按授权`spaceId`创建`ProtyleApplicationPort`，经`@singularity/protyle-browser/core`调用`createRealProtyleBrowserCoreFactory`，再创建公共Factory并作为必填依赖传给`App -> SpacePage`。临时未接线函数、错误码及HTML替代路径已物理删除；任何接线缺失成为编译或装配错误，不存在运行时fallback。

## 3. 目标模块边界

```text
React workspace
  | authorized SpaceRuntimeBootstrap
  v
Space route composition root
  | one Session for the validated spaceId
  | service directory -> selected notebookId + documentId
  v
ProtyleHost.tsx
  | public Factory: create(host, session, notebookId, documentId, readOnly, signal)
  v
@singularity/protyle-browser
  |-- ProtyleSession       spaceId + one owned Runtime
  |-- ProtyleRuntime       explicit Core capability set
  |-- public Factory       workspace + live only
  |-- Core constructor     explicit surface + participation
  |-- KernelTransport      HTTP/WS protocol boundary
  |-- ProtylePluginPort    editor-facing plugin ABI
  |-- ProtyleHostPort      typed events leaving editor
  |-- browser platform     clipboard/path/assets/viewport
  `-- Protyle DOM core     blocks/transactions/undo/shortcuts
            |
            v
NestJS Kernel Gateway -> one isolated Go Kernel for spaceId
```

React和企业模块只能import浏览器公共入口，不得import Protyle内部文件、旧`App`、`layout`、`mobile`、`menus`或Electron模块。

生产Core迁移前必须完成[企业空间Session组合根与Kernel Gateway启动方案](space-session-composition-root.md)中的S0至S3。React路由参数只定位启动查询，只有服务端验证后返回的`SpaceRuntimeBootstrap.spaceId`可以创建Session；`notebookId + documentId`只能来自[ADR-020](../adr/0020-space-content-directory-bootstrap.md)定义的当前空间目录项。

## 4. 权威合同

### 4.1 React到编辑器

边界只传以下权威字段：

| 字段 | 来源 | 消费点 |
| --- | --- | --- |
| `spaceId` | 授权后的`SpaceRuntimeBootstrap` | `ProtyleSession`和Kernel Gateway路由 |
| `notebookId` | 当前空间服务目录的文档项 | Protyle构造时绑定的Kernel内容库路由；同一实例生命周期不可由响应改写 |
| `documentId` | 同一当前空间服务目录项 | Protyle构造参数中的目标块 |
| `readOnly` | 企业授权和所有者强制约束 | 作为宿主只读来源；不包含文档属性，也不作为服务端授权依据 |

边界不同时传`workspaceId`、`rootId`等同义或近似字段。`notebookId`只选择内容库，不是第二个文档ID；`documentId`标识根文档，`blockId`标识该文档内的导航目标，二者不得互相替代。目录按笔记本根或真实父文档每页128项返回最小项，不公开路径或正文；浏览器不能把路由、DOM、全局状态、首个内容响应或笔记本ID解释为缺失文档身份。Kernel生成的breadcrumb和父文档导航目标都直接携带`notebookId + documentId + blockId`；浏览器只转交该目标，不解析存储路径，也不把当前文档身份套给父文档或反链目标。

React不持有文档DOM、块数组、撤销栈、选区或事务副本。内容事实仍只属于`.sy`和Kernel SQLite。

### 4.2 单空间会话

一个浏览器标签页同一时刻只有一个活动`ProtyleSession`。切换`spaceId`时按固定顺序执行，每一步完成后对应资源不再接收新工作：

1. 阻止新编辑命令。
2. 中止旧空间全部未完成请求。
3. 关闭旧空间全部订阅。
4. 关闭并注销全部浮层及其表面持有的菜单实例。
5. 释放Session菜单能力；第4步已经关闭所有表面持有的菜单实例。
6. 销毁并注销全部Protyle实例，释放监听器、Observer及非内容型临时缓存。
7. 销毁插件端口和资源链接。
8. 创建新空间会话后再挂载文档。

不支持同一标签页同时打开多个空间的文档。该约束消除了全局插件ABI和Kernel配置跨空间串用的状态分叉。

### 4.3 生命周期

现有Protyle在构造时通过`IProtyleOptions.blockId`绑定文档，没有公共`openDocument`合同。创建边界分为两层：React主编辑器只使用公共Factory，公共Factory固定创建`workspace + live + bound content + automatic initial load`；搜索、反链、卡片、浮层、历史和资源预览等迁入Vite闭包的Core所有者使用内部构造合同，显式声明`surface`、`participation`与`content`，且仅bound分支声明首请求所有权。旧壳不创建生产Session，也不作为第三种创建边界。

```ts
interface ProtyleController {
  focus(): void;
  setHostReadOnly(readOnly: boolean): void;
  destroy(): void;
}

interface ProtyleFactory {
  create(options: {
    host: HTMLElement;
    session: ProtyleSession;
    notebookId: string;
    documentId: string;
    readOnly: boolean;
    signal: AbortSignal;
  }): Promise<ProtyleController>;
}
```

Core内部合同如下，`IProtyleOptions.blockId`是唯一Core文档身份：

```ts
type ProtyleParticipation = "live" | "detached";

interface ProtyleCoreCommonOptions {
  host: HTMLElement;
  readOnly: boolean;
  signal: AbortSignal;
  surface: ProtyleSurface;
}

type ProtyleCoreCreateOptions =
  | (ProtyleCoreCommonOptions & {
      session: ProtyleSession;
      participation: "live";
      content: { mode: "bound"; notebookId: string };
      initialLoad: "automatic" | "owner";
      options: Omit<IProtyleOptions, "blockId" | "notebookId"> & { blockId: string };
    })
  | (ProtyleCoreCommonOptions & {
      session: ProtyleSession;
      participation: "detached";
      content: { mode: "bound"; notebookId: string };
      initialLoad: "automatic" | "owner";
      options: Omit<IProtyleOptions, "blockId" | "notebookId"> & { blockId: string };
    })
  | (Omit<ProtyleCoreCommonOptions, "surface"> & {
      surface: "embedded";
      participation: "detached";
      content: { mode: "local-only" };
      options: Omit<IProtyleOptions, "blockId" | "notebookId"> & { blockId?: never };
    });

interface ProtyleCoreFactory {
  create(options: ProtyleCoreCreateOptions): Promise<ProtyleController>;
}
```

- 公共Factory把唯一`notebookId`绑定为Core内容库身份，把唯一`documentId`一次映射为Core的`IProtyleOptions.blockId`，固定补入`surface: "workspace"`、`participation: "live"`、`content.mode: "bound"`与`initialLoad: "automatic"`；Core内部不再接收第二组身份字段。
- 内部构造器接收`host`、`readOnly`、`signal`、唯一`surface`、标量`participation`、显式`content`和不含身份副本的`IProtyleOptions`；只有`bound`分支接收Session，并从中取得Runtime内容能力。`content.mode: "bound"`在构造时要求真实`notebookId`且生命周期内不可改写；`onGet`只消费内容结果。
- `live`要求`options.blockId`和`content.notebookId`为真实身份并加入Registry与实时订阅；`detached + bound`不加入二者，只有属性ghost等真实上下文才可同时保留真实`blockId`和`content.notebookId`。历史、配置或生成预览不得填空串、占位或近似ID；没有真实身份时只能使用`embedded + detached + local-only`，该分支不接收Session，因此不能取得文档/资源Transport、ResourcePort或内容域HostEvent能力。
- 公共Factory中的`notebookId`、`documentId`或`session`变化时销毁旧实例并创建新实例；嵌入式live所有者任一目标身份变化也必须重建。
- `initialLoad`只存在于bound分支并声明首个内容请求的唯一所有者；两种模式都必须在构造时绑定非空、非占位的真实`blockId + notebookId`，不得再以空`blockId`、action、DOM或响应回填阻止或补做首请求。`automatic`由Core通过当前`session.runtime.transport`发起一次请求并把结果交给既有`onGet`初始化路径；`owner`使Core发出零次自动请求，由迁入Vite闭包后的直接所有者通过同一Transport和同一AbortSignal发起一次带owner查询语义的请求，并在owner仍存活、代次匹配且挂载节点有效时把唯一成功响应交给同一`onGet`路径。失败进入同一Runtime错误合同，销毁或换目标后的迟到结果丢弃，不重试另一入口、不回退旧`fetchPost`。local-only没有Session、身份、`initialLoad`或`onGet`首载。
- embedded反链结果中，只有成功transaction内的`delete`和`move`会改变当前反链成员集合；普通文本编辑由子Core就地渲染，不需要重查集合。前两类操作在应用成功后只调用构造时由直接`Backlink`父所有者提供的局部`() => void`回调；回调不是公共Core options、HostEvent、EventBus或共享能力，父owner用自身已绑定的`notebookId + documentId`刷新。调用前必须同时确认父owner未销毁、代次匹配且挂载节点仍有效，销毁或换目标后的迟到transaction不触发刷新；禁止扫描DOM、布局或Registry寻找父模型。
- `readOnly`变化只调用`setHostReadOnly`，不修改Core从真实文档响应取得的属性只读，也不复制编辑器状态。
- `surface`、`participation`与`content`由直接创建合同显式确定；同一实例生命周期内不变化，也不从DOM、action或Registry资格互相推断。
- 异步创建使用`AbortSignal`和实例代次，迟到的控制器立即销毁，不能覆盖新文档。
- `destroy`必须幂等，并释放该实例拥有的订阅、DOM监听器、Observer、插件事件和动态资源引用；bound实例不得提前释放Session级Transport、Menu或Plugin能力，local-only实例没有这些能力。
- 创建失败进入可诊断错误状态，不回退到旧编辑器或空白兼容路径。

### 4.4 Kernel传输

`KernelTransport`是有实际语义的Adapter：把Protyle的Kernel HTTP/WS/FormData协议转换为企业Gateway的空间路由、认证和错误合同。

- 所有请求显式绑定`spaceId`；不从Referer、当前DOM或文档ID猜测空间。
- Gateway验证会话和空间权限后才转发，浏览器不能直连Kernel地址。
- 所有正式写入只走Gateway的HTTP策略；Protyle WebSocket只接收服务端推送，浏览器数据帧由Gateway拒绝；`readOnly`只负责前端体验。
- 上传只调用Transport的结构化`upload`能力。Transport以XHR承担上传进度这一浏览器协议差异，注入同一内存CSRF和内容身份，连接Session的AbortSignal与终止状态，并原样发送调用方FormData；不复制File/Blob、不清洗插件额外字段，也不向Core返回裸upload URL。
- Gateway用户401/403与活动Session中的隐藏式404转换为宿主可处理的认证/授权事件；Kernel mTLS/JWT失败由Gateway归一为`kernel-unavailable`，不能误改用户身份。
- 公共请求与上传选项不暴露任意header字典；Gateway按canonical route policy重建允许头，Range、取消和上传进度分别由类型化选项表达。
- 传输销毁时中止请求并关闭订阅；不建立直连Kernel的fallback。
- 保留`protyle.transport`诊断标签，只记录`spaceId`、路由、状态、耗时和请求ID，不记录正文、令牌或完整payload。

### 4.5 宿主事件

离开编辑器的行为通过一个类型化`ProtyleHostPort`发送最小事件，由React工作台作为Mediator处理。P1-B固定以下事件语义：

| 事件 | 唯一载荷 | 所有者 |
| --- | --- | --- |
| `open-document` | `notebookId`、`documentId`、`disposition`、`scope`、`attention`、`scroll`、`restoreScroll`、`zoom` | React标签页/分屏与Protyle初始定位 |
| `open-search` | `query`、`queryMode`、`method` | React全局搜索 |
| `open-document-search` | `notebookId`、`documentId` | React文档范围搜索 |
| `open-outline` | `notebookId`、`documentId`、`preview` | React大纲视图 |
| `open-backlinks` | `notebookId`、`documentId` | React反链视图 |
| `open-graph` | `scope`及文档范围时的`notebookId`、`documentId` | React图谱视图 |
| `open-document-history` | `notebookId`、`documentId` | React历史视图 |
| `open-card-review` / `open-card-browser` | `notebookId`、`documentId` | React卡片视图 |
| `open-card-deck-picker` | `notebookId`、`blockIds` | React牌组选择器 |
| `add-blocks-to-agent` | `notebookId`、`blockIds` | React智能体编辑器；加密块标题使用当前笔记本InBox读取 |
| `open-asset` | `notebookId`、`assetPath`、可选`page`、`disposition` | React资源查看器 |
| `open-external` | `url` | 浏览器外链策略 |
| `close-document` | `notebookId`、`documentId`、`reason` | React标签页生命周期 |
| `notify` | `level`、`message` | React通知系统 |
| `refresh-outline` | `notebookId`、`documentId` | 刷新当前文档大纲，不负责打开面板 |
| `refresh-backlinks` | `notebookId`、`documentId` | 刷新当前文档反链，不负责打开面板 |
| `set-document-title` | `notebookId`、`documentId`、`title` | 更新工作台标题 |
| `set-document-icon` | `notebookId`、`documentId`、`icon` | 更新工作台图标 |
| `activate-document` | `notebookId`、`documentId` | 将当前工作台文档标为活动目标 |
| `toggle-document-fullscreen` | `notebookId`、`documentId` | 切换当前工作台编辑表面全屏 |
| `persist-workspace-layout` | `notebookId`、`documentId` | 持久化当前工作台布局 |
| `update-document-statistics` | `notebookId`、`documentId`、`statistics` | 更新字数、字符、链接、图片、引用和块计数 |
| `runtime-error` | `category`、可选`documentId`、可选`triggeringRequestId` | 收紧授权或阻断提交并显示对应动作 |

`open-document.disposition`只取`current`、可复用已有目标的`new-tab`、强制重复目标的`duplicate-tab`、`background-tab`、`split-right`、`split-bottom`。`scope`只取默认目标加载`target`、上下文加载`context`或全量子树加载`subtree`；`zoom`独立表示是否进入块聚焦视图，因为旧加载全部子树不必然触发zoom。`attention`只取`none`、`focus`、`highlight`或`focus-and-highlight`。`scroll`只取`auto`或`start`；`restoreScroll`只取`never`、`always`或`if-document`，两者组合表达目标定位与已存滚动恢复。

`open-search.queryMode`只取覆盖现有查询的`replace`或在现有查询中增删词项的`toggle-term`；它不表示搜索/替换界面。`method`只取用户偏好的`preferred`或强制关键词的`keyword`。

`statistics`固定包含`runeCount`、`wordCount`、`linkCount`、`imageCount`、`refCount`和`blockCount`六个数值，不携带选区文本、正文或预渲染HTML。`runtime-error.category`只取`unauthenticated`、`forbidden`、`kernel-unavailable`和`network-failure`；前两类不允许重试写入，后两类允许调用当前Session的`retrySubmission()`。类别已经决定动作，不再增加同义`retryable`布尔字段。Gateway request、upload和subscribe已显式绑定内容身份时携带`documentId`；只有`ApiProblem.requestId`或响应`X-Request-Id`提供真实请求源时才携带`triggeringRequestId`。网络失败、WebSocket关闭或消息解析失败没有可信请求源，字段保持缺省，不由浏览器生成随机UUID，也不以Session generation或connection ID代替。

思源3.7.2的加密笔记本使用独立内容库，因此所有离开编辑器后仍需按文档或资源调用Kernel的事件必须携带当前`notebookId`。`spaceId`选择经授权的Kernel实例，`notebookId`选择该实例内的内容库，`documentId`标识目标；三者正交且不得用DOM、布局模型、`rootId`、Registry、首个Kernel响应或遍历已解锁内容库推断。workspace/live以及任何可发送文档或资源事件的embedded表面必须在首次内容请求前由所有者取得并传入身份；`onGet`只消费内容结果，不得写入或改写身份。detached且没有真实身份的历史、配置和生成预览不得发送内容域HostEvent。普通笔记本继续走全局内容库；只有加密笔记本请求向Kernel发送`notebook`或资源`box`。文档导航在形成HostEvent前执行的折叠状态判断属于同一条路由链，必须使用事件源Protyle的`notebookId`调用明确的InBox读取，不能先访问全局库再发送正确事件。图谱和闪卡没有加密库实现，宿主必须在请求Kernel前按该身份明确拒绝，不得回退到全局查询。`add-blocks-to-agent`同样携带身份；Host在加密身份下向既有`getRefText`专用入口发送`notebook`，让解锁状态读取当前InBox、锁定状态由Kernel拒绝，不能隐藏入口、扫描身份或回退全局标题。

只有`surface: "workspace"`可以发送刷新面板、元数据、活动、全屏、布局和统计事件；`embedded + bound content`仍可发送导航、资源和通知等显式宿主动作，但不能借助DOM或Registry资格修改工作台状态；`local-only`没有Session及内容Host/Transport/Resource能力。该规则由真实Core事件消费的unit证据和P3浏览器集成共同保护。

旧`CB_GET_*`数组不穿过公共边界。旧壳Host实现负责把上述语义一次性转换为旧加载参数；React Host直接消费语义字段，不保留第二套动作合同。

事件使用discriminated union，每种语义只保留一个字段名。Protyle内部菜单、选区和块事务仍由Protyle拥有，不转成React state，也不为每个旧函数建立一层透传adapter。

Core消费的`ProtyleEditorHostEvent`不要求每个生产点重复传实例字段。事件离开当前实例时，实例Host facade一次附加`sourceEditorId`，Session Runtime只接收`ProtyleHostDispatchEvent`；`runtime-error`由Transport产生且不带编辑器来源。宿主对块DOM、菜单、属性、活动状态、统计和全屏等实例动作按`sourceEditorId`精确定位，对标题、图标和关闭等文档动作按`notebookId + documentId`显式扇出。`sourceEditorId`只标识当前内存实例，不进入Zustand、不替代内容身份，也不得从DOM、active实例或Registry首项推断。

标题写链固定为`浏览器输入体验 -> Session HTTP Transport -> Kernel单次canonicalize/persist -> HTTP canonical响应校正发起实例 + rename推送同步Host`。HTTP响应与推送复用同一次`RenameDocResult {title, empty}`；发起实例以提交代次拒绝迟到响应，工作台只从canonical推送更新目录。浏览器不得把请求前标题直接派发成最终标题，API/Gateway不得再次规范化。

### 4.6 插件端口

编辑器不再依赖完整旧`App`，只依赖`ProtylePluginPort`：

- `extendOptions`按插件注册顺序应用Protyle选项，保持后插件的既有覆盖优先级。
- `extendToolbar`在初建和刷新时使用同一流水线，并在旧壳适配器边界应用用户自定义快捷键。
- `emit`同步广播生命周期、编辑区、代码语言和菜单事件；所有插件接收同一个detail引用，消费点可见前一插件的同步修改。
- `runEditorCommand`按插件和命令顺序执行首个匹配项；热键语法仍由Protyle提供的matcher拥有，不复制命令列表。
- `forEachSlashItem`按稳定顺序访问原斜杠对象，保留额外字段且不创建中间列表；`runSlashItem`以`pluginName + itemId`调用准确回调。
- `transformPaste`按插件顺序等待`preventDefault + resolve`异步接管，并把当前最小载荷传给下一插件。
- `dispose`表达端口生命周期；旧App适配器不拥有插件启停，故不重复调用`onunload`，未来Session插件运行时在此释放自身资源。

公共合同采用以下能力形态；泛型保留Core的真实options、toolbar和editor类型，不复制上游完整插件模型：

```ts
interface ProtylePluginPort<TOptions, TToolbar, TEditor> {
  extendOptions(options: TOptions): TOptions;
  extendToolbar(
    toolbar: TToolbar,
    normalizeToolbar: (toolbar: TToolbar) => TToolbar,
  ): TToolbar;
  emit<TDetail extends object>(event: ProtylePluginEvent<TDetail>): void;
  runEditorCommand(
    editor: TEditor,
    event: KeyboardEvent,
    matchesHotkey: (hotkey: string, event: KeyboardEvent) => boolean,
  ): boolean;
  forEachSlashItem(
    visitor: (pluginName: string, item: ProtylePluginSlashItem) => void,
  ): void;
  runSlashItem(
    pluginName: string,
    itemId: string,
    editor: TEditor,
    nodeElement: HTMLElement,
  ): boolean;
  transformPaste<TPayload extends object>(
    editor: TEditor,
    payload: TPayload,
  ): Promise<TPayload>;
  dispose(): void | Promise<void>;
}
```

`ProtylePluginSlashItem`只要求`id`、`filter`和`html`，允许额外字段。visitor接收插件原对象引用；工具栏返回值和事件detail同样不做字段白名单或unknown-field rejection。Protyle菜单辅助函数只拥有菜单容器、插件分组和分隔位置，调用端口`emit`后继续由Core渲染，不把菜单状态搬入React。

插件命令合同没有可靠的读写效果元数据，本批不增加字段，也不从回调名称、热键或源码猜测副作用。命令继续按既有顺序执行；有效`readOnly`在Core的事务、上传和其他正式写能力入口统一拒绝写入，S2 Gateway对全部HTTP写协议强制授权，Protyle订阅不暴露客户端发送能力。读取、搜索、复制和导航类插件命令因此仍可使用，经正式写能力修改内容的命令不能改变或持久化内容。绕开公开能力直接改DOM或自行请求的恶意插件不属于兼容承诺，企业插件准入与沙箱属于后续独立安全范围。

Paste以调用方小载荷为唯一当前值。旧壳适配器为保持调用方所有权只创建一次浅工作副本，随后原地应用各插件返回的有效字段；普通paste约五个字段，本地文件paste约一个文件列表字段，不复制File、正文DOM或编辑器状态。每个插件事件detail只携带当前字段、editor引用和resolve回调；额外返回字段继续进入下一插件。该低频浅拷贝避免修改调用方局部变量，替代方案是直接改写输入对象，所有权更模糊，故不采用。

内部复制/剪切的HTML注释只保存一份版本化小载荷：BlockDOM及其来源`spaceId + notebookId + documentId`。`clipboard.ts`在外部剪贴板边界一次解析，直接`text/siyuan`必须与注释中的BlockDOM一致才继承来源；插件改变`siyuanHTML`后来源失效。粘贴到同一空间时按来源身份查询来源笔记本，只有原块已删除才按剪切保留ID；跨空间或缺少有效来源时直接生成新ID。该链不查询当前笔记本或全局blocktree，不把来源身份放进Zustand、DOM属性或插件可改写payload。

`createAppProtylePluginPort`是有实际语义的上游旧壳Adapter：旧侧是`App.plugins`、可取消DOM EventBus、可变工具栏、命令和斜杠回调；新侧是顺序能力端口。它转换事件取消语义、用户快捷键覆盖、首命中命令、斜杠身份和异步paste结果，不进入企业生产组合根，也不作为fallback；其desktop/mobile真实消费者仍存在时保留源码，企业P5只删除错位owner并阻止该依赖进入Vite闭包。

插件的顶栏、Dock、页签等旧壳扩展由独立React插件Facade处理。该Facade承担DOM槽位到React扩展点的生命周期和错误语义转换，因此不是薄透传层。编辑器本身不得重新import旧布局。

设计模式只采用解决现有复杂度的三项：`ProtylePluginPort`作为Facade隔离完整插件对象，旧App实现作为Adapter转换真实协议差异，options、toolbar、快捷键和paste按Chain of Responsibility保持注册顺序；普通事件沿用Observer语义。不拆成七个小端口，不新增React store，也不为每种事件建立方法，因为这些方案会增加对象数量和调用跳转而不减少状态。

### 4.7 编辑器注册表

`ProtyleEditorRegistry`由单空间`ProtyleSession`拥有，保存当前Session中的实例引用，不保存文档内容副本。

- `register`按插入顺序保存实例；重复注册同一引用返回已有注销语义，不新增重复项。
- `unregister`与注册返回的注销函数均幂等；注销active实例后active为空，不猜测下一个实例。
- `forEach`和`find`直接遍历内部有序集合，不返回数组或可变集合，不为drag、transaction和resize复制实例列表。
- `activate`只接受已注册实例并返回是否成功；`getActive`供全局撤销选择目标，不读取旧`Tab`、布局DOM或`blockPanels`。
- `dispose`幂等清空实例和active并关闭注册阶段；后续`register`抛出带`protyle.registry`标签的生命周期错误，不建立迟到实例fallback。
- React工作台状态不复制注册表；跨页面状态仍遵循Zustand边界。

公共合同与实现工厂保持泛型，不把`IProtyle`或旧布局类型写进浏览器包：

```ts
interface ProtyleEditorRegistry<TEditor> {
  register(editor: TEditor): () => void;
  unregister(editor: TEditor): void;
  forEach(visitor: (editor: TEditor) => void): void;
  find(predicate: (editor: TEditor) => boolean): TEditor | undefined;
  activate(editor: TEditor): boolean;
  getActive(): TEditor | undefined;
  dispose(): void;
}

function createProtyleEditorRegistry<TEditor>(): ProtyleEditorRegistry<TEditor>;
```

公共包先提供Registry真实实现；S3企业空间组合根一次性创建生产HostPort、正式零插件PluginPort、唯一Registry、Transport、ResourcePort、Menu、Overlay、完整Runtime与`ProtyleSession`，不存在占位能力、旧App临时Runtime或第二个注册表。B4接通Core后，`live`实例完成内部对象构造再注册并订阅，`focusin`更新active；`detached`实例明确跳过两者。服务端关闭浏览器外层连接后由Gateway关闭上游订阅，Kernel执行既有`HandleDisconnect -> RemovePushChan`清理，不需要客户端销毁后发送`closews`。反链模型和`BlockPanel`等所有者关闭时严格执行停止新工作、中止请求、关闭订阅、关闭浮层与菜单句柄、销毁并注销子实例；回调还必须确认所有者未销毁、代次仍匹配且挂载节点仍在DOM。历史、快照、资源预览与属性ghost的所有者同样必须确定性调用幂等`destroy`，不能只清变量或替换DOM。

Registry只替换实例协同：跨编辑器拖拽源定位与超级块清理、Kernel move DOM查找、resize锚点、active undo和旧Host关闭。大纲/反链面板刷新、全屏工作台布局、全局浮层收起、`BlockPanel`创建仍是B4工作台边界；禁止为追求“调用清零”把这些模型塞入Registry。

跨文档drag的源DOM必须属于当前Registry。找不到源实例时抛出`[protyle.registry]`诊断错误并中止，不再查询跨窗口/mobile数组、Kernel块信息或使用目标rootID。事务提交把发起实例ID写入Kernel `session`，Kernel广播以`sid`原样返回，订阅边界将其作为必填`sourceEditorId`交给Kernel move处理；需要复制拖出源DOM时只精确访问该Registry实例，不按注册顺序、active实例或同文档首个实例扫描。只读历史预览不接收实时Kernel move。远端或已经销毁的源实例在当前Session不存在时，接收实例只在自身DOM放置协议占位并以当前内容身份取得权威块DOM，不伪造或近似推断源编辑器身份。

设计模式只采用Registry封装实例身份与生命周期，内部`Map`同时提供Repository式find/遍历但不另建Repository层。更简单的全局数组无法隔离空间和销毁；Zustand会复制非渲染领域状态；继续扫描布局树会保留旧壳依赖，均不采用。

### 4.8 浏览器Runtime与表面

`ProtyleRuntime`是单空间Session向浏览器Core提供的唯一运行时对象。它只组合已有或有真实所有权差异的能力，不暴露旧`App`：

```ts
type ProtyleSurface = "workspace" | "embedded";

interface ProtyleSession<TRuntime> {
  readonly spaceId: string;
  readonly runtime: TRuntime;
  retrySubmission(): Promise<void>;
  dispose(): void | Promise<void>;
}

interface ProtyleRuntime<TEditor, TOptions, TToolbar, TMessage, TMenu, TOverlay> {
  readonly host: ProtyleHostPort;
  readonly plugins: ProtylePluginPort<TOptions, TToolbar, TEditor>;
  readonly editors: ProtyleEditorRegistry<TEditor>;
  readonly transport: ProtyleTransport<TMessage>;
  readonly resources: ProtyleResourcePort;
  readonly menu: ProtyleMenuPort<TMenu>;
  readonly overlays: ProtyleOverlayPort<TOverlay>;
}
```

Runtime中的可释放能力使用以下生命周期形态：

```ts
interface ProtyleTransport<TMessage> {
  request<TResponse>(path: string, body: unknown, options: ProtyleRequestOptions): Promise<TResponse>;
  upload<TResponse>(body: FormData, options: ProtyleUploadOptions): Promise<TResponse>;
  subscribe(options: ProtyleSubscriptionOptions<TMessage>): ProtyleSubscription;
  dispose(): void;
}

interface ProtyleRequestOptions {
  readonly identity: ProtyleContentIdentity;
  readonly intent: "read" | "write";
  readonly signal?: AbortSignal;
  readonly responseType?: "json" | "blob";
  readonly range?: { readonly start: number; readonly end?: number };
}

interface ProtyleUploadOptions {
  readonly identity: ProtyleContentIdentity;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: {
    readonly loadedBytes: number;
    readonly totalBytes?: number;
  }) => void;
}

interface ProtyleResourcePort {
  resolveAsset(identity: ProtyleContentIdentity, path: string): string;
  resolveEmoji(identity: ProtyleContentIdentity, path: string): string;
  resolveExport(identity: ProtyleContentIdentity, path: string): string;
}

interface ProtyleMenuPort<TMenu> {
  open(): ProtyleMenuHandle<TMenu>;
  dispose(): void;
}

interface ProtyleMenuHandle<TMenu> {
  readonly menu: TMenu;
  close(): void;
}

interface ProtyleOverlayPort<TOverlay> {
  add(overlay: TOverlay): ProtyleOverlayHandle;
  forEach(visitor: (overlay: TOverlay) => void): void;
  dispose(): void;
}

interface ProtyleOverlayHandle {
  close(): void;
}
```

`ProtyleSession`只保存唯一`spaceId`、唯一`runtime`并暴露`retrySubmission()`与有序`dispose()`；Host不在Session上重复暴露，因为它已经是Runtime能力。Factory和bound Core内部构造器都只接收Session，不另收Runtime；bound Core只从`session.runtime`取得能力，local-only Core不接收Session。生产内容数据链为`SpaceRuntimeBootstrap -> ProtyleSession -> ProtyleRuntime -> bound Core`。

Core内部构造器另收唯一`surface`、标量`participation`和`content`；只有bound内容另收首请求所有权`initialLoad`。`workspace`表示React工作台拥有的主编辑表面，可以请求活动状态、面板同步、全屏和布局持久化；`embedded`表示搜索、反链、浮层、历史和属性预览等由局部所有者销毁的表面。`live`加入Registry和当前编辑器订阅，`detached`跳过二者；`bound`取得Session内容能力并以`automatic`或`owner`选择同一个`onGet`初始化入口的唯一请求方，`local-only`只渲染所有者提供的数据且没有首载模式。各字段互不推断，也不从DOM类名反推。所有进入Vite生产闭包的新所有者显式声明适用字段，不保留接收`App`的重载。

当前16个旧构造点按下表处置，不向缺少企业身份的旧壳注入Session：

| 旧创建点 | 目标处置 | 新合同 | 完成条件 |
| --- | --- | --- | --- |
| `editor/index.ts` | React主编辑器替代 | 公共Factory固定`workspace + live + bound + automatic` | 真实空间、笔记本与文档路由创建，旧页签所有者不进入闭包 |
| `block/Panel.ts` | 迁入浏览器Core | `embedded + live + bound + automatic` | 真实引用`blockId + notebookId`，Panel有序销毁 |
| `layout/dock/Backlink.ts`、`search/util.ts` | 随React反链与搜索迁移 | `embedded + live + bound + owner` | 首个真实目标出现后创建并由owner把唯一查询响应交给`onGet`；目标切换重建，旧Dock/搜索所有者删除 |
| `card/openCard.ts`、`card/viewCards.ts` | 随React卡片能力迁移 | `embedded + live + bound + owner` | 真实卡片目标创建，owner把唯一卡片响应交给`onGet`；切卡重建，旧Dialog/页签所有者删除 |
| `menus/commonMenuItem.ts` ghost | 随属性Dialog迁移 | `embedded + detached + bound + automatic` | 仅真实属性上下文保留`blockId + notebookId`，关闭时销毁 |
| `history/*`、`config/assets.ts` | 随React历史/设置迁移 | `embedded + detached + local-only` | 直接渲染所有者载荷，不伪造身份或首载模式，强制只读并确定性销毁 |
| `layout/dock/agent/AgentComposer.ts` | 随React智能体编辑器迁移 | `embedded + detached + local-only` | 不取得内容Host/Transport/Resource能力，关闭时确定性销毁 |
| `mobile/editor.ts` | 排除 | 无 | 不进入canonical browser，未来单独设计 |

Factory和内部构造器输入的`readOnly`只表示宿主约束，即授权只读与所有者强制只读的或值。Core从真实文档响应取得`documentReadOnly`，在消费点派生`effectiveReadOnly = hostReadOnly || documentReadOnly`；不得要求宿主预请求、猜测或重复传递文档属性。`setHostReadOnly()`只更新宿主来源，文档响应只更新属性来源；同步或网络故障只改变`submission`，不进入该合并式。

事务、上传和其他正式写能力统一先经过有效只读守卫；`effectiveReadOnly`成立时拒绝进入写能力，读取、搜索、复制、导航和纯渲染不经过该守卫。正交的`submission: blocked`只在Transport提交边界拒绝新提交，不修改有效只读。文档锁控件使用唯一窄化的`setDocumentReadOnlyAttribute()`命令：仅当用户有编辑授权且`hostReadOnly`为`false`时可调用；解除请求完成前保持原属性与只读，失败保留原状态并报告结果，成功后使用响应中的最新属性和当前宿主约束重新合并。普通事务、上传、插件和其他属性入口不能调用该例外命令。

所有异步所有者必须把自己的`AbortSignal`传至内部请求，并用实例代次拒绝迟到结果；清空变量或替换DOM不能代替`destroy()`。

Runtime不是新的全局服务定位器。Core只读取所需粗粒度能力；React不订阅Runtime，也不把其中实例复制到Zustand。企业空间路由是唯一生产组合根，在Core外把Host、PluginPort、Registry、Transport、ResourcePort、Menu与Overlay组装为Runtime；旧壳不创建生产Runtime或Session。

`spaceId`只由服务端授权后的企业空间启动响应产生并由`ProtyleSession`保存，是请求、订阅与资源隔离的权威标识；Runtime接收的Transport已经绑定该Session，不重复保存同一字段。旧思源壳没有`spaceId`语义，不能拿workspace路径、随机应用ID或Kernel实例ID近似代替，也不增加local Session。`ProtyleTransport.request`返回JSON/Blob协议响应，`upload`原样消费Core创建的小规模FormData并用XHR提供上传进度、AbortSignal、内存CSRF、内容身份和相同错误状态，`subscribe`只创建当前编辑器订阅；调用方不能提供headers、URL、Cookie或CSRF。Transport、Menu与Overlay均提供幂等`dispose`，由Session按固定顺序释放。Menu端口只创建Session内菜单句柄，触发表面持有并幂等关闭自己的句柄；句柄关闭不终止能力，只有切空间调用Menu端口`dispose()`关闭残留实例并使能力进入终态。Overlay端口返回同时关闭DOM资源并注销登记的幂等句柄，不暴露可变数组或创建业务动作。

生命周期只有一条所有权链：Session拥有Runtime和空间级资源，编辑器/嵌入式所有者拥有自己的请求、订阅和菜单句柄，Overlay端口拥有浮层登记，Registry拥有可交互编辑器身份。三条路径分别以独立状态机严格执行：

1. 关闭嵌入式所有者：停止新工作、中止其请求、关闭其订阅、关闭其浮层与菜单实例、保留Session菜单能力、销毁并注销其子编辑器，不创建后继实例。
2. 切文档：停止旧文档工作、中止其请求、关闭其订阅、关闭其浮层与菜单实例、保留Session菜单能力、销毁并注销旧编辑器，再创建新文档编辑器。
3. 切空间：递增路由代次、停止旧Session工作、中止全部请求、关闭全部订阅、关闭全部浮层与当前菜单实例、释放Session菜单能力、销毁并注销全部编辑器、释放插件端口、清除编辑器DOM，再失效Bootstrap查询；只允许当前代次的新授权响应创建Session并挂载文档。

步骤不得交换、合并或跳过适用项。销毁是终态，任一步完成后对应资源不再接收新工作，迟到Promise、网络恢复和插件回调均不能更新后继界面或重新登记实例。

Transport错误只输出正交类别`unauthenticated`、`forbidden`、`kernel-unavailable`和`network-failure`及真实可达的可选`documentId`/`triggeringRequestId`，不携带正文或凭证。Host收到前两类后立即冻结命令并收紧只读，等待Session销毁、清除编辑器DOM并失效对应查询；不复制正文形成惰性视图。后两类只转换为提交阻断与用户显式重试并保留当前内容；重试成功只解除提交阻断，不解除授权只读。任何类别都不触发整页刷新、自动重复写、备用地址、随机关联标识或默认成功。公共包以可控的浏览器`fetch`/`WebSocket`外部边界做unit证据；S2以真实NestJS HTTPS/WSS和受控外部Kernel证明状态码、授权与空间路由；P3/P4再以浏览器集成证明工作台结果。

宿主约束、文档属性与运行故障保持正交；有效只读只在Core消费点派生，不把三个来源压成一个可被任意调用方改写的状态：

| 状态 / 派生值 | 来源 | Core结果 | 恢复条件 |
| --- | --- | --- | --- |
| `hostReadOnly: boolean` | 路由授权、所有者强制约束、`unauthenticated`、`forbidden` | 参与有效只读；为`true`时禁用文档锁解除 | 宿主取得新的授权和所有者事实 |
| `documentReadOnly: boolean` | 真实文档响应、受控文档锁命令成功响应 | 参与有效只读；不得由宿主或插件直接覆盖 | 新文档响应或受控命令成功 |
| `effectiveReadOnly` | `hostReadOnly || documentReadOnly`即时派生 | 拒绝事务、上传和正式写能力，保留读取能力 | 任一来源变化后重新派生 |
| `submission: available | blocked` | `kernel-unavailable`、`network-failure` | 保留当前授权和内容，阻断新提交 | 用户触发同一宿主重试动作且成功 |

Host错误事件只携带错误类别和请求标识；是否允许重试由类别唯一决定。重试命令由工作台回到当前Session的Transport，不通过插件、正文或旧刷新函数。成功结果只把`submission`恢复为`available`，不得把`hostReadOnly`改为`false`或清除`documentReadOnly`。

### 4.9 B4闭包审计与依赖顺序

真实公共入口已经由企业`main.tsx -> @singularity/protyle-browser/core -> browser-entry.ts`接入Core，`protyle-vite-closure-audit.mjs`从该生产入口遍历并约束批准闭包。生产主编辑器只从授权空间Session取得Transport、Registry、Menu、Overlay、Plugin与Resource能力；旧壳专属模块中仍存在的`fetchPost`、`window.siyuan`和工作台依赖不等于生产加载边，但必须继续由正向allowlist阻止回流。该源码接线与静态闭包仍不能替代P3真实DOM和P5全链证据。

依赖顺序已按下列路径实施；各项最终完成状态仍以L1末集中复评和verification为准：

1. **B4-Runtime合同**：落公共Session、Runtime、Factory、surface、工作台事件和所有权合同；该局部批次已具备unit证据。
2. **S0-S1企业身份与空间**：落PostgreSQL权威空间、本地账号会话、成员授权和`SpaceRuntimeBootstrap`真实HTTP。
3. **S2-S3 Gateway与组合根**：落显式Kernel路径策略、单空间HTTP/WS、授权错误、React空间路由和唯一Session组合根。
4. **B4-Core**：已从真实Session切入并由Runtime提供请求、订阅、菜单、浮层与浏览器能力；`IProtyle.app`等剩余收口条件仍按B4清单审计。
5. **B4-Gate**：真实入口与TS/TSX/JS正向allowlist已落盘并进入Vite生产图；集中static、typecheck与build尚未在本阶段执行。

每个子批删除自己的旧字段和旧入口，不保留双请求、双菜单、App构造器重载、local Session或fallback。P1-B4只有在第5项门禁、空间启动合同和集中验证完成后才标记结束。

## 5. 浏览器平台与构建

### 5.1 单一浏览器目标

- 浏览器公共入口及其闭包不得出现`ifdef-loader`指令、Electron/Node内置模块或原生移动端import。
- 用明确的浏览器模块实现剪贴板、外链、资源打开和响应式输入模式。
- 原生移动和Electron动作在产品范围外；对应控件不渲染，不保留空操作fallback。
- 浏览器窄视口是运行时响应式状态，不再等同于`MOBILE`构建目标。
- P1旧壳仅以`webpack.desktop.js`作为`BROWSER=true`、`MOBILE=false`的过渡编译证据；`webpack.config.js`的Electron main/window、`webpack.mobile.js`和`webpack.export.js`不接入canonical运行时，也不纳入B3兼容声明。

### 5.2 Vite入口

`enterprise/apps/web`只从一个`@singularity/protyle-browser`公共入口加载编辑器。公共入口负责：

1. 初始化当前空间的配置、语言、非内容型编辑器缓存和插件端口。
2. 加载Lute与Protyle Web Components等版本化资源。
3. 创建和销毁真实Protyle实例。
4. 暴露稳定的Factory、Session和事件类型。

企业旧Webpack Web入口不参与开发、测试或生产构建，相关入口及浏览器构建脚本必须物理不存在，不保留双构建命令。上游`app/webpack.config.js`、`app/webpack.desktop.js`、`app/webpack.mobile.js`和`app/webpack.export.js`仍服务思源客户端，不属于企业入口删除范围。

### 5.3 合同所有权与源码接入

`enterprise/packages/protyle-browser/src/contracts.ts`是唯一公共合同源。`app/src/protyle`只能通过显式相对路径做`import type`，该依赖在运行时擦除；禁止在旧源码复制事件union或PluginPort定义。

B4由`@singularity/protyle-browser`公共入口接入保留于`app/src/protyle`的上游Core，P3再证明真实DOM挂载与编辑行为。边界校验将Core目录视为受审源码根，只允许进入已批准的浏览器共享模块；不得因此放开`app/src/index.ts`、`layout`、`mobile`或旧工作台动作。类型依赖从Core指向公共合同不形成运行时包循环。

### 5.4 样式与资源

- 新建只包含Protyle、菜单、Tooltip和必要基础类的浏览器Sass入口，不导入旧应用壳的完整`base.scss`。
- Tailwind继续只加载theme和utilities，不启用全局Preflight；React规则限制在`[data-singularity-ui]`。
- Protyle继续消费`--b3-*`，其值由奇点设计系统语义token映射。
- Lute、图表、数学公式和Web Component资源由构建期版本化只读清单加载；在线`assets`、upload和exports只通过Runtime的`ProtyleResourcePort`解析为当前组织/空间Gateway地址。Session不增加隐式配置对象。
- 企业组合根关闭AI Writing与Widget，自定义Emoji只通过携带`spaceId + notebookId + documentId`的只读`ProtyleResourcePort`加载，SVG和HTML仍强制下载。
- 应用源只内联Gateway MIME allowlist中的惰性资源；HTML、JavaScript、SVG、XML、PDF、未知类型与导出HTML强制下载并使用`nosniff`和sandbox CSP。PDF预览由PDF.js绘制canvas，不使用应用源`iframe/object`执行原文件。
- 主题或视觉变化先更新设计系统token或Protyle样式入口，不在业务页面写局部补丁。

## 6. 状态与数据流

- TanStack Query拥有组织、空间、权限和空间目录分页等服务端视图缓存，目录数组不复制进客户端store。
- Zustand只保存内存CSRF与跨文档树、编辑器共享的当前`spaceId + notebookId + documentId`选择；Protyle、Session和编辑器内部状态不得进入Zustand。
- `ProtyleSession`拥有空间级编辑器运行时和传输生命周期，不拥有文档内容副本。
- Kernel响应中的breadcrumb节点和可选父文档目标是编辑器实例内的一次性导航元数据，不进入Zustand；它们不能改写构造时绑定的当前文档身份。
- 临时派生值在消费点计算；跨边界只传`spaceId`、`notebookId`、`documentId`等正交ID、权限结果和类型化事件，内容响应不反向改写身份。
- 不新增深拷贝、双写、兼容字段或运行时unknown-field拒绝逻辑。

## 7. 设计模式评估

| 模式 | 用途 | 采用结论 |
| --- | --- | --- |
| Facade | 把旧插件的顶栏/Dock/页签扩展转换为React扩展点 | 采用；承担真实UI生命周期转换 |
| Adapter | 把Kernel HTTP/WS/FormData协议转换为带`spaceId`和企业错误语义的Gateway协议 | 采用；承担认证、CSRF、路由、取消、上传进度和错误状态转换，不是同形透传 |
| Mediator / Event-Driven | 处理编辑器发出的打开文档、搜索、图谱等宿主事件 | 采用；避免Protyle直接依赖React路由和旧布局 |
| Factory | 公共层固定创建`workspace + live + bound content + automatic`，Core层承接显式内部组合 | 采用；不向React暴露无意义组合，身份只在创建边界映射一次 |
| Command | 文档属性只读的受控解除 | 采用；把唯一允许的只读元数据写与普通内容写守卫隔离 |
| Plugin | 保留Protyle插件选项、工具栏和事件扩展 | 采用；只暴露必要能力 |
| Singleton | 保存活动空间会话 | 不采用；Session由React工作台显式拥有，便于销毁和测试 |

## 8. 更简单方案比较

| 方案 | 未采用原因 |
| --- | --- |
| iframe嵌入旧思源Web UI | 保留Webpack和旧壳，形成双路由、双会话和跨frame插件问题，不满足L1生产入口切换 |
| Vite直接import并伪造`App`/`window.siyuan` | 真实Core仍把旧App和工作台模块带入闭包；shim不能消除隐式副作用 |
| 立即用TipTap/Lexical重写 | 丢失块事务、引用、属性视图、插件和快捷键语义，风险远高于抽取 |
| 公共Factory同时暴露surface与participation | React可构造无意义组合并承担Core内部生命周期；两层Factory让公共心智模型更小 |
| 宿主预取并合并文档属性只读 | 产生重复请求和第二事实源；Core已从真实文档响应取得该属性 |
| 继续使用全局current菜单对象 | 局部表面无法只关闭自己的菜单实例；句柄所有权能区分实例关闭与能力释放 |
| 继续以空`blockId`或action推断是否延迟首载 | 身份在首次请求前不完整且请求所有权隐式；bound-only的二值`initialLoad`直接表达唯一请求方，local-only不增加无意义状态 |
| 为automatic与owner建立两个Core构造器或初始化adapter | 两个入口会复制身份、生命周期和错误合同；单一判别字段配合既有`onGet`路径让结果消费只有一处 |
| 让embedded反链使用workspace HostEvent、EventBus或共享刷新adapter | 局部父子变化会误改工作台并增加无第二消费者的中间层；直接父owner回调的数据路径最短且销毁边界明确 |
| 由SpaceRuntimeBootstrap、首个响应或旧工作台推断文档身份 | 企业状态与易变目录耦合，且首次请求前身份仍缺失；服务目录项是唯一合法选择来源 |
| 同文档事件按Registry顺序选择首个编辑器 | 重复页签和分屏共享内容身份却拥有不同DOM、选区和菜单生命周期；实例Host facade附加来源句柄的数据路径更短且确定 |
| 一次返回完整文档树或公开旧文件路径 | 大目录载荷、迟到覆盖和锁门持有无界；按真实父文档分页只传当前可见层 |
| ResourcePort继续只返回upload URL | Core必须重建XHR、CSRF、header、错误和终止状态，形成第二传输路径；Transport直接拥有上传使数据路径更短 |
| Transport把FormData转换成JSON或复制File/Blob | 增加大载荷拷贝并破坏浏览器multipart边界；原样传递FormData只在XHR外部信任边界增加必要头 |
| CSRF进入upload查询串 | 查询串会进入日志与中间设施，并产生第二种CSRF合同；只允许Transport从内存取值并写请求头 |

最终方案模块更多于一个空shim，但把复杂性集中在四个真实边界，React到编辑器的数据路径仍只有`spaceId + notebookId + documentId -> Protyle -> Kernel`。

## 9. 安全与可观测性

- 浏览器产物不得包含Kernel内网地址、工作空间路径、服务凭证或分享密码。
- 目录只经Nest同源授权与Kernel服务身份读取；锁定加密库不返回内部文档标识、标题、层级或数量，目录日志不记录名称、标题、路径或页内容。
- 插件和编辑器请求必须经过同一Gateway授权；插件不能绕过只读权限直接提交事务。
- 资源URL只允许配置的同源Gateway前缀，禁止由文档内容提供任意Kernel基址。
- 上传CSRF只存在于内存和请求头，不进入URL、日志、FormData、持久状态或插件对象；终止Session必须中止正在进行的XHR。
- `protyle.lifecycle`记录`spaceId`、generation、阶段、结果以及事件真实携带的可选`documentId`/`triggeringRequestId`；不记录正文、选区文本或插件私有数据，generation不作为请求标识。
- `protyle.transport`只记录真实响应提供的`triggeringRequestId`及显式内容身份、Kernel路由、状态和耗时；浏览器网络/协议失败不生成请求标识，鉴权信息与payload不入日志。
- 创建、切文档、切空间和销毁失败必须可区分，便于定位异步竞态与资源泄漏。

## 10. 测试矩阵

测试遵循最低充分层级。B4所有当前证据由一个聚合命令发现，未来浏览器集成与真实E2E使用物理互斥的目录和配置。

| 稳定合同 / 风险 | 最低层级 | 真实与模拟边界 | 现有测试处置 |
| --- | --- | --- | --- |
| 浏览器入口不依赖旧壳、ifdef、Electron或Node内置 | static | TypeScript AST/import图；不运行源码字符串伪行为测试 | 新增边界校验并接入`lint`或`check` |
| HostEvent不携带旧动作数组，Protyle不直接import工作台导航实现 | static + typecheck | AST依赖方向与公共discriminated union | 扩展现有平台AST门禁，不建孤儿脚本 |
| 同文档多实例动作精确命中来源，文档事件显式扇出 | typecheck + unit + P3 browser integration | 公共dispatch合同要求`sourceEditorId`，Host unit驱动真实Registry中的重复文档实例，P3验证分屏DOM与菜单结果 | 扩展公共typecheck和Host既有suite，不按实现字符串或首命中mock自证 |
| 加密内容动作在首次请求前绑定`spaceId + notebookId + documentId`且不被响应改写 | static + typecheck + unit + integration | 类型与依赖图证明必填合同和禁用依赖；Core/Host unit证明构造时绑定、智能体标题路由及local-only detached零内容事件；Kernel integration只证明InBox与锁定拒绝；P4浏览器证明用户路径 | 删除源码顺序式身份传播测试；扩展canonical合同与既有门禁，运行时证据不由AST冒充 |
| 空间目录按真实父文档分页产生完整身份，锁态与迟到响应不泄漏或串树 | Go + HTTP integration + component + P3 browser integration | 真实Kernel普通/加密目录与响应门、真实Nest授权/mTLS边界、真实QueryClient/Zustand/Router；浏览器层只替换外部Gateway时标为integration | 扩展`verify:s0-s3`的Kernel/Nest/Web标准suite，不建源码字符串测试、孤儿脚本或第二目录store |
| 插件选项、工具栏和同步事件顺序 | unit + static | 单元测试驱动真实旧壳Adapter与最小插件；不模拟Adapter内部链 | P1-B2接入workspace `test`，AST禁止Core读取插件注册表 |
| 插件快捷键首命中、斜杠身份和paste异步顺序 | unit + browser integration | unit使用真实端口和最小插件；P4浏览器使用真实Protyle与插件端口 | P1-B2覆盖顺序、额外字段和零插件；P4补DOM回归 |
| 公共Factory固定`workspace + live + bound content + automatic`，Core构造器显式声明表面、参与方式、内容绑定与首请求所有权，正交身份只映射一次 | typecheck + unit + static | 真实Factory/Core类型、React主编辑器和迁入Vite闭包的嵌入式所有者；只模拟外部资源加载 | 扩展`ProtyleHost`组件测试与AST边界；旧壳和原生移动点显式排除 |
| bound首载只有一个请求方且统一进入`onGet`，local-only没有首载状态 | unit + static + P3 browser integration | unit驱动真实Core：automatic经绑定Transport得到一个初始化结果；owner零自动请求并把同一响应形态交给既有`onGet`；仅替换外部Transport，断言初始化状态、身份路由及销毁后迟到结果，不只断言mock次数 | 扩展app Core标准`node:test`并接入`verify:b4`；AST只保护禁用空`blockId`哨兵、旧fetch与双初始化入口，真实DOM留P3 |
| embedded反链delete/move只刷新直接owner且不发送workspace事件 | unit + P3 browser integration | unit驱动真实embedded Core transaction和Backlink owner，证明成功后刷新、普通编辑不重查、销毁/换目标后迟到结果无效；P3证明真实DOM结果 | 扩展现有app Core runner，不新增helper或孤儿入口；P3沿用browser integration诊断 |
| Session只持`spaceId + runtime`，Core只经`session.runtime`取能力 | unit + typecheck + static | 真实Session/Runtime对象；不构造完整mock App | 公共包Vitest验证所有权与幂等销毁，AST拒绝重复Host/Runtime字段 |
| 宿主只读与真实文档属性只读独立取源并派生有效只读 | unit | 驱动真实Core只读状态与真实文档响应形态；只替换Transport外部边界 | 新增Core `node:test`，覆盖任一来源成立、宿主解除不覆盖文档属性及文档响应更新 |
| 有效只读拒绝事务、上传和正式写能力，同时保留读取能力 | unit + P4 integration | unit调用真实写守卫与读能力；P4使用真实DOM交互 | 新增Core `node:test`，不以源码字符串或mock调用次数证明 |
| 文档锁受控解除只在宿主可写时可用，失败保持原状态，成功重新合并来源 | unit + P4 integration | 真实窄化命令与状态转换；仅Transport请求为外部替身 | 新增Core `node:test`，分别覆盖宿主强制只读、请求中、失败和成功 |
| 关闭嵌入式所有者按序关闭其请求、订阅、浮层、菜单实例和子编辑器 | unit + P3 integration | 真实生命周期控制器与资源句柄；P3验证真实嵌入式DOM | 独立命名case，证明保留Session菜单能力且不创建后继实例 |
| 切文档按序关闭旧文档资源并在旧编辑器销毁后创建后继实例 | unit + component + P3 integration | 真实Session生命周期和React effect；只模拟外部Factory | 独立命名case并扩展`ProtyleHost.test.tsx` |
| 切空间按序释放菜单能力、编辑器和插件后才创建新Session | unit + P3 integration | 真实Session/Runtime资源句柄；不以mock Factory冒充Core注册 | 独立命名case，证明迟到结果不能复活旧资源 |
| Session注册、活动实例、幂等注销与detached排除 | unit + static + P3 integration | unit驱动真实Registry；AST验证旧扫描移除；P3验证真实Factory/Core | 将`ProtyleEditorRegistry.test.ts`从Web迁到公共包，不保留双测试 |
| HTTP/WS/FormData绑定spaceId与内容身份，上传携带内存CSRF并支持取消/进度，错误语义、真实请求关联和销毁终止一致 | B4 unit + S2 integration + P4 browser integration + P5 E2E | B4只替换浏览器`fetch`/`WebSocket`/`XMLHttpRequest`外部边界并证明无请求源时不生成随机ID；S2以真实HTTPS/WSS驱动Gateway并将上游请求ID匹配到日志；P4驱动真实上传进度与只读拒绝 | 公共Transport原生case与S2真实Gateway合同同批删除旧fetch/Model/上传XHR、任意header字典、`uploadUrl`及`ModelReconnectLifecycle.test.js`，不保留双实现 |
| 菜单能力属于Session、菜单实例属于触发表面 | unit + P4 integration | unit驱动真实Menu端口与句柄；真实定位和DOM关闭由P4证明 | 公共包/Core unit覆盖实例关闭与能力dispose，不为菜单动作建helper |
| 公共入口真实Core闭包不含旧壳与平台禁用边 | static + build | AST/import图覆盖TS/TSX/JS及所有模块加载形式；Vite产物 | B4把现有source/boundary门禁收敛到真实入口，不以目录字符串搜索代替依赖图 |
| `notebookId`/`documentId`/Session任一变化重建，迟到实例销毁，宿主只读就地更新 | component | 真实React effect；只模拟外部Protyle Factory | 扩展现有`ProtyleHost.test.tsx`，不另建重复组件测试 |
| 真实Protyle渲染、编辑、提交事务和处理推送 | browser integration | 真实React+Protyle；拦截外部Gateway HTTP/WS时明确标为integration | P3场景先内联；至少两个稳定消费者后才抽诊断support |
| Gateway请求携带唯一`spaceId`并区分用户401/403/隐藏式404、Kernel服务认证和业务Problem | contract | 至少一条真实HTTPS驱动；外部Kernel可模拟 | Kernel Gateway落地时新增来源到四类Runtime/业务Problem的独立合同测试 |
| 打开、编辑、保存、重载、搜索、块引用、AV、快捷键和插件 | e2e | 真实React、NestJS Gateway、Go Kernel、真实HTTP/WS | CI具备Go/服务后建立，不用route interception冒充E2E |
| 桌面/窄视口无溢出、重叠，主题token正确 | visual | 真实浏览器与稳定baseline/布局断言 | 使用对应浏览器层的互斥config；共享诊断仍受双消费者门槛约束 |

B4建立唯一标准入口：

```text
cd enterprise
pnpm verify:b4

verify:b4
  -> pnpm lint
  -> pnpm typecheck
  -> pnpm test
     -> pnpm test:architecture
     -> pnpm --filter @singularity/protyle-browser test
     -> pnpm --filter @singularity/web test
     -> pnpm --dir ../app test
  -> pnpm build
```

`verify:b4`由`enterprise/package.json`拥有，按固定顺序执行static/ESLint、typecheck、统一`pnpm test`和Vite生产构建。统一`pnpm test`必须同时发现：公共浏览器包自己的Vitest、React宿主Vitest、`enterprise/scripts`的`node:test` AST case，以及独立`app`包的Core/旧壳行为Adapter `node:test`。命令失败即停止，不依赖人工补跑，也不恢复已退役静态壳Playwright来冒充编辑器集成。该命令是B4源码合同的唯一聚合入口，但在S0至S3真实空间与Gateway门禁通过前不能单独证明B4生产完成。

公共包声明并锁定自己的Vitest依赖，不借用Web包runner。旧壳PluginPort行为证据已迁到`app/src/host/plugin.test.js`并改为`node:test`原生case；企业Web中的错放副本已删除。旧`layout/Model`重连测试不保护企业Transport合同，已从企业Web删除，`app/src/layout/Model.ts`只继续服务上游客户端并由生产闭包排除。Core只读与生命周期case同样归`app`；`ProtyleSourceBoundary.test.js`已迁到`enterprise/scripts/protyle-browser-source-audit.test.mjs`，Registry测试归公共包，不保留双测试。

`app`拥有独立`pnpm-lock.yaml`和`tsx` runner依赖。CI必须分别按`enterprise/pnpm-lock.yaml`与`app/pnpm-lock.yaml`执行冻结安装，再只调用`pnpm verify:b4`收集B4证据；不得因企业工作区安装成功而假定`app`测试依赖存在。B3/B4继续扩展现有AST实现，不新增第二套扫描器。

Playwright按交付证据分为两个阶段。S1已经用`tests/browser-integration/`与`playwright.integration.config.ts`收集可替换外部身份、空间或Gateway边界的浏览器集成，并把原静态shell的布局、响应式和浏览器健康合同并入真实身份/空间流程后删除shell runner。P3/P4继续扩展同一browser integration入口；P5首个真实全链合同时再原子建立`tests/e2e/`、独立配置与非空命令，且禁止拦截目标React/Gateway/Kernel链路。B4已删除单消费者fixture与page object；当前诊断support由三个独立browser integration文件共同消费，只按Playwright Request对象原样采集console error/warn、pageerror、requestfailed、HTTP状态、资源失败和请求持续时间，业务允许状态由各spec判断。WebSocket异常采集在S2真实browser消费者出现时同批加入，不预建无消费者分支。

B4门禁的证据边界如下：`verify-protyle-browser-source.mjs`保护Core平台规则，`protyle-vite-closure-audit.mjs`从企业`main.tsx`与唯一Core入口遍历生产闭包，覆盖TS/TSX/JS、静态与动态import、require、re-export、import type及非字面量加载，并应用正向allowlist；通过条件不是固定文件数。两者不能替代运行时行为。P3的真实打开、编辑、事务、推送、viewer只读和三类销毁browser integration代码已落盘但尚未运行；真实菜单、复杂内容与插件留给P4，真实Gateway序列化、授权、空间路由及旧入口删除由P5 E2E收口，不新增完整内部mock链。

## 11. 实施批次与完成条件

### P0 合同与依赖围栏

- 落盘Session、Factory、Controller、HostEvent和PluginPort类型。
- 改正React生命周期组件与组件测试。
- 增加浏览器入口依赖边界校验并接入标准命令。
- 完成条件：类型、lint、组件测试和构建通过；生产入口仍不伪装成真实编辑器。

### S0-S3 企业空间生产前置

- **S0合同与数据库**：建立NestJS/Fastify、Prisma/PostgreSQL、共享合同、授权和Kernel客户端模块。
- **S1身份与空间启动**：建立本地账号Cookie、组织/空间成员和授权后的`SpaceRuntimeBootstrap`。
- **S2 Kernel Gateway**：建立未知即拒绝的Kernel路径策略、实例解析、同源HTTP和只接收推送的Protyle WebSocket。
- **S3空间目录**：以Nest原生Controller/Guard/Pipe/DI和Kernel `identity: service`私网路由提供笔记本、根文档与真实父文档分页；TanStack Query持服务端页，Zustand只持当前三ID选择，锁态、空库和迟到代次均不创建Core。
- **S3浏览器组合根**：由React空间路由从真实启动响应创建生产HostPort、正式零插件PluginPort、Registry、Transport、ResourcePort、Menu、Overlay、无Core完整Runtime和唯一Session，并在空间变化或撤权时销毁；不得使用占位能力或测试Factory冒充编辑器。
- 完成条件：以真实PostgreSQL、Nest HTTPS/WSS和React组件证明真实`spaceId`、完整Runtime、跨空间拒绝、viewer写拒绝、内部地址不泄露和确定性销毁；详见[企业空间Session组合根与Kernel Gateway启动方案](space-session-composition-root.md)。

### P1 浏览器平台收敛

- **P1-A平台源码**：已完成。解析`BROWSER=true`、`MOBILE=false`，移除Protyle目录内ifdef、Electron、Node内置与原生移动import。
- **P1-B1宿主动作**：扩充公共事件；迁移文档、搜索、图谱、大纲、反链、历史、卡片、资源与关闭动作；旧动作不进入公共载荷。
- **P1-B2插件端口**：迁移options、toolbar、事件、菜单、快捷键、斜杠项和paste链；Protyle不再读取`app.plugins`。
- **P1-B3会话协同**：以Session注册表替换`getAllEditor`、活动Tab与跨编辑器布局查询；工作台面板刷新改由Host/Kernel事件拥有。
- **P1-B4边界收口**：保留已完成的显式Runtime与surface合同，S0至S3通过后从真实企业Session切入，经Transport切断请求/订阅隐式边，再移除Protyle对旧`App`、工作台`layout/editor/search/card/history/plugin/menus/mobile`实现的运行时依赖，更新真实入口闭包allowlist。
- 当前实现状态：临时HTML Core和未接线分支已删除；企业`main.tsx`通过唯一公共Factory接入真实Core，生产Session提供Transport/WS、零插件端口、Menu、Overlay、Registry与ResourcePort，专用Sass由运行时资产清单编译并注入Vite入口。P3 browser integration代码已落盘但未运行；`IProtyle.app`等B4剩余条件、P4复杂内容及P5真实全链/旧入口删除仍未完成集中验收。
- 完成条件：公共事件和插件合同类型通过；Protyle源码无旧工作台动作import、无`protyle.app`；浏览器入口闭包只含批准模块；static、unit、component与build集中通过。未达到这些条件前不得把B4或P3标记为已验证，也不得添加HTML、旧App或第二Factory fallback。

P1-B1思源3.7.2加密内容路由收口任务清单与完成条件：

1. 扩充canonical文档、资源与智能体转交HostEvent，使`notebookId`与目标ID一起成为必填载荷；所有可生产这些事件的Protyle在首次内容请求前由所有者传入身份，`onGet`不得回填；迁入Vite闭包后的搜索、卡片和反链直接所有者以显式`initialLoad: owner`替代空`blockId`哨兵；完成条件是生产者直接发送自身身份，公共合同不出现`rootId`、布局对象或旧动作数组，无身份detached表面不能生产内容域事件。
2. 旧壳Host只在`isEncryptedBox(notebookId)`时向Kernel发送`notebook`或资源`box`，包括智能体块标题读取；完成条件是普通内容路径不变，加密解锁时读取当前InBox、锁定时由Kernel拒绝，均不访问全局内容库。
3. `openFileById`、大纲、反链、历史与资源所有者显式接收并继续传递身份；完成条件是删除`getAllModels`、DOM、首个响应回填和其他推断路径，布局复制与恢复保存同一字段。
4. 文档导航的`checkBlockFold`预查询显式接收`notebookId`，Kernel以InBox模型读取加密树；图谱与闪卡在加密身份下于Kernel调用前拒绝；完成条件是正确事件前没有全局预查询，也没有伪造InBox实现、全局查询或默认数据。
5. 删除`app/test/protyle/notebookIdPropagation.test.ts`的源码顺序式行为断言；扩展既有canonical类型与静态边界，只证明显式合同和禁用依赖，运行时InBox与拒绝语义由Kernel integration及P4 browser integration拥有。
6. 完成代码复评后批量运行app标准`node:test`、按case过滤、ESLint、`verify:b4`、Kernel测试与仓库治理门禁；完成条件是当前层级全绿，并明确P4真实浏览器义务仍未被static冒充。

P1-B2任务清单与完成条件：

1. 扩充canonical `ProtylePluginPort`、事件类型和宽容斜杠必要字段；完成条件是公共类型通过且无同义字段。
2. 在旧壳边界实现唯一`createAppProtylePluginPort`并注入`IProtyle.plugins`；完成条件是Adapter承担顺序、快捷键、身份和paste协议转换，不暴露插件数组。
3. 一次性迁移options、toolbar、同步事件、五个直接菜单入口、快捷键、斜杠和两条paste路径；完成条件是Protyle不再读取`App.plugins`或import旧插件实现。
4. 扩展AST门禁并接入既有`pnpm lint`；完成条件是门禁覆盖属性访问、元素访问和旧插件目录运行时import。
5. 以标准`pnpm test`运行真实Adapter的最小插件测试；完成条件是选项/工具栏、事件、首命中、斜杠、异步paste、额外字段和零插件合同通过。
6. 评审后集中运行lint、typecheck、test、build、旧App定向语义诊断与文档校验；真实DOM菜单和paste交互按矩阵留至P4 browser integration。

P1-B3任务清单与完成条件：

1. 在canonical合同中新增泛型Registry并提供无旧壳依赖的真实实现；完成条件是注册顺序、重复注册、active、幂等注销/dispose与迟到注册合同有unit证据。
2. 公共包提供唯一Registry实现；生产Registry由S3真实企业Session拥有，`live`实例构造注册并订阅，`detached`实例明确排除。旧App不得为通过该任务伪造Session；完成条件是已销毁实例、历史/快照/资源预览与ghost均不可遍历且迟到回调不能复活实例。
3. 迁移drag源定位/超级块、Kernel move DOM查找、resize锚点、active undo和Host关闭；完成条件是这些路径不再读取`getAllEditor`、活动Tab、正文Editor model或`blockPanels`数组。
4. 删除drag的Kernel/mobile fallback；源实例缺失以稳定`protyle.registry`错误中止，完成条件是不用目标rootID近似源位置。
5. 扩展AST门禁，覆盖静态/动态/import-equals/import type/require/re-export与`blockPanels`解构，保护已迁移调用不重新导入旧扫描API；明确allowlist中留给B4的大纲/反链、fullscreen和全局浮层UI。
6. 评审后集中运行lint、typecheck、test、build、旧App定向语义诊断与文档校验；真实drag、move、resize和focus DOM路径按矩阵留至P3 integration。

P1-B4任务清单与完成条件：

1. **B4-Runtime合同**：落盘PRD，扩充canonical Session/Runtime、公共Factory、Core内部构造器、surface、participation、content、bound-only initialLoad、错误类别、重试和最小工作台事件；完成条件是公共Factory固定`workspace + live + bound content + automatic`，Session只持`spaceId + runtime`，Core只经Runtime取能力，participation不携带身份，content只表达内容能力，local-only没有首载模式。当前公共包与React Host局部证据已具备。
2. **S0-S3前置门禁**：先完成真实身份、空间、Gateway、服务目录和无Core React组合根；完成条件是生产Session只从授权后的`SpaceRuntimeBootstrap`创建，Factory身份只从当前目录项取得，不存在硬编码、测试Factory、旧壳、local Session、路径或哨兵来源。
3. **Transport迁移**：建立绑定真实`spaceId`的HTTP/WS/FormData上传、结构化请求选项、请求取消、上传进度、订阅终止、四类错误、提交阻断、显式重试与诊断；完成条件是Core不再导入旧`fetchPost`、上传XHR或`layout/Model`，公共合同删除任意header字典与`uploadUrl`，所有者signal进入内部请求，FormData文件不复制，销毁后无迟到响应和重连，旧Model测试与实现同批删除。
4. **B4-Core**：消费S3已建立的Menu、Overlay、正式零插件PluginPort和其他Runtime能力，迁入浏览器Core所需纯能力，把大纲/反链、元数据、活动、全屏、布局和统计同步改为最小HostEvent；完成条件是不重建Session或Runtime，局部关闭只销毁自身菜单实例，切空间才释放菜单能力，嵌入式surface不误改工作台。
5. **B4所有者迁移**：React主编辑器使用公共Factory；BlockPanel与已进入L1迁移范围的搜索、反链、卡片、历史和属性所有者使用Core内部合同，旧所有者退出生产闭包；完成条件是构造器和`IProtyle`删除`app/editors/host/plugins/model/ws`旧字段，live切目标重建，detached不伪造身份且确定性销毁。
6. **B4-Gate**：将公共入口接入真实Core并扩展AST/import图正向allowlist；完成条件是TS/TSX/JS全部加载形式可审计，闭包无旧App、工作台实现、Electron、Node内置、原生移动、平台指令和非字面量运行时加载。
7. **B4测试归属迁移**：公共包声明自己的Vitest入口并迁入Registry/Session；AST样本迁到`enterprise/scripts`的`node:test`；旧壳行为Adapter与Core unit归`app`的`node:test`；当前单消费者Playwright fixture/page object内联删除。完成条件是两个lockfile均由CI冻结安装，旧错放文件删除且没有双测试。
8. **B4验证入口**：补齐`cd enterprise && pnpm verify:b4`对源码合同的聚合发现，并保持与`pnpm verify:s0-s3`职责互补；只在全部L1生产代码、迁移、测试代码、旧路径清理和集中代码复评完成后统一执行。完成条件是最终verification中PRD的B4、P3/P4真实DOM及P5全链E2E证据同时形成，静态壳不得冒充编辑器集成。

### P3 真实编辑器挂载

- 对B4已经接通的React Host、真实Factory、Core和专用Sass执行真实浏览器挂载，不再新增第二处生产接线。
- 证明打开、编辑、事务、推送、只读和三类有序销毁在真实DOM中成立，并修复只属于浏览器行为的缺陷。
- 浏览器集成只从`tests/browser-integration`与专用config收集，允许替换外部Gateway边界。
- 完成条件：上述browser integration通过，B4生产依赖图不变，构建不依赖Webpack Web入口。

### P4 插件与复杂内容回归

- 在B4已接通的正式PluginPort上增加非空React插件注册与管理外围能力，不替换端口或创建第二套插件事实源。
- 验证块引用、属性视图、菜单、快捷键、插件事件、PDF安全预览和主动内容下载策略。
- 完成条件：黄金样例与browser integration通过，不存在旧布局import、旧插件Adapter生产依赖或应用源主动内容执行。

### P5 真实链路与入口删除

- 复用S2已落地的NestJS Gateway和隔离Kernel，运行完整真实E2E。
- 删除旧Webpack Web入口、旧浏览器runner、兼容shim和重复测试。
- 真实E2E只从`tests/e2e`与独立config收集，不拦截目标React/Gateway/Kernel链路。
- 完成条件：真实登录、选空间、打开/编辑/保存/重载、搜索、块引用、AV、插件、越权写拒绝、主动内容隔离和撤权清屏均通过；企业旧Web入口文件、企业侧错位Adapter owner和重复runner物理不存在；上游客户端Adapter由AST证明不进入Vite生产闭包，并满足L1第9.3节对应的生产Protyle验收。L0第8.3节基础工程验收已独立完成。

P3、P4和P5在实现期完成对应浏览器/E2E用例、fixture边界与生产接线，不逐项启动runner。剩余L1全部实现完成后先集中复评，再由verification一次运行`verify:b4`、`verify:s0-s3`、P3/P4 browser integration、P5 E2E、Kernel与供应链矩阵；中途最小诊断不计通过证据。

## 12. 架构审查结论

- **SOLID**：React、生命周期、传输、插件和平台职责分离；Protyle依赖端口而非旧壳。
- **安全**：空间显式绑定，Gateway统一授权，私网跳转使用mTLS与短期服务JWT，请求头按策略重建，主动内容不在应用源执行，无Kernel直连和客户端权限自证。
- **代码质量**：不存在虚构的`openDocument`合同；异步竞态和幂等销毁有明确处理。
- **数据流**：内容不复制，跨边界载荷最小，派生状态就近处理；`spaceId + notebookId + documentId`在创建边界正交绑定，加密内容从Protyle直接发送同一`notebookId`，不从响应、编辑器、布局或内容库反推。
- **剪贴板来源**：版本化注释将内部BlockDOM与来源三ID绑定；外部解析、插件改写失效、同空间来源库查询和跨空间重建ID分别只有一个owner，不以目标编辑器或全局blocktree近似来源。
- **目录选择**：Nest固定路由使用原生装饰器、Guard、Pipe与DI，不建自定义registry；TanStack Query拥有目录页，Zustand只持当前三ID选择，Session通过直接owner传递，锁态和generation使迟到页无法挂载Core。
- **插件字段**：options、toolbar、事件detail和斜杠对象只要求必要字段并保留额外字段；不做exact-object拒绝或字段白名单。
- **插件状态流**：插件注册表由真实企业Session运行时拥有，旧壳Adapter只保留迁移期行为证据；Protyle只持能力端口，不进入React props链或Zustand副本。
- **编辑器状态流**：Registry由单空间企业Session拥有，不进入Zustand；跨模块只传Registry或实例引用，不传布局模型和数组快照。
- **Runtime所有权**：单空间Session只持`spaceId + runtime`；Runtime同时拥有Transport与ResourcePort，Factory与Core不再持第二份Host或Runtime，唯一链路为`Session -> Runtime -> Core`。
- **首载所有权**：`initialLoad`仅存在于两个bound分支且两者都要求真实`blockId + notebookId`；`automatic`与`owner`均经当前Session的同一Transport、同一AbortSignal并只把唯一成功响应交给既有`onGet`，取消、换代、失败或迟到结果不切换入口；local-only无该字段。
- **传输依赖**：旧请求错误链会带回layout，且旧壳没有真实空间身份；故S0至S3先建立真实组合根，再由Transport一次性删除旧fetch/Model路径。
- **拷贝策略**：只在低频paste入口浅拷贝约一至五个载荷字段一次，File、DOM、插件对象和编辑器状态均按引用传递；不做深拷贝或逐层normalize。
- **运行时校验**：沿完整链路为每个真实边界指定唯一owner；目录schema收敛后的内容身份在Transport只做序列化，HTTP/WS/API、跨进程、外部字节和安全生命周期边界分别验证自己的合同，不在编辑热路径重复拦截同一非法值。静态类型不能保护不可信网络输入，因此不以编译期约束替代；不对插件额外字段做unknown-field rejection。详见[ADR-021](../adr/0021-trust-boundary-validation-ownership.md)。
- **生命周期门禁**：Registry仅在低频register时检查disposed并显式抛错，activate对未注册实例返回false；这是Session状态机，不在编辑、drag或resize热路径做重复校验。
- **设计系统**：沿用已批准的shadcn/Tailwind token和Protyle `--b3-*`映射。
- **测试治理**：分阶段非空`verify:s0-s3`与`verify:b4`分别承担服务链和Core源码合同，双lockfile安装、PostgreSQL随机schema、Go服务认证、production build、runner owner、互斥Playwright目录及共享层退役均已明确。
- **对象字段唯一性**：公共Factory只接收一个`notebookId`和一个`documentId`，分别一次绑定为内容库身份并映射为Core `blockId`；HostEvent复用同一`notebookId`，不保存第二份；`participation`只表达生命周期，`content.mode`只表达是否具备内容能力。
- **Adapter必要性**：上游旧壳Host与插件Adapter承担宿主事件、EventBus取消、快捷键、命令/斜杠身份和异步paste协议差异，并继续服务思源客户端；企业React拥有独立正式能力，它们不得进入企业生产组合根，行为证据归App runner而不复制到企业Web。
- **只读边界**：宿主约束与文档响应属性独立取源，Core就近派生有效只读；受控文档锁命令是唯一允许绕过内容写守卫的窄化元数据动作。
- **Menu/Overlay边界**：DOM菜单与浮层留Core；Session拥有菜单能力，触发表面拥有可关闭实例句柄，局部结束不释放Session能力。
- **反链局部刷新**：embedded反链仅在成功`delete`/`move`后调用创建边界注入的直接Backlink父owner `() => void`；普通文本编辑不重查，该回调不进入公共Core options、HostEvent、EventBus、共享能力或Registry，并受owner存活、代次和挂载状态约束。
- **Fallback控制**：无直连Kernel、旧导航或空插件fallback；未提供端口即创建失败。
- **产物泄露**：文档、日志、fixture和快照只包含合同、结果和必要诊断，不包含正文、凭证、内部提示或隐藏推理。

## References

1. [奇点完整方案](../../output/md/Singularity_Enterprise_Knowledge_Base_v1.0.0_2026-07-13.md)
2. [奇点设计系统](../../output/md/Singularity_Design_System_v1.0.0_2026-07-13.md)
3. [ADR-002](../adr/0002-react-shell-protyle-editor.md)
4. [Protyle实现](../../app/src/protyle/index.ts)
5. [真实浏览器Core迁移入口](../../app/src/protyle/browser-entry.ts)
6. [旧应用入口](../../app/src/index.ts)
7. [思源加密笔记本说明](../ENCRYPTED-NOTEBOOK.zh-CN.md)
8. [ADR-020：空间内容目录引导](../adr/0020-space-content-directory-bootstrap.md)
9. [ADR-021：信任边界校验所有权](../adr/0021-trust-boundary-validation-ownership.md)
10. [Protyle类型](../../app/src/types/protyle.d.ts)
11. [ADR-010](../adr/0010-protyle-host-actions-and-contract-ownership.md)
12. [P1-B2插件兼容PRD](../product/protyle-plugin-compatibility.md)
13. [P1-B3编辑器注册表PRD](../product/protyle-editor-registry.md)
14. [P1-B4运行时收口PRD](../product/protyle-runtime-closure.md)
15. [企业空间Session组合根与Kernel Gateway启动方案](space-session-composition-root.md)
16. [ADR-011](../adr/0011-space-session-composition-root.md)
