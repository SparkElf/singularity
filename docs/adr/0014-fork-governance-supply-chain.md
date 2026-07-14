---
title: "ADR-014: Fork治理、供应链与上游同步门禁"
description: "定义奇点独立仓库的工作流隔离、品牌法律入口、制品扫描与可重复上游merge流程"
author: "Codex"
date: "2026-07-15"
version: "1.0.0"
status: "accepted"
tags: ["adr", "l0", "fork", "supply-chain", "upstream", "github-actions"]
---

# ADR-014: Fork治理、供应链与上游同步门禁

> 将奇点从可构建的思源派生树收敛为可独立维护、可追溯且不会误执行上游运维动作的正式仓库。

## Change Log

| Version | Date | Author | Changes |
| --- | --- | --- | --- |
| 1.0.0 | 2026-07-15 | Codex | 接受独立Fork治理、品牌法律、SBOM、漏洞、许可证与上游同步门禁 |

## Table of Contents

1. [Status](#status)
2. [Context](#context)
3. [Decision](#decision)
4. [Data Flow](#data-flow)
5. [Test Matrix](#test-matrix)
6. [Alternatives](#alternatives)
7. [Consequences](#consequences)
8. [References](#references)

## Status

Accepted

## Context

奇点仓库已经配置独立`origin`和只读`upstream`，但代码树仍保留思源的发布、Docker、AUR、Issue锁定和目标分支工作流，其中两个工作流没有仓库身份保护。远端曾实际定时运行带Issue和PR写权限的上游锁定任务；该任务和上游CD现已在远端手工禁用，但远端设置不能替代版本库内的安全边界。

根README、贡献、安全、Issue模板、赞助、行为准则和GitHub仓库元数据仍把思源或B3log当作当前产品与维护方。L0方案同时要求Docker构建、SBOM、漏洞与许可证扫描，以及一次可审计的上游merge演练，现有`singularity-l0.yml`尚未提供这些证据。

本地已将`upstream/master`更新到`c8dcdd0860ef000a14552c619fe19c0dcb5175f5`并执行无工作树写入的`git merge-tree --write-tree HEAD upstream/master`。演练真实发现13个Protyle冲突，因此L0当前不能声明完成；冲突解决和完整回归必须形成后续独立merge提交。

本决策只使用仓库源码、Git历史、GitHub仓库元数据和相关Action的官方`action.yml`。没有进行泛化网页搜索。

## Decision

1. 奇点仓库只保留奇点拥有的GitHub Actions。删除思源的`cd.yml`、`dockerimage.yml`、`auto_aur_release_stable.yml`、`lock.yml`和`target-branch.yml`；仓库内校验器以工作流文件名允许列表阻止后续上游merge重新带回。所有奇点job增加精确条件`github.repository == 'SparkElf/singularity'`，权限默认只读，写权限按单个未来发布job显式申请。
2. 根README及中文、日文、土耳其文入口以奇点为当前产品，明确“基于SiYuan”、当前开发状态、企业云端目标、上游仓库与AGPL-3.0义务。根`LICENSE`保持AGPL文本，新增纯文本`NOTICE`记录上游来源和派生关系；安全、贡献、行为准则、PR与Issue入口全部指向`SparkElf/singularity`，没有奇点赞助入口前删除`FUNDING.yml`。
3. GitHub仓库description改为奇点企业知识库，homepage在没有奇点正式站点前留空，不继续指向B3log。远端元数据由`gh repo edit`修改，并以只读`gh repo view`复核；脚本不持有或输出GitHub凭证。
4. 现有根`Dockerfile`使用Node 22、Webpack、思源路径和上游维护者元数据，不能代表奇点云端制品；将其改名为明确的上游参考文件。L0建立独立的企业API与Web镜像：API镜像用Node 24构建并运行Nest产物，Web镜像用Node 24构建Vite静态产物并由无特权静态服务器提供SPA回退。两者由部署入口保持同源，L0不在容器内增加临时反向代理、进程监督器或Kernel Gateway替身。
5. 供应链只采用Trivy，避免同时维护Syft、Grype和另一套许可证分类器。GitHub Action固定为`aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25`，工具版本固定为`v0.72.0`；它生成源码及两个企业镜像的CycloneDX JSON，并分别输出漏洞与许可证JSON。
6. 许可证扫描启用Trivy标准包扫描和扩展文件扫描。`config/license-policy.json`显式把本项目AGPL及兼容许可证归入允许集合，把商业限制、禁止再分发和非商业许可证归入拒绝集合；未知许可证阻断L0，必须审阅后更新唯一策略，不能靠忽略文件静默消失。
7. 漏洞门禁扫描两个企业镜像。存在已有修复版本的High或Critical漏洞时阻断；未修复发现仍进入JSON报告并在后续版本治理，不把“尚无修复”误写为不存在漏洞。
8. `config/upstream-baseline.json`继续拥有当前已集成上游提交、版本、工具链与许可证。校验器增加根`LICENSE`、`NOTICE`、仓库身份、只读upstream push URL和架构文档检查，不能只证明提交是HEAD祖先。
9. 上游同步分两阶段。`report-upstream-impact.mjs`对固定候选提交生成机器JSON与可读Markdown，记录基线、候选、受影响模块和冲突路径；正式同步使用`git merge --no-ff`，禁止rebase。冲突解决后在merge结果上运行Node 24全门禁、Go Kernel测试、企业镜像构建和供应链扫描，再把候选提升为新基线。
10. 当前`c8dcdd0860ef000a14552c619fe19c0dcb5175f5`作为首个真实候选。S1复评修复先形成稳定提交，随后创建独立上游merge提交并解决已报告冲突；只有该merge通过完整回归、基线提升且CI重放成功后，L0才可标记完成。
11. L0 workflow的路径触发覆盖`.github/**`、`README*.md`、`LICENSE`、`NOTICE`、`Dockerfile*`、`config/**`、`scripts/singularity/**`、`docs/**`、`plans/**`、`output/md/**`、`enterprise/**`、`app/**`和`kernel/**`。路径过滤只决定何时运行，真实元数据、法律、工作流允许列表和供应链校验仍由命令执行。

## Data Flow

```text
source commit + upstream baseline
  -> repository governance verification
  -> Node/Go regression + enterprise API/Web image build
  -> source/image CycloneDX SBOM
  -> license policy report + vulnerability report
  -> immutable CI artifacts

upstream baseline + pinned candidate + fork HEAD
  -> impact report
  -> explicit merge commit
  -> conflict resolution
  -> full regression
  -> promoted upstream baseline
```

所有报告只包含提交、路径、依赖标识、许可证结论、漏洞标识和必要诊断，不写凭证、环境秘密、内部提示或隐藏推理。报告生成是低频CI路径，不进入产品运行时，也不复制业务数据。

## Test Matrix

| Stable contract | Minimum layer | Evidence and runner |
| --- | --- | --- |
| 上游写权限工作流不能进入Fork | static | Node校验工作流允许列表、精确仓库guard与最小权限；`singularity-l0`调用 |
| 奇点品牌和上游AGPL归属同时存在 | static | 结构化配置加文件存在/固定法律标识检查；不以网页截图证明 |
| 基线元数据与Git事实一致 | integration | 真实`git remote`、祖先关系、版本、Go、pnpm、LICENSE和NOTICE |
| 企业API/Web镜像可重复构建并可追溯 | build | 真实`docker build`及OCI revision/upstream标签检查 |
| SBOM包含源码与两个镜像包清单 | supply-chain integration | 固定Trivy版本生成三份CycloneDX JSON并上传制品 |
| 禁止与未知许可证均阻断 | static + supply-chain integration | 真实Trivy许可证JSON加唯一策略配置 |
| 可修复High/Critical漏洞阻断 | supply-chain integration | Trivy扫描两个真实镜像，JSON制品与退出码 |
| 上游候选影响和冲突可重放 | Git integration | `merge-tree`生成报告；正式`--no-ff` merge后运行全部门禁 |

上述命令进入仓库唯一L0聚合入口。不会新增顶层断言测试、未注册脚本或只检查源码函数名的伪行为测试；CI脚本直接验证其拥有的Git、配置和制品合同。

## Alternatives

- **只在GitHub设置中禁用上游workflow**：拒绝。上游merge或管理员操作可重新启用，代码评审也看不到安全边界。
- **给全部上游workflow加owner guard并继续保留**：拒绝。独立Fork没有使用这些发布流程的场景，保留会增加权限和同步噪声。
- **现在设计完整企业容器编排**：拒绝。Gateway尚未进入S2，临时Nginx或双Web入口会形成需要删除的兼容路径。
- **继续把根思源Dockerfile当奇点制品**：拒绝。它使用Node 22和旧Webpack入口，也没有企业API/Web运行时。
- **分别采用Syft、Grype和自建许可证扫描器**：拒绝。三套工具、数据库和输出模型没有增加当前证据，固定Trivy即可覆盖三类合同。
- **每次CI直接跟随最新upstream/master并作为required check**：拒绝。外部提交会让已批准分支无本仓改动也突然变红；候选必须先固定、报告、评审和显式提升。
- **把当前有冲突的merge演练记录为成功**：拒绝。13个冲突是有效工程事实，必须解决并通过回归后才能提升基线。
- **以rebase保持线性历史**：拒绝。项目约束和ADR-008均要求保留可审计merge边界。

## Consequences

- 奇点不再误执行思源的Issue维护、发布、Docker Hub或AUR动作，未来发布需要奇点专用ADR和最小权限workflow。
- README变短并聚焦奇点现状；思源完整产品说明通过明确上游链接保留，不复制成两套易漂移文档。
- CI时间和网络用量增加，但SBOM、漏洞、许可证和镜像追溯证据成为L0的真实交付门禁。
- 最新上游候选当前仍有13个冲突。S1修复可以继续，但L0状态保持未完成，直到独立merge提交和自动回归完成。

## References

1. [奇点企业知识库完整方案](../../output/md/Singularity_Enterprise_Knowledge_Base_v1.0.0_2026-07-13.md)
2. [ADR-008：差异化上游同步策略](0008-upstream-sync-strategy.md)
3. [SiYuan upstream repository](https://github.com/siyuan-note/siyuan)
4. [Trivy Action](https://github.com/aquasecurity/trivy-action)
5. [Trivy License Scanning](https://github.com/aquasecurity/trivy/blob/v0.72.0/docs/guide/scanner/license.md)
