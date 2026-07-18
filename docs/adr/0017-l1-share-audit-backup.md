---
title: "ADR-017: L1分享、审计、备份恢复与运行观测"
description: "确定L1只读分享、可验证审计链、隔离恢复和后台采样的长期边界"
author: "Codex"
date: "2026-07-18"
version: "1.2.0"
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

### 文档只读分享

1. 分享是当前文档的实时只读渲染，不是创建时快照。每次页面、引用和附件请求都重新查询当前分享记录，并验证未撤销、未过期、空间仍可用且目标文档仍属于原空间。
2. 分享令牌是高熵随机凭证，PostgreSQL只保存带域分隔的摘要。令牌只用于定位分享，不复用成员会话、CSRF令牌或Kernel服务JWT。
3. 有密码的分享使用独立Argon2id摘要和独立来源/分享限流器。密码验证成功后签发短期随机挑战Cookie，服务端只保存挑战摘要、`shareId`和绝对到期时间；Cookie不能由分享ID、密码或令牌确定性推导。
4. 每次受密码保护的读取都验证挑战Cookie仍有效且绑定当前分享。撤销分享、修改密码或分享过期会使后续读取立即失败；不以缓存、已打开页面或旧挑战继续授权。
5. Kernel按明确的`notebookId`和`documentId`解析当前文档闭包。只允许渲染该文档、该文档内实际引用且仍在同一笔记本中的块，以及该闭包实际使用的本地附件；不提供搜索、图谱、任意块、任意文件或跨文档浏览接口。
6. 分享响应使用`noindex`、`no-store`、`nosniff`和严格CSP。HTML、JavaScript、SVG、XML、PDF、未知类型及导出HTML一律作为附件下载；允许内联的图片、音频和视频也只能从当前闭包内的资源标识读取，不能用原始路径探测工作空间。
7. 分享访问记录稳定标签`share.access`，只记录`shareId`、结果、来源摘要和`requestId`，不记录分享令牌、密码、挑战Cookie、正文、附件路径或Kernel地址。

### 追加审计与归档

1. 审计事件写入PostgreSQL追加表。生产数据库角色不具有更新或删除事件的权限，并以数据库约束或触发器拒绝变更；业务代码不提供更新和删除方法。
2. 同一组织内事件按稳定序号串联。每个事件保存上一事件MAC、规范化事件载荷的HMAC-SHA-256和密钥版本；HMAC密钥来自数据库外部的秘密管理，不进入事件、日志、备份清单或代码配置默认值。
3. 事件写入、组织序号推进和业务状态变更在同一数据库事务内完成。规范化载荷固定包含组织、可选空间、操作者、动作、目标、结果、发生时间和`requestId`，不包含令牌、密码、正文或任意大payload。
4. 组织`owner`和`admin`可查询本组织审计；空间`admin`只能查询自己管理空间的事件。空间成员资格不能扩大到组织级事件，组织与空间状态失效后不保留旧查询授权。
5. Worker按已封口范围生成有序归档，写入对象存储后保存对象摘要、起止序号和链首尾MAC。归档成功不删除在线事件，保留策略后续另行决策。
6. HMAC链用于发现数据库内事件被篡改、删除或重排，不构成法律意义的不可否认性，也不能证明外部密钥、应用主机或数据库管理员从未同时失陷。

### 备份与隔离恢复

1. 组织`owner`、组织`admin`或目标空间`admin`可以创建备份和恢复任务；普通成员、`editor`和`viewer`不能操作。授权在任务创建时检查，并在Worker执行破坏性阶段前重新检查目标仍属于同一组织。
2. 备份由Kernel在受控暂存目录生成版本化清单和归档，清单至少包含格式版本、Kernel版本、源空间身份、创建时间、文件数、展开总大小以及每个条目的相对路径、类型、大小和SHA-256。归档及清单整体摘要由控制面记录。
3. 对象存储写入采用私有根目录、不透明键、独占创建、临时文件加原子重命名、大小上限和SHA-256返回值。拒绝绝对路径、路径穿越、空段、反斜杠、符号链接和非普通文件。
4. 恢复只能创建新的非活动隔离空间和新的Kernel实例，禁止覆盖或合并到现有在线空间。恢复前依次验证对象摘要、清单格式、Kernel版本兼容、归档路径、条目类型、单项大小、展开总大小和文件摘要；解包过程拒绝符号链接、硬链接、设备文件和路径逃逸。
5. 解包后Kernel在隔离目录完成结构、SQLite可打开性、`.sy`可解析性、引用索引和清单一致性检查。所有检查通过后任务进入`ready-for-activation`，仍需显式激活；任一步失败都关闭实例并删除整个恢复目标，不保留部分空间或回退到源空间。
6. 备份不是在线读取事实源，恢复期间不向浏览器提供内容，也不以旧版本兼容、跳过文件或部分成功作为降级路径。
7. 任务日志稳定标签`backup.job`，记录`spaceId`、任务ID、状态、对象键、校验结果和`requestId`，不记录正文、对象内容、凭证或宿主绝对路径。

### 健康与容量

1. Kernel后台采样器在有界周期内采集进程健康、数据总字节、附件字节、文件数、采样耗时、Kernel版本和最近错误。采样结果以单个不可变快照替换，读取不触发目录遍历。
2. 私有HTTP接口只返回最近快照及`sampledAt`。没有样本、样本过旧或最近采样失败必须显式表达，不能同步调用`DataSize`补算，也不能把数据库readiness混入同一状态字段。
3. Worker或控制面定期拉取样本并按`kernelInstanceId`写入PostgreSQL。公共空间状态只显示持久化样本及其时间，不暴露工作空间路径或采样错误原文。

### 恢复实例句柄生命周期

1. 每个Worker进程只创建一个`RuntimeKernelDeploymentRegistry`。启动配置在canonical deployment schema解析后写入该registry；`KernelPrivateClient`和恢复平台通过Nest DI共享同一实例，不维护第二套句柄表。
2. `ProcessRestoreDeployment`只有在归档解包完成、隔离工作区验证通过、Kernel以服务认证的`readyz`返回匹配实例身份和版本，并且运行时metadata持久化成功后，才把本地端点注册到registry。恢复处理器收到句柄后再以同一任务claim写入`ready-for-activation`。
3. 失败恢复、过期claim和显式目标清理先从registry撤销句柄，再终止进程并删除metadata、工作区和控制面目标；撤销后新的备份或观测请求立即无法解析该实例。
4. Worker重启只接纳metadata、工作区、进程命令行和实例环境均匹配的存活目标，并把它们重新注册到同一registry。句柄冲突或身份不一致不走fallback，启动失败并清理该目标。
   接纳前还必须与数据库`ready`端点逐字段一致；metadata只表达文件边界，不替代控制面事实。
5. Worker恢复的网络端点由`KernelRuntimeEndpoint`持久化，API启动时先监听
   `singularity_kernel_deployment_changed`再hydrate `ready`行；Worker在状态、
   端点和通知同一事务提交，清理反向删除端点并通知。API与Worker各自只持有
   进程内唯一`RuntimeKernelDeploymentRegistry`，不从句柄、地址或首个响应推断
   TLS profile。详见[ADR-022](0022-cross-process-kernel-endpoint-source.md)。

### 不在本决策范围

- 不实现实时多人协作、评论、通知、文档级ACL或跨空间搜索。
- 不把分享改为不可变快照，也不把备份对象作为分享或在线附件来源。
- 不注册共享路由；Kernel端点表和通知接线仅服务于跨进程运行时解析，不改变正文或分享事实源。

## Integration Contracts

共享集成必须补齐`DocumentShare`、`ShareChallenge`、`AuditEvent`、组织审计序列、`SpaceBackup`、`SpaceRestoreJob`、`KernelHealthObservation`和`SpaceCapacityObservation`，并保持上文唯一语义字段。API领域以明确Repository和Kernel端口表达所需字段，不引入同形DTO映射或内存fallback。Worker的备份和观测消费者必须解析同一个进程内registry，不能退回启动时静态句柄或另建恢复句柄表。

Kernel路由注册必须位于服务认证中间件之后，只接受私网mTLS与短期服务JWT。分享闭包读取、备份创建、恢复校验和观测读取使用不同策略项；浏览器不能直接调用这些Kernel路径。

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
