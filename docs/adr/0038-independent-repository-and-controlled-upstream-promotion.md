---
title: "ADR-038: 独立仓库与受控上游晋升"
description: "定义Singularity脱离GitHub Fork Network后的canonical仓库身份、SiYuan基线、差异登记与受控promotion流程"
author: "Singularity Contributors"
date: "2026-08-24"
version: "1.0.0"
status: "accepted"
tags: ["adr", "repository", "upstream", "governance", "ci", "siyuan"]
---

# ADR-038: 独立仓库与受控上游晋升

## Status

Accepted

## Context

Singularity最初以`SparkElf/singularity`作为` s iyuan-note/siyuan`的GitHub Fork开发。GitHub Fork Network身份限制了项目作为独立产品被发现、索引和治理的方式，也容易把“GitHub fork同步”误当作正式的上游维护模型。与此同时，Singularity已经在SiYuan 3.7.2基线上形成大量企业能力与原生`app/**`/`kernel/**`差异，简单追随上游`master`会把产品差异、上游能力重叠和回归风险隐藏在普通merge冲突之后。

2026-08-24完成仓库身份切换：历史fork改名为`SparkElf/singularity-legacy-fork`，新的`SparkElf/singularity`以普通公开仓库创建并验证为`fork: false`。既有SiYuan和Singularity产品提交保持原Git对象与作者历史；仓库身份变化不改变AGPL-3.0、NOTICE、上游署名或源码提供义务。

ADR-008建立的“差异化上游同步”方向仍然有效，但其中“定期merge上游”的表述不足以描述当前产品治理。ADR-014的供应链、许可证、SBOM、漏洞和只读工作流原则继续有效，但其中以Fork仓库身份为前提的仓库治理和直接同步表述由本ADR取代。

## Decision

1. `SparkElf/singularity:main`是唯一canonical产品仓库与集成分支；它必须保持GitHub `fork: false`。`SparkElf/singularity-legacy-fork`只作为历史、旧引用和Fork Network证据保留，不再产生新功能或发布。
2. `siyuan-note/siyuan:master`是显式只读上游。GitHub Fork Network元数据不再承担上游关系；准确关系由`upstream/baseline.yaml`、`config/upstream-baseline.json`、`diffs/upstream/registry.yaml`和Git历史共同证明。
3. 当前已晋升SiYuan基线继续固定为`3.7.2` / `c8dcdd0860ef000a14552c619fe19c0dcb5175f5`，直到一个新的upstream promotion通过完整流程。基线SHA引用原始SiYuan Git对象，不因仓库重建而改写。
4. 上游自动化只允许发现、拉取、比较、生成impact报告和准备候选；禁止自动把`upstream/master`合并、rebase或force-update到`main`。
5. 新SiYuan版本在`upstream/siyuan-<version>`候选分支上处理。候选必须与所有active upstream diff记录求交，并逐项分类为`adopt-upstream`、`rebase-local`、`keep-local`或`defer`。上游已经满足产品要求时，优先退役本地差异而不是维护双实现。
6. Promotion默认保留可审计的上游Git来源，不以rebase改写已发布产品历史。具体集成提交由候选PR记录，但无论Git操作形式如何，都必须保持基线来源、差异处理和验证证据可追溯。
7. Upstream baseline变更始终视为full-risk：运行完整repository governance、native app/kernel、enterprise static/integration/browser/E2E、package/supply-chain等适用门禁。impact planner对未知路径同样fail-open到full。
8. PR通过、候选分支可合并或CI全绿都不授权promotion；更新`main`与`upstream/baseline.yaml`需要维护者明确批准。
9. Canonical PR/CI和日常开发以`main`为基线；文档和自动化必须明确区分canonical `main`与SiYuan upstream `master`，不得把两者简称为同一个“主分支”。
10. AI辅助开发必须通过仓库Skills、ADR、Diff Protocol和真实用户路径证据保持工程与UI一致性。方法可以借鉴DeepSeek Harness Plus，但Singularity不复制其视觉样式、包结构或第二套决策文档树。

## Consequences

- Singularity作为独立GitHub项目可被单独索引和治理，同时保留SiYuan完整来源关系。
- 上游升级从“Git同步动作”提升为可审查的产品晋升事件；冲突之外的能力重叠和本地差异退役也成为显式决策。
- `app/**`和`kernel/**`的本地修改成本可见，长期目标是缩小而不是无限扩大upstream divergence。
- CI可按普通变更影响面选择证据，但baseline promotion和未知影响始终回退完整验证。
- 旧Fork仓库不再是活跃开发面；其保留价值是历史URL、原Fork Network关系和迁移审计。

## Supersession

- 本ADR取代ADR-008中“定期直接merge上游到产品分支”的同步流程表述；ADR-008关于原生SiYuan工作区、Protyle与企业模块边界的产品原则继续由后续ADR（尤其ADR-035）承接。
- 本ADR取代ADR-014中依赖GitHub Fork身份和旧canonical `master`的仓库/上游同步表述；ADR-014的供应链、许可证、SBOM、漏洞扫描和制品验证决策继续有效。

## References

1. [`upstream/baseline.yaml`](../../upstream/baseline.yaml)
2. [`DIFFS.md`](../../DIFFS.md)
3. [`docs/repository-rebuild.md`](../repository-rebuild.md)
4. [`docs/ci-cd.md`](../ci-cd.md)
5. [ADR-008](0008-upstream-sync-strategy.md)
6. [ADR-014](0014-fork-governance-supply-chain.md)
7. [ADR-035](0035-native-siyuan-workspace-react-enterprise-mount.md)
