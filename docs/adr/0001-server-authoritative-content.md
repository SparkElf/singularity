---
title: "ADR-001: 服务器权威内容模式"
description: "确定奇点内容仅由云端服务端持有"
author: "Codex"
date: "2026-07-13"
version: "1.0.0"
status: "accepted"
tags: ["adr", "architecture", "cloud"]
---

# ADR-001: 服务器权威内容模式

## Status

Accepted

## Context

奇点面向企业组织、权限、分享与审计。端侧内容库、离线编辑和同步合并会增加事实源、冲突状态与安全边界。

## Decision

内容仅存Linux云端。浏览器及PWA只承担交互与展示，不保存可独立编辑的内容事实源，不支持离线编辑和端侧同步。

## Consequences

- 权限、审计和备份均以服务端状态为准。
- 客户端无需Go、Rust、`gomobile`或原生内容内核。
- 网络不可用时不能编辑内容。
- 敏感查询缓存须在退出登录后清除。

## References

1. [奇点完整方案](../../output/md/Singularity_Enterprise_Knowledge_Base_v1.0.0_2026-07-13.md)

