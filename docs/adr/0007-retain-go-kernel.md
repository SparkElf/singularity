---
title: "ADR-007: 保留思源Go Kernel"
description: "确定当前长期路线不重写思源内容内核"
author: "Codex"
date: "2026-07-13"
version: "1.0.0"
status: "accepted"
tags: ["adr", "go", "kernel"]
---

# ADR-007: 保留思源Go Kernel

## Status

Accepted

## Context

Kernel约13万行Go代码及516个API，承载Lute AST、定制SQLite、块事务、文件锁、同步、索引和导入导出。现有测试不足以证明全量重写等价。

## Decision

保留Go Kernel作为云端内容引擎。不将其翻译为TypeScript或Rust；现代化工作集中于React Web与NestJS企业控制面。

## Consequences

- 降低数据兼容与内容回归风险。
- 团队需维护Go与TypeScript两种服务技术栈。
- 通过稳定Content Core API隔离语言边界。
- 只有出现经测量且无法解决的内核约束时重新审议。

## References

1. [SiYuan official repository](https://github.com/siyuan-note/siyuan)
2. [奇点完整方案](../../output/md/Singularity_Enterprise_Knowledge_Base_v1.0.0_2026-07-13.md)

