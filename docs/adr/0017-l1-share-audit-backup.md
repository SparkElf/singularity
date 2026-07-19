---
title: "ADR-017: L1分享、审计、备份恢复与运行观测"
description: "确定L1只读分享、可验证审计链、隔离恢复和后台采样的长期边界"
author: "Codex"
date: "2026-07-19"
version: "1.9.1"
status: "accepted"
tags: ["adr", "share", "audit", "backup", "observability"]
---

# ADR-017: L1分享、审计、备份恢复与运行观测

## Status

Accepted

## Context

L1需要交付文档只读分享、管理审计、空间备份恢复以及容量和健康状态。企业控制面拥有身份、授权和任务状态，Go Kernel拥有`.sy`、SQLite、引用和在线附件，二者不能通过内容双写、共享文件路径或HTTP热路径目录遍历形成第二事实源。

现有Kernel发布访问使用工作空间配置、明文密码、确定性Cookie和进程内缓存，不满足企业分享的独立凭证、即时撤销和失败关闭要求。现有全工作区导入会写入当前在线目录，现有`DataSize`会同步遍历数据目录，均不能直接作为恢复和HTTP容量接口。

## Decision

### 所有权与数据流

1. PostgreSQL拥有分享元数据、独立凭证摘要、审计事件、备份与恢复任务、对象键以及Kernel观测样本。PostgreSQL不保存正文、`.sy`、SQLite副本或在线附件。
2. Go Kernel只通过服务认证的私有接口提供当前文档闭包、受控备份暂存、隔离恢复校验以及后台采样结果。Kernel接口不接收组织角色、不查询企业数据库，也不决定公网分享是否有效。
3. 私有对象存储保存备份包和审计归档。对象键由控制面生成且保持不透明，公共API不返回对象键、工作空间路径、Kernel地址或存储根目录。
4. Worker拥有有界任务领取、租约、重试状态和归档调度。API只创建任务和读取状态，不在请求生命周期内压缩工作空间、上传大对象、恢复空间或遍历容量。

### 企业管理能力发现

1. 已认证浏览器通过唯一只读接口取得当前账号的企业管理能力。响应按组织返回组织能力及逐空间能力，不返回角色、全组织空间能力副本或供前端猜测权限的替代字段；菜单、深链和操作入口只消费该显式能力合同。
2. 组织`owner`和`admin`的组织能力、组织`owner`独有的所有权转移能力，以及组织普通成员通过直接成员关系或活动用户组获得的空间`admin`能力，都由PostgreSQL活动用户、组织、组织成员、空间、空间成员和用户组授权事实一次派生。没有任一管理能力的组织不进入响应，未激活的恢复目标也不作为可管理空间暴露。
3. 授权空间列表与企业管理能力是两个独立只读事实。管理能力查询失败、暂停或重试不能隐藏已经成功重验的普通授权空间；单空间自动进入只在管理能力查询本轮成功且明确返回零管理入口后发生。前端用固定界面优先级在能力集合中选择首个可见页面，不把服务端数组顺序当作路由事实。

### 文档只读分享

1. 分享是当前文档的实时只读渲染，不是创建时快照。每次页面、引用和附件请求都重新查询当前分享记录，并验证未撤销、未过期、空间仍可用且目标文档仍属于原空间。
2. 分享令牌是高熵随机凭证，PostgreSQL只保存带域分隔的摘要。令牌只用于定位分享，不复用成员会话、CSRF令牌或Kernel服务JWT。
3. 有密码的分享使用独立Argon2id摘要和独立来源/分享限流器。密码验证成功后签发短期随机挑战Cookie，服务端只保存挑战摘要、`shareId`和绝对到期时间；Cookie不能由分享ID、密码或令牌确定性推导。
4. 每次受密码保护的读取都验证挑战Cookie仍有效且绑定当前分享。撤销分享、修改密码或分享过期会使后续读取立即失败；不以缓存、已打开页面或旧挑战继续授权。
5. Kernel按明确的`notebookId`和`documentId`解析当前文档闭包。只允许渲染该文档、该文档内实际引用且仍在同一笔记本中的块，以及该闭包实际使用的本地附件；不提供搜索、图谱、任意块、任意文件或跨文档浏览接口。
6. 分享响应使用`noindex`、`no-store`、`nosniff`和严格CSP。HTML、JavaScript、SVG、XML、PDF、未知类型及导出HTML一律作为附件下载；允许内联的图片、音频和视频也只能从当前闭包内的资源标识读取，不能用原始路径探测工作空间。
7. 分享访问记录稳定标签`share.access`，只记录`shareId`、结果、来源摘要和`requestId`，不记录分享令牌、密码、挑战Cookie、正文、附件路径或Kernel地址。
8. 公开Web壳对`/shares/<token>`使用`no-store`、`noindex`和不允许表单提交的CSP；Web边缘访问日志将分享令牌路径归一化为占位符并省略Referer。公开React页面挂载时总是重新读取当前分享，缓存不会在撤销后继续提供正文；同源内部链接和内容身份`data-*`属性在公开投影中删除。
9. Kernel跨进程响应由`ShareKernelClient`在字节解析边界核对返回`documentId`与请求中的显式身份，不匹配按服务不可用处理；控制面不从响应或首个实例推断笔记本、文档或空间。

### 追加审计与归档

1. 审计事件写入PostgreSQL追加表。生产数据库角色不具有更新或删除事件的权限，并以数据库约束或触发器拒绝变更；业务代码不提供更新和删除方法。
2. 同一组织内事件按稳定序号串联。每个事件保存上一事件MAC、规范化事件载荷的HMAC-SHA-256和密钥版本；HMAC密钥来自数据库外部的秘密管理，不进入事件、日志、备份清单或代码配置默认值。
3. 事件写入、组织序号推进和业务状态变更在同一数据库事务内完成。规范化载荷固定包含组织、可选空间、操作者、动作、目标、结果、发生时间和`requestId`，不包含令牌、密码、正文或任意大payload。
4. 组织`owner`和`admin`可查询本组织审计；空间`admin`只能查询自己管理空间的事件。空间成员资格不能扩大到组织级事件，组织与空间状态失效后不保留旧查询授权。
5. Worker按已封口范围生成有序归档，写入对象存储后保存对象摘要、起止序号和链首尾MAC。对象写成后、元数据提交前再次响应任务取消；取消或元数据写入失败都删除本次对象，清理失败以稳定错误码结束，不能留下无主对象或把失败报告为成功。相同任务重放时先按已提交对象键复算大小和摘要，一致才视为幂等完成。归档成功不删除在线事件，保留策略后续另行决策。
6. HMAC链用于发现数据库内事件被篡改、删除或重排，不构成法律意义的不可否认性，也不能证明外部密钥、应用主机或数据库管理员从未同时失陷。

### 备份与隔离恢复

1. 组织`owner`、组织`admin`或目标空间`admin`可以创建备份和恢复任务；普通成员、`editor`和`viewer`不能操作。授权在任务创建时检查，并在Worker执行破坏性阶段前重新检查目标仍属于同一组织。
2. 备份由Kernel在受控暂存目录生成版本化清单和归档，清单至少包含格式版本、Kernel版本、源空间身份、创建时间、文件数、展开总大小以及每个条目的相对路径、类型、大小和SHA-256。归档及清单整体摘要由控制面记录。
3. 对象存储写入采用私有根目录、不透明键、独占创建、临时文件加原子重命名、大小上限和SHA-256返回值。拒绝绝对路径、路径穿越、空段、反斜杠、符号链接和非普通文件。
4. 恢复只能创建新的非活动隔离空间和新的Kernel实例，禁止覆盖或合并到现有在线空间。恢复前依次验证对象摘要、清单格式、Kernel版本兼容、归档路径、条目类型、单项大小、展开总大小和文件摘要；解包过程拒绝符号链接、硬链接、设备文件和路径逃逸。
5. 解包后Kernel在隔离目录完成结构、SQLite可打开性、`.sy`可解析性、引用索引和清单一致性检查。明文`.sy`必须以合法文档根和文件名节点ID解析，块ID不得重复，非空块引与嵌入引的目标ID必须符合节点ID合同且在可解析明文内容中存在；上游已将跨加密边界引用降级为纯文本的空块引ID不再作为引用解析。加密`.sy`只验证加密信封和nonce，不把密文按JSON解析，也不在没有密钥时伪造引用结论。恢复归档不含索引时由Kernel启动重建；若目录已有明文SQLite索引则只读执行`PRAGMA integrity_check`并检查`refs`到`blocks`的孤儿目标，加密SQLite只验证为非空。所有检查通过后任务进入`ready-for-activation`，仍需显式激活；任一步失败都关闭实例并删除整个恢复目标，不保留部分空间或回退到源空间。
6. 备份不是在线读取事实源，恢复期间不向浏览器提供内容，也不以旧版本兼容、跳过文件或部分成功作为降级路径。
7. 控制面按源空间提供恢复任务集合，使用`createdAt DESC, id ASC`稳定排序并返回每个任务的公开状态、源备份和目标空间身份。备份恢复页面进入时总是读取该集合，因此离开创建响应、刷新或换浏览器后仍可发现运行中及`ready-for-activation`任务；任务身份不依赖URL参数、DOM、前端全局状态或最近一次创建响应。集合存在尚未终止的恢复时不创建第二个恢复，待激活任务直接从集合发起显式激活。
8. 任务日志稳定标签`backup.job`由`BackupSpaceHandler`和`RestoreSpaceHandler`在领域状态提交后记录；Worker启动对账发现已进入`ready-for-activation`的恢复实例丢失时，`ProcessRestoreDeployment`是该失败转移和目标删除的生产owner，并在同一事务提交后记录一次失败标签。固定字段为`taskKind`、`taskId`、`spaceId`、可选`targetSpaceId`、`status`、`objectKey`、`validationResult`、`reason`、`elapsedMs`和`requestId`。成功路径的`reason`来自显式任务`kind`，失败路径来自显式失败码；`validationResult`只使用`pending`、`passed`、`failed`或`not-completed`。恢复处理器的执行期失败和清理重放都通过恢复任务到备份的作用域关系读取权威不透明对象键；只有启动对账未重新验证对象键，因此该路径的`objectKey`记录`null`。通用Worker租约日志不重复生成该标签，日志不记录正文、对象内容、凭证、错误原文或宿主绝对路径。

### 健康与容量

1. Kernel后台采样器在有界周期内采集进程健康、数据总字节、附件字节、文件数、采样耗时、Kernel版本和最近错误。采样结果以单个不可变快照替换，读取不触发目录遍历。
2. 私有HTTP接口只返回最近快照及`sampledAt`。没有样本、样本过旧或最近采样失败必须显式表达，不能同步调用`DataSize`补算，也不能把数据库readiness混入同一状态字段。
3. Worker定期拉取样本时保留实际请求使用的部署句柄。收到响应后在同一PostgreSQL事务中按组织、空间、Kernel顺序锁定权威状态，并复验组织仍活动、空间仍可采样、Kernel仍为`ready`且部署句柄未变；只有复验通过才同时写入健康与容量样本。任一事实变化都以`observation-state-conflict`结束且不写任一观测表，不能让迟到响应覆盖新实例。
4. 采样和审计归档生产者通过声明式Worker发现机制独立调度，并以schema作用域的事务级 advisory lock串行同类生产。已有`queued`或`running`任务时不为同一Kernel或组织创建第二个活动任务；生产失败向上终止调度，不静默跳过。公共空间状态只显示持久化样本及其时间，不暴露工作空间路径、部署句柄或采样错误原文。

### 恢复实例句柄生命周期

1. 每个Worker进程只创建一个`RuntimeKernelDeploymentRegistry`。启动配置在canonical deployment schema解析后写入该registry；`KernelPrivateClient`和恢复平台通过Nest DI共享同一实例，不维护第二套句柄表。`WorkerPlatformModule`是`DatabaseRuntime`、该registry、`NestWorkerJobLogger`和`WORKER_JOB_LOGGER`的唯一生命周期owner；`WorkerModule`与`RestorePlatformModule`导入同一个动态模块实例，不重复提供或关闭这些进程级资源。
2. `ProcessRestoreDeployment`只有在归档解包完成、隔离工作区验证通过、Kernel以服务认证的`readyz`返回匹配实例身份和版本，并且运行时metadata持久化成功后，才把本地端点注册到registry。恢复处理器收到句柄后再以同一任务claim写入`ready-for-activation`。
3. 失败恢复、过期claim和显式目标清理先从registry撤销句柄，再终止进程并删除metadata、工作区和控制面目标；撤销后新的备份或观测请求立即无法解析该实例。
4. Worker重启只接纳metadata、工作区、进程命令行和实例环境均匹配的存活目标，并把它们重新注册到同一registry。metadata必须是运行时根下的0600普通单链接文件，工作区必须是根下的真实目录；句柄冲突或身份不一致不走fallback，启动失败并清理该目标。接纳前还必须与数据库`ready`端点逐字段一致；metadata只表达文件边界，不替代控制面事实。
5. metadata丢失时，Worker按任务身份计算唯一工作区路径并扫描Linux `/proc`进程命令行与环境；只终止同时匹配Kernel二进制、`--workspace`、端口（若已知）、`SINGULARITY_KERNEL_INSTANCE_ID`和`SINGULARITY_KERNEL_SPACE_ID`的进程，然后才删除工作区和metadata残片。Worker无法打开`/proc`或无法核验metadata中的已知PID时以`target-cleanup-failed`失败关闭并保留目标，不能把平台能力缺失当作无进程；广域扫描中已消失或明确不可读的非目标条目可跳过。带恢复句柄前缀的非目录运行时artifact、符号链接、硬链接metadata或非真实工作区均失败关闭，不按名称猜测或删除。
6. Worker恢复的网络端点由`KernelRuntimeEndpoint`持久化，API启动时先监听
   `singularity_kernel_deployment_changed`再hydrate `ready`行；Worker在状态、
   端点和通知同一事务提交，清理反向删除端点并通知。API与Worker各自只持有
   进程内唯一`RuntimeKernelDeploymentRegistry`，不从句柄、地址或首个响应推断
   TLS profile。详见[ADR-022](0022-cross-process-kernel-endpoint-source.md)。
7. Kernel实例创建时的`starting`是初始化值，不是状态转移，不写`kernel.lifecycle`。运维三态变更由`AccessOperationsService#setKernelState`在事务提交后记录；恢复成功或执行期失败清理由`RestoreSpaceHandler`在对应事务提交后记录；Worker启动对账的运行时丢失由`ProcessRestoreDeployment`在对账事务提交后记录。对账保留空间时记录`ready -> unavailable`；若同一事务还把恢复任务置为`failed`并删除Kernel和隔离空间，只记录最终提交结果`ready -> removed`，不记录未提交的中间`unavailable`。固定字段为`kernelInstanceId`、`spaceId`、`fromState`、`toState`、`reason`、`elapsedMs`和触发`requestId`；同态更新不记录。运维原因来自显式操作名，恢复成功原因来自显式任务`kind`，失败原因来自显式失败码；启动对账固定使用`restore-runtime-lost`，同一次对账生成的`requestId`同时关联数据库通知和日志。对账事务已移除端点或目标，重放不会重复记录。不记录错误原文、部署凭据、正文、端点或路径。

### 不在本决策范围

- 不实现实时多人协作、评论、通知、文档级ACL或跨空间搜索。
- 不把分享改为不可变快照，也不把备份对象作为分享或在线附件来源。
- 不注册共享路由；Kernel端点表和通知接线仅服务于跨进程运行时解析，不改变正文或分享事实源。

## Integration Contracts

共享集成必须补齐`DocumentShare`、`ShareChallenge`、`AuditEvent`、组织审计序列、`SpaceBackup`、`SpaceRestoreJob`、`KernelHealthObservation`和`SpaceCapacityObservation`，并保持上文唯一语义字段。企业管理能力响应和恢复任务集合只投影这些权威授权与任务事实，不保存第二份角色、菜单或当前恢复状态。API领域以明确Repository和Kernel端口表达所需字段，不引入同形DTO映射或内存fallback。Worker的备份和观测消费者必须解析同一个进程内registry，不能退回启动时静态句柄或另建恢复句柄表；观测端口返回样本及本次请求使用的唯一部署句柄，持久化处理器不从响应、首个实例或当前registry反推该身份。

Kernel路由注册必须位于服务认证中间件之后，只接受私网mTLS与短期服务JWT。分享闭包读取、备份创建、恢复校验和观测读取使用不同策略项；浏览器不能直接调用这些Kernel路径。分享HTTP、Go投影、React组件和浏览器集成合同必须进入各自标准runner，且不以静态字符串扫描替代运行时证据。

## Consequences

- 分享撤销与密码轮换可在下一次资源请求生效，但每个资源请求都会增加一次控制面状态读取。
- 审计链可以检测常见篡改并支持归档校验，但需要外部密钥轮换、数据库权限和事务序列共同保持正确。
- 新空间恢复避免破坏在线内容，代价是需要额外存储、实例生命周期和显式激活步骤。
- 后台采样移除HTTP热路径目录遍历，容量数据因此具有明确的新鲜度而不是瞬时精确值。
- L1仍不承诺实时协作；单文档并发编辑继续使用现有服务端事务语义。

## References

1. [ADR-003：NestJS企业控制面与Go内容内核](./0003-enterprise-control-plane-and-go-kernel.md)
2. [ADR-004：空间级Kernel实例隔离](./0004-space-kernel-isolation.md)
3. [ADR-005：内容单一事实源](./0005-single-content-fact-source.md)
4. [ADR-006：实时协作技术门禁](./0006-realtime-collaboration-gate.md)
5. [奇点完整方案](../../output/md/Singularity_Enterprise_Knowledge_Base_v1.0.0_2026-07-13.md)
