---
title: "ADR-002: React应用壳与Protyle编辑器边界"
description: "历史决策：React接管应用壳并保留Protyle内容编辑器"
author: "Codex"
date: "2026-07-13"
version: "1.2.0"
status: "superseded"
tags: ["adr", "react", "protyle"]
---

# ADR-002: React应用壳与Protyle编辑器边界

## Status

Accepted

## Context

原应用以TypeScript直接操作DOM，企业功能需要一致的组件、路由、状态和测试体系；Protyle包含成熟块编辑语义，不宜重写。

## Decision

该决策已由 [ADR-035](0035-native-siyuan-workspace-react-enterprise-mount.md) 取代。主工作区继续由思源原生代码拥有；React 只在企业管理 panel 内挂载。

具体的单空间Session、Kernel传输、插件端口、宿主事件、浏览器平台入口和文档重建生命周期由ADR-009定义。现有Protyle没有公共`openDocument`方法，因此`documentId`变化时销毁并重建实例。

## Consequences

- 企业新功能继续使用React、Vite 8与Tailwind CSS 4。
- Protyle继续使用既有Sass与插件DOM合同。
- 原生 Dock/Tab/Model 边界负责企业 panel 的创建、切换、销毁和事件释放。
- 不删除或替代思源原生工作区，避免双工作区所有者。

## References

1. [React documentation](https://react.dev/)
2. [奇点完整方案](../../output/md/Singularity_Enterprise_Knowledge_Base_v1.0.0_2026-07-13.md)
3. [ADR-009](0009-protyle-browser-runtime-boundary.md)

## Superseded by

[ADR-035: 原生思源工作区与 React 企业模块挂载](0035-native-siyuan-workspace-react-enterprise-mount.md)
