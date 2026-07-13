---
title: "ADR-006: 实时协作技术门禁"
description: "要求实时协作先通过思源块语义无损原型"
author: "Codex"
date: "2026-07-13"
version: "1.0.0"
status: "accepted"
tags: ["adr", "collaboration", "crdt"]
---

# ADR-006: 实时协作技术门禁

## Status

Accepted

## Context

现有WebSocket事务广播不等于CRDT。直接接入Yjs可能破坏块ID、引用、属性视图、历史和撤销语义。

## Decision

L3前先建立独立原型。普通块、块引用、嵌入块、属性视图、历史和撤销均无损通过后，方可产品化实时协作。

## Consequences

- L0与L1不承诺多人同时编辑同一文档。
- 原型失败时停止实现并重新评估内容底座。
- 不用锁、最后写入获胜或双写路径伪装实时协作。

## References

1. [Yjs documentation](https://docs.yjs.dev/)
2. [奇点完整方案](../../output/md/Singularity_Enterprise_Knowledge_Base_v1.0.0_2026-07-13.md)

