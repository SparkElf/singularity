---
title: "奇点（Singularity）"
description: "基于思源笔记代码库、处于持续开发阶段的企业知识库。"
author: "奇点贡献者"
date: "2026-08-24"
version: "1.2.0"
status: "draft"
tags: ["奇点", "知识库", "思源笔记", "AGPL"]
---

# 奇点（Singularity）

> 基于思源笔记代码库、处于持续开发阶段的企业知识库。

[English](README.md) | **中文** | [日本語](README.ja.md) | [Türkçe](README.tr.md)

## 变更记录

| 版本 | 日期 | 作者 | 变更 |
|------|------|------|------|
| 1.0.0 | 2026-07-15 | 奇点贡献者 | 将上游产品介绍替换为奇点项目入口 |
| 1.1.0 | 2026-07-17 | 奇点贡献者 | 将已合并的思源 3.7.2 提交晋升为上游基线 |
| 1.2.0 | 2026-08-24 | 奇点贡献者 | 建立独立仓库治理、显式上游追踪、AI 工程 Skills、UI 治理和基于影响面的 CI 规划 |

## 目录

- [当前状态](#当前状态)
- [项目方向](#项目方向)
- [工程与上游治理](#工程与上游治理)
- [贡献与安全](#贡献与安全)
- [许可证与上游](#许可证与上游)
- [参考资料](#参考资料)

## 当前状态

奇点正在持续开发，尚未形成可用于生产环境的正式版本。设计或计划文档中描述的能力可能仍未完成或尚不可用，实际状态以当前源码和验证证据为准。

## 项目方向

项目计划在思源笔记基础上演进出云端企业知识库，并逐步建设组织、分享、权限、协作、治理、发现和 AI 辅助能力。这些内容是项目目标，不代表所有能力已经实现。

奇点按照“基于思源、独立维护的产品仓库”进行治理。GitHub Fork Network 不再承担上游集成关系：项目固定精确的思源基线、显式记录长期差异，并通过候选分支与 Pull Request 审阅后晋升新的上游版本。

## 工程与上游治理

AI 辅助开发遵循 [`.agents/README.md`](.agents/README.md) 和 [`AGENTS.md`](AGENTS.md) 中的仓库原生流程。可见 UI 变更必须遵循 [`docs/ui-governance.md`](docs/ui-governance.md)：AI 复用现有语义主题、组件和交互模式，不为单个功能另建一套视觉或组件体系。

当前思源上游基线记录在 [`upstream/baseline.yaml`](upstream/baseline.yaml)。长期维护的上游差异和产品自有能力由 [`DIFFS.md`](DIFFS.md) 及 `diffs/` 下的 registry 管理。上游版本会先进行影响分析，再通过受控 promotion 流程合入；不会自动把思源 `master` 合并到主分支。

CI/CD 规则见 [`docs/ci-cd.md`](docs/ci-cd.md)。变更影响分析遇到未知路径或上游基线变更时会 fail-open 到完整验证。PR 检查通过并不自动授权合并、发布、上游晋升或生产部署。

从旧 GitHub Fork Network 仓库切换到新的独立 canonical 仓库的一次性流程见 [`docs/repository-rebuild.md`](docs/repository-rebuild.md)。

## 贡献与安全

提出变更前请阅读[贡献指南](.github/CONTRIBUTING.zh-CN.md)。可在[奇点 Issue 列表](https://github.com/SparkElf/singularity/issues)提交可复现的缺陷或范围明确的建议。

发现疑似安全漏洞时，请按照[安全政策](.github/SECURITY.md)私下报告。在维护者完成评估前，请勿在公开 Issue 中披露漏洞。

## 许可证与上游

奇点是基于[思源笔记](https://github.com/siyuan-note/siyuan)的修改作品，当前固定上游基线为版本 `3.7.2`、提交 `c8dcdd0860ef000a14552c619fe19c0dcb5175f5`。

本项目依据 [GNU Affero 通用公共许可证第 3 版](LICENSE)发布。修改、部署或再分发时，必须保留适用的版权、许可证、源码提供和署名声明。上游基线与商标归属见 [NOTICE](NOTICE)。

独立仓库身份不会移除或削弱从思源继承的许可证、版权、署名和源码提供义务。

## 参考资料

1. [奇点代码仓库](https://github.com/SparkElf/singularity)
2. [思源笔记上游代码仓库](https://github.com/siyuan-note/siyuan)
3. [GNU Affero 通用公共许可证第 3 版](https://www.gnu.org/licenses/agpl-3.0.html)
