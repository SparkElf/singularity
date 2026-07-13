---
title: "ADR-004: 空间级Kernel实例隔离"
description: "确定一个空间对应一个隔离的思源Kernel实例"
author: "Codex"
date: "2026-07-13"
version: "1.0.0"
status: "accepted"
tags: ["adr", "security", "isolation"]
---

# ADR-004: 空间级Kernel实例隔离

## Status

Accepted

## Context

思源Kernel原生不具备企业文档ACL。共享实例会使搜索、引用、附件、导出和插件形成跨空间泄露面。

## Decision

每个空间绑定唯一Kernel实例及独立工作空间目录。Kernel仅在私有网络可达，所有成员请求先经过NestJS授权与实例解析。

## Consequences

- 搜索、引用和附件天然受空间存储边界隔离。
- 实例数量与运维成本随空间增长。
- L5前不得为节省实例而共享内容目录。
- 容量、健康和生命周期须按`kernelInstanceId`观测。

## References

1. [奇点完整方案](../../output/md/Singularity_Enterprise_Knowledge_Base_v1.0.0_2026-07-13.md)

