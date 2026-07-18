---
title: "ADR-021: 信任边界校验所有权"
description: "沿完整数据链路确定唯一校验 owner，避免对上游已收敛值重复解析和拦截"
author: "Codex"
date: "2026-07-18"
version: "1.0.0"
status: "accepted"
tags: ["adr", "trust-boundary", "validation", "data-flow", "l1"]
---

# ADR-021: 信任边界校验所有权

## Status

Accepted

## Context

L1内容链路同时经过目录HTTP、浏览器状态、企业Gateway、Kernel私网客户端和Go服务认证。若只按单个函数的理论输入添加防御分支，同一个非法值会在多个层重复解析、归一化或拦截，造成分叉错误语义、重复日志和难以维护的心智模型。上游schema、类型、DI或数据库约束已经排除的值，不应被下游当作本层边界重新处理。

## Decision

1. 任何新增校验先沿`source -> transport/API/event -> schema/parser -> service/use case -> persistence/state -> consumer`追踪，记录该值首次进入本信任域的位置、输出合同和下游假设。
2. 每个非法值在同一信任域只保留一个校验 owner。owner完成解析、归一化和失败语义后，下游直接消费收敛类型，不再重复做同义`parse`、`normalize`、`safeParse`、validator、拦截器或fallback。
3. 跨越新的真实边界时允许重新验证新边界自己的合同。HTTP请求、跨进程字节、外部插件协议、持久化历史数据、文件归档和安全生命周期分别拥有独立边界；这不是同一层的重复校验。跨边界的再次校验不得把上游值重新推断成近似身份。
4. 语义不变量与输入格式校验分开。比如父文档必须属于请求笔记本、目录分页必须前进、撤权后连接不得发送，这些是下游状态或所有权规则，不得用重复格式校验替代，也不得把它们并入通用输入解析器。
5. L1内容身份的具体 owner 如下：

| 链路位置 | 唯一 owner | 下游合同 |
| --- | --- | --- |
| 目录HTTP路径、查询和请求体 | Nest `ZodValidationPipe` | Controller只接收规范化参数 |
| Kernel目录响应字节 | `ContentDirectoryService` 的 contracts schema | Web目录API只接收公开响应 |
| 浏览器目录响应字节 | `requestJson` 的 contracts schema | 选择Store只保存目录已产生的三ID |
| 浏览器Transport | URL、Header和Range序列化 | 不重复验证已收敛的内容身份 |
| 浏览器到企业Gateway | `KernelGatewayAdmission` | `KernelGatewayTarget`携带结构化身份 |
| API到Kernel私网 | `KernelPrivateClient` | 只向受策略允许的路由重建身份头 |
| Kernel服务入口 | `serviceauth.Middleware` | Handler从请求上下文消费身份 |
| 内容库与文档所有权 | Kernel model | 校验库、root和父文档归属，不重做HTTP格式解析 |

6. 已删除浏览器Transport对目录选择结果的本地`assertContentIdentity`。Transport现在只序列化值；真正的浏览器请求边界由企业Gateway拥有，Kernel私网和Go服务入口仍保留各自跨进程合同校验。
7. 永久测试只在真实边界的 owner 验证非法输入，在跨层合同测试中验证已收敛值能被消费；不为上游类型或schema已经排除的不可达值增加下游负例测试。若发现真实绕过入口，校验和测试应移动到该入口，而不是复制到所有消费者。

8. Worker任务分发遵循同一规则：PostgreSQL `worker_jobs.kind` 枚举、声明式
   `HandlesWorkerJob` discovery 和完整 handler Map 是分发 owner；handler 不再
   重复比较已经用于 Map 查找的 `kind`，只在 JSONB 持久化边界解析本任务需要的
   payload 字段。`worker_jobs.payload` 的对象形状由数据库约束拥有，不在每个
   handler 再做一次对象检查。
9. 恢复运行时有两个独立持久化边界：metadata 文件由单个
   `#readRuntimeMetadata()` parser 拥有，PostgreSQL endpoint 行由恢复启动
   reconciliation parser 拥有。Worker 只有在 DB `ready` 行与存活 metadata
   的完整 endpoint 身份相等时才注册；监听、claim 或进程生命周期失效时撤销
   动态端点并清理确定性孤儿目录。metadata 的 `starting` 标记覆盖写入标记前
   的崩溃窗口，不把文件状态推断成数据库事实。

## Alternatives

- **每层都再做一次“更稳妥”的校验**：拒绝。它不能增加真实边界证据，却会产生不同错误语义、重复热路径成本和状态分叉。
- **完全删除跨层校验**：拒绝。HTTP、跨进程和外部字节仍是不可信输入，必须由各自边界保护。
- **用中心校验器或全局拦截器覆盖所有模块**：拒绝。它会隐藏边界 owner，扩大无关请求的影响面，并与Nest声明式路由和Kernel服务认证的局部合同冲突。
- **用近似字段或首个响应补齐缺失身份**：拒绝。缺失语义必须回到上游合同补齐，不能在消费点猜测。

## Consequences

- 内容链路的状态数量和错误路径减少，已收敛的`spaceId + notebookId + documentId`在编辑热路径不再被重复拦截。
- 每个跨进程边界仍有明确安全校验，不能把“只校验一次”误解为跨信任域信任浏览器或内部类型。
- 新增运行时校验必须在方案、代码评审和测试治理中说明真实来源、唯一 owner、失败语义和是否跨越新边界。
- 目录、Gateway、Kernel和Worker的测试按稳定合同归属 owner；不会为了覆盖理论非法值而增加重复或孤儿测试。

## References

1. [ADR-020：空间内容目录引导](0020-space-content-directory-bootstrap.md)
2. [企业空间Session组合根与Kernel Gateway启动方案](../architecture/space-session-composition-root.md)
3. [Protyle浏览器宿主与Vite抽取方案](../architecture/protyle-browser-host.md)
