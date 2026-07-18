---
title: "ADR-020: 空间内容目录引导"
description: "确定授权空间如何取得真实笔记本与文档身份，并在内容请求前建立唯一选择链"
author: "Codex"
date: "2026-07-18"
version: "1.2.0"
status: "accepted"
tags: ["adr", "space", "directory", "notebook", "document", "nestjs"]
---

# ADR-020: 空间内容目录引导

## Change Log

| Version | Date | Author | Changes |
| --- | --- | --- | --- |
| 1.0.0 | 2026-07-18 | Codex | 固定空间目录选择链、声明式控制面、Kernel服务目录与迟到结果规则 |
| 1.1.0 | 2026-07-18 | Codex | 将服务、内容与WebSocket查询身份改为随路由一体声明，避免整个internal命名空间错误免除内容身份 |
| 1.2.0 | 2026-07-18 | Codex | 固定Kernel readyz必须等待完整启动门禁，避免端口监听被误判为内容可用 |

## Status

Accepted

## Context

ADR-009和ADR-011要求任何内容请求及Protyle实例在首次请求前已经具有真实`spaceId + notebookId + documentId`。当前React空间路由只能从`SpaceRuntimeBootstrap`取得`spaceId`，而Gateway又在读取正文前强制要求`notebookId + documentId`；浏览器因此没有合法来源可以列出笔记本、展开文档树或选择首文档。

以空字符串、笔记本ID、随机ID或固定测试ID冒充文档ID会破坏身份语义；从DOM、`window.siyuan`、旧`App`、首个正文响应、全局BlockTree或已解锁内容库扫描推断身份会重新引入跨库查询和迟到响应覆盖。直接放宽Gateway则会让目录和正文共用一条缺失身份的请求链，无法证明加密内容库隔离。

思源现有文件树已经验证“先列笔记本，再按笔记本根或真实父文档惰性列一层子文档”的用户行为，但旧接口公开文件路径并依赖全局状态和Kernel直连，不能直接暴露给企业浏览器。目录必须成为独立的身份选择边界，且不能读取正文或替代内容Gateway。

## Decision

1. 在空间启动与内容Gateway之间增加唯一的“空间内容目录”边界。目录只负责把授权空间中的可见笔记本和文档项变成真实`notebookId + documentId`选择，不读取正文、不创建内容Session、不承担写权限，也不改变所有正文、资源、上传和WebSocket请求必须携带三ID的现有门禁。
2. 公共控制面只提供三个精确、安全的同源`GET`合同：`/api/v1/organizations/{organizationId}/spaces/{spaceId}/content-directory/notebooks`列笔记本；`.../notebooks/{notebookId}/documents?offset=N`列根文档；`.../notebooks/{notebookId}/documents/{documentId}/children?offset=N`列真实父文档的直接子项。根层由路由自身表达，不使用空文档ID、笔记本ID或其他哨兵；`offset`缺省为0且只用于同级分页。
3. 笔记本项只包含`notebookId`、名称、图标和`locked`。关闭笔记本不返回；锁定加密笔记本只返回自身壳，不返回或暗示内部文档标识、标题、层级和数量。文档项包含`notebookId`、`documentId`、标题、图标和`hasChildren`，不返回`.sy`路径、Kernel路径、正文、摘要、块数组或内部地址。每页固定最多128项并返回唯一`nextOffset: number | null`；文档项重复携带自身`notebookId`，使其进入选择状态时不必与可能已经换代的查询参数拼接身份。
4. NestJS沿用现有声明式HTTP边界，不创建目录专用扫描器或第二套registry。精确路由由`@Controller`、`@Get`、Swagger metadata和常量模板声明，认证由现有`@Authenticated()` metadata与全局Guard执行，当前会话由`@CurrentSession()`注入，路径与查询由`ZodValidationPipe`解析，`ContentDirectoryService`以`@Injectable()`和构造器DI取得`KernelAccessService`与`KernelPrivateClient`。Controller和Service均为默认singleton；路由不重叠，无优先级。缺失provider、重复Fastify路由或重复Kernel策略键使Nest启动失败，不保留手工注册、中央`switch`或兼容路径。
5. `ContentDirectoryService`先用当前`userId + organizationId + spaceId + action=read`读取最新五层授权与ready Kernel部署，再调用私网目录；`viewer`、`editor`和`admin`均可读。未认证返回401，不存在、停用、未授权的空间或笔记本及不属于该笔记本的父文档统一返回隐藏式404，Kernel未就绪、mTLS/JWT失败、超时、非JSON、超限或schema不符返回503。目录是安全GET，不新增CSRF传递方式，也不启用CORS或自动重试。
6. Kernel新增`GET /internal/enterprise/directory/notebooks`与`GET /internal/enterprise/directory/documents`。两项只在企业私网监听，通过mTLS与最长30秒Ed25519服务JWT认证，并在`kernelRoutePolicies`中以精确`method + path`声明`action: read`、`contentMode: json`、`identity: service`和头允许集；`KernelRoutePolicyRegistry`仍是Nest出站路由唯一事实源，重复声明启动失败。Go端使用单个路由声明同时注册Gin handler与`service`、`content`或`query`身份要求：readyz、directory、backup和observation使用服务身份，share三路继续强制`notebookId + documentId`内容身份，`/ws`继续使用已验证查询身份，未知路由默认要求内容身份；`/internal/readyz`只有在`util.IsBooted()`通过后才返回ready，监听中的未完成启动统一返回503；不为目录添加浏览器Gateway路径。
7. Kernel目录模型复用`ListNotebooks`和一层`ListDocTree`排序语义，只在模型边界把服务器路径转换为最小目录项。子层先在声明的内容库中解析真实父文档并验证其root、box与目标笔记本一致，再取得直接子项；不得按全局文档ID猜笔记本。加密笔记本列文档前持有该笔记本的响应读门与内容库生命周期，锁定竞态返回`locked: true`且空文档数组，响应门保持到JSON写完，锁完成后不存在仍在传输的旧明文标题。
8. Kernel私网JSON响应以1 MiB为硬上限，在Nest网络信任边界使用contracts的Zod schema解析后才返回浏览器；浏览器再次以同一公开schema解析不可信HTTP字节。该校验只发生在低频目录网络I/O，每页128项，时间和内存有界，不进入编辑或输入热路径；静态TypeScript不能验证Go进程、代理和浏览器收到的字节，因此不以类型断言代替。载荷按引用消费，不复制正文、File、DOM或全目录快照。
9. TanStack Query拥有笔记本与各层分页响应，查询键完整包含`organizationId + spaceId + notebookId + level + offset`，其中`level`是根层或真实`parentDocumentId`的判别状态，不作为内容身份，并把AbortSignal传到请求。Zustand只新增当前内容选择`spaceId + notebookId + documentId`这一跨树与编辑器共享的最小客户端状态；目录数组不复制进store，Session和Protyle实例仍不进入Zustand。树展开状态留在当前空间树owner；`SpaceSessionRoot`以直接render-prop把活动Session交给一个工作台owner，不建立全局Session Context或第二个Session store。
10. 空间首次进入且没有当前代次的有效选择时，工作台按Kernel目录顺序逐个读取未锁定笔记本的首个根页，并自动选择第一个真实文档项。选择完成后才把三ID交给`ProtyleHost`和公共Factory。没有笔记本、只有锁定笔记本或全部笔记本为空时不创建Protyle；显式选择另一个文档通过销毁并重建Core切换，Session继续属于当前空间。
11. 所有目录请求和选择都绑定空间路由generation。切空间、401、隐藏式404、权限失效或锁态变化先使旧查询和选择失去提交资格；迟到页不得更新树、恢复旧选择或创建编辑器。初次目录503或网络失败显示可重试故障且不创建Protyle；已加载树的展开失败保留现有节点并显示本次未完成，不把错误改写为空数组、不切换备用文档。目录可用性错误不解除只读、不自动重复内容写入。
12. 长期保留`content.directory`诊断：Nest记录`organizationId`、`spaceId`、可选`notebookId`、可选`parentDocumentId`、`offset`、结果、耗时和`requestId`；React只记录space、notebook/document ID、generation、阶段与结果。日志禁止名称、标题、路径、正文、页内容、凭证和完整上游响应。所有输出只包含公开合同与必要错误类别。
13. 目录引导属于L1的S3/B4同一大阶段。实现期同步写合同、Go/Nest/React代码和永久测试，但不逐功能运行runner；全部L1功能、旧路径清理和代码复评完成后，统一运行`verify:s0-s3`、`verify:b4`、Kernel聚合与P3-P5矩阵。真实HTTP、mTLS Kernel、加密锁态、React竞态和真实浏览器各由最低充分层证明，源码中出现装饰器或策略字符串不构成运行时证据。

## Alternatives

- **放宽内容Gateway，让缺失文档ID的请求先列目录**：拒绝。会把身份选择和正文访问混成一条路径，并使“所有内容链显式三ID”失真。
- **把首笔记本和首文档塞进`SpaceRuntimeBootstrap`**：拒绝。启动响应会同时拥有企业运行状态和易变内容目录，缓存、错误与锁态耦合，仍不能支撑完整树。
- **从第一个正文响应、DOM、旧全局状态或BlockTree扫描补齐身份**：拒绝。请求发出前身份已经缺失，且会跨加密内容库猜测所有权。
- **直接公开思源`lsNotebooks/listDocsByPath`**：拒绝。旧接口接受服务器路径、依赖全局状态并绕过企业同源授权边界。
- **一次返回完整笔记本与文档树**：拒绝。大空间载荷、锁门持有时间、浏览器内存和迟到覆盖面无界；一层分页让数据流更瘦。
- **为根目录制造空字符串或固定root ID**：拒绝。哨兵会进入类型、缓存键、日志和测试，并最终被误用为内容身份。
- **用自定义目录装饰器、DiscoveryService和handler registry分发三个固定路由**：拒绝。Nest原生Controller、Guard、Pipe和DI已能完整表达，额外发现层只会双写路由事实。
- **把Session、目录响应和选择全部放进Zustand**：拒绝。会复制服务端视图和非序列化能力；TanStack Query、最小选择store与直接Session所有权边界更清楚。

## Consequences

- S3可先创建真实空间Session，但B4只有在目录产生完整内容身份后才挂载Core；空间Session与文档选择保持两个正交生命周期。
- 公共合同、Nest控制面、Kernel私网API、React树和测试矩阵各增加一个明确owner，但不增加数据库表、内容副本、第二Gateway或兼容分支。
- 加密笔记本锁定时仍可显示笔记本壳，文档目录与标题保持不可见；锁定和分页会增加显式UI状态，但消除了“空库还是锁定”的歧义。
- 每层分页在并发目录变更时可能需要失效后从首项重读；L1不承诺多人实时目录同步，成功的本地文档树变更必须失效对应query，P5重载取得权威顺序。
- 目录私网响应必须接受与内容响应相同的mTLS/JWT运维，换取浏览器永远不知道Kernel地址且不能直接访问旧文件树API。

## References

1. [Protyle浏览器运行时收口产品需求](../product/protyle-runtime-closure.md)
2. [ADR-009：Protyle浏览器运行时边界](0009-protyle-browser-runtime-boundary.md)
3. [ADR-011：企业空间Session组合根前移](0011-space-session-composition-root.md)
4. [企业空间Session组合根与Kernel Gateway启动方案](../architecture/space-session-composition-root.md)
5. [Protyle浏览器宿主与Vite抽取方案](../architecture/protyle-browser-host.md)
6. [思源加密笔记本说明](../ENCRYPTED-NOTEBOOK.zh-CN.md)
