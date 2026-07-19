---
title: "ADR-018: PostgreSQL跨进程访问失效通知"
description: "以事务内pg_notify连接独立运维进程与API连接注册表，保证撤权提交后关闭WebSocket"
author: "Codex"
date: "2026-07-18"
version: "1.0.0"
status: "accepted"
tags: ["adr", "authorization", "postgresql", "websocket"]
---

# ADR-018: PostgreSQL跨进程访问失效通知

## Status

Accepted

## Context

L1要求会话撤销、用户或组织停用、空间停用、两级成员变化及角色变化在事务提交后关闭`pending`与`active`浏览器连接。原S2方案采用API进程内`AccessChanged`观察者，但受控运维入口由`enterprise/apps/api/src/operations/main.ts`启动独立Node进程；该进程内事件无法到达正在服务的API进程，可能形成“PostgreSQL已撤权、WebSocket仍活动”的分叉事实。

本仓`@singularity/database`已锁定`pg`并由同一PostgreSQL配置建立Prisma连接，故本地证据足以决策，无需网页搜索。

## Decision

1. PostgreSQL仍是唯一授权事实源。所有影响活动连接的写入在同一业务事务内调用`pg_notify('singularity_access_changed', payload)`；PostgreSQL只在事务提交后投递，回滚不产生通知。
2. 通知载荷只含`kind`、必要的`authSessionId|userId|organizationId|spaceId`选择键，以及会话续期所需的`absoluteExpiresAt|idleExpiresAt`。不含角色快照、正文、令牌、摘要、密码、Cookie或数据库模型。
3. API启动时先建立一个专用`LISTEN singularity_access_changed`连接，再接受Kernel WebSocket升级。`SpaceConnectionRegistry`是唯一消费者；HTTP授权继续每次读取PostgreSQL，不消费通知缓存。
4. `kind`只取`close-unauthenticated`、`close-forbidden`、`session-renewed`。关闭事件按载荷中全部已给选择键匹配连接；续期只更新对应`authSessionId`的到期计时器。关闭状态吸收后续事件。
5. 监听连接异常时，Registry先终止全部上游订阅，再以`1011 + service-unavailable`关闭全部浏览器连接并进入不可用态；后续升级返回服务不可用。进程不在未知事件窗口内重连或继续服务WebSocket，部署层重启API后恢复单一路径。
6. `@singularity/database`拥有PostgreSQL通知连接的配置解析、`LISTEN`生命周期和关闭；API领域拥有事件schema、事务内发布及连接选择语义。此边界承担真实数据库协议与生命周期，不建立同形Repository或消息DTO转换层。
7. 稳定日志标签`authorization.change`记录事件种类、已给选择键、结果与`requestId`；监听异常记录`access.notification`和结果，不记录载荷原文或连接凭证。

## Data Flow

```text
HTTP或独立运维进程
  -> 领域事务写授权事实
  -> 同事务pg_notify最小事件
  -> PostgreSQL提交
  -> API专用LISTEN连接
  -> SpaceConnectionRegistry匹配pending/active连接
  -> 先断上游，再关闭浏览器
```

## Alternatives

- **进程内Observer**：拒绝。独立运维进程无法触达API，数据流断裂。
- **定时重验全部连接**：拒绝。引入撤权延迟、全量扫描和第二套时序事实，仍不能证明立即关闭。
- **Redis/BullMQ事件总线**：本期拒绝。新增运行依赖和双事实路径；L5多副本扩展时另作决策。
- **数据库Outbox加Worker**：本期拒绝。可靠重放并非关闭当前单副本连接所需，表、租约和清理状态会扩大主干复杂度。

## Consequences

- HTTP进程与运维进程共用一条提交后失效链，撤权心智模型保持单一。
- `NOTIFY`不是持久队列；通过“监听异常立即关闭全部连接且拒绝新升级”消除漏事件后继续授权，而非增加重连fallback。
- L5横向扩展前须以具备跨副本交付合同的消息基础设施替换本决策，不并行保留两套发布路径。

## Implementation Checklist

- [x] `DatabaseRuntime`增加专用通知订阅生命周期，应用关闭时释放连接。
- [x] `AccessChangedPublisher`与`AccessChangedListener`负责事件schema、事务内发布和监听分发。
- [x] `SpaceConnectionRegistry`提供三态与四索引，监听异常失败关闭。
- [x] Identity、Organization、Group、Space及Operations所有相关提交路径发布唯一事件。
- [x] Gateway升级在监听就绪后登记`pending`、复验、激活并设置会话到期计时器。
- [ ] 集中评审完成后批量验证真实PostgreSQL跨进程撤权与零迟到推送。

## Verification

| 稳定合同 | 最低层级 | 证据 |
| --- | --- | --- |
| 提交投递、回滚不投递 | PostgreSQL integration | 两个独立连接、真实事务与原生runner case |
| 独立运维进程撤权关闭API连接 | HTTPS/WSS integration | 真实operations组合根、真实API、真实PostgreSQL |
| 监听异常不继续带权服务 | integration | 终止LISTEN连接，断上游、关浏览器并拒绝新升级 |
| 选择键只关闭受影响连接 | integration | 会话、用户、组织、空间及组合选择键独立case |

实现阶段不逐文件运行测试；L1生产代码与必要测试代码全部就绪、集中代码评审通过后，再由`verification`按矩阵批量执行。

## References

1. [企业空间Session组合根与Kernel Gateway启动方案](../architecture/space-session-composition-root.md)
2. [ADR-011：企业空间Session组合根前移](0011-space-session-composition-root.md)
3. [ADR-013：S1受控运维、身份会话与空间发现](0013-s1-identity-space-access.md)
