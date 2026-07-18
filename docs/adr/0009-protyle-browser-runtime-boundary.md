---
title: "ADR-009: Protyle浏览器运行时边界"
description: "确定Protyle通过单空间Session、Kernel传输和类型化宿主事件接入React/Vite"
author: "Codex"
date: "2026-07-13"
version: "1.7.0"
status: "accepted"
tags: ["adr", "protyle", "react", "vite", "runtime"]
---

# ADR-009: Protyle浏览器运行时边界

## Change Log

| Version | Date | Author | Changes |
| --- | --- | --- | --- |
| 1.0.0 | 2026-07-13 | Codex | 确定Protyle浏览器运行时边界 |
| 1.1.0 | 2026-07-14 | Codex | 对齐Session严格销毁顺序与后继会话创建条件 |
| 1.2.0 | 2026-07-14 | Codex | 固定两层Factory、唯一Runtime链、只读来源与B4聚合门禁 |
| 1.2.1 | 2026-07-14 | Codex | 独立架构复评通过并接受决策 |
| 1.3.0 | 2026-07-14 | Codex | 前移真实空间启动与Session组合根，取消旧壳生产Session路径 |
| 1.4.0 | 2026-07-14 | Codex | 闭合S3/B4原子接入、空间资源、服务认证、撤权和S0-S3门禁 |
| 1.4.1 | 2026-07-14 | Codex | 补齐Core通过Runtime取得ResourcePort的唯一能力链 |
| 1.5.0 | 2026-07-14 | Codex | 固定mTLS、结构化请求、主动内容、撤权清理及B4与P3-P5唯一职责 |
| 1.5.1 | 2026-07-14 | Codex | 架构、安全与测试治理复评通过并接受决策 |
| 1.6.0 | 2026-07-18 | Codex | 将带CSRF、取消和进度的FormData上传收归Transport，删除ResourcePort上传URL |
| 1.7.0 | 2026-07-18 | Codex | 以前置空间内容目录补齐真实notebookId与documentId选择来源 |

## Status

Accepted

## Context

ADR-002确定React拥有应用壳、Protyle拥有编辑器DOM。源码审计发现，直接导入`app/src/protyle/index.ts`仍会把旧布局、移动端、菜单、插件、Electron和大量`window.siyuan`状态带入Vite；当前React控制器中的`openDocument`也不是Protyle真实公共方法。

实现审计进一步确认当前企业Web只有固定路由，旧App没有组织或空间身份，仓库内不存在真实`spaceId`生产者。若先迁移旧Core，只能伪造空间身份或增加local Session，二者都违反服务器权威合同。

S3组合根实现审计又确认，原`ProtyleResourcePort.uploadUrl()`只能返回同源字符串，不能携带登录后保存在内存中的CSRF、Session终止状态、AbortSignal和旧上传交互需要的进度。继续让Core按URL创建XHR会重新开放任意header与第二传输路径，并在真实Gateway上被非安全请求CSRF门禁拒绝。

B4接线审计进一步确认，空间路由启动时只有`SpaceRuntimeBootstrap.spaceId`，公共Factory却要求首次内容请求前已有真实`notebookId + documentId`。没有独立目录选择链时，React只能用空值、旧全局状态、DOM或正文响应猜测身份，均会破坏加密内容库隔离。

## Decision

1. 建立唯一的`@singularity/protyle-browser`公共入口，React和企业模块不得越过该入口导入Protyle内部或旧应用壳。
2. 一个浏览器标签页同一时刻只持有一个`spaceId`对应的`ProtyleSession`。Session只保存`spaceId + runtime`并提供重试与有序销毁；Core唯一通过`session.runtime`取得Host、Plugin、Registry、Transport、ResourcePort、Menu和Overlay能力。
3. 公共`ProtyleFactory`只创建`workspace + live`主编辑器，接收`host`、Session、`documentId`、宿主`readOnly`和`AbortSignal`。Core内部构造器才显式接受`workspace/embedded`与`live/detached`；公共`documentId`只映射一次为Core `blockId`，`participation`不携带身份。
4. 文档变化通过销毁并重建Protyle处理，不保留虚构的`openDocument`方法。嵌入式live所有者切目标同样重建，detached预览由所有者确定性销毁。
5. 宿主`readOnly`只表达授权和所有者约束；文档属性只读由Core从真实文档响应取得。Core即时派生有效只读，正式写守卫拒绝事务、上传和写插件能力，同时保留读取能力；文档锁控件使用唯一受控元数据命令，成功或失败后按真实结果重新合并来源。
6. Session拥有菜单能力，触发表面拥有具体菜单句柄。关闭嵌入式表面或切文档只关闭旧表面的句柄，切空间才释放菜单能力；三条生命周期都先停止工作、中止请求、关闭订阅和浮层/菜单实例，再按所有权销毁编辑器与Session能力。
7. `KernelTransport`负责绑定空间的JSON请求、只接收推送的WebSocket和FormData上传，并统一拥有CSRF、取消、上传进度、错误转换与终止状态；`ProtyleResourcePort`只解析assets、自定义Emoji和exports只读URL。公共请求与上传选项不允许任意header字典，上传CSRF不得进入查询串，Gateway按路由策略重建头并通过mTLS与服务JWT访问Kernel。应用源只内联安全MIME allowlist，主动内容与导出HTML强制下载，不允许浏览器直连Kernel、全局资源路径、旧XHR上传或fallback。
8. Protyle通过类型化HostEvent请求React执行文档导航、搜索、图谱、资源和通知；编辑器插件只依赖`ProtylePluginPort`，不直接依赖React路由或旧布局。
9. 浏览器入口闭包不得包含ifdef指令、Electron、Node内置模块或原生移动端import；Vite是唯一Web构建路径。
10. B4由`enterprise`中的唯一`pnpm verify:b4`聚合静态边界、类型、公共包Vitest、React Vitest、`enterprise/scripts`与`app`的`node:test`以及Vite构建；CI分别冻结安装enterprise与app两个lockfile。
11. 生产Session只能由认证、组织成员和空间成员验证后的`SpaceRuntimeBootstrap.spaceId`创建；React空间路由是唯一组合根，旧App、工作区路径、设备ID和随机App ID均不得创建Session。
12. S0数据库与合同、S1身份与空间启动、S2 Kernel Gateway先于生产Core迁移；S3创建生产HostPort、正式零插件PluginPort、Registry、Transport、ResourcePort、Menu、Overlay、无Core完整Runtime和Session。B4作为唯一Core接线批次把React Host、公共Factory和Core接到该Session，不重建Runtime能力；P3/P4只补真实浏览器行为、非空插件和复杂内容证据。
13. Gateway到Kernel的HTTPS、WSS握手和readiness统一使用mTLS与短期Ed25519服务JWT；浏览器Cookie和用户token不进入私网跳转。浏览器连接先pending登记再复验并原子激活，按认证会话、用户、组织和空间索引；会话到期、组织/空间状态及两级成员变化都关闭连接。认证或权限失效时等待Session销毁、清除编辑器DOM后才失效查询并允许当前代次的新Session。
14. `verify:s0-s3`按S0-S3原子增加非空suite，最终聚合数据库、production build、真实Nest HTTPS/WSS、`kernel/serviceauth` Go unit和React组合根证据；`verify:b4`聚合Core源码合同。P3/P4提供真实浏览器能力证据，P5收口真实E2E并物理删除旧Web文件、Adapter和重复runner。
15. B4挂载Core前必须经ADR-020的空间内容目录取得完整文档项。目录由授权后的Nest控制面经mTLS与服务JWT调用Kernel内部只读目录，按笔记本根或真实父文档分页选择身份；目录不走内容Gateway、不读取正文、不暴露路径，也不放宽所有正文、资源、上传和WebSocket继续强制三ID的规则。React只从当前路由代次的目录项创建`ProtyleHost`，迟到目录结果不能补填或改写身份。

## Alternatives

- **iframe旧Web UI**：拒绝。会保留Webpack、旧壳和双会话。
- **直接import并伪造App**：拒绝。真实Core仍会把旧App和工作台模块带入闭包，当前没有可重复的固定文件数阈值。
- **重写编辑器**：拒绝。块语义、属性视图和插件回归风险不可接受。
- **公共Factory暴露全部surface/participation组合**：拒绝。会把Core内部生命周期状态推给React，并扩大无效组合空间。
- **宿主预取文档属性只读**：拒绝。会产生重复请求与第二事实源；Core已从真实文档响应取得属性。
- **增加local Session或占位spaceId**：拒绝。会建立与云端权威并行的身份和传输路径。
- **每实例长期API token**：拒绝。HTTP与WebSocket认证不统一，轮换与泄露半径不满足私网服务边界。
- **ResourcePort只返回upload URL**：拒绝。URL不能承载内存CSRF、请求取消、统一错误状态和上传进度，会迫使Core重建任意header或保留旧XHR传输。
- **把CSRF放进upload查询串**：拒绝。查询串会进入日志、历史和中间设施，并形成第二种CSRF传递合同。
- **从正文响应或旧工作台状态取得notebookId/documentId**：拒绝。首次请求前身份已经缺失，且会让响应反向改写内容库。
- **让内容Gateway接受无documentId的目录请求**：拒绝。目录选择与正文访问会共享不完整身份路径，三ID不变量失效。

## Consequences

- Protyle生产闭包抽取必须先取得真实企业空间组合根，不能以空`App`、测试Session或本地标识假装真实接入。
- 同一标签页暂不支持跨空间同时打开文档；多空间通过显式会话切换处理。
- React不复制文档、选区、事务和撤销状态；Gateway权限是唯一写授权边界。
- React公共装配面保持最小；搜索、反链、卡片、浮层和历史等内部所有者使用受审Core构造合同。
- 宿主约束、文档属性与提交阻断保持正交；网络重试成功不能解除授权或文档属性只读。
- 菜单实例关闭与Session菜单能力释放成为两个独立生命周期动作。
- FormData由Core原样交给Transport且不复制文件；Transport只在XHR信任边界注入CSRF与内容身份头，并与JSON/WS共用同一终止和重试状态。
- 用户认证或权限失效会清除编辑器DOM且不复制正文惰性视图；内容服务或网络故障继续保留当前内容。
- Kernel服务认证失败被Gateway归一为内容服务不可用，不能误映射成用户未认证或无权限。
- 旧Web入口在真实链路验收后删除，不保留双构建或兼容shim。
- React工作台新增独立目录加载、分页、锁态与选择状态；只有当前目录项能产生Factory输入，空库和锁定库不创建Core。
- 迁移按S0-S2、S3无Core组合根、B4原子Core接入和P3-P5批次执行，完成条件和测试矩阵见详细方案。

## References

1. [Protyle浏览器宿主与Vite抽取方案](../architecture/protyle-browser-host.md)
2. [ADR-002](0002-react-shell-protyle-editor.md)
3. [奇点完整方案](../../output/md/Singularity_Enterprise_Knowledge_Base_v1.0.0_2026-07-13.md)
4. [企业空间Session组合根与Kernel Gateway启动方案](../architecture/space-session-composition-root.md)
5. [ADR-011](0011-space-session-composition-root.md)
6. [ADR-020](0020-space-content-directory-bootstrap.md)
