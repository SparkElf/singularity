---
title: "ADR-023: 空间搜索与图谱服务边界"
description: "为云端授权空间提供不依赖当前编辑器身份的搜索与图谱纵向链路"
author: "Codex"
date: "2026-07-19"
version: "1.3.0"
status: "accepted"
tags: ["adr", "discovery", "search", "graph", "space", "l1"]
---

# ADR-023: 空间搜索与图谱服务边界

## Status

Accepted

## Context

思源的搜索和图谱原本由当前编辑器、全局内容库或旧布局调用。奇点把内容放到
按空间隔离的云端Kernel后，空间工作台仍可能尚未选择笔记本和文档；因此不能从
DOM、全局状态、当前编辑器、首个结果、首个Kernel响应或路径反推内容身份。若把
空间级查询错误地挂到文档级接口，还会把迟到响应写回另一个空间或笔记本。

本批需要一个可以由React工作台直接消费的最小搜索/图谱合同，同时保留Go Kernel
已有的FTS和图谱语义，不把内容索引复制到Prisma或Nest，也不引入第二个内容事实源。

## Decision

1. 公共HTTP入口固定为：

   - `POST /api/v1/organizations/{organizationId}/spaces/{spaceId}/discovery/search`
   - `POST /api/v1/organizations/{organizationId}/spaces/{spaceId}/discovery/graph`

   路径只选择组织和空间；请求体分别是`{method, query}`与`{query}`。请求体不接受
   `notebookId`、`documentId`、`rootId`、路径或同义`workspaceId`。

2. Nest `SpaceDiscoveryController`使用现有的声明式`@Controller`、
   `@SessionMutation`、`@CurrentSession`、`ZodValidationPipe`和OpenAPI装饰器。
   `SpaceDiscoveryService`是唯一的空间授权和Kernel调用编排者：先由
   `KernelAccessService`按`organizationId + spaceId + userId`授权，再以service
   identity调用私有Kernel路由。调用不得发送内容身份头，也不得从授权部署对象
   推断`notebookId`或`documentId`。

3. Kernel只注册两个精确的service-identity `POST`路由：
   `/internal/enterprise/discovery/search`和`/internal/enterprise/discovery/graph`。
   路由策略限制请求/响应头为JSON合同，服务认证中间件是私有入口的唯一身份门禁；
   浏览器、内容身份或公网请求不能直接访问它们。

4. Kernel请求在Go入口以严格JSON解码。查询最多512个Unicode code point，请求体
   最多4096字节；未知字段、缺失查询、方法枚举之外的值和超限值返回`400`。搜索
   页大小固定为64，正文投影最多4096个Unicode code point；图谱最多2048个节点
   和4096条边。`method=preferred`在L1明确使用Kernel的keyword默认（与
   `method=keyword`相同），不读取或猜测浏览器旧的搜索偏好；将来增加真正的搜索
   算法时再单独扩展合同。

5. 搜索响应只投影`id + notebookId + documentId + content`及计数。图谱响应只投影
   节点的`id + notebookId + documentId + label`和`from + to`边。Go `GraphNode`
   的`DocumentID`必须由源block的`RootID`产生，`NotebookID`由源block的`Box`
   产生；投影阶段丢弃缺少任一身份的节点，并且只保留两端都在投影集合中的边。
   不得从`path`、首节点、遍历顺序或图谱标签补齐身份。

6. Nest在跨进程响应字节边界使用`@singularity/contracts` schema解析一次，随后
   将已收敛的公开类型交给React。响应超过2 MiB、状态码非200、内容类型错误或
   schema不匹配统一映射为`503`；授权失败对外映射为`404`以避免空间枚举。成功
   响应带`Cache-Control: no-store`，请求断开时取消Kernel调用。

7. 空间级查询没有预先选择的内容身份，因此使用上述公共Nest入口。文档范围面板
   已有目录产生的`notebookId + documentId`，继续只走现有
   `ProtyleTransport -> Kernel Gateway`，不再建立第二套Nest文档查询入口。Gateway
   使用五条`read + content identity`策略：`/api/search/fullTextSearchBlock`、
   `/api/outline/getDocOutline`、`/api/ref/getBacklink2`、
   `/api/history/searchHistory`和`/api/graph/getLocalGraph`。

8. 五条文档路由由service-auth middleware解析内容头一次。Go handler校验请求目标
   属于该`notebookId + documentId`，并把搜索范围和历史查询固定到该文档；浏览器
   发送的path、method、page size、首个`getBlockInfo`或当前布局不能扩大范围。局部
   图谱在企业read分支不得保存浏览器`conf`为Kernel配置，避免只读策略产生隐藏写入。
   `getLocalGraph`是其外部JSON配置的唯一解析owner；反序列化后必须拒绝显式为
   `null`的`conf.type`或`conf.d3`，随后model只消费两个嵌入配置均非空的合同。

9. 文档raw envelope只由React `discovery-api`解析一次，取出`data`后使用公共payload
   schema。企业分支的最小data合同如下：

   - 文档搜索：`blocks[{id, notebookId, documentId, content}]`及
     `matchedBlockCount + pageCount`；
   - 大纲：递归`[{id, name, children}]`，`name`为纯文本且不保留`hPath`别名；
   - 反链：`backlinks/backmentions[{notebookId, documentId, title}]`；
   - 历史：`histories + pageCount + totalCount`；
   - 局部图谱：`nodes[{id, label, notebookId, documentId}] + links[{from,to}]`。

   局部图谱内容节点的两ID来自各自源block；tag等非内容节点的两ID同时为`null`，
   只能展示、不能导航，边只连接本次已经投影的节点。不得把请求的当前文档身份复制给所有节点，也不保留旧`box/rootID/id`响应别名作为第二合同。

10. React工作台头部提供空间搜索和空间图谱入口，两者只打开当前授权空间面板，不读取当前编辑器；Protyle的标签/菜单事件仍可打开相同面板事实源。React只把响应返回的显式笔记本/文档身份交给导航，文档面板使用当前Session Transport，并以面板请求代数和AbortSignal阻止迟到结果覆盖另一代空间或文档会话。该切片不实现实时协作或跨空间全文搜索。

11. 永久证据按真实边界分层：Nest HTTP合同覆盖授权、service identity、CSRF、
   路径和响应schema；Go合同覆盖严格请求解码、身份投影和最小字段；OpenAPI库存
   覆盖两个公共空间路由；Gateway HTTP合同覆盖五条文档read policy和完整内容头；
   Go合同覆盖源节点身份与不可导航tag。实现阶段只做静态语法和差异检查，全部L1
   实现完成后再由`verification`统一运行正式矩阵。

## Alternatives

- **复用当前编辑器的文档搜索/图谱请求**：拒绝。它要求文档身份已经存在，且会把
  空间工作台错误地绑定到某个编辑器实例。
- **为文档面板再建一组Nest Controller**：拒绝。目录已经产生完整内容身份，重复
  入口会让同一文档查询出现Gateway与Controller两套授权、解析和错误语义。
- **在Nest或Prisma复制FTS/图谱索引**：拒绝。会形成第二内容事实源、重复索引维护和
  与Go Kernel语义漂移。
- **由浏览器补发`notebookId/documentId`或由API取首个结果推断**：拒绝。身份来源
  不稳定，跨空间迟到响应可覆盖，并违反ADR-021的唯一owner规则。
- **仅用NOTIFY或内存缓存保存结果**：拒绝。进程重启、撤权和空间切换会丢失明确的
  授权边界；本批只返回实时查询结果，不把缓存当事实源。
- **让`preferred`继续读取旧全局偏好**：拒绝。旧偏好不是空间身份，也无法证明其
  与云端索引算法相容；L1使用显式、可审计的keyword默认。

## Consequences

- 搜索和图谱成为可独立并行交付的空间纵向功能，React、Nest、Kernel之间通过一个
  公共合同集成，互不需要修改编辑器身份链。
- 文档面板继续复用唯一Gateway内容链，但raw Kernel对象在企业分支收敛为最小
  canonical payload；本地非企业思源的既有响应保持不变。
- 每次请求都会经过空间授权和Kernel服务认证，响应只包含导航所需字段；正文和内部
  图谱结构不穿过企业控制面。
- L1暂不提供跨空间全文搜索、服务端结果缓存或多人实时图谱同步；后续能力必须以
  新的产品/安全合同单独评审。

## References

1. [ADR-004：空间级Kernel实例隔离](0004-space-kernel-isolation.md)
2. [ADR-020：空间内容目录引导](0020-space-content-directory-bootstrap.md)
3. [ADR-021：信任边界校验所有权](0021-trust-boundary-validation-ownership.md)
4. [ADR-022：跨进程Kernel端点事实源](0022-cross-process-kernel-endpoint-source.md)
5. [企业空间Session组合根与Kernel Gateway启动方案](../architecture/space-session-composition-root.md)
