---
title: "ADR-014: Fork治理、供应链与上游同步门禁"
description: "定义奇点独立仓库的工作流隔离、品牌法律入口、制品扫描与可重复上游merge流程"
author: "Codex"
date: "2026-07-15"
version: "1.3.0"
status: "accepted"
tags: ["adr", "l0", "fork", "supply-chain", "upstream", "github-actions"]
---

# ADR-014: Fork治理、供应链与上游同步门禁

> 将奇点从可构建的思源派生树收敛为可独立维护、可追溯且不会误执行上游运维动作的正式仓库。

## Change Log

| Version | Date | Author | Changes |
| --- | --- | --- | --- |
| 1.0.0 | 2026-07-15 | Codex | 接受独立Fork治理、品牌法律、SBOM、漏洞、许可证与上游同步门禁 |
| 1.1.0 | 2026-07-15 | Codex | 增补缺失许可证正文的Go历史源码发布证明合同 |
| 1.2.0 | 2026-07-15 | Codex | 固定离线来源证据、生产运行图闭包、非空漏洞报告与22路径上游冲突事实 |
| 1.2.1 | 2026-07-15 | Codex | 限定exp-html完整来源证据替换Trivy源码头BSD-2-Clause误判 |
| 1.3.0 | 2026-07-17 | Codex | 记录首个候选完成显式merge并晋升为SiYuan 3.7.2上游基线 |
| 1.4.0 | 2026-07-18 | Codex | 纳入Node 24 Worker镜像、运行图闭包及三镜像供应链门禁 |

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

首次同步前，本地将`upstream/master`更新到`c8dcdd0860ef000a14552c619fe19c0dcb5175f5`并执行无工作树写入的`git merge-tree --write-tree HEAD upstream/master`。演练真实发现22个冲突路径，其中10个属于Fork治理、品牌和工作流路径，12个属于Editor/Protyle路径；该报告当时只证明冲突范围，不构成成功merge。

候选随后通过双父提交`ebe5e941b6dbdc9c139d76883b2746f9db7fa7fa`显式合入，22个冲突均在该merge中解决。该提交已进入`master`与`origin/master`，候选已晋升为SiYuan 3.7.2当前基线；Git历史、机器基线、NOTICE和多语言README共同记录这次晋升。

本决策只使用仓库源码、Git历史、GitHub仓库元数据和相关Action的官方`action.yml`。没有进行泛化网页搜索。

真实源码扫描进一步发现`github.com/levigross/exp-html@v0.0.0-20120902181939-8df60c69a8f5`模块归档缺少其源码头引用的`LICENSE`。不能把仅含许可证引用的`doc.go`当作许可证正文，也不能以包名例外绕过SBOM证据。该模块`README`声明复制自Go`weekly.2012-03-27`，其10个生产源码文件与Go官方提交`3895b5051df256b442d0b0af50debfffd8d75164`的`src/pkg/exp/html`逐文件一致，因此可用固定来源发布和官方历史许可证形成可重复的补充证据。

## Decision

1. 奇点仓库只保留奇点拥有的GitHub Actions。删除思源的`cd.yml`、`dockerimage.yml`、`auto_aur_release_stable.yml`、`lock.yml`和`target-branch.yml`；仓库内校验器以工作流文件名允许列表阻止后续上游merge重新带回。所有奇点job增加精确条件`github.repository == 'SparkElf/singularity'`，权限默认只读，写权限按单个未来发布job显式申请。
2. 根README及中文、日文、土耳其文入口以奇点为当前产品，明确“基于SiYuan”、当前开发状态、企业云端目标、上游仓库与AGPL-3.0义务。根`LICENSE`保持AGPL文本，新增纯文本`NOTICE`记录上游来源和派生关系；安全、贡献、行为准则、PR与Issue入口全部指向`SparkElf/singularity`，没有奇点赞助入口前删除`FUNDING.yml`。
3. GitHub仓库description改为奇点企业知识库，homepage在没有奇点正式站点前留空，不继续指向B3log。远端元数据由`gh repo edit`修改，并以只读`gh repo view`复核；脚本不持有或输出GitHub凭证。
4. 现有根`Dockerfile`使用Node 22、Webpack、思源路径和上游维护者元数据，不能代表奇点云端制品；将其改名为明确的上游参考文件。企业制品由三个镜像组成：API镜像用Node 24构建并运行Nest产物，Worker镜像用Node 24运行Nest后台任务并携带固定Go Kernel/`restore-archive`工具与appearance资源，Web镜像用Node 24构建Vite静态产物并由无特权静态服务器提供SPA回退。三者由部署入口保持同源，L0不在容器内增加临时反向代理或Kernel Gateway替身。
5. 供应链只采用Trivy，避免同时维护Syft、Grype和另一套许可证分类器。GitHub Action固定为`aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25`，工具版本固定为`v0.72.0`；它生成源码及三个企业镜像的原始CycloneDX JSON，并分别输出漏洞与许可证JSON。补充许可证证据只写入独立canonical SBOM，原始Trivy SBOM继续作为不可覆盖的扫描证据。
6. 许可证扫描启用Trivy标准包扫描、扩展文件扫描和开发依赖扫描。`config/license-policy.json`显式把本项目AGPL及兼容许可证归入允许集合，把商业限制、禁止再分发和非商业许可证归入拒绝集合；未知许可证阻断L0，必须审阅后更新唯一策略，不能靠忽略文件静默消失。只有完整离线来源链验证通过的固定`exp-html`组件可以在canonical SBOM中把Trivy依据源码头推断的唯一`BSD-2-Clause`替换为历史许可证正文证明的`BSD-3-Clause`，并记录原scanner值；任何其他既有许可证冲突继续阻断，原始SBOM保持不变。API和Worker原始SBOM必须分别与只读、断网运行镜像中从各自根`package.json`递归解析的`dependencies`和已安装`optionalDependencies`唯一PURL集合双向一致；Web运行镜像不得包含npm组件。
7. 漏洞门禁扫描企业源码及三个企业镜像，四份报告都必须包含至少一个具有非空`Target`和`Type`的真实扫描结果。存在已有修复版本的High或Critical漏洞时阻断；未修复发现仍进入JSON报告并在后续版本治理，不把空报告、“尚无修复”或未识别目标误写为不存在漏洞。
8. `config/upstream-baseline.json`继续拥有当前已集成上游提交、版本、工具链与许可证。校验器增加根`LICENSE`、`NOTICE`、仓库身份、只读upstream push URL和架构文档检查，不能只证明提交是HEAD祖先。
9. 上游同步分两阶段。`report-upstream-impact.mjs`对固定候选提交生成机器JSON与可读Markdown，记录基线、候选、受影响模块和冲突路径；正式同步使用`git merge --no-ff`，禁止rebase。冲突解决后在merge结果上运行Node 24全门禁、Go Kernel测试、企业镜像构建和供应链扫描，再把候选提升为新基线。
10. `c8dcdd0860ef000a14552c619fe19c0dcb5175f5`是首个真实候选，已由独立merge提交`ebe5e941b6dbdc9c139d76883b2746f9db7fa7fa`合入并晋升为SiYuan 3.7.2基线。在固定下一候选前，机器配置中的基线与候选指向同一上游提交；后续同步继续重复“固定候选、影响报告、显式merge、完整回归、基线晋升”的合同。
11. L0 workflow的路径触发覆盖`.github/**`、`README*.md`、`LICENSE`、`NOTICE`、`Dockerfile*`、`config/**`、`scripts/singularity/**`、`docs/**`、`plans/**`、`output/md/**`、`enterprise/**`、`app/**`和`kernel/**`。路径过滤只决定何时运行，真实元数据、法律、工作流允许列表和供应链校验仍由命令执行。
12. Go模块归档存在真实许可证正文时，只接受精确模块坐标、归档内许可证路径与SHA-256组成的`go-module-file`证据。仅当归档缺失正文且来源链可逐文件确认时，才接受`go-source-release`：策略必须锁定模块坐标、归档内来源声明文件及哈希、官方源提交和标签、官方源目录、仓库内保留的历史许可证正文及哈希；校验器必须离线重验这些字段后才能写入SBOM。该特例当前只允许`exp-html`，不形成按名称或模糊许可证放行。运行时代码、Go依赖图和构建路径保持不变。

## Data Flow

```text
source commit + upstream baseline
  -> repository governance verification
  -> Node/Go regression + enterprise API/Worker/Web image build
  -> source/image CycloneDX SBOM
  -> exact archive license or locked source-release attestation
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
| 企业API/Worker/Web镜像可重复构建并可追溯 | build | 真实`docker build`及OCI revision/upstream标签检查 |
| SBOM包含源码与三个镜像包清单 | supply-chain integration | 固定Trivy版本生成四份原始CycloneDX JSON；补证写独立canonical SBOM并共同上传 |
| API与Worker镜像只包含各自根运行图可达npm包，Web镜像不包含npm包 | supply-chain integration | 在只读断网API/Worker镜像内递归解析运行图，与各自原始SBOM按name、version和PURL双向比较 |
| 禁止与未知许可证均阻断 | static + supply-chain integration | 真实Trivy许可证JSON加唯一策略配置 |
| 缺正文Go模块不能凭源码头放行 | static + supply-chain integration | `node:test`覆盖来源发布坐标/哈希漂移，真实Trivy源码SBOM须由锁定历史许可证补齐且未知为零 |
| 可修复High/Critical漏洞阻断且空报告不能假绿 | supply-chain integration | Trivy扫描企业源码与三个真实镜像，要求非空Target/Type，再由统一策略处理四份JSON |
| 上游候选影响和冲突可重放 | Git integration | `merge-tree`生成报告；正式`--no-ff` merge后运行全部门禁 |

上述命令进入仓库唯一L0聚合入口。不会新增顶层断言测试、未注册脚本或只检查源码函数名的伪行为测试；CI脚本直接验证其拥有的Git、配置和制品合同。

## Alternatives

- **只在GitHub设置中禁用上游workflow**：拒绝。上游merge或管理员操作可重新启用，代码评审也看不到安全边界。
- **给全部上游workflow加owner guard并继续保留**：拒绝。独立Fork没有使用这些发布流程的场景，保留会增加权限和同步噪声。
- **现在设计完整企业容器编排**：拒绝。Gateway尚未进入S2，临时Nginx或双Web入口会形成需要删除的兼容路径。
- **继续把根思源Dockerfile当奇点制品**：拒绝。它使用Node 22和旧Webpack入口，也没有企业API/Worker/Web运行时。
- **分别采用Syft、Grype和自建许可证扫描器**：拒绝。三套工具、数据库和输出模型没有增加当前证据，固定Trivy即可覆盖三类合同。
- **把`doc.go`源码头直接当作许可证正文**：拒绝。该文件只引用缺失的`LICENSE`，不能独立表达完整再分发条件。
- **按包名给`exp-html`增加许可证例外**：拒绝。例外不能证明许可证，也会让同名或漂移版本绕过SBOM完整性。
- **仓内复制或Fork整个`exp-html`模块**：拒绝。运行时代码与官方历史发布完全一致，复制224KB代码只增加补丁所有权；保留精确历史许可证并锁定来源链即可闭合相同法律证据。
- **每次CI直接跟随最新upstream/master并作为required check**：拒绝。外部提交会让已批准分支无本仓改动也突然变红；候选必须先固定、报告、评审和显式提升。
- **把当前有冲突的merge演练记录为成功**：拒绝。22个冲突路径是有效工程事实，必须解决并通过回归后才能提升基线。
- **以rebase保持线性历史**：拒绝。项目约束和ADR-008均要求保留可审计merge边界。

## Consequences

- 奇点不再误执行思源的Issue维护、发布、Docker Hub或AUR动作，未来发布需要奇点专用ADR和最小权限workflow。
- README变短并聚焦奇点现状；思源完整产品说明通过明确上游链接保留，不复制成两套易漂移文档。
- CI时间和网络用量增加，但SBOM、漏洞、许可证和镜像追溯证据成为L0的真实交付门禁。
- 仓库新增一个历史第三方许可证正文；CI只做低频离线哈希和模块坐标验证，不增加产品运行时校验、网络请求或依赖Fork。
- 首个上游候选报告的22个冲突路径已在独立merge提交中解决并完成基线晋升；后续候选仍须重新生成影响报告并通过相同门禁，不能沿用本次结论。

## References

1. [奇点企业知识库完整方案](../../output/md/Singularity_Enterprise_Knowledge_Base_v1.0.0_2026-07-13.md)
2. [ADR-008：差异化上游同步策略](0008-upstream-sync-strategy.md)
3. [SiYuan upstream repository](https://github.com/siyuan-note/siyuan)
4. [Trivy Action](https://github.com/aquasecurity/trivy-action)
5. [Trivy License Scanning](https://github.com/aquasecurity/trivy/blob/v0.72.0/docs/guide/scanner/license.md)
