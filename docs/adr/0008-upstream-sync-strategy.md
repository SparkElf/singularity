---
title: "ADR-008: 差异化上游同步策略"
description: "历史决策：定义Kernel、Protyle与原生思源工作区及企业React模块的上游同步方式"
author: "Codex"
date: "2026-07-13"
version: "1.1.0"
status: "superseded"
tags: ["adr", "git", "upstream"]
---

# ADR-008: 差异化上游同步策略

## Status

Superseded by [ADR-038](0038-independent-repository-and-controlled-upstream-promotion.md) for repository/upstream synchronization. The surviving native-workspace and enterprise-mount ownership is carried by [ADR-035](0035-native-siyuan-workspace-react-enterprise-mount.md).

## Context

Kernel、Protyle与原生工作区需持续吸收思源修复，企业 React 模块独立迭代。对全部目录采用同一种同步方式会扩大冲突。

## Decision

Kernel保持最小补丁并定期 merge 上游。Protyle 与原生工作区继续沿上游同步；企业模块位于独立目录，通过原生 Dock custom model 挂载，不替代上游旧壳。

> 历史说明：以上“定期merge上游”的流程不再是当前维护合同。当前模型为独立canonical `main` + SiYuan `upstream/master` + 固定baseline + diff registry + promotion PR，见ADR-038。

## Consequences

- 每次同步必须记录基线、模块影响、冲突与验证结果。
- Git同步使用merge，不默认rebase。
- 不以 React 重做工作区，也不删除上游原生工作区入口。
- 原生企业入口的 fork 代码保持在 ADR-035 定义的边界内。
- 基线校验工具必须在CI执行。

## References

1. [SiYuan official repository](https://github.com/siyuan-note/siyuan)
2. [ADR-035](0035-native-siyuan-workspace-react-enterprise-mount.md)
3. [ADR-038](0038-independent-repository-and-controlled-upstream-promotion.md)
4. [奇点完整方案](../../output/md/Singularity_Enterprise_Knowledge_Base_v1.0.0_2026-07-13.md)
