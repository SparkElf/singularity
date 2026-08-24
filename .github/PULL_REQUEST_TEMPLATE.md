<!-- Do not include credentials, private workspace content, hidden prompts, production data, or internal reasoning transcripts. -->
<!-- 不要提交凭据、私有工作区内容、隐藏提示词、生产数据或内部推理记录。 -->

## At a glance

<!-- Who is affected, what problem is solved, and what observable result changes? / 谁受到影响、解决什么问题、用户可观察结果是什么？ -->

## Product design

- Primary user and task / 主要用户与任务:
- Availability claim (available / in development / deferred) / 可用性声明:
- Success path, failure feedback, recovery / 成功路径、失败反馈与恢复:

## Architecture

- Owning modules and state owners / 所属模块与状态所有者:
- Persistence, permissions, credentials, external effects / 持久化、权限、凭据与外部副作用:
- SiYuan-derived vs Singularity-owned paths / 思源派生路径与 Singularity 自有路径:
- Deliberately unchanged adjacent modules / 明确不变的相邻模块:

## Frontend design

<!-- Write `none` only when there is no visible UI change. / 仅在没有可见 UI 变化时填写 `none`。 -->

- Reference surface/pattern / 参考界面或交互模式:
- Reused primitives and semantic tokens / 复用的组件与语义 token:
- Light/dark, keyboard/focus, loading/error/overflow considerations / 明暗主题、键盘焦点、加载错误与溢出:

## Implementation

- Changed behavior / 已改变行为:
- Deliberate exclusions / 明确排除内容:

## Code review

- Findings and resolutions / 发现与修复:
- Residual concerns / 剩余关注点:
- Human reviewer / 人工审阅者:

## Test governance

- User/operator risks being proven / 要证明的用户或运维风险:
- Selected evidence and why / 选择的验证证据及原因:

## Verification

- Exact commands and outcomes / 实际命令与结果:
- UI/browser evidence when applicable / 适用时的 UI/浏览器证据:
- Unverified environment or residual risk / 未验证环境或剩余风险:

## Upstream impact

- Current SiYuan baseline / 当前思源基线:
- Upstream-derived files changed / 修改的上游派生文件:
- Candidate/upstream overlap or retirement decision / 候选上游重叠或退役决策:

## Diff records

- Upstream record: none | `diffs/upstream/registry.yaml#<id>`
- Product record: none | `diffs/product/registry.yaml#<id>`
- Baseline change: none | `upstream/baseline.yaml`

## Migration and security

- Data/schema migration and rollback / 数据或模式迁移与回滚:
- Permission/credential/privacy impact / 权限、凭据与隐私影响:

## Related issue

- Fixes #NN | Related to #NN | none

## Checklist

- [ ] This pull request has one coherent user/product purpose. / 本 PR 只有一个连贯的用户或产品目标。
- [ ] Product, architecture, implementation, review, test, and verification evidence match the current commit. / 产品、架构、实现、审阅、测试与验证证据与当前提交一致。
- [ ] Visible UI changes follow `docs/ui-governance.md` and `singularity-frontend-design`. / 可见 UI 变化遵循 UI 治理与前端设计 Skill。
- [ ] Upstream/product divergence metadata is updated when required. / 需要时已更新上游或产品差异元数据。
- [ ] No secret, private content, production data, or hidden prompt is included. / 不包含密钥、私有内容、生产数据或隐藏提示词。
- [ ] Documentation and availability/release claims match what is actually implemented and verified. / 文档与可用性或发布声明与真实实现和验证一致。
- [ ] I have the right to submit this work and agree to distribute it under AGPL-3.0. / 我有权提交这些内容，并同意按照 AGPL-3.0 发布。
