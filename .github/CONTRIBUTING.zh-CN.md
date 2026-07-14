---
title: "参与奇点项目"
description: "奇点项目的仓库工作流、质量要求和许可证要求。"
author: "奇点贡献者"
date: "2026-07-15"
version: "1.0.0"
status: "approved"
tags: ["贡献", "开发", "AGPL"]
---

# 参与奇点项目

> 让每次变更范围明确、便于审阅、能够验证，并与奇点当前方案保持一致。

[English](CONTRIBUTING.md) | **中文**

## 变更记录

| 版本 | 日期 | 作者 | 变更 |
|------|------|------|------|
| 1.0.0 | 2026-07-15 | 奇点贡献者 | 建立奇点独立仓库的贡献流程 |

## 目录

- [开始变更前](#开始变更前)
- [仓库准备](#仓库准备)
- [实现与验证](#实现与验证)
- [拉取请求](#拉取请求)
- [许可证与上游署名](#许可证与上游署名)
- [参考资料](#参考资料)

## 开始变更前

开始工作前请先搜索[奇点 Issue 列表](https://github.com/SparkElf/singularity/issues)。非简单功能、行为变更、迁移或架构决策应先建立 Issue，在实现前明确范围和验收标准。

请阅读变更路径适用的 `AGENTS.md` 和仓库中的当前计划。奇点仍处于持续开发阶段，计划文档中描述的工作可能尚未实现。

## 仓库准备

克隆本仓库，并从 `master` 创建范围明确的分支：

```bash
git clone https://github.com/SparkElf/singularity.git
cd singularity
git switch master
git switch -c your-branch-name
```

请使用仓库声明的工具版本。Go 版本以 `kernel/go.mod` 为准；Node 和 pnpm 要求以相关包清单和持续集成配置为准。安装依赖前，应检查变更模块适用的锁文件、registry 配置、认证源和持续集成设置。

## 实现与验证

- 每次变更只处理一个连贯目标。
- 保留现有声明，并清楚标识继承自思源笔记的行为。
- 只在变更后的稳定合同需要证据时新增或修改验证。
- 执行项目指南要求的 lint、类型检查、测试和构建命令。
- 除非任务明确需要，否则不要包含生成产物或无关格式化变更。

## 拉取请求

通过[仓库拉取请求页面](https://github.com/SparkElf/singularity/pulls)向奇点的 `master` 分支提交 PR。请关联对应 Issue，说明用户可见变化和合同变化，列出验证证据，并披露已知限制或未验证的环境。

如果一个变更混合了无关的行为、重构、文档或生成产物，维护者可能要求拆分。

## 许可证与上游署名

提交贡献即表示你有权提供这些内容，并同意按照本仓库的 [AGPL-3.0 许可证](../LICENSE)发布。请保留上游和第三方的版权、许可证、署名与商标声明。

仅面向上游思源笔记产品的变更，应与[思源笔记上游仓库](https://github.com/siyuan-note/siyuan)协调。奇点特有的问题和建议应提交到本仓库。

## 参考资料

1. [奇点代码仓库](https://github.com/SparkElf/singularity)
2. [奇点 Issue 列表](https://github.com/SparkElf/singularity/issues)
3. [奇点声明](../NOTICE)
4. [思源笔记上游仓库](https://github.com/siyuan-note/siyuan)
