---
title: "Protyle Vite 生产闭包审计"
description: "记录奇点企业唯一 Vite 入口与真实 Protyle Core 生产闭包的静态依赖审计合同"
author: "Codex"
date: "2026-07-18"
version: "1.3.0"
status: "implementation"
tags: ["singularity", "protyle", "vite", "boundary"]
---

# Protyle Vite 生产闭包审计

## 目的

`enterprise/apps/web/index.html`只装载`enterprise/apps/web/src/main.tsx`，该文件是企业Web的唯一脚本生产入口；真实Core由专用公共子入口`@singularity/protyle-browser/core`接到`app/src/protyle/browser-entry.ts`。审计从该入口遍历TypeScript、TSX、JavaScript的静态、动态、`require`、重导出和type-only加载，确认Vite闭包没有偷偷带入旧应用壳或平台运行时。

## 标准工具

```text
node enterprise/scripts/protyle-vite-closure-audit.mjs
node --test enterprise/scripts/protyle-vite-closure-audit.test.mjs
node --test enterprise/scripts/p5-entry-closure.test.mjs
```

审计脚本在真实 Core 未接入时报告 `core-entry-missing` 并扫描候选闭包；接入后只审计生产图，任何旧边界依赖都作为生产违规返回非零，不能再藏在候选阶段。

## 门禁

- 企业生产入口必须经 `enterprise/packages/protyle-browser/src/core.ts` 实际加载 `app/src/protyle/browser-entry.ts`，否则报告 `core-entry-missing`。
- `enterprise/apps/web/index.html`必须只有`/src/main.tsx`一个module入口，Web package构建脚本必须以`vite build`收口且不得包含Webpack；P5 static case还复用同一module-load AST扫描全部Web源码，保证只有`main.tsx`加载公共Core子入口且没有旧壳owner导入。
- 专用公共 Core 子入口只能由 `enterprise/apps/web/src/main.tsx` 装配；其他生产模块加载该子入口会报告 `core-composition-root`。
- 禁止旧 `App`、`layout`、`editor`、`search`、`history`、`card`、`plugin`、`menus`、`mobile`、Electron、Node 内置模块和 `ifdef-loader` 指令。
- 禁止 `window.siyuan`、旧 `fetchPost`/`fetchGet`/`fetchSyncPost` 以及旧 `layout/Model` 进入 Core 闭包。
- 禁止非字面量动态 import、`require`、URL import、绝对路径和未经声明的外部包。
- Core 只允许从受审的 `app/src/protyle` 与明确批准的共享设置/类型文件取得源码；企业端只允许公共 Protyle 包作为跨边界依赖。
- `enterprise/packages/protyle-browser/src/core.ts -> app/src/protyle/browser-entry.ts` 是唯一批准的跨源码根运行时边；审计按精确源文件和精确目标文件放行，其他 `enterprise -> app` 依赖仍报告 `source-escape`。
- 样式和图片等非 TypeScript/JavaScript 资源不计入脚本闭包，但仍由 Vite 自身负责构建。

## 当前证据

2026-07-19 实现状态：`main.tsx` 已按授权 `spaceId` 创建`ProtyleApplicationPort`，经专用公共子入口创建真实Core，再交给公共Factory；`space-session.ts`中的临时未接线函数和错误码已删除。当前允许的实现期source scan从真实入口遍历273个生产文件并报告0项边界违规；本快照只证明静态依赖方向，不替代L1完成后的集中typecheck、测试、Vite build、浏览器和E2E证据。

本轮最后一条扩散根是`Title -> util/pathName`；Title改为消费Core自有纯显示名能力后，`pathName`及其旧全局、transport和平台依赖全部退出生产图。旧壳文件没有迁入Core，allowlist没有扩大，也没有增加App shim、全局fallback或第二条生产路径。后续代码变化继续由同一门禁拒绝回流。

企业Web中原先直接加载`app/src/host/plugin.ts`与`app/src/layout/Model.ts`的两个错位Vitest文件已退出：PluginPort的稳定行为合同迁回`app/src/host/plugin.test.js`并由App标准`node:test`入口发现，旧Model重连case因不保护企业Transport合同而删除。P5 static case同时保护这两个旧企业路径物理不存在；本实现状态尚未执行runner，不构成验证通过证据。

## 入口生命周期

`main.tsx` 只在服务端授权的 ready 空间创建按 `spaceId` 隔离的 ApplicationPort；`SpacePage` 从组合根取得 Factory，并把目录项产生的 `notebookId + documentId` 与当前 Session 一次交给 Host。`app/src/protyle/browser-entry.ts` 只接受显式应用端口，bound Core 创建时传入当前 `ProtyleSession`，不运行时导入或实例化旧 `App`。

## 完成条件

只有在生产图实际包含真实 Core、生产扫描不再有上述违规、Vite 构建产物与静态图一致，并由集中 code-review/verification 证明真实编辑、读写、推送和销毁生命周期后，才可将 B4 Core 闭包标记完成。
