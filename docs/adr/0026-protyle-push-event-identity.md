---
title: "ADR-026: Protyle 推送事件内容身份"
description: "为事务和单目标编辑器推送事件固定显式 notebookId 与 documentId"
author: "Codex"
date: "2026-07-19"
version: "1.0.0"
status: "accepted"
tags: ["adr", "protyle", "websocket", "content-identity", "l1"]
---

# ADR-026: Protyle 推送事件内容身份

## Status

Accepted

## Context

Protyle WebSocket 会同时收到多个文档和内容库的广播。旧 `addLoading` 使用裸 root ID，旧 `removeDoc` 使用无内容库范围的 `ids` 数组，旧 `unfoldHeading` 只携带块 ID，旧 `reload` 把 root ID 与 content-store selector 混在一起；消费端只能从当前编辑器、首个响应、路径或全局内容库猜测目标。事务的 `notebook` 字段又是内容存储选择器，普通笔记本按既有合同必须为空，不能作为真实 notebook 身份。

## Decision

1. `addLoading`、`removeDoc`、`unfoldHeading` 和 `reload` 的文档目标必须携带真实 `{notebookId, documentId}`。`unfoldHeading` 另带 `id` 和 `currentNodeID`；`reload` 另带 `notebook`，但该字段只表示 content-store selector。
2. `reload.data.notebook` 保留既有 selector 合同：普通内容库为空，加密内容库为 box ID；它只供 Kernel 路由、缓存和加密生命周期使用，绝不作为编辑器身份。`rootID` 不再作为 reload 的第二套身份字段。
3. 删除子树按每个实际文档根逐条发送事件，不把多个文档压成单一 `documentId`，并删除旧 `ids` 字段。
4. 事务保留 `notebook` 的内容存储选择器语义，新增唯一 `contentTargets: [{notebookId, documentId}]` 投影。目标集合来自已提交事务树的 `tree.Box + tree.ID`，企业请求的服务身份可补充当前目标；不从 DOM、当前 Core、首个响应或全局状态推断。
5. Protyle 只消费与自身构造身份完全相同的目标。`moveDoc` 必须同时匹配 `fromNotebook + id + fromPath`；路径不能单独决定源文档。撤销状态只投影当前文档键。
6. Kernel producer 在内容库生命周期执行器内广播，锁定或关闭的加密内容库不产生迟到事件。

## Evidence

- Go JSON contracts cover `contentTargets`, the four single-document payload shapes, and the selector/identity split for `reload`.
- `protyle-complex-content.spec.ts` covers wrong notebook, wrong document and correct reload/transaction targets, plus source-identity filtering for `moveDoc`.
- `protyle-editor.spec.ts` supplies explicit targets for remote and post-dispose transaction fixtures.

## References

1. [ADR-021：信任边界校验所有权](0021-trust-boundary-validation-ownership.md)
2. [奇点 L1 实现重启交接](../architecture/l1-implementation-handoff.md)
