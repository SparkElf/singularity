---
title: "ADR-010: Protyle宿主动作与合同所有权"
description: "确定P1-B工作台动作、插件能力、Session注册表和公共合同的唯一所有者"
author: "Codex"
date: "2026-07-13"
version: "1.11.1"
status: "accepted"
tags: ["adr", "protyle", "host-event", "plugin", "session"]
---

# ADR-010: Protyle宿主动作与合同所有权

## Change Log

| Version | Date | Author | Changes |
| --- | --- | --- | --- |
| 1.0.0 | 2026-07-13 | Codex | 确定P1-B合同所有权与迁移批次 |
| 1.1.0 | 2026-07-13 | Codex | 补宿主导航、搜索、牌组、资源与外链精确语义 |
| 1.2.0 | 2026-07-13 | Codex | 固定插件能力端口、顺序流水线与额外字段策略 |
| 1.3.0 | 2026-07-13 | Codex | 固定单空间编辑器Registry、active与销毁隔离语义 |
| 1.4.0 | 2026-07-14 | Codex | 固定显式浏览器Runtime、表面语义与传输前置关系 |
| 1.4.1 | 2026-07-14 | Codex | 固定readOnly单向收紧、生命周期顺序与分阶段传输证据 |
| 1.4.2 | 2026-07-14 | Codex | 去除Runtime重复spaceId并补能力端口释放合同 |
| 1.5.0 | 2026-07-14 | Codex | 分离授权只读与提交阻断并统一Session销毁顺序 |
| 1.5.1 | 2026-07-14 | Codex | 统一决策状态并固定三类所有者严格销毁步骤 |
| 1.6.0 | 2026-07-14 | Codex | 闭合Session/Runtime链路、participation、创建点与错误重试合同 |
| 1.7.0 | 2026-07-14 | Codex | 分离公共与Core创建合同，固定菜单句柄、受控解锁和唯一测试门禁 |
| 1.7.1 | 2026-07-14 | Codex | 独立架构复评通过并接受决策 |
| 1.8.0 | 2026-07-14 | Codex | 前移真实空间组合根并将旧创建点改为React替代或按功能迁移 |
| 1.9.0 | 2026-07-14 | Codex | 统一S3/B4原子接入、空间资源、私网认证、撤权链与S0-S3门禁 |
| 1.9.1 | 2026-07-14 | Codex | 补齐ResourcePort能力并明确Protyle WebSocket禁止浏览器写入 |
| 1.10.0 | 2026-07-14 | Codex | 固定结构化请求头、mTLS、撤权清屏、主动内容及B4唯一生产接线 |
| 1.10.1 | 2026-07-14 | Codex | 架构、安全与测试治理复评通过并接受决策 |
| 1.10.2 | 2026-07-15 | Codex | 明确静态shell条款已由ADR-013取代，当前仅保留browser integration，P5再建立E2E |
| 1.11.0 | 2026-07-15 | Codex | 对齐思源3.7.2独立加密内容库，为文档宿主动作增加显式notebookId路由 |
| 1.11.1 | 2026-07-15 | Codex | 固定智能体转交与折叠预查询的显式加密内容库路由 |

## Status

Accepted

## Context

P1-A后，Protyle目录的平台源码已无ifdef、Electron、Node内置和原生移动import；2026-07-14现有平台门禁实测扫描118个Core文件和4个边界文件，但真实公共入口尚未接入Core，因此没有可重复的完整闭包证据。源码直接证据仍表明导航、搜索、布局、卡片、历史、插件和多编辑器协同依赖旧应用壳。

现有`ProtyleHostEvent`不足以表达右/下分屏、后台页签、块上下文、定位和文档范围视图；现有`ProtylePluginPort`也未覆盖快捷键、斜杠项、菜单与顺序paste变换。若继续直接调用旧函数，React无法成为工作台所有者；若把旧参数原样放进事件，则公共合同会永久绑定旧壳。

固定思源3.7.2候选把加密笔记本置于独立blocktree、content数据库与资源路由中。`documentId`仍标识目标，但不能选择内容库；缺少`notebookId`时，文档、反链、大纲、历史和资源会误走全局路径，图谱与闪卡还可能对不支持的加密内容执行全局查询。该身份已由Protyle拥有，宿主扫描布局、Registry、DOM或遍历已解锁内容库都会形成隐式第二事实源。

## Decision

1. React工作台拥有文档导航、搜索、大纲、反链、图谱、历史、卡片、资源和标签页关闭；Protyle只发类型化`HostEvent`。
2. `open-document`使用唯一目标`documentId`和唯一内容库`notebookId`，并以`disposition`、`scope`、`attention`、`scroll`、`restoreScroll`、`zoom`表达正交语义；`scope`区分`target`、`context`、`subtree`，`attention`允许同时focus与highlight，目标定位不与滚动恢复混写，`zoom`不由`scope`推断；禁止携带`CB_GET_*`、`position`、`keepCursor`或`openNewTab`。
3. 全局搜索、文档范围搜索、大纲、反链、历史和卡片使用不同事件类型；不以可选字段组合猜测事件语义。
4. 全局搜索以`queryMode`区分覆盖查询和切换词项，不把旧`replace`参数误解为替换界面。
5. `new-tab`允许复用已有目标，`duplicate-tab`强制新建目标；不得把旧`removeCurrentTab`与`openNewTab`压成同一行为。
6. 卡片牌组选择、资源打开和外链打开分别使用`open-card-deck-picker`、`open-asset`和`open-external`；Protyle内部菜单只负责产生这些命令。
7. 编辑器插件能力统一经`ProtylePluginPort`提供，包括options、toolbar、事件、菜单、快捷键、斜杠项与顺序paste变换。插件额外自有字段不被拒绝或剥离。
8. 跨编辑器拖拽、事务、resize和活动撤销目标由单空间`ProtyleEditorRegistry`拥有；注册表不进入React store，也不保存内容副本。
9. Protyle内部菜单、选区、块事务、属性编辑、对话框和DOM浮层留在浏览器Core，不转成工作台事件。
10. `enterprise/packages/protyle-browser/src/contracts.ts`是唯一公共合同源。上游Core只可`import type`该文件，不复制union；运行时依赖方向仍从公共入口指向受审Core。
11. 旧壳Host可以承担语义事件到旧布局参数的真实协议转换，但不得成为fallback；P5删除旧Web入口时同步删除。
12. 插件端口使用七项粗粒度能力，不暴露插件数组：顺序扩展options和toolbar、同步emit、首命中编辑器命令、斜杠遍历与身份调用、异步paste流水线及dispose。
13. 事件detail、工具栏项和斜杠对象按引用保留额外字段；paste只为调用方所有权创建一次小载荷浅副本，随后顺序应用插件结果。禁止exact-object校验、字段白名单、超时fallback或备用paste路径。
14. 旧`App.plugins`适配器负责把可取消EventBus、用户快捷键、命令/斜杠注册和`preventDefault + resolve`转换为能力端口；这是协议与生命周期边界，P5随旧Web入口删除。
15. `ProtyleEditorRegistry`只保存当前空间`IProtyle`引用、插入顺序和active；不保存布局模型、正文、DOM副本、undo镜像或React状态。
16. Registry提供幂等register/unregister、直接forEach/find、已注册实例activate、getActive和幂等dispose；dispose后的register显式失败，旧Session实例不能进入新Session。
17. Registry只拥有drag、transaction、resize、active undo与Host关闭的实例协同。大纲/反链、fullscreen、全局浮层UI和`BlockPanel`创建留给B4 Host/工作台边界。
18. Session只保存唯一`spaceId`、唯一Runtime、重试和有序销毁；Factory与Core不得重复保存Host或再接收一份Runtime。Core只从`session.runtime`取得Host、PluginPort、Registry、Transport、ResourcePort、Menu与Overlay能力，唯一数据链为`Session -> Runtime -> Core`。
19. 公共`ProtyleFactory`只创建`workspace + live + bound content`主编辑器，接收`host`、Session、唯一`notebookId`、唯一`documentId`、宿主`readOnly`和`AbortSignal`。`notebookId`在构造时绑定内容库，`documentId`只映射一次为Core `IProtyleOptions.blockId`；两者正交且生命周期内不由响应改写。Core内部构造器才显式接受`surface: workspace | embedded`、`participation: live | detached`与`content.mode: bound | local-only`。
20. `fetchPost`、任意请求header字典、全局资源路径和旧`layout/Model`会重新引入旧壳或绕过空间路由。S0至S2先建立真实Gateway，S3组装生产HostPort、正式零插件PluginPort、Registry、Transport、ResourcePort、Menu、Overlay、无Core完整Runtime和Session，B4再原子替换Core请求、资源和订阅链，最后关闭真实入口闭包门禁；请求选项只保留signal、响应类型和Range等结构化语义，不保留独立传输批次或双路径。
21. Menu和BlockPanel的DOM行为留在浏览器Core；Session拥有菜单能力与浮层登记，触发菜单的工作台或嵌入式表面拥有返回的菜单句柄。局部结束只关闭自己的句柄，切空间才释放菜单能力；不得继续读取`window.siyuan.menus.menu`或`window.siyuan.blockPanels`作为事实源。
22. 大纲/反链刷新、文档元数据、活动状态、全屏、布局持久化和字数统计通过最小HostEvent交付；不传布局对象、DOM、完整编辑器、正文或选区文本。
23. 真实浏览器入口闭包门禁从公共入口遍历TS/TSX/JS的静态、动态、require、re-export和type-only加载，使用正向allowlist拒绝旧`App`、工作台实现、Electron、Node内置、原生移动、平台指令及非字面量运行时加载。
24. `spaceId`只来自服务端授权后的`SpaceRuntimeBootstrap`并由Session保存；路由参数只定位查询，Runtime中的Transport已经绑定Session，不重复该字段。旧壳不得以workspace路径、随机应用ID或Kernel实例ID近似，也不增加local Session；旧壳Adapter只验证迁移行为，不进入生产组合根。
25. Transport同时拥有HTTP请求和编辑器订阅；Menu创建带幂等`close()`的表面句柄，Overlay的登记也返回同时关闭DOM资源并注销的幂等句柄。三者均提供幂等`dispose`，且不暴露旧App、可变全局数组、正文或布局对象。
26. Factory/Controller的`readOnly`只表示授权与所有者强制约束；文档属性只读只从真实文档响应取得。Core即时派生两者的或值，未认证或无权限只能收紧宿主来源，网络恢复和插件不能解除任一仍成立的来源。Kernel/网络故障只阻断提交，显式重试成功不能改变只读来源。
27. B4以可控浏览器外部边界证明请求/订阅取消与错误分类；S2以真实NestJS HTTPS/WSS、mTLS和受控外部Kernel证明授权、空间路由及主动内容策略，P5以完整React、Gateway和Kernel链路收口E2E，三者不得互相冒充。
28. 关闭嵌入式所有者、切文档与切空间是三个独立有序状态机：三者都依次停止新工作、中止请求、关闭订阅、关闭浮层与表面菜单实例；前两者保留Session菜单能力，切空间才在编辑器之前释放菜单能力并在编辑器之后释放插件。销毁后任何迟到结果不得更新后继界面或重新登记实例。
29. `surface`只决定工作台与嵌入式宿主行为；`participation`是仅含`live | detached`的标量，只决定Registry和订阅；`content.mode`只决定是否具有内容Transport、ResourcePort与内容域HostEvent能力。`live`必须以唯一Core `blockId`和构造时`notebookId`绑定真实目标并在任一目标变化时重建；`detached`只有真实属性上下文才可使用`bound`并同时保留两项身份，历史、配置和生成预览没有真实身份时只能`local-only`，不得填空串、占位或近似ID。
30. 当前16个旧构造点不机械注入Session：主编辑器由React公共Factory替代，BlockPanel迁入Core，搜索、反链、卡片、历史、属性、资源预览和AgentComposer随对应React所有者迁移，旧所有者退出生产闭包；AgentComposer使用`embedded + detached + local-only`，`app/src/mobile/editor.ts`继续排除，不得为兼容旧入口放宽allowlist。
31. `effectiveReadOnly = hostReadOnly || documentReadOnly`只在Core消费点派生，不作为第三个可写事实源；Kernel/网络故障只改变正交`submission`状态。四类错误只携带类别和请求标识，重试资格由类别决定；Session重试成功不得改变宿主或文档只读。
32. B4新增刷新大纲/反链、文档标题/图标、活动文档、全屏、布局、统计和运行时错误的独立HostEvent；只有workspace surface可发送工作台同步事件，统计载荷只含计数，不含正文、选区或HTML。
33. 插件命令ABI不新增读写推断字段；有效只读在Core事务、上传和正式写能力入口拒绝写入，Gateway对HTTP写协议再次授权并拒绝浏览器WebSocket数据帧。文档锁控件使用唯一窄化的受控元数据命令：宿主只读时不可用，请求中与失败保持原状态，成功后用最新文档属性重新合并；普通插件和写入口不能调用该例外。
34. `enterprise`中的`pnpm verify:b4`是唯一B4聚合门禁，必须发现公共包Vitest、React Vitest、`enterprise/scripts`的AST `node:test`、`app`的Core/Adapter `node:test`、类型、静态边界和Vite构建。CI分别冻结安装enterprise与app两个lockfile，不依赖人工补跑。
35. P3/P4 browser integration与P5 E2E使用互斥`testDir`和独立Playwright config。原静态shell目录、配置与空E2E入口已由ADR-013在S1删除，其设计系统证据并入真实身份/空间browser integration；P5首个真实全链合同落地时才建立非空E2E。只有一个消费者的fixture和page object在B4内联删除，至少两个稳定合同出现后才可重新抽取技术support。
36. S0至S3先建立PostgreSQL空间事实、认证Cookie、Gateway真实HTTP/WS和React唯一Session组合根；该前置未通过时，`verify:b4`的局部合同证据不得解释为生产B4完成。
37. Gateway到Kernel统一使用mTLS与短期Ed25519服务JWT；Kernel路由策略以`HTTP method + canonical route template`为键并声明头白名单，空间assets/upload/exports由ResourcePort消费，主动内容不在应用源执行。
38. 连接Registry先pending登记再复验激活，并按`authSessionId/userId/organizationId/spaceId`索引；会话到期、用户/组织/空间及两级成员变化以4401/4403关闭。浏览器先等待Session销毁并清DOM，再失效查询；数据帧以4408拒绝。
39. S3创建包含正式零插件PluginPort、Menu、Overlay及其他能力的无Core完整Runtime；B4是React Host、公共Factory和Core接入该Session的唯一批次，不重建Runtime。P3只验证真实DOM与编辑行为，P4只增加非空插件和复杂内容外围能力，P5运行全链E2E并删除旧入口。
40. `verify:s0-s3`按阶段原子增加非空数据库、production build、HTTPS/WSS、Go服务认证和组合根证据；`verify:b4`是Core源码合同门禁。P3/P4/P5测试不得被任一局部门禁冒充。
41. 所有离开Protyle后仍访问文档或资源的HostEvent必须携带当前`notebookId`；`spaceId`选择授权Kernel实例，`notebookId`选择实例内内容库，目标ID标识文档、块或资源。普通笔记本不额外发送Kernel路由参数；加密笔记本显式发送`notebook`或`box`。图谱与闪卡缺少加密库实现时在宿主调用Kernel前拒绝；不得扫描布局、Registry、DOM、`rootId`或其他内容库推断身份，也不得回退到全局查询。
42. `add-blocks-to-agent`携带源`notebookId`；Host仅在加密身份下向`getRefText`发送`notebook`，解锁时读取当前InBox，锁定时由Kernel专用入口拒绝，不隐藏入口或回退全局标题。文档导航的折叠状态预查询同样显式携带该身份，并由Kernel以InBox模型读取加密树；禁止在正确HostEvent前先查询全局库。
43. workspace/live及任何可发送内容域HostEvent的embedded Protyle由所有者在首次内容请求前传入真实`notebookId`；`onGet`不得从响应回填或改写身份。没有真实身份的detached历史、配置或生成预览不能发送内容域事件，不以空串、`rootId`或首个响应近似。

## Alternatives

- **继续传完整`App`**：拒绝。Protyle可越过边界访问任意旧壳状态，入口闭包无法收敛。
- **把每个旧函数包装成同名事件**：拒绝。会保留旧参数、薄adapter和工作台实现细节。
- **把所有编辑器浮层迁到React**：拒绝。选区、DOM生命周期和插件菜单会产生双状态源。
- **复制一份合同到`app/src/protyle`**：拒绝。事件演进会出现两个公共事实源。
- **新增独立contracts包**：暂不采用。两个消费者可用擦除后的类型依赖，新增包不减少当前数据流或边界复杂度。
- **把插件数组挂到`IProtyle`**：拒绝。Core仍能读取任意插件内部状态，B2无法形成能力边界。
- **继续只用通用`emit(): boolean`**：拒绝。布尔值无法同时清楚表达事件广播、快捷键首命中、斜杠身份和异步paste顺序。
- **每项能力拆成独立端口**：拒绝。七个对象共享同一插件顺序和生命周期，会增加装配与跳转而没有独立所有者。
- **继续扫描布局树和`blockPanels`**：拒绝。实例身份依赖旧壳容器，切空间与销毁没有统一边界。
- **让旧壳Host从活动编辑器或首个Kernel响应补`notebookId`**：拒绝。宿主事件失去自包含路由，首次请求已可能进入错误内容库，复制、恢复和并发标签页还会选择错误实例。
- **让Kernel按`documentId`遍历已解锁加密内容库**：拒绝。它破坏笔记本隔离、扩大查询成本并把缺失字段掩盖成运行时fallback。
- **把编辑器列表放入Zustand**：拒绝。Registry不是React渲染事实，复制实例集合会产生双状态源和无效订阅。
- **Registry返回数组快照**：拒绝。drag、transaction和resize只需直接遍历/find，数组复制与可变集合暴露没有收益。
- **先局部复制helper再处理Transport**：拒绝。通用请求仍会经错误处理链带回旧layout，闭包数字下降但事实源不变。
- **保留`App`并只改为type import**：拒绝。运行时对象仍可被间接模块穿透，类型无法证明React可独立装配。
- **用surface推断Registry/订阅资格**：拒绝。搜索、反链和卡片是embedded但需要实时会话，历史和属性ghost同为embedded却不需要，推断会混淆宿主行为与资源生命周期。
- **给缺少文档身份的预览伪造documentId**：拒绝。历史、快照和生成AV的内容事实来自所有者载荷，空串或近似ID会污染路由和诊断。
- **为插件命令增加推测性读写字段**：拒绝。会改变既有插件ABI且不能约束绕过公开能力的插件；写保护应位于Core和Gateway的权威写边界。
- **让公共Factory暴露全部surface/participation组合**：拒绝。React不需要构造内部表面，暴露后会增加无效组合与调用方分支。
- **由宿主预取文档属性并传有效readOnly**：拒绝。会重复真实文档请求并形成第二事实源。
- **继续暴露全局current菜单实例**：拒绝。关闭局部表面时无法区分实例关闭与Session能力释放。
- **为旧壳增加local Session**：拒绝。它会引入第二种身份、传输和销毁状态，且不属于云端产品范围。

## Consequences

- P1-B须先扩充公共合同，再分宿主动作、插件端口、Session注册表和边界收口四批迁移。
- 旧壳行为只在Host实现中翻译；React Host不识别旧动作常量。
- 入口边界AST门禁须区分类型依赖与运行时依赖，并禁止Protyle重新导入旧工作台动作。
- 插件和跨编辑器合同需要最低充分的unit/component证据；真实DOM、Gateway和Kernel行为留给browser integration与E2E。
- P1-B2以真实旧壳Adapter和最小插件验证顺序、首命中、斜杠身份、异步paste及额外字段；AST门禁禁止Protyle重新读取插件注册表或import旧插件实现。
- P1-B3以真实Registry unit验证生命周期状态转移，并以AST保护已迁移扫描；真实DOM协同留给P3 integration，不用mock Factory冒充Core接入。
- B4 Runtime局部合同可先完成；S0至S2真实空间与Gateway、S3无Core组合根随后成为生产Core迁移前置，B4原子接通Host/正式PluginPort/Factory/Core并通过真实闭包门禁后才算P1-B4结束。
- 旧Web壳不装配生产Session/Runtime；公共Factory服务React主编辑器，嵌入式所有者随对应功能切到Core内部合同，不保留接收`App`的构造器重载。
- React创建边界固定为`spaceId + notebookId + documentId + readOnly`；`notebookId`与`documentId`在构造时一次绑定，内容响应不得回填或改写。无真实身份的detached实例仅本地渲染，不取得内容能力。
- 文档与资源HostEvent复用构造时的标量`notebookId`；事件仍不携带正文、DOM或布局对象，React和旧壳宿主均可在访问Kernel前确定内容库或拒绝不支持能力。
- 菜单和浮层保持编辑器DOM语义，但菜单实例归触发表面、菜单能力归Session，全局集合不再属于`window.siyuan`。
- 有效只读从宿主约束和真实文档属性就近派生，文档锁解除成为唯一窄化例外，网络恢复不改变权限状态。
- B4 CI需要安装两个独立pnpm锁文件，并只以一个聚合命令形成当前阶段证据；浏览器集成与真实E2E不再共用目录。
- 认证或权限失效会有序销毁Session并清除编辑器DOM；Kernel或网络故障只阻断提交并保留当前内容。
- 本决策不改变云端内容权威或Gateway授权；React到编辑器的边界明确为`spaceId`、`notebookId`、`documentId`和`readOnly`。

## References

1. [Protyle浏览器宿主与Vite抽取方案](../architecture/protyle-browser-host.md)
2. [ADR-009](0009-protyle-browser-runtime-boundary.md)
3. [奇点完整方案](../../output/md/Singularity_Enterprise_Knowledge_Base_v1.0.0_2026-07-13.md)
4. [企业空间Session组合根与Kernel Gateway启动方案](../architecture/space-session-composition-root.md)
5. [ADR-011](0011-space-session-composition-root.md)
6. [思源加密笔记本说明](../ENCRYPTED-NOTEBOOK.zh-CN.md)
