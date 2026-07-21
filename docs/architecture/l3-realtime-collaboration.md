---
title: "奇点 L3.0 实时协作语义原型架构方案"
description: "定义实时协作原型的语义操作、因果合并、Kernel事实源与集中验证门禁"
author: "Codex"
date: "2026-07-22"
version: "1.0.0"
status: "verification"
tags: ["architecture", "l3", "realtime-collaboration", "crdt", "prototype"]
---

# 奇点 L3.0 实时协作语义原型架构方案

## 1. 目标与前置

本方案承接 [L3.0 PRD](../product/l3-realtime-collaboration.md) 和 [ADR-006](../adr/0006-realtime-collaboration-gate.md)。目标是建立一个独立、可重复、失败可停止的语义协作原型，证明思源块模型能承载并发操作；目标不是把 CRDT、WebSocket 双向写入或第二正文存储直接接入企业生产。

前置事实：

- Go Kernel 继续拥有正文、块、引用、属性视图和历史；React/Web 只拥有工作台和编辑器宿主。
- L2 已把 `organizationId + spaceId + notebookId + documentId` 固定为内容身份，并由服务端 ACL 重新授权。
- 现有生产 Protyle WebSocket 是只接收推送的订阅；正式写入走 HTTP Kernel transaction。L3.0 不改变该合同。
- 现有仓库没有 CRDT 依赖，也没有可复用的实时写入协议；依赖安装和生产引入必须等候本方案评审。

## 2. 架构决策摘要

1. L3.0 采用“语义操作 + 因果上下文 + 纯 reducer”原型，不采用整文档快照、锁、LWW 或把 Yjs/Automerge 直接当正文模型。
2. 语义核心放在 Go Kernel 侧，因为它拥有 block tree、Lute AST、事务、历史和 AV 事实；TypeScript 只承载公共协议 schema、协议客户端和浏览器测试壳。
3. 原型协议与生产 Gateway/Kernel HTTP/WS 物理隔离；L3.0 不新增生产路由、不新增 Prisma 表、不改变当前客户端默认行为。
4. 所有操作消息携带完整四段内容身份；认证用户和 ACL 从已建立的 HTTP/WS 边界取得，不把 `userId` 再复制进操作对象作为第二权限事实。
5. 并发操作必须可交换或产生明确冲突记录；不能用一个隐含的“最后到达值”覆盖另一个已确认操作。对于无法无损合并的结构操作，原型应拒绝或呈现冲突，而不是静默选择。
6. presence/光标是独立、短生命周期的 ephemeral 流，不进入 Kernel 内容历史、PostgreSQL 或 CRDT 文档。

## 3. 候选方案与选择

| 方案 | 优点 | 主要风险 | L3.0 结论 |
| --- | --- | --- | --- |
| 浏览器直接使用 Yjs/Automerge，服务端只转发更新 | 初始实现快，已有生态 | 会复制块/AV模型；引用、历史、撤销和加密内容身份容易脱离 Kernel | 拒绝作为正文事实源；可在隔离实验中作为对照，不进入生产 |
| 中央锁或最后写入获胜 | 数据结构简单 | 丢失已确认操作，无法满足并发编辑和历史语义 | 拒绝 |
| 继续广播现有 Kernel transaction | 复用现有通道 | 只定义到达顺序，不定义并发文本/结构合并；客户端会互相覆盖 | 拒绝 |
| Go Kernel 内的语义操作引擎，外部 TypeScript 协议/浏览器测试壳 | 内容事实、历史、AV和现有身份在同一内核；可用纯 reducer 做确定性测试 | 需要定义操作语义和冲突状态，原型前期成本较高 | 采用 |

选择 Go 语义核心不是重写 Kernel，也不是引入 Rust；它把新并发算法放在现有内容事实源旁边，减少跨语言内容模型转换。TypeScript 层只做真实协议边界，不建立同形 DTO 或第二 reducer。

## 4. 模块边界与文件归属

| 模块 | 目标 | 生产/原型范围 | 上下游合同 |
| --- | --- | --- | --- |
| L3 contracts | Zod/TypeScript 操作、确认、presence 和错误 schema | `enterprise/packages/contracts/src/realtime-collaboration.ts`、聚合导出和合同测试 | 只表达协议和四段身份，不持有内容状态 |
| Go semantic core | 纯语义操作、因果判断、冲突记录、历史/撤销模型 | `kernel/collab/**` 及 Go 单元/集成测试 | 输入已解析的操作；输出 canonical operation/result，不做 HTTP/WS I/O |
| Kernel bridge | 把原型语义操作应用到现有 block/AV/transaction 模型 | `kernel/collab/bridge.go` 或同领域文件 | 只做真实语义协议转换；不保存第二正文快照 |
| Protocol harness | 模拟两个以上客户端、乱序/重复/断线和权限事件 | `enterprise/packages/realtime-prototype/**` | 消费 contracts，驱动 Go core/bridge，不进入生产 App 模块 |
| Browser prototype | 用两个真实页面/编辑器壳证明 DOM 结果和临时 presence | `enterprise/apps/web/tests/l3-prototype/**`、独立 Playwright config | 只替换明确外部原型服务；不把 route mock 称真实 E2E |
| Integration owner | 唯一聚合入口、固定夹具、证据文档和旧路径审计 | `enterprise/package.json`、计划/ADR/文档 | 在全部模块完成后统一接入，不抢写 contracts 或 Kernel reducer |

共享文件 owner：contracts 聚合器和唯一 prototype runner 由 integration owner 修改；Go 内容模型和 AV 文件由 Go semantic core owner 修改；任何跨模块合同变更先更新 contracts 与 ADR，再改调用方。

## 5. 语义操作合同

### 5.1 操作封装

原型中唯一的正文操作封装为：

```ts
interface CollaborationOperationEnvelope {
  readonly identity: DocumentIdentity;
  readonly operationId: string;
  readonly clientId: string;
  readonly clientSequence: number;
  readonly causalContext: Readonly<Record<string, number>>;
  readonly operation: CollaborationOperation;
}
```

`clientId` 是本次原型会话的临时来源标识，不是用户权限字段；`clientSequence` 在该来源内单调递增；`causalContext` 是唯一因果事实。操作本身不携带 `serverRevision`、`userId`、`space` 或其他同义身份字段，服务端确认消息才添加服务端序号。

### 5.2 操作种类

第一版只实现能覆盖 PRD 门禁的最小联合类型：

- `text.insert` / `text.delete`：以稳定字符/位置锚点表达，不传整段最终文本。
- `block.insert` / `block.move` / `block.delete`：显式 `blockId`、父块和位置；删除保留 tombstone 供历史和引用失效判断。
- `reference.update`：显式目标 `notebookId + documentId + blockId`，目标缺失只能形成失效状态。
- `embed.update`：显式目标内容身份和嵌入属性，不从 DOM 或标题推断目标。
- `attribute-view.cell-set`：显式 `attributeViewId + viewId + rowId + columnId` 和最小单元格值，不提交完整 AV JSON。

禁止新增一个泛化 `document.replace`、`block.patch` 或 `payload: unknown` 来绕过语义类型；新操作必须在联合类型、Go reducer、协议 schema、夹具和验收矩阵中同时出现。

### 5.3 确认与拒绝

服务端确认只返回操作状态和 canonical 因果信息：

```ts
type CollaborationOperationResult =
  | { readonly outcome: "accepted"; readonly identity: DocumentIdentity; readonly operationId: string; readonly serverSequence: number; readonly causalContext: VersionVector }
  | { readonly outcome: "duplicate"; readonly identity: DocumentIdentity; readonly operationId: string; readonly serverSequence: number }
  | { readonly outcome: "rejected"; readonly identity: DocumentIdentity; readonly operationId: string; readonly code: CollaborationRejectionCode };
```

`rejected` 必须说明身份缺失、权限失效、过期因果上下文、结构冲突或协议无效；不能返回“成功但使用了当前文档快照”。异常日志保留原始对象的 `name/message/stack`，并关联 `operationId`、四段身份和请求/会话上下文，不记录完整正文或凭据。

## 6. 因果合并与冲突规则

### 6.1 纯 reducer

Go semantic core 由纯函数式状态转换组成：输入当前语义状态和一条已解析操作，输出新状态、canonical 变更和可观察冲突。reducer 不读 DOM、文件、网络、数据库或全局 Kernel 状态；bridge 才负责把结果应用到现有内容模型。

### 6.2 可合并操作

- 同一位置的并发文本插入按稳定锚点和确定性 tie-break 排序，两个插入都保留；tie-break 只解决相同位置顺序，不覆盖另一操作。
- 不同单元格的 AV 写入可交换；同一单元格的并发写入形成明确 conflict record，不能静默采用后到值。
- 独立块插入、同一父块不同位置的移动和不同目标引用更新按 ID 合并，操作历史完整保留。

### 6.3 不可无损合并操作

- 删除与编辑并发时保留删除 tombstone 和编辑操作历史；可见结果按明确的“已删除”状态呈现，不能丢失编辑操作记录。
- 同一块并发移动到不同父块、同一 AV schema 并发修改或引用目标身份矛盾时产生冲突，不自动选父块、标题或首个响应。
- 冲突状态必须能序列化、回放和在测试中独立断言；没有冲突 UI/解决合同前，不进入 L3.1 生产候选。

### 6.4 历史与撤销

原型历史由 append-only operation log 和可重建 checkpoint 组成，checkpoint 只存在测试运行目录，不作为生产正文存储。每个客户端的 undo manager 只生成自己操作的 inverse operation；inverse 仍经过因果检查和 reducer，不能直接覆盖当前状态。redo 也必须是新操作，不修改旧日志。

## 7. 协议和生命周期

```text
client join(identity, capability)
  -> prototype coordinator authorize + canonical state/version vector
  -> client ready

client submit(operation envelope)
  -> parse identity + ACL + causal context
  -> Go semantic reducer
  -> accepted/duplicate/rejected result
  -> canonical operation broadcast to authorized clients

presence update(identity, ephemeral cursor)
  -> coordinator memory/TTL only
  -> authorized peers
```

- `join`、`submit`、`resume` 和 `leave` 都以四段身份为路由键；连接不得从首个 snapshot 推断 notebook/document。
- `submit` 只接受当前 ACL 允许的 `editor` capability；viewer/commenter 可以加入并接收允许的实时投影，但正文提交在协议入口拒绝，不能靠 UI 禁用按钮。
- `resume` 使用客户端最近确认的 `causalContext`，服务端返回最小缺口操作；不能重发整篇正文作为恢复协议。
- `presence` 与正文操作使用不同的生命周期和错误语义；presence 丢失不改变正文，也不进入历史。
- ACL 撤销通过既有 L2 access-change 事实关闭原型会话；不复制第二套权限事件。

## 8. 数据所有权与边界

| 数据 | 唯一 owner | 原型跨边界载荷 | 下游假设 |
| --- | --- | --- | --- |
| 文档/块/AV正文 | Go Kernel 内容模型 | 最小语义操作或测试状态 | 不从 DOM、标题或缓存推断身份 |
| ACL/capability | L2 DocumentAccessPolicy | 已授权 capability 结果 | 原型不重新实现权限算法 |
| 操作因果 | Go semantic core/coordinator | operationId、clientSequence、causalContext | duplicate/ordering 在协议入口收敛 |
| 历史/撤销 | prototype operation log + reducer | 操作批次和 inverse operation | 不写 PostgreSQL 正文表 |
| presence/光标 | coordinator ephemeral TTL | 最小坐标/选择标识和身份 | 不进入历史、数据库或正文 |

真实外部边界只有 contracts 解析、认证/ACL、跨进程操作字节和浏览器传输；Go reducer 不重复解析 HTTP 或重新做 ACL。跨边界验证只处理新的信任域，不把上游已经保证的值再次归一化。

## 9. 诊断与异常可观测性

保留以下稳定日志标签：

- `collaboration.join`：四段身份、会话代次、capability、结果、耗时。
- `collaboration.operation`：operationId、clientId、clientSequence、serverSequence、结果、冲突代码、耗时；不记录完整操作正文。
- `collaboration.resume`：最近 causalContext 摘要、缺口数量、结果、耗时。
- `collaboration.presence`：会话、目标身份、TTL 结果；不记录正文或选区文本。
- `collaboration.lifecycle`：connecting/ready/reconnecting/revoked/closed 和原因。

每个 `catch`/Promise rejection 由所属边界 logger 记录原始异常对象和完整 stack；协议错误、Kernel bridge 错误和浏览器 pageerror 不能只记录 message 或吞掉。诊断日志保留在原型和未来生产候选中，不因测试通过删除。

## 10. 设计模式与简化比较

- **State**：只用于 coordinator 会话状态和 reducer 的明确状态转换，避免用布尔字段组合出 revoked/reconnecting。
- **Command**：语义操作是可记录、可重放、可生成 inverse 的命令；它比把最终正文快照放入事件更瘦且能解释历史。
- **Observer**：presence 和 canonical operation broadcast 通过订阅者消费，但不让订阅者拥有正文状态。
- **Dependency Injection**：Go bridge 注入内容模型/测试存储边界；reducer 本身保持纯，不通过全局变量取 Kernel 状态。
- 不创建 Event Bus、CQRS、第二 Repository、DTO mapper 或“RealtimeService facade”。它们只会复制同一操作事实并拉长数据流。

更简单的“服务器顺序化 HTTP transaction + 广播”无法表达并发文本和结构合并；更复杂的“浏览器完整 CRDT + Kernel 快照双写”会产生第二事实源。当前方案只在原型中新增语义操作和测试协调器，保持生产主路径不变。

## 11. 测试矩阵与统一门禁

L3.0 只有一个 prototype aggregate，阶段全部实现和 code-review 复评后运行。实现期间可写测试和静态自查，但不运行正式 aggregate。

| 稳定合同 | 最低层级 | 真实/模拟边界 | 测试处置 |
| --- | --- | --- | --- |
| 操作 schema、四段身份、拒绝码 | contract/static | Zod/TypeScript 标准 runner | 新增 contracts case，按 case 可独立运行 |
| 因果向量、重复/乱序、文本/树/引用/AV reducer | Go unit | 纯 semantic core，无 HTTP/DB mock 链 | `go test` 独立 suite，按主要失败原因拆 case |
| Kernel block/AV/history bridge | Go integration | 真实测试内容模型，隔离运行目录 | 扩展 Go 标准入口，不写生产正文到 PostgreSQL |
| 两客户端提交、确认、重连、权限撤回 | integration | 原型 coordinator + 真实 reducer；ACL 使用已有授权合同 | `node:test`/Vitest 标准 runner，固定故障注入 |
| 浏览器双实例 DOM/presence/撤销结果 | browser integration | 独立 prototype 页面，替换明确原型服务边界 | 独立 L3 Playwright config，不称真实 E2E |
| 生产路径未被接入、无新数据库表/默认路由 | static | AST/import/config 结构化审计 | architecture boundary runner，不用源码字符串证明行为 |

统一命令在实现阶段冻结为 `pnpm verify:l3-prototype`，顺序为 contracts -> Go semantic/bridge -> protocol harness -> browser prototype -> static/build。失败按共同根因整批回到 implementation，不能逐 case 修补或用 retry/fallback 通过。

## 12. 完成定义

- L3.0 PRD、架构、ADR 和实施计划全部评审通过并保持 `review`/`implementation`/`verification` 状态一致。
- 普通块、结构块、块引用、嵌入、AV 单元格、历史、撤销、presence、四段身份、重复/乱序/断线/撤权全部通过矩阵。
- 没有锁、LWW、整文档覆盖、第二正文存储、隐式身份推断、未经授权操作或静默冲突丢弃。
- `pnpm verify:l3-prototype` 是唯一集中入口，标准 runner 能按 case 过滤并清理所有本轮资源。
- 只有完成定义全部满足后，才创建 L3.1 生产候选方案；L3.0 不自动改变 L2 或生产 Protyle 合同。

## References

1. [L3.0 实时协作语义原型 PRD](../product/l3-realtime-collaboration.md)
2. [ADR-006：实时协作技术门禁](../adr/0006-realtime-collaboration-gate.md)
3. [ADR-029：L2 异步协作控制面边界](../adr/0029-l2-async-collaboration-boundary.md)
4. [Protyle 浏览器运行时方案](./protyle-browser-host.md)
