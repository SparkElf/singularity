---
title: "ADR-002: React应用壳与Protyle编辑器边界"
description: "确定React接管应用壳并保留Protyle内容编辑器"
author: "Codex"
date: "2026-07-13"
version: "1.1.0"
status: "accepted"
tags: ["adr", "react", "protyle"]
---

# ADR-002: React应用壳与Protyle编辑器边界

## Status

Accepted

## Context

原应用以TypeScript直接操作DOM，企业功能需要一致的组件、路由、状态和测试体系；Protyle包含成熟块编辑语义，不宜重写。

## Decision

React拥有应用壳及全部新增页面。Protyle保留编辑器DOM与事务状态，通过单一React生命周期组件挂载；编辑器内部状态不复制到Zustand。

具体的单空间Session、Kernel传输、插件端口、宿主事件、浏览器平台入口和文档重建生命周期由ADR-009定义。现有Protyle没有公共`openDocument`方法，因此`documentId`变化时销毁并重建实例。

## Consequences

- 新功能统一使用React、Vite 8与Tailwind CSS 4。
- Protyle继续使用既有Sass与插件DOM合同。
- React边界须负责创建、切换、只读、销毁和事件释放。
- 旧壳迁移完成后删除，不保留双入口。

## References

1. [React documentation](https://react.dev/)
2. [奇点完整方案](../../output/md/Singularity_Enterprise_Knowledge_Base_v1.0.0_2026-07-13.md)
3. [ADR-009](0009-protyle-browser-runtime-boundary.md)
