---
title: "奇点 L3.0 实时协作语义原型验证报告"
description: "记录 L3.0 语义协作原型的集中验证证据和测试治理复评"
author: "Codex"
date: "2026-07-22"
version: "1.0.0"
status: "verified"
tags: ["verification", "l3", "realtime-collaboration", "prototype"]
---

# 奇点 L3.0 实时协作语义原型验证报告

## 结果

L3.0 原型通过集中验证。验证对象是独立语义原型，不代表生产 Protyle、Gateway、WebSocket、Prisma 或实时协作功能已启用；L3.1 生产候选仍需另行形成方案和安全评审。

唯一入口：`cd enterprise && pnpm verify:l3-prototype`

## 验收证据

| 合同 | 层级 | 证据 |
| --- | --- | --- |
| 四段身份、操作联合类型、确认/拒绝、presence 序列化 | contract | contracts runner 33 passed |
| 文本并发插入、文本删除逆操作、块树移动冲突、tombstone、引用、嵌入、AV 单元格冲突、历史重放 | Go unit/integration | `go -C ../kernel test -vet=off ./collab/...` 6 passed |
| editor/viewer、重复操作、resume、presence TTL、ACL 撤权、迟到跨文档身份拒绝、完整日志身份 | integration | protocol runner 3 passed |
| 双页面普通块、引用/嵌入/AV 投影、presence、撤销、撤权和最小 320px 布局 | browser integration | Playwright L3 config 4 passed（desktop 2、narrow-320 2） |
| 原型包依赖方向、默认 React 路由隔离、无 Prisma 实时表和生产 API runner | static | boundary runner 3 passed |

## 测试治理复评

- 永久测试均注册在 Node `node:test`、Go 标准 runner 或现有 Playwright runner；没有顶层 assert、逐文件子进程、异步注册 case 或孤儿脚本。
- browser integration 使用同一 BrowserContext 的两个页面证明 BroadcastChannel 投影，并检查 `pageerror` 与 `requestfailed`；桌面和 320px 视口均通过。
- 真实边界只有 Zod 协议解析、ACL 回调和浏览器传输；Go reducer 消费已解析操作，不重复解析 HTTP 或重做权限算法。
- 没有新增第二正文事实源、整文档快照、锁、LWW、fallback、Prisma 表或默认生产路由。
- `SemanticCore` 是协议协调器的唯一语义端口；TypeScript 的 `RecordingSemanticCore` 只记录外部 canonical 结果，不复制 Go reducer。
- 关键函数包含中文备注，异常日志保留 `name/message/stack`，日志不记录正文或凭据。
- 本轮未启动或重配 PostgreSQL；Playwright 自带 WebServer 在命令结束后已清理，端口 4173 无残留监听。

## 后续门禁

L3.0 通过只授权进入 L3.1 生产候选设计，不授权将原型接入生产编辑器、Gateway 或双向 WebSocket。生产候选必须重新评审横向扩展、持久化 operation log、ACL 撤权广播、加密内容协作、客户端升级和安全模型。
