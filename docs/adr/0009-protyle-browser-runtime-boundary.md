---
title: "ADR-009: Protyle浏览器运行时边界"
description: "确定Protyle通过单空间Session、Kernel传输和类型化宿主事件接入React/Vite"
author: "Codex"
date: "2026-07-13"
version: "1.0.0"
status: "accepted"
tags: ["adr", "protyle", "react", "vite", "runtime"]
---

# ADR-009: Protyle浏览器运行时边界

## Status

Accepted

## Context

ADR-002确定React拥有应用壳、Protyle拥有编辑器DOM。源码审计发现，直接导入`app/src/protyle/index.ts`仍会把旧布局、移动端、菜单、插件、Electron和大量`window.siyuan`状态带入Vite；当前React控制器中的`openDocument`也不是Protyle真实公共方法。

## Decision

1. 建立唯一的`@singularity/protyle-browser`公共入口，React和企业模块不得越过该入口导入Protyle内部或旧应用壳。
2. 一个浏览器标签页同一时刻只持有一个`spaceId`对应的`ProtyleSession`；切空间必须先销毁旧编辑器、请求、WebSocket、插件和资源。
3. React只传`spaceId`、`documentId`和`readOnly`。文档变化通过销毁并重建Protyle处理，不保留虚构的`openDocument`控制器方法。
4. `KernelTransport`负责空间路由、认证、HTTP/WS和错误转换；所有内容请求经过NestJS Gateway，不允许浏览器直连Kernel或fallback。
5. Protyle通过类型化HostEvent请求React执行文档导航、搜索、图谱、资源和通知；不直接依赖React路由或旧布局。
6. 编辑器只依赖`ProtylePluginPort`，插件的顶栏、Dock和页签扩展由React插件Facade承接。
7. 浏览器入口闭包不得包含ifdef指令、Electron、Node内置模块或原生移动端import；Vite是唯一Web构建路径。

## Alternatives

- **iframe旧Web UI**：拒绝。会保留Webpack、旧壳和双会话。
- **直接import并伪造App**：拒绝。不能消除跨369个文件的隐式依赖闭包。
- **重写编辑器**：拒绝。块语义、属性视图和插件回归风险不可接受。

## Consequences

- Protyle必须先完成浏览器闭包抽取，不能以空`App`对象假装真实接入。
- 同一标签页暂不支持跨空间同时打开文档；多空间通过显式会话切换处理。
- React不复制文档、选区、事务和撤销状态；Gateway权限是唯一写授权边界。
- 旧Web入口在真实链路验收后删除，不保留双构建或兼容shim。
- 迁移按P0-P5批次执行，完成条件和测试矩阵见详细方案。

## References

1. [Protyle浏览器宿主与Vite抽取方案](../architecture/protyle-browser-host.md)
2. [ADR-002](0002-react-shell-protyle-editor.md)
3. [奇点完整方案](../../output/md/Singularity_Enterprise_Knowledge_Base_v1.0.0_2026-07-13.md)

