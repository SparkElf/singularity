---
title: "Protyle浏览器宿主与Vite抽取方案"
description: "定义奇点React应用与思源Protyle之间的运行时、传输、插件和生命周期边界"
author: "Codex"
date: "2026-07-13"
version: "1.5.2"
status: "review"
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
- `Protyle`构造函数接收旧`App`，实际直接使用`app.plugins`，但其子模块继续导入旧布局、移动端、菜单、搜索、卡片和插件实现。
- P1-A后以`app/src/protyle/index.ts`为入口解析静态相对import，仍形成374个文件的闭包：116个在`protyle`，其余进入`asset`、`config`、`layout`、`mobile`、`plugin`、`search`等旧区域。
- 117个Protyle TypeScript文件仍有458条跨目录import；其中`util`174条、`constants.ts`82条、`dialog`41条、`menus`33条、`layout`25条、`editor`25条、`plugin`22条。
- P1-A已移除Protyle目录内的ifdef、Electron、Node内置和原生移动import；闭包中的移动端与旧壳仍由`App`、布局和工作台动作的反向依赖间接带入。
- `app/src/protyle/method.ts`已有UMD导出先例，但该入口不包含编辑器生命周期，不能替代真实Protyle。
- 当前React `ProtyleHost`只验证了抽象控制器调用，没有连接真实编辑器、Kernel传输、插件或资源。

审计使用本仓源码、现有ADR、正式方案、执行计划和依赖配置完成；本地证据足够，本轮未联网搜索。

### 2.2 P1-B调用归属

| 旧调用 | 所有者 | 目标合同 |
| --- | --- | --- |
| `openFileById`、搜索、图谱、大纲、反链、历史、卡片、资源 | React工作台 | `ProtyleHostEvent` |
| `app.plugins`、`eventBus.emit`、插件菜单、快捷键、斜杠项、paste链 | 编辑器插件运行时 | `ProtylePluginPort` |
| `getAllEditor`、活动编辑器、跨编辑器拖拽/撤销/resize | 单空间Session | `ProtyleEditorRegistry` |
| Protyle菜单、选区、块事务、属性编辑、编辑器对话框与浮层 | Protyle DOM Core | 保留内部实现 |
| HTTP、WebSocket、鉴权错误与Kernel推送 | `KernelTransport` | P2传输合同 |

`BlockPanel`等依赖编辑器DOM、选区和临时Protyle实例的浮层不迁成React路由事件；其生命周期在浏览器Core内收敛。React只接收工作台拥有的导航和外围视图动作。

### 2.3 结论

直接import现有`Protyle`或伪造旧`App`都会把旧应用壳隐式带入Vite。正确边界不是一个空对象shim，而是明确分离浏览器运行时、Kernel传输、插件端口和离开编辑器的宿主事件。

## 3. 目标模块边界

```text
React workspace
  | documentId, spaceId, readOnly
  v
ProtyleHost.tsx
  | create(host, session, documentId, readOnly)
  v
@singularity/protyle-browser
  |-- ProtyleSession       active-space runtime
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

## 4. 权威合同

### 4.1 React到编辑器

边界只传以下权威字段：

| 字段 | 来源 | 消费点 |
| --- | --- | --- |
| `spaceId` | 当前空间路由/会话 | `ProtyleSession`和Kernel Gateway路由 |
| `documentId` | 文档路由/选中项 | Protyle构造参数中的目标块 |
| `readOnly` | 企业授权的有效结果 | 编辑器交互禁用；不作为服务端授权依据 |

边界不同时传`workspaceId`、`blockId`、`rootId`等同义或近似字段。`documentId`到Kernel `blockId`的协议命名只在浏览器编辑器内部转换一次。

React不持有文档DOM、块数组、撤销栈、选区或事务副本。内容事实仍只属于`.sy`和Kernel SQLite。

### 4.2 单空间会话

一个浏览器标签页同一时刻只有一个活动`ProtyleSession`。切换`spaceId`时按固定顺序执行：

1. 阻止新编辑命令。
2. 销毁全部Protyle实例并释放监听器、Observer和编辑器WebSocket。
3. 中止旧空间未完成请求并清除非内容型临时缓存。
4. 销毁插件端口和资源链接。
5. 创建新空间会话后再挂载文档。

不支持同一标签页同时打开多个空间的文档。该约束消除了全局插件ABI和Kernel配置跨空间串用的状态分叉。

### 4.3 生命周期

现有Protyle在构造时通过`IProtyleOptions.blockId`绑定文档，没有公共`openDocument`合同。React边界因此采用重建语义：

```ts
interface ProtyleController {
  focus(): void;
  setReadOnly(readOnly: boolean): void;
  destroy(): void;
}

interface ProtyleFactory {
  create(options: {
    host: HTMLElement;
    session: ProtyleSession;
    documentId: string;
    readOnly: boolean;
    signal: AbortSignal;
  }): Promise<ProtyleController>;
}
```

- `documentId`或`session`变化时销毁旧实例并创建新实例。
- `readOnly`变化只调用控制器，不复制编辑器状态。
- 异步创建使用`AbortSignal`和实例代次，迟到的控制器立即销毁，不能覆盖新文档。
- `destroy`必须幂等，并释放WebSocket、DOM监听器、Observer、插件事件和动态资源引用。
- 创建失败进入可诊断错误状态，不回退到旧编辑器或空白兼容路径。

### 4.4 Kernel传输

`KernelTransport`是有实际语义的Adapter：把Protyle的Kernel HTTP/WS协议转换为企业Gateway的空间路由、认证和错误合同。

- 所有请求显式绑定`spaceId`；不从Referer、当前DOM或文档ID猜测空间。
- Gateway验证会话和空间权限后才转发，浏览器不能直连Kernel地址。
- 写权限由Gateway在HTTP与WebSocket两条路径统一强制执行；`readOnly`只负责前端体验。
- `401/403`转换为宿主可处理的认证/授权事件，不调用旧代码中的延迟整页刷新。
- 传输销毁时中止请求并关闭订阅；不建立直连Kernel的fallback。
- 保留`protyle.transport`诊断标签，只记录`spaceId`、路由、状态、耗时和请求ID，不记录正文、令牌或完整payload。

### 4.5 宿主事件

离开编辑器的行为通过一个类型化`ProtyleHostPort`发送最小事件，由React工作台作为Mediator处理。P1-B固定以下事件语义：

| 事件 | 唯一载荷 | 所有者 |
| --- | --- | --- |
| `open-document` | `documentId`、`disposition`、`scope`、`attention`、`scroll`、`restoreScroll`、`zoom` | React标签页/分屏与Protyle初始定位 |
| `open-search` | `query`、`queryMode`、`method` | React全局搜索 |
| `open-document-search` | `documentId` | React文档范围搜索 |
| `open-outline` | `documentId`、`preview` | React大纲视图 |
| `open-backlinks` | `documentId` | React反链视图 |
| `open-graph` | `scope`及文档范围时的`documentId` | React图谱视图 |
| `open-document-history` | `documentId` | React历史视图 |
| `open-card-review` / `open-card-browser` | `documentId` | React卡片视图 |
| `open-card-deck-picker` | `blockIds` | React牌组选择器 |
| `open-asset` | `assetPath`、可选`page`、`disposition` | React资源查看器 |
| `open-external` | `url` | 浏览器外链策略 |
| `close-document` | `documentId`、`reason` | React标签页生命周期 |
| `notify` | `level`、`message` | React通知系统 |

`open-document.disposition`只取`current`、可复用已有目标的`new-tab`、强制重复目标的`duplicate-tab`、`background-tab`、`split-right`、`split-bottom`。`scope`只取默认目标加载`target`、上下文加载`context`或全量子树加载`subtree`；`zoom`独立表示是否进入块聚焦视图，因为旧加载全部子树不必然触发zoom。`attention`只取`none`、`focus`、`highlight`或`focus-and-highlight`。`scroll`只取`auto`或`start`；`restoreScroll`只取`never`、`always`或`if-document`，两者组合表达目标定位与已存滚动恢复。

`open-search.queryMode`只取覆盖现有查询的`replace`或在现有查询中增删词项的`toggle-term`；它不表示搜索/替换界面。`method`只取用户偏好的`preferred`或强制关键词的`keyword`。

旧`CB_GET_*`数组不穿过公共边界。旧壳Host实现负责把上述语义一次性转换为旧加载参数；React Host直接消费语义字段，不保留第二套动作合同。

事件使用discriminated union，每种语义只保留一个字段名。Protyle内部菜单、选区和块事务仍由Protyle拥有，不转成React state，也不为每个旧函数建立一层透传adapter。

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

Paste以调用方小载荷为唯一当前值。旧壳适配器为保持调用方所有权只创建一次浅工作副本，随后原地应用各插件返回的有效字段；普通paste约五个字段，本地文件paste约一个文件列表字段，不复制File、正文DOM或编辑器状态。每个插件事件detail只携带当前字段、editor引用和resolve回调；额外返回字段继续进入下一插件。该低频浅拷贝避免修改调用方局部变量，替代方案是直接改写输入对象，所有权更模糊，故不采用。

`createAppProtylePluginPort`是有实际语义的Adapter：旧侧是`App.plugins`、可取消DOM EventBus、可变工具栏、命令和斜杠回调；新侧是顺序能力端口。它转换事件取消语义、用户快捷键覆盖、首命中命令、斜杠身份和异步paste结果，不作为fallback，P5删除旧Web入口时同步删除。

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

P1阶段由浏览器旧`App.protyleEditors`临时拥有该实例，并注入每个`IProtyle.editors`；P2创建真实`ProtyleSession`时把所有权原样迁入Session，不保留两个注册表。可交互Protyle完成内部对象构造后注册，`destroy`统一注销、终止WS及排队重连，`focusin`更新active。服务端对浏览器主动关闭执行既有`HandleDisconnect → RemovePushChan`清理，不需要客户端销毁后继续发送`closews`。反链模型和`BlockPanel`各自拥有动态子Protyle与未完成请求，关闭所有者时先中止请求再逐一销毁子实例；回调还必须确认所有者未销毁且挂载节点仍在DOM，防止迟到构造重新注册。带`CB_GET_HISTORY`的只读历史与资源预览没有WS、协同事务、拖拽或活动撤销语义，因此明确不注册。属性面板为读取属性视图而在脱离DOM容器中构造的ghost Protyle通过内部`participateInSession: false`生命周期参数同时排除Registry与WS；该参数不进入插件可修改的Protyle options。这些实例仍可调用幂等`destroy`，但注销为空操作。

Registry只替换实例协同：跨编辑器拖拽源定位与超级块清理、Kernel move DOM查找、resize锚点、active undo和旧Host关闭。大纲/反链面板刷新、全屏工作台布局、全局浮层收起、`BlockPanel`创建仍是B4工作台边界；禁止为追求“调用清零”把这些模型塞入Registry。

跨文档drag的源DOM必须属于当前Registry。找不到源实例时抛出`[protyle.registry]`诊断错误并中止，不再查询跨窗口/mobile数组、Kernel块信息或使用目标rootID。Kernel move从Registry覆盖的正文、搜索、反链和浮层实例按注册顺序查找首个包含目标块的DOM，找到后即停止并只深克隆一次；只读历史预览不接收实时Kernel move。找不到可见DOM时仍保留现有协议占位元素，用于应用Kernel操作，不伪造源编辑器身份。

设计模式只采用Registry封装实例身份与生命周期，内部`Map`同时提供Repository式find/遍历但不另建Repository层。更简单的全局数组无法隔离空间和销毁；Zustand会复制非渲染领域状态；继续扫描布局树会保留旧壳依赖，均不采用。

### 4.8 浏览器Runtime与表面

`ProtyleRuntime`是单空间Session向浏览器Core提供的唯一运行时对象。它只组合已有或有真实所有权差异的能力，不暴露旧`App`：

```ts
type ProtyleSurface = "workspace" | "embedded";

interface ProtyleRuntime<TEditor, TOptions, TToolbar, TMessage, TMenu, TOverlay> {
  readonly host: ProtyleHostPort;
  readonly plugins: ProtylePluginPort<TOptions, TToolbar, TEditor>;
  readonly editors: ProtyleEditorRegistry<TEditor>;
  readonly transport: ProtyleTransport<TMessage>;
  readonly menu: ProtyleMenuPort<TMenu>;
  readonly overlays: ProtyleOverlayPort<TOverlay>;
}

interface ProtyleTransport<TMessage> {
  request<TResponse>(path: string, body?: unknown, options?: ProtyleRequestOptions): Promise<TResponse>;
  subscribe(options: ProtyleSubscriptionOptions<TMessage>): ProtyleSubscription;
  dispose(): void;
}

interface ProtyleMenuPort<TMenu> {
  readonly current: TMenu;
  dispose(): void;
}

interface ProtyleOverlayPort<TOverlay> {
  add(overlay: TOverlay): () => void;
  forEach(visitor: (overlay: TOverlay) => void): void;
  dispose(): void;
}
```

构造器另收唯一`surface`字段。`workspace`表示React或旧壳页签拥有的主编辑表面，可以请求活动状态、面板同步、全屏和布局持久化；`embedded`表示搜索、反链、浮层、历史和属性预览等由局部所有者销毁的表面。是否加入Registry和实时订阅仍由生命周期合同决定，不能拿该资格或DOM类名反推surface。`readOnly`仍由`ProtyleFactory`/Controller拥有，不进入插件可变options；权限或错误将其收紧后，只有宿主取得新的授权事实才能解除。所有现有创建点在同一迁移批一次性显式声明，不保留接收`App`的重载。

Runtime不是新的全局服务定位器。Core只读取所需粗粒度能力；React不订阅Runtime，也不把其中实例复制到Zustand。旧壳过渡入口在Core外把现有Host、PluginPort、Registry与后续Transport/Menu/Overlay实现组装为Runtime，P5随旧入口删除适配器。

`spaceId`只由企业路由和`ProtyleSession`保存，是请求、订阅与资源隔离的权威标识；Runtime接收的Transport已经绑定该Session，不重复保存同一字段。旧思源壳没有`spaceId`语义，不能拿workspace路径、随机应用ID或Kernel实例ID近似代替；过渡旧壳仅用于验证既有行为，在P5真实链路中由企业Session替换。`ProtyleTransport.request`返回协议响应并保留服务端错误类别，`subscribe`只创建当前编辑器订阅；Transport、Menu与Overlay均提供幂等`dispose`，由Session按固定顺序释放。Menu端口只暴露当前会话菜单，Overlay端口只增量登记和遍历当前会话浮层，不暴露可变数组或创建业务动作。

生命周期只有一条所有权链：Session拥有Runtime和空间级资源，编辑器/嵌入式所有者拥有自己的请求与订阅，Overlay端口拥有浮层登记，Registry拥有可交互编辑器身份。关闭嵌入式所有者先中止请求再销毁子实例；切文档先销毁旧实例再创建新实例；切空间先停止接收工作，再按请求、订阅、浮层/菜单、编辑器、插件端口顺序释放。销毁是终态，迟到Promise、网络恢复和插件回调均不能重新登记实例。

Transport错误只输出正交类别`unauthenticated`、`forbidden`、`kernel-unavailable`和`network-failure`及必要请求标识，不携带正文或凭证。Host将前两类转换为会话失效或权限只读，将后两类转换为停止提交与用户显式重试；任何类别都不触发整页刷新、自动重复写、备用地址或默认成功。B4以真实Transport实现和可控的浏览器`fetch`/`WebSocket`外部边界做unit证据；P5在NestJS Gateway落地后再以真实HTTP/WS证明状态码、序列化、授权与空间路由。

### 4.9 B4闭包审计与依赖顺序

当前从真实`app/src/protyle/index.ts`追踪的运行时闭包为378个文件，仍包含旧`App`、layout、menus、mobile、plugin、search、editor、history与card。现有平台门禁只扫描Protyle目录本身，公共包门禁尚未接入真实Core，因此两项绿色结果均不能证明B4完成。

最大隐式边来自通用请求：Protyle中54个文件直接使用旧`fetchPost`，其错误和Kernel故障处理继续导入layout；旧WebSocket Model也在重连时读取完整App。由此B4不能在Transport之前完成。依赖顺序调整为：

1. **B4-Runtime**：落公共Runtime、surface、工作台事件和所有权合同；旧壳在Core外组装。
2. **P2-Transport**：落单空间HTTP/WS、授权错误、取消与诊断；一次性替换Core旧请求和Model链。
3. **B4-Core**：收回菜单、浮层与纯浏览器能力，删除`IProtyle.app/model/ws`及旧工作台运行时边。
4. **B4-Gate**：公共入口接入真实Core后，从入口遍历TS/TSX/JS全部模块加载，应用正向allowlist。

每个子批删除自己的旧字段和旧入口，不保留双请求、双菜单、App构造器重载或fallback。P1-B4只有在第4项门禁和集中验证完成后才标记结束。

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

旧Webpack Web入口不参与开发、测试或生产构建。迁移完成时删除旧入口及其浏览器构建脚本，不保留双构建命令。

### 5.3 合同所有权与源码接入

`enterprise/packages/protyle-browser/src/contracts.ts`是唯一公共合同源。`app/src/protyle`只能通过显式相对路径做`import type`，该依赖在运行时擦除；禁止在旧源码复制事件union或PluginPort定义。

P3由`@singularity/protyle-browser`公共入口接入保留于`app/src/protyle`的上游Core。边界校验将Core目录视为受审源码根，只允许进入已批准的浏览器共享模块；不得因此放开`app/src/index.ts`、`layout`、`mobile`或旧工作台动作。类型依赖从Core指向公共合同不形成运行时包循环。

### 5.4 样式与资源

- 新建只包含Protyle、菜单、Tooltip和必要基础类的浏览器Sass入口，不导入旧应用壳的完整`base.scss`。
- Tailwind继续只加载theme和utilities，不启用全局Preflight；React规则限制在`[data-singularity-ui]`。
- Protyle继续消费`--b3-*`，其值由奇点设计系统语义token映射。
- Lute、图表、数学公式和Web Component资源通过版本化只读资源地址加载，地址由Session配置提供。
- 主题或视觉变化先更新设计系统token或Protyle样式入口，不在业务页面写局部补丁。

## 6. 状态与数据流

- TanStack Query拥有组织、空间、权限和文档树等服务端视图缓存。
- Zustand只在出现跨页面或多组件共享的客户端工作台状态时使用；Protyle内部状态不得进入Zustand。
- `ProtyleSession`拥有空间级编辑器运行时和传输生命周期，不拥有文档内容副本。
- 临时派生值在消费点计算；跨边界只传ID、权限结果和类型化事件。
- 不新增深拷贝、双写、兼容字段或运行时unknown-field拒绝逻辑。

## 7. 设计模式评估

| 模式 | 用途 | 采用结论 |
| --- | --- | --- |
| Facade | 把旧插件的顶栏/Dock/页签扩展转换为React扩展点 | 采用；承担真实UI生命周期转换 |
| Adapter | 把Kernel HTTP/WS协议转换为带`spaceId`和企业错误语义的Gateway协议 | 采用；承担认证、路由和错误转换 |
| Mediator / Event-Driven | 处理编辑器发出的打开文档、搜索、图谱等宿主事件 | 采用；避免Protyle直接依赖React路由和旧布局 |
| Factory | 异步创建真实Protyle并统一销毁 | 采用；隔离资源加载和实例生命周期 |
| Plugin | 保留Protyle插件选项、工具栏和事件扩展 | 采用；只暴露必要能力 |
| Singleton | 保存活动空间会话 | 不采用；Session由React工作台显式拥有，便于销毁和测试 |

## 8. 更简单方案比较

| 方案 | 未采用原因 |
| --- | --- |
| iframe嵌入旧思源Web UI | 保留Webpack和旧壳，形成双路由、双会话和跨frame插件问题，不满足L0入口切换 |
| Vite直接import并伪造`App`/`window.siyuan` | 浏览器闭包仍跨369个文件并包含Electron和旧布局；shim不能消除隐式副作用 |
| 立即用TipTap/Lexical重写 | 丢失块事务、引用、属性视图、插件和快捷键语义，风险远高于抽取 |

最终方案模块更多于一个空shim，但把复杂性集中在四个真实边界，React到编辑器的数据路径仍只有`spaceId -> documentId -> Protyle -> Kernel`。

## 9. 安全与可观测性

- 浏览器产物不得包含Kernel内网地址、工作空间路径、服务凭证或分享密码。
- 插件和编辑器请求必须经过同一Gateway授权；插件不能绕过只读权限直接提交事务。
- 资源URL只允许配置的同源Gateway前缀，禁止由文档内容提供任意Kernel基址。
- `protyle.lifecycle`记录`spaceId`、`documentId`、阶段、结果和耗时；不记录正文、选区文本或插件私有数据。
- `protyle.transport`记录请求ID、Kernel路由、状态和耗时；鉴权信息与payload不入日志。
- 创建、切文档、切空间和销毁失败必须可区分，便于定位异步竞态与资源泄漏。

## 10. 测试矩阵

测试遵循最低充分层级，并统一接入workspace命令。

| 稳定合同 / 风险 | 最低层级 | 真实与模拟边界 | 现有测试处置 |
| --- | --- | --- | --- |
| 浏览器入口不依赖旧壳、ifdef、Electron或Node内置 | static | TypeScript AST/import图；不运行源码字符串伪行为测试 | 新增边界校验并接入`lint`或`check` |
| HostEvent不携带旧动作数组，Protyle不直接import工作台导航实现 | static + typecheck | AST依赖方向与公共discriminated union | 扩展现有平台AST门禁，不建孤儿脚本 |
| 插件选项、工具栏和同步事件顺序 | unit + static | 单元测试驱动真实旧壳Adapter与最小插件；不模拟Adapter内部链 | P1-B2接入workspace `test`，AST禁止Core读取插件注册表 |
| 插件快捷键首命中、斜杠身份和paste异步顺序 | unit + browser integration | unit使用真实端口和最小插件；P4浏览器使用真实Protyle与插件端口 | P1-B2覆盖顺序、额外字段和零插件；P4补DOM回归 |
| Session注册、活动实例、幂等注销、WS终止、只读预览排除与切空间清理 | unit + static + P3 integration | unit驱动真实Registry与Model计时器/WS边界；AST验证旧扫描移除；P3使用真实Factory/Core验证实例构造与预览排除 | P1-B3新增无重复合同的Registry、Model生命周期与AST边界测试，由现有workspace `pnpm test`发现；保留现有App、PluginPort与ProtyleHost测试，不以mock Factory自证Core注册 |
| Runtime装配、显式surface与旧App移除 | typecheck + static + P3 integration | 公共类型与真实入口闭包；P3验证各表面真实生命周期 | B4扩展canonical合同和AST门禁；不以构造完整mock App证明解耦 |
| HTTP/WS绑定spaceId、取消、错误语义和销毁终止 | B4 unit + P5 contract | B4只替换浏览器`fetch`/`WebSocket`外部边界；P5以真实HTTP/WS驱动Gateway并模拟外部Kernel | P2建立统一Transport测试入口并删除旧fetch/Model；Gateway合同落地后补真实HTTP/WS，不保留双实现 |
| 菜单、浮层与工作台面板事件的唯一所有者 | unit + P3/P4 integration | unit验证Session集合生命周期；真实DOM行为由浏览器集成证明 | 复用现有Vitest与后续Playwright入口，不为每个菜单helper建测试 |
| 公共入口真实Core闭包不含旧壳与平台禁用边 | static + build | AST/import图覆盖TS/TSX/JS及所有模块加载形式；Vite产物 | B4把现有source/boundary门禁收敛到真实入口，不以目录字符串搜索代替依赖图 |
| `documentId`/Session变化重建，迟到实例销毁，readOnly就地更新 | component | 真实React effect；只模拟外部Protyle Factory | 改造`ProtyleHost.test.tsx`，删除不存在的`openDocument`断言 |
| 真实Protyle渲染、编辑、提交事务和处理推送 | browser integration | 真实React+Protyle；拦截外部Gateway HTTP/WS时明确标为integration | 扩展现有Playwright fixture和page object，不另建临时脚本 |
| Gateway请求携带唯一`spaceId`并转换401/403/Kernel错误 | contract | 至少一条真实HTTP驱动；外部Kernel可模拟 | Kernel Gateway落地时新增合同测试 |
| 打开、编辑、保存、重载、搜索、块引用、AV、快捷键和插件 | e2e | 真实React、NestJS Gateway、Go Kernel、真实HTTP/WS | CI具备Go/服务后建立，不用route interception冒充E2E |
| 桌面/窄视口无溢出、重叠，主题token正确 | visual | 真实浏览器与稳定baseline/布局断言 | 复用现有桌面/移动project和诊断fixture |

当前标准入口：

```text
pnpm lint          static boundary + ESLint
pnpm typecheck     public contracts and consumers
pnpm test          Vitest component contracts
pnpm build         Vite production artifact
pnpm e2e           current static workspace shell browser check
```

P3建立`pnpm test:browser`作为Playwright浏览器集成入口；P5再把`pnpm e2e`收敛为不拦截目标后端的真实Gateway与Kernel链路。当前`workspace.spec.ts`只验证静态壳，其单一fixture仅采集console error/warning、requestfailed和HTTP 4xx/5xx，尚未采集pageerror、CORS细节、关键长pending或WebSocket异常；其fixture与page object当前均只有一个稳定消费者，B3不扩展共享层。P3出现第二个稳定浏览器合同时，再按测试治理统一诊断生命周期并补齐上述信号。

B3静态门禁扩展现有`verify-protyle-browser-source.mjs`并由`pnpm lint`聚合；其纯AST审计入口由现有`pnpm test`以最小内联语法样本验证动态import、import-equals、re-export、import type、require和`blockPanels`解构，不读取源码字符串证明运行时行为。Registry行为与Model终止状态测试同由现有入口发现；Model测试只替换浏览器WebSocket与时钟外部边界，证明排队重连取消、幂等断开和活动连接重连，不模拟内部调用链。不新增runner、fixture、helper或SDK。现有App、PluginPort和ProtyleHost测试保护不同合同，均保留不改；当前没有与Registry生命周期、活动实例、传输终止或该架构边界重复的测试。

B4先把现有门禁的证据边界说清：`verify-protyle-browser-source.mjs`只证明117个Core文件本身的平台与已迁移import规则，`verify-protyle-browser-boundary.mjs`只证明尚未接入Core的公共包闭包；两者不能合并声称真实入口已经安全。B4-Gate在公共入口接入Core后扩展现有AST/import图实现，覆盖TS/TSX/JS、静态与动态import、require、re-export、import type及非字面量加载，并由`pnpm lint`发现。永久行为测试只保护Runtime/Transport/Menu/Overlay的稳定状态、取消和错误分类；真实菜单、浮层、面板、全屏和字数统计留给P3/P4浏览器集成，真实Gateway序列化与授权留给P5，不新增完整内部mock链。

## 11. 实施批次与完成条件

### P0 合同与依赖围栏

- 落盘Session、Factory、Controller、HostEvent和PluginPort类型。
- 改正React生命周期组件与组件测试。
- 增加浏览器入口依赖边界校验并接入标准命令。
- 完成条件：类型、lint、组件测试和构建通过；生产入口仍不伪装成真实编辑器。

### P1 浏览器平台收敛

- **P1-A平台源码**：已完成。解析`BROWSER=true`、`MOBILE=false`，移除Protyle目录内ifdef、Electron、Node内置与原生移动import。
- **P1-B1宿主动作**：扩充公共事件；迁移文档、搜索、图谱、大纲、反链、历史、卡片、资源与关闭动作；旧动作不进入公共载荷。
- **P1-B2插件端口**：迁移options、toolbar、事件、菜单、快捷键、斜杠项和paste链；Protyle不再读取`app.plugins`。
- **P1-B3会话协同**：以Session注册表替换`getAllEditor`、活动Tab与跨编辑器布局查询；工作台面板刷新改由Host/Kernel事件拥有。
- **P1-B4边界收口**：先建立显式Runtime与surface，经P2 Transport切断请求/订阅隐式边，再移除Protyle对旧`App`、工作台`layout/editor/search/card/history/plugin/menus/mobile`实现的运行时依赖，更新真实入口闭包allowlist。
- 完成条件：公共事件和插件合同类型通过；Protyle源码无旧工作台动作import、无`protyle.app`；浏览器入口闭包只含批准模块；static、unit、component与build集中通过。

P1-B2任务清单与完成条件：

1. 扩充canonical `ProtylePluginPort`、事件类型和宽容斜杠必要字段；完成条件是公共类型通过且无同义字段。
2. 在旧壳边界实现唯一`createAppProtylePluginPort`并注入`IProtyle.plugins`；完成条件是Adapter承担顺序、快捷键、身份和paste协议转换，不暴露插件数组。
3. 一次性迁移options、toolbar、同步事件、五个直接菜单入口、快捷键、斜杠和两条paste路径；完成条件是Protyle不再读取`App.plugins`或import旧插件实现。
4. 扩展AST门禁并接入既有`pnpm lint`；完成条件是门禁覆盖属性访问、元素访问和旧插件目录运行时import。
5. 以标准`pnpm test`运行真实Adapter的最小插件测试；完成条件是选项/工具栏、事件、首命中、斜杠、异步paste、额外字段和零插件合同通过。
6. 评审后集中运行lint、typecheck、test、build、旧App定向语义诊断与文档校验；真实DOM菜单和paste交互按矩阵留至P4 browser integration。

P1-B3任务清单与完成条件：

1. 在canonical合同中新增泛型Registry并提供无旧壳依赖的真实实现；完成条件是注册顺序、重复注册、active、幂等注销/dispose与迟到注册合同有unit证据。
2. 由浏览器旧`App`创建唯一Registry并注入`IProtyle`；可交互实例构造注册、focus激活和所有destroy路径统一注销并终止WS，反链与浮层所有者关闭时中止请求并销毁动态子实例，`CB_GET_HISTORY`与脱离DOM的ghost预览明确排除，完成条件是已销毁实例、只读预览与ghost均不可遍历且迟到回调不能复活实例。
3. 迁移drag源定位/超级块、Kernel move DOM查找、resize锚点、active undo和Host关闭；完成条件是这些路径不再读取`getAllEditor`、活动Tab、正文Editor model或`blockPanels`数组。
4. 删除drag的Kernel/mobile fallback；源实例缺失以稳定`protyle.registry`错误中止，完成条件是不用目标rootID近似源位置。
5. 扩展AST门禁，覆盖静态/动态/import-equals/import type/require/re-export与`blockPanels`解构，保护已迁移调用不重新导入旧扫描API；明确allowlist中留给B4的大纲/反链、fullscreen和全局浮层UI。
6. 评审后集中运行lint、typecheck、test、build、旧App定向语义诊断与文档校验；真实drag、move、resize和focus DOM路径按矩阵留至P3 integration。

P1-B4任务清单与完成条件：

1. 落盘[运行时收口PRD](../product/protyle-runtime-closure.md)，扩充canonical Runtime、surface与最小工作台事件；完成条件是类型语义正交，不携带旧App、layout model、DOM、正文或同义ID。
2. 在旧壳边界组装唯一Runtime并一次性迁移所有Protyle创建点；完成条件是构造器和`IProtyle`删除`app`，各创建点显式声明surface和生命周期，不保留重载或兼容桥。
3. 进入P2 Transport前置子批，建立绑定`spaceId`的HTTP/WS、取消、授权错误与诊断；完成条件是Core不再导入旧`fetchPost`或`layout/Model`，销毁后无迟到响应和重连。
4. 建立Session Menu/Overlay所有权并迁入浏览器Core所需纯能力；完成条件是Core不再以`window.siyuan.menus.menu`、`blockPanels`、旧layout/editor/search/card/history/plugin/menus/mobile模块为运行时事实源。
5. 把大纲/反链、元数据、活动、全屏、布局和统计同步改为最小HostEvent；完成条件是工作台只收ID、动作与统计结果，嵌入式surface不误改工作台。
6. 删除`IProtyle.model/ws`旧所有权字段和间接插件/App读取，收敛插件调用到唯一PluginPort；完成条件是无旧字段、双状态、fallback或薄透传adapter。
7. 将公共入口接入真实Core并扩展AST/import图正向allowlist；完成条件是TS/TSX/JS全部加载形式可审计，闭包无旧App、工作台实现、Electron、Node内置、原生移动、平台指令和非字面量运行时加载。
8. 代码复评后集中运行lint、typecheck、unit、contract、Vite build、旧Web定向诊断与文档校验；真实DOM行为按矩阵进入P3/P4，静态壳不得冒充编辑器集成。

### P2 Session与Kernel传输

- 初始化空间配置、语言、临时缓存、资源和HTTP/WS传输。
- 实现切空间销毁顺序、授权错误和诊断日志。
- 完成条件：真实HTTP合同通过；无直连Kernel或fallback。

### P3 真实编辑器挂载

- Vite加载Protyle DOM核心和专用Sass。
- React工作台以真实Factory替换空状态，完成打开、编辑、事务和只读。
- 完成条件：browser integration通过，构建不依赖Webpack Web入口。

### P4 插件与复杂内容回归

- 接入PluginPort及React插件Facade。
- 验证块引用、属性视图、菜单、快捷键和插件事件。
- 完成条件：黄金样例与浏览器回归通过，不存在旧布局import。

### P5 真实链路与入口删除

- 接入NestJS Gateway和隔离Kernel，运行真实E2E。
- 删除旧Webpack Web入口、旧浏览器runner、兼容shim和重复测试。
- 完成条件：L0第8.3节验收全部通过。

每批完成一个可交付边界后集中验证；不为每个机械替换单独运行整套测试。

## 12. 架构审查结论

- **SOLID**：React、生命周期、传输、插件和平台职责分离；Protyle依赖端口而非旧壳。
- **安全**：空间显式绑定，Gateway统一授权，无Kernel直连和客户端权限自证。
- **代码质量**：不存在虚构的`openDocument`合同；异步竞态和幂等销毁有明确处理。
- **数据流**：内容不复制，跨边界载荷最小，派生状态就近处理。
- **插件字段**：options、toolbar、事件detail和斜杠对象只要求必要字段并保留额外字段；不做exact-object拒绝或字段白名单。
- **插件状态流**：插件注册表仍由Session/旧壳运行时拥有，Protyle只持能力端口；不进入React props链或Zustand副本。
- **编辑器状态流**：Registry由单空间Session/旧App过渡所有，不进入Zustand；跨模块只传Registry或实例引用，不传布局模型和数组快照。
- **Runtime所有权**：单空间Session拥有Runtime；Core只消费显式能力和surface，旧App只在Core外过渡装配且P5删除。
- **传输依赖**：旧请求错误链会带回layout，故P2 Transport作为B4闭包前置子批；不保留旧fetch/Model并行路径。
- **拷贝策略**：只在低频paste入口浅拷贝约一至五个载荷字段一次，File、DOM、插件对象和编辑器状态均按引用传递；不做深拷贝或逐层normalize。
- **运行时校验**：不新增schema校验、unknown-field rejection、超时或热路径断言；正确性由类型、端口所有权、unit与AST门禁保证。
- **生命周期门禁**：Registry仅在低频register时检查disposed并显式抛错，activate对未注册实例返回false；这是Session状态机，不在编辑、drag或resize热路径做重复校验。
- **设计系统**：沿用已批准的shadcn/Tailwind token和Protyle `--b3-*`映射。
- **测试治理**：稳定合同、层级、mock边界、runner和旧测试处置已明确。
- **对象字段唯一性**：公共事件不携带`id/blockId/rootId`并存；宿主统一使用`documentId`，旧Kernel命名只在边界内转换。
- **Adapter必要性**：旧壳Host承担宿主事件到旧布局参数的转换；旧插件Adapter承担EventBus取消、用户快捷键、命令/斜杠身份和异步paste协议转换。两者均不暴露旧对象，并在P5随旧Web入口删除。
- **Menu/Overlay边界**：DOM菜单与浮层留Core，Session仅拥有单例集合和生命周期；不是把每个菜单动作包装成HostEvent。
- **Fallback控制**：无直连Kernel、旧导航或空插件fallback；未提供端口即创建失败。
- **并发协作**：当前`mailbox.md`只声明`dataops`范围，与本方案文件无重叠；若出现同文件并发修改，先在根`mailbox.md`声明归属，不覆盖他人改动。
- **产物泄露**：文档、日志、fixture和快照只包含合同、结果和必要诊断，不包含正文、凭证、内部提示或隐藏推理。

## References

1. [奇点完整方案](../../output/md/Singularity_Enterprise_Knowledge_Base_v1.0.0_2026-07-13.md)
2. [奇点设计系统](../../output/md/Singularity_Design_System_v1.0.0_2026-07-13.md)
3. [ADR-002](../adr/0002-react-shell-protyle-editor.md)
4. [Protyle实现](../../app/src/protyle/index.ts)
5. [旧应用入口](../../app/src/index.ts)
6. [Protyle类型](../../app/src/types/protyle.d.ts)
7. [ADR-010](../adr/0010-protyle-host-actions-and-contract-ownership.md)
8. [P1-B2插件兼容PRD](../product/protyle-plugin-compatibility.md)
9. [P1-B3编辑器注册表PRD](../product/protyle-editor-registry.md)
10. [P1-B4运行时收口PRD](../product/protyle-runtime-closure.md)
