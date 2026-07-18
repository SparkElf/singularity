---
title: "ADR-022: 跨进程Kernel端点事实源"
description: "让Worker恢复的Kernel端点在API进程重启和实时变更后仍可被同一声明式registry解析"
author: "Codex"
date: "2026-07-18"
version: "1.0.0"
status: "accepted"
tags: ["adr", "kernel", "deployment", "worker", "postgresql", "trust-boundary"]
---

# ADR-022: 跨进程Kernel端点事实源

## Context

Worker恢复Kernel时先在本地进程创建端点并把`deploymentHandle`写入
`KernelInstance`。API是独立进程，启动时只读取静态部署文件，无法从这个句柄
得到恢复实例的地址和TLS身份；合法的目录、分享、编辑和观测请求因此会在
API自己的registry解析阶段失败。把Worker内存、句柄前缀或首个响应当作地址来源
会产生进程重启丢失、跨空间推断和迟到事件覆盖。

## Decision

1. PostgreSQL增加一对一`KernelRuntimeEndpoint`持久化表。它只保存
   `kernelInstanceId + spaceId`、`hostname`、`port`、`serverName`和显式
   `tlsProfile`；句柄和版本仍由`KernelInstance`拥有，私钥、证书内容、文件路径、
   工作区路径和正文不进入数据库。
2. Worker在恢复完成的同一事务中写入Kernel状态、端点行和
   `pg_notify(singularity_kernel_deployment_changed, event)`；失败清理在删除
   Kernel实例前删除端点行并发布`remove`。通知只携带显式身份键和请求ID，API
   仍以数据库行作为端点事实源，避免事件与持久化字段双写。
3. API的`RuntimeKernelDeploymentRegistry`仍是本进程唯一解析owner。Nest
   `KernelDeploymentSynchronizer`以`@Injectable()`和模块metadata装配，启动时先
   LISTEN再hydrate持久化端点，随后串行消费事件；事件或数据库历史值在数据库
   边界解析一次，只有`status=ready`且身份完全匹配的行才能替换registry中的端点。
   静态部署和动态端点共用这个registry，不建立第二套句柄表。
4. `tlsProfile`只能匹配API启动配置中显式声明的TLS profile。profile不匹配、
   端点结构不合法、身份不一致或通知监听失败都进入明确的Kernel不可用/启动失败
   语义，不从handle、hostname、首行结果或其他近似字段推断profile或空间。
5. Worker恢复配置显式声明对API可达的`gatewayHostname`和`tlsProfile`；本地
   readiness仍使用`127.0.0.1`，网络端点使用配置值。恢复metadata同时保存并校验
   这些端点字段，Worker重启adoption不会把新配置或默认地址冒充旧进程身份。
6. 校验owner按真实链路分配：环境配置由各进程配置parser拥有，跨进程通知由
   event schema拥有，数据库历史端点由同步器的持久化边界拥有，TLS字节和
   `createSecureContext`由消费进程拥有；service、Kernel client和目录消费者只
   消费已经收敛的部署对象，不重复解析或添加fallback。
7. 通知消费是单一串行失效队列。API先完成LISTEN和ready行hydrate，再开放事件
   消费；每个事件只按`kernelInstanceId + spaceId`回读当前数据库行，`remove`
   也不能绕过事实源直接删除。通知解析失败、监听断开或hydrate失败时清空动态
   registry并进入明确的不可用语义，不继续使用可能过期的句柄。
8. Worker重启的adoption同样以数据库ready endpoint为准。metadata先写入
   `state=starting`标记，ready后原子替换为`state=ready`；无对应数据库行、
   身份不一致或进程已退出的目标不注册。启动时回收无metadata的确定性恢复工作区
   和暂存归档；ready-for-activation目标的孤儿端点会在同一事务中标记恢复失败、
   删除隔离目标并发布remove通知，已激活空间只撤销运行时端点并保留内容。

## Alternatives

- **API继续只读静态deployment文件**：拒绝。恢复端点只存在Worker进程，API重启
  后必然丢失，跨进程链路不闭合。
- **按句柄前缀或第一个静态部署推断地址/TLS**：拒绝。句柄不是网络或安全身份，
  会把不同空间、节点和证书profile混在一起。
- **只用PostgreSQL NOTIFY不持久化**：拒绝。API重启或监听短暂中断会丢事件。
- **把完整TLS文件路径或私钥写进数据库**：拒绝。泄露秘密和主机布局，也无法
  支持API与Worker分离部署。
- **每次请求直接查询数据库并临时创建客户端**：拒绝。重复TLS装配、增加热路径
  状态和连接生命周期；同一registry的hydrate与增量更新更明确。

## Consequences

- API和Worker都能在重启后从同一持久化事实恢复动态端点，事件只承担低延迟失效
  通知；数据库不可用或监听失败不会静默使用旧端点。
- 增加一张端点表、一个通知订阅和显式TLS profile配置，换取跨进程身份不推断、
  单一registry和可审计的端点生命周期。
- endpoint host必须是Worker到API可达的配置值；`127.0.0.1`只保留为Worker
  到本地Kernel readiness的地址。

## References

1. [ADR-017：L1分享、审计、备份恢复与运行观测](0017-l1-share-audit-backup.md)
2. [ADR-021：信任边界校验所有权](0021-trust-boundary-validation-ownership.md)
3. [企业空间Session组合根与Kernel Gateway启动方案](../architecture/space-session-composition-root.md)
