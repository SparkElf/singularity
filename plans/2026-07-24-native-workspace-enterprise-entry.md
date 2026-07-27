---
title: "原生思源工作区与企业入口落地计划"
description: "修正 React 壳方向，恢复原生思源主工作区并挂载企业 React"
author: "Codex"
date: "2026-07-24"
version: "1.0.0"
status: "completed"
---

目标依据：[原生思源工作区与企业管理入口](../docs/product/native-workspace-enterprise-entry.md)、[ADR-035](../docs/adr/0035-native-siyuan-workspace-react-enterprise-mount.md)。

## 本期范围

- 在原生思源左 Dock 增加企业管理按钮。
- 用原生 Dock/Tab/Model 生命周期挂载企业 React 页面。
- 停止把 React `SpacePage` 当作原生主工作区的视觉基准。
- 保留企业 React 路由、API 和设计系统，暂不把企业功能复制进 Protyle。
- 用原生构建产物和未修改基线做亮色、暗色、窄屏对比。

## 任务清单

- [x] 形成产品验收标准和架构 ADR。
- [x] 将旧 React shell ADR 标记为 superseded。
- [x] 增加原生 enterprise Dock 类型、入口和 model。
- [x] 增加企业 iframe origin 配置合同及销毁语义。
- [x] 建立原生 app 编译和企业 web 构建的整阶段门禁。
- [x] 代码评审和 test-governance 复评。
- [x] 集中验证：类型、构建、原生截图、企业入口浏览器检查。

## 完成条件

主空间由原生思源 DOM 负责，和同版本基线的差异只剩企业入口；企业 React 只出现在企业 panel；打开、关闭和失败路径没有跨 panel 残留资源。

## 恢复提示

恢复后先读取本文件、ADR-035 和 product 文档。不要继续在 `SpacePage.tsx` 上调整顶栏、Dock、文档树或编辑器外壳；这些均属于原生 app 所有者。

## Verification 记录

- `enterprise`: `pnpm typecheck` 通过；`pnpm build` 通过；`pnpm test` 通过（架构 57/57、Protyle browser 17/17、Web 187/187、app 93/93）。
- `app`: `pnpm run build:desktop` 通过；仅保留上游已有的导出缺失和包体积告警，无新增编译错误。
- 原生 Chromium 入口：主工作区无 `[data-singularity-ui]`；企业 Dock 打开后 iframe 为 1，关闭为 0，重开为 1，切换到文件 Dock 后为 0；iframe 地址显式携带 `theme=dark|light`。
- 主题与布局：暗色、亮色截图均与原生工作区同色；320px 下父页面 `scrollWidth=320` 且无横向溢出，企业 iframe 正常挂载。
- 浏览器诊断：6808 的临时 HTTPS Kernel 因自签名 Service Worker 产生已知 SSL console 噪声；4174 未登录测试工作区产生预期 `401`（`/api/v1/spaces`、`/api/v1/enterprise-management-access`），未发现其他失败请求或跨工作区 DOM 写入。
