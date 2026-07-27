---
title: "ADR-035: 原生思源工作区与 React 企业模块挂载"
description: "将原生思源作为主工作区所有者，仅在企业管理入口挂载 React"
author: "Codex"
date: "2026-07-24"
version: "1.0.0"
status: "accepted"
tags: ["adr", "ui", "siyuan", "react", "vite"]
---

# ADR-035: 原生思源工作区与 React 企业模块挂载

## Context

奇点必须保留思源 Web 版的像素级工作区体验。此前由企业 React `SpacePage` 重做顶栏、侧栏、页签和编辑器外壳，导致布局和交互与原生基线产生明显差异，也让两个工作区所有者同时维护文档身份、布局和快捷键。

## Decision

- `app/src` 的思源原生 `App`、layout、Dock、Tab、Protyle、状态栏和全局快捷键继续拥有主工作区。
- 企业 React 应用不再拥有主工作区壳；`SpacePage` 只保留为独立企业路由的兼容页面，不作为原生思源生产入口。
- 原生左 Dock 增加固定的 `enterprise` Dock 项。点击后由原生 `Wnd/Tab` 创建 `EnterpriseAdminModel`，在 panel 中挂载企业 React URL。
- 企业页面和原生工作区之间使用浏览器 iframe 边界。React 只拥有 iframe 内 DOM、路由和企业状态，不接触原生编辑器 DOM、块数组、撤销栈、布局或快捷键。
- 企业 URL 使用 `localStorage` 的 `singularity.enterprise.webOrigin` 覆盖值；未配置时使用当前 origin，保证生产同源部署不需要额外配置。开发时可显式设置为 Vite 预览端口。
- 企业 URL 同时携带原生 `appearance.mode` 解析出的 `theme=light|dark`，React 在根节点创建前消费该参数，避免跨源 iframe 退回自己的亮色 localStorage。
- 原生 model 的 `init/destroy/resize` 是唯一生命周期 owner。React 页面加载失败只显示在 panel 内，不影响原生文档工作区。

## Alternatives

1. React 重做整个工作区：视觉漂移、重复布局状态和编辑器身份风险，不采用。
2. 仅用新窗口打开企业站点：无法满足“原生侧栏进入企业内页”的体验，不采用。
3. 原生 custom tab/Dock + iframe：复用原生布局生命周期，模块边界清晰，采用。

## Consequences

- 主工作区可以直接与未修改思源构建产物做截图基线比较。
- 企业 React 构建仍可独立使用 Vite 8、React 19、Tailwind 4 和 shadcn；它不再需要仿制思源 shell。
- iframe 生产部署必须提供同源或允许的企业 web origin；跨源开发环境由 localStorage 明确配置。
- 原生入口增加少量 fork 代码，后续上游合并只需处理入口、model 和 Dock 类型三处边界。

## Verification

- 原生 app desktop build 与基线截图对比。
- 原生 TypeScript 编译。
- enterprise web typecheck/build/test 聚合。
- 浏览器检查企业入口打开、关闭和错误隔离。
