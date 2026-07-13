---
title: "ADR-008: 差异化上游同步策略"
description: "定义Kernel、Protyle与React应用壳的上游同步方式"
author: "Codex"
date: "2026-07-13"
version: "1.0.0"
status: "accepted"
tags: ["adr", "git", "upstream"]
---

# ADR-008: 差异化上游同步策略

## Status

Accepted

## Context

Kernel与Protyle需持续吸收思源修复，React应用壳则会替代上游旧DOM壳。对全部目录采用同一种同步方式会扩大冲突。

## Decision

Kernel保持最小补丁并定期merge上游。Protyle保留明确边界并同步相关变更。React壳不合并上游旧壳，由影响报告指导人工移植。企业模块位于独立目录。

## Consequences

- 每次同步必须记录基线、模块影响、冲突与验证结果。
- Git同步使用merge，不默认rebase。
- React迁移完成后删除旧入口，不保留长期兼容层。
- 基线校验工具必须在CI执行。

## References

1. [SiYuan official repository](https://github.com/siyuan-note/siyuan)
2. [奇点完整方案](../../output/md/Singularity_Enterprise_Knowledge_Base_v1.0.0_2026-07-13.md)

