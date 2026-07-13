---
title: "ADR-005: 内容单一事实源"
description: "禁止PostgreSQL与思源工作空间双写文档内容"
author: "Codex"
date: "2026-07-13"
version: "1.0.0"
status: "accepted"
tags: ["adr", "data", "ownership"]
---

# ADR-005: 内容单一事实源

## Status

Accepted

## Context

同时把文档写入PostgreSQL和`.sy`会产生提交顺序、恢复、索引和引用一致性问题。

## Decision

`.sy`与Kernel SQLite是文档、块、引用和索引的唯一事实源。PostgreSQL仅持有组织、空间、权限、分享、审计及Kernel实例元数据。

## Consequences

- 不建立文档内容双写、兼容映射或后台对账路径。
- 跨空间聚合必须读取Kernel公开合同或未来独立索引事件。
- 备份对象不是在线读取事实源。
- 企业实体只使用唯一权威ID字段。

## References

1. [奇点完整方案](../../output/md/Singularity_Enterprise_Knowledge_Base_v1.0.0_2026-07-13.md)

