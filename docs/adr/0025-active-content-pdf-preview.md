---
title: "ADR-025: 主动内容隔离与 PDF 安全预览"
description: "固定空间资源的 MIME 策略、受控下载和 PDF.js canvas 生命周期"
author: "Codex"
date: "2026-07-19"
version: "1.0.0"
status: "accepted"
tags: ["adr", "active-content", "pdf", "security", "protyle"]
---

# ADR-025: 主动内容隔离与 PDF 安全预览

## Status

Accepted

## Context

空间资源来自授权后的内容链，路径只能由当前 `spaceId + notebookId + documentId` 组合根生成。资源响应可能来自用户上传、导出或历史数据，文件扩展名和持久化链接不能作为执行安全依据；把 HTML、JavaScript、SVG、XML 或未知字节直接交给浏览器源会把内容库变成应用源的一部分。PDF 需要可读预览，但原文件不能通过 iframe、object、embed 或浏览器原生导航执行。

## Decision

1. `AssetPreviewSurface` 只接受显式内容身份和由空间 Gateway path builder 生成的资源地址；组件不拼接原始工作区路径、不直连 Kernel，也不从 DOM、首个响应或当前全局状态补齐身份。附件读取使用 `same-origin`、`no-store` 和禁止重定向的 fetch 合同。
2. `AssetPreview` 以响应 `Content-Type` 的规范化 MIME 作为唯一前端展示分类。惰性内联 allowlist 只包含 `image/avif`、`image/gif`、`image/jpeg`、`image/png`、`image/webp`、`audio/aac`、`audio/flac`、`audio/mpeg`、`audio/ogg`、`audio/wav`、`video/mp4`、`video/ogg` 和 `video/webm`；其他类型一律不创建媒体元素并使用带 `download=true` 的受控下载地址。
3. HTML、JavaScript、SVG、XML、未知类型和导出 HTML 不进入应用源执行。Gateway 对这些类型返回附件 disposition、`nosniff` 和 sandbox CSP；前端即使收到错误 MIME，也只显示下载面板并触发受控下载，不以内联标签承载响应字节。
4. `application/pdf` 是唯一的受信预览例外。组件把已授权字节交给仓库已有的 PDF.js 3.38.1 runtime，固定关闭 XFA、脚本求值、流式请求、Range、自动预取和 WASM，使用同源 checked-in worker、cmap 与 standard fonts；只把页面绘制到 canvas，不创建原文件 URL、iframe、object 或 embed。
5. PDF.js runtime 通过字面模块脚本入口加载一次。共享 promise 只负责加载受信静态模块，调用方的 `AbortSignal` 只取消当前等待；脚本失败会清除共享 promise，下一次调用显式重试同一入口，不建立备用 loader。组件销毁或换字节时先取消当前 render task，再销毁唯一 loading task，并清空旧 canvas，迟到的页面或响应不能覆盖新资源。
6. 附件状态携带产生它的资源地址。状态更新、自动下载和媒体展示都要求状态来源仍等于当前 `src`，因此换空间、文档或资源时迟到响应不能覆盖当前表面。Blob URL 只由组件创建并在销毁时撤销，不写入 React 全局状态或内容库。

## Consequences

安全媒体仍可在工作台内惰性查看，PDF 获得可分页的 canvas 预览；主动内容和未知字节需要用户下载后交给外部程序。Gateway 的 MIME/响应头策略是服务器事实源，前端 allowlist 只决定是否创建惰性展示元素，不能放宽服务器的附件策略。PDF.js 运行时复用现有 `app/stage/protyle/js/pdf` 资产，不新增 npm 依赖或第二份 PDF 引擎。

## Evidence

组件合同由 `AssetPreview.test.tsx`、`PdfCanvasPreview.test.tsx` 和 `pdfjs-runtime.test.ts` 保护；浏览器 integration `tests/browser-integration/active-content.spec.ts` 通过真实页面、受控 Gateway 响应、canvas 像素和无执行元素检查 PDF、惰性图片及 HTML/JavaScript/SVG/XML/未知附件路径。实现阶段只进行静态语法、transpile 和差异检查，正式测试留给 L1 集中 verification。

## Alternatives

- **按扩展名决定是否预览**：拒绝。扩展名来自持久化内容，不能证明实际响应 MIME 或授权边界。
- **把 PDF 放进 iframe 或原生 `<embed>`**：拒绝。浏览器会重新获得原文件导航、脚本和外部资源处理能力，无法证明应用源不执行内容。
- **为 PDF 新增 npm PDF 引擎**：拒绝。仓库已有版本锁定的 PDF.js 资产，新增依赖会形成第二份供应链和构建入口。
- **用响应正文补齐资源身份或在组件中回退旧 URL**：拒绝。会破坏三段内容身份和加密笔记本隔离，且形成无法审计的第二传输路径。

## References

1. [ADR-009：Protyle 浏览器运行时边界](0009-protyle-browser-runtime-boundary.md)
2. [ADR-010：Protyle 宿主动作与合同所有权](0010-protyle-host-actions-and-contract-ownership.md)
3. [Protyle 浏览器宿主与 Vite 抽取方案](../architecture/protyle-browser-host.md)
4. [奇点完整方案](../../output/md/Singularity_Enterprise_Knowledge_Base_v1.0.0_2026-07-13.md)
