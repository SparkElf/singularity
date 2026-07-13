---
title: "ADR-010: Protyle宿主动作与合同所有权"
description: "确定P1-B工作台动作、插件能力、Session注册表和公共合同的唯一所有者"
author: "Codex"
date: "2026-07-13"
version: "1.3.0"
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

## Status

Accepted

## Context

P1-A后，Protyle目录的平台源码已无ifdef、Electron、Node内置和原生移动import，但真实入口仍闭包374个文件。117个Protyle TypeScript文件有458条跨目录import，导航、搜索、布局、卡片、历史、插件和多编辑器协同仍依赖旧应用壳。

现有`ProtyleHostEvent`不足以表达右/下分屏、后台页签、块上下文、定位和文档范围视图；现有`ProtylePluginPort`也未覆盖快捷键、斜杠项、菜单与顺序paste变换。若继续直接调用旧函数，React无法成为工作台所有者；若把旧参数原样放进事件，则公共合同会永久绑定旧壳。

## Decision

1. React工作台拥有文档导航、搜索、大纲、反链、图谱、历史、卡片、资源和标签页关闭；Protyle只发类型化`HostEvent`。
2. `open-document`使用唯一`documentId`，并以`disposition`、`scope`、`attention`、`scroll`、`restoreScroll`、`zoom`表达正交语义；`scope`区分`target`、`context`、`subtree`，`attention`允许同时focus与highlight，目标定位不与滚动恢复混写，`zoom`不由`scope`推断；禁止携带`CB_GET_*`、`position`、`keepCursor`或`openNewTab`。
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
- **把编辑器列表放入Zustand**：拒绝。Registry不是React渲染事实，复制实例集合会产生双状态源和无效订阅。
- **Registry返回数组快照**：拒绝。drag、transaction和resize只需直接遍历/find，数组复制与可变集合暴露没有收益。

## Consequences

- P1-B须先扩充公共合同，再分宿主动作、插件端口、Session注册表和边界收口四批迁移。
- 旧壳行为只在Host实现中翻译；React Host不识别旧动作常量。
- 入口边界AST门禁须区分类型依赖与运行时依赖，并禁止Protyle重新导入旧工作台动作。
- 插件和跨编辑器合同需要最低充分的unit/component证据；真实DOM、Gateway和Kernel行为留给browser integration与E2E。
- P1-B2以真实旧壳Adapter和最小插件验证顺序、首命中、斜杠身份、异步paste及额外字段；AST门禁禁止Protyle重新读取插件注册表或import旧插件实现。
- P1-B3以真实Registry unit验证生命周期状态转移，并以AST保护已迁移扫描；真实DOM协同留给P3 integration，不用mock Factory冒充Core接入。
- 本决策不改变云端内容权威、Gateway授权或React到编辑器的`spaceId`、`documentId`、`readOnly`边界。

## References

1. [Protyle浏览器宿主与Vite抽取方案](../architecture/protyle-browser-host.md)
2. [ADR-009](0009-protyle-browser-runtime-boundary.md)
3. [奇点完整方案](../../output/md/Singularity_Enterprise_Knowledge_Base_v1.0.0_2026-07-13.md)
