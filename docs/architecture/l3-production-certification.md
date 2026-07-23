---
title: "L3 生产发布认证架构方案"
description: "以单一标准 aggregate 串联真实部署、协作 WSS、固定数据库、Kernel 恢复、容量与回滚证据"
author: "Codex"
date: "2026-07-23"
version: "1.0.0"
status: "accepted"
tags: ["architecture", "l3", "release-certification", "realtime-collaboration"]
---

# L3 生产发布认证架构方案

## Decision

新增“发布认证”大阶段，但不新增生产运行时事实源；认证由既有真实 Nest/API、专用协作 WSS、受控 Go Kernel、固定 PostgreSQL、浏览器和部署 supervisor 组成。标准入口为一个 aggregate，内部调用已锁定 runner 的 contract、API/WS integration、Go Kernel、Playwright e2e、capacity/performance、recovery/rollback 与静态边界 case；每个 runner 仍按原生 case/hook/reporter 工作。

认证报告只记录可复核结论、结构化 case 结果、版本/配置摘要、资源指标、日志关联和残余风险，不把正文、密钥、token 或完整 operation payload 写入产物。认证完成后，L3 技术验证与生产发布认证分别记录，功能开关默认状态由发布判定表决定。

## Certification Result

2026-07-23，`pnpm verify:l3-release-certification` 的 5 个 runner 全部退出码为 0。API/WSS integration 通过 20 用户与 64 活动会话上限，浏览器 case 通过撤权和开关关闭收敛；此前 API-only 回滚证据已通过。认证结论仅适用于单 API 副本、单空间 Kernel；多副本和目标生产 supervisor 回滚仍需扩展认证。

## Multi-process Supervisor Drill

为闭合 L3-REL-10 的本地可复现证据，新增 `l3-supervisor-rollback-drill.mjs` 作为运维演练驱动；它复用 `apps/web/tests/e2e/support/start-stack.mjs` 的真实三进程启动/清理边界，不复制 API、Worker 或 Go Kernel 的 wiring。驱动先在固定测试库独立 schema、同一端口组启动候选版本，再核对 Kernel readiness、API database readiness、OpenAPI、Worker sample job 和三进程 PID/PPID/命令归属；随后停止候选 supervisor，确认端口与所有子进程均退出，再用同一端口组启动 `HEAD^` 已批准版本并重复健康/归属核对。

该演练证明“本地 supervisor 可按制品切换并完整清理”，不等价于目标生产 supervisor 的发布认证；真实部署仍须按 runbook 在目标系统执行并保存运维记录。候选/批准报告只记录版本、端口、PID 归属、健康状态、耗时和清理结果，不记录正文、密钥、token 或完整 operation payload。

## Local Precedents

| 先例 | 位置 | 采用 | 不采用 |
| --- | --- | --- | --- |
| L3 技术 aggregate | `enterprise/package.json` | 保留 contracts → Go Kernel → API → Web → static 的既有顺序 | 不把它改名或伪装成发布认证 |
| 真实 E2E supervisor | `enterprise/apps/web/tests/e2e/global-setup.ts`、`support/start-stack.mjs` | 复用固定 PostgreSQL schema、真实 Nest、Go Kernel、Web、端口检查、进程组清理和状态文件 | 不新建逐文件子进程 runner |
| 真实 WSS 测试 | `enterprise/apps/api/test/access-change.http.test.ts`、`test/support/kernel-gateway.ts` | 复用 `ws`、真实升级、撤权、关闭和堆栈诊断边界 | 不用完整内部 mock 链证明生产行为 |
| L3 feature/control | `enterprise/apps/api/src/collaboration/**`、Prisma migration | 消费现有 feature gate、session metadata、ACL 和审计 owner | 不增加第二开关或正文表 |
| Kernel recovery | `kernel/collab/production.go`、已有 Go tests | 复用 prepared/committed/fail-closed 语义和 canonical history | 不另建恢复日志或快照事实源 |
| 观测投影 | `enterprise/apps/api/src/collaboration/collaboration-control.service.ts`、observability contracts | 复用 session/operation/resume/revoke 记录和脱敏 logger | 不在测试侧拼造指标结论 |

本地先例已覆盖认证所需技术骨架，证据足够，当前不需外部联网调研。

## Scope

### Included

- 预发布真实启动、固定数据库/Kernel/配置核对和开关状态核对。
- 2 用户真实协作冒烟：join、submit、确认、presence、冲突、离开和资源清理。
- 10/20 用户固定数据集容量；接近每文档 64 活动会话上限时的限流/关闭与资源指标。
- ACL 撤权、API 重启、Kernel 重启、canonical history 缺口恢复、prepared/unknown fail-closed。
- `restricted-encrypted` 密钥/客户端版本/匿名准入拒绝及敏感数据存储/日志审计。
- 开关关闭时新旧会话收敛、发布回滚、结构化日志/审计和完整 teardown。

### Excluded

- 多 API 副本、跨空间 Kernel 广播、Redis/NATS、跨区域和灾备容量。
- 移动端生产体验、离线无限编辑、零知识端到端协作。
- Docmost L4 新功能实现；其方案在 L3 认证后另立 architecture/ADR。

## Source-to-Consumer Flow

```text
认证命令/发布 runbook
  -> 已注册标准 runner
  -> 真实 HTTP/CSRF + 专用 WSS + 浏览器动作
  -> Nest schema/Guard/ACL/feature gate
  -> CollaborationCoordinator + KernelCollaborationPort
  -> Go Kernel content/history/recovery
  -> PostgreSQL control metadata/audit projection
  -> client-visible result + structured report + resource teardown
```

测试驱动只提供外部用户/运维输入和固定数据集；协议解析、身份绑定、ACL、加密 admission、语义 reducer、历史与资源释放仍由生产 owner 负责。测试不从 DOM、首个响应或旧状态推断四段身份，也不手工注入上游 schema 已排除的非法值。

## Module Boundaries and File Ownership

| 模块 | 目标 | 主要范围 | 前置/交接 |
| --- | --- | --- | --- |
| Certification aggregate | 唯一正式入口、命令顺序、报告与失败收口 | `enterprise/package.json`、`enterprise/scripts/l3-release-certification.mjs` 或等价已注册入口、reporter | 所有模块完成后统一接线；不实现业务 |
| Real API/WS certification | 真实 join/submit/resume/revoke/toggle/restart contract | `enterprise/apps/api/test/**`，复用现有 support | 依赖固定 DB、真实 Nest、受控 Kernel；输出结构化 case |
| Multi-process supervisor drill | 候选/批准制品的 API、Worker、Kernel 同端口切换、readiness、归属和清理 | `enterprise/scripts/l3-supervisor-rollback-drill.mjs`，复用 `enterprise/apps/web/tests/e2e/support/start-stack.mjs` | 依赖固定 DB、Go Kernel 构建和 Node 24；输出本地演练证据，不宣称目标生产认证 |
| Kernel recovery certification | history 缺口、prepared/unknown、重复/乱序与加密拒绝 | `kernel/collab/**` Go tests/fixtures | 只消费 Kernel 公共 port；不解析 HTTP/ACL |
| Browser release path | 两用户可见状态、撤权、重连、只读、诊断和 teardown | `enterprise/apps/web/tests/e2e/**`、既有 Playwright config/support | 依赖真实 API/WS；不称 route-mocked 为真实 E2E |
| Capacity/operations | 10/20 用户、64 会话、资源释放、回滚与报告 | 同一 aggregate 里的标准 performance/integration cases 与 runbook | 共享固定数据集和 metrics owner；不复制业务断言 |
| Documentation/evidence | 认证计划、发布判定、最终报告、残余风险 | `plans/2026-07-23-l3-production-certification.md`、`docs/verification/**`、runbook | 由 integration owner 统一更新 |

共享合同、固定数据库、supervisor 和报告格式由 Certification aggregate owner 统一修改；同一阶段不并行抢写共享文件。

## Declarative and Design-Pattern Decisions

- Nest 生产模块继续使用 `@Module`、DI、Guard、Pipe、Interceptor、Discovery metadata；认证不新增中央 switch 或手工 handler registry。
- 测试用例由 Vitest/Playwright/Go 标准 runner 原生声明；aggregate 只编排命令，不扫描源码、不包装顶层断言、不逐文件 fork 子进程。
- 采用 Strategy 仅用于按 runner 类型收集统一结构化证据；每个 strategy 只负责启动/等待/报告/清理，不改变业务判断。若现有 reporter 可直接满足，删除该抽象。
- 采用现有 supervisor 的生命周期管理；不新增 Adapter 透传层。只有真实协议差异（HTTP、WSS、浏览器、Go）才保留各自测试入口。
- 采用现有事件/观察者订阅处理 feature change 和 ACL revoke；认证不另建广播总线。
- 更简单方案是人工 checklist + 单一 API 测试；其不能证明真实浏览器、Kernel 重启、容量和资源清理，故保留多层标准 runner，但用一个 aggregate 收口。

## Boundary Ownership

| 边界 | 首次 owner | 输入/输出 | 下游不重复处理 |
| --- | --- | --- | --- |
| 外部浏览器/测试客户端 → API/WSS | Nest schema/parser、auth、Origin/CSRF | JSON/WSS frame → typed contract | service 不重新解析原始字节 |
| 会话 → ACL | `DocumentAccessPolicyService` | actor + 四段身份 → capability/generation | coordinator 不复制角色算法 |
| 协作 → Kernel | `KernelCollaborationPort` | typed operation → canonical result/history | Kernel 不解析 HTTP/WS、不重新授权 |
| Kernel → history/recovery | Go Kernel production owner | accepted operation → append/replay/fail-closed | PostgreSQL 不保存正文/payload |
| feature/revoke → connection | `CollaborationControlService` + gateway subscription | persisted change → close/read-only | client 不本地提升或猜测状态 |
| runner → report | aggregate reporter | observable evidence → redacted result | report 不读取正文或密钥 |

## Diagnostic and Rollback Contracts

- 每个认证 case 记录稳定 case id、版本摘要、组织/空间/笔记本/文档哈希、request/session/kernel instance 关联、耗时、连接数、结果码和资源计数；不记录正文、密钥、token 或完整 payload。
- catch、重抛、WS error、Promise rejection 和 supervisor shutdown 保留原始 `name/message/stack`；报告只保留脱敏后的结构化错误。
- 回滚使用既有部署 supervisor/restore 语义和版本化配置，先冻结新 join/submit，再停止/恢复受控进程，最后用 canonical history 与健康合同确认；不对数据库做未经方案批准的破坏性降级。
- 发布判定为全量必选 case 通过、无高风险未决项、资源清理通过、回滚演练可重复；否则保持开关关闭并记录阻断项。

## Test Matrix and Governance

| 合同 | 层级 | 真实边界 | 已有证据处置 | 认证新增 |
| --- | --- | --- | --- | --- |
| schema、身份、错误码、metadata | contract/static | 真实序列化、Nest bootstrap、AST 边界 | 保留现有 L3 contracts/static | 仅补发布配置/命令合同 |
| reducer/history/recovery/encryption | Go unit/integration | 真实 Kernel 夹具与内容事务 | 保留现有 `kernel/collab` tests | 补重启/故障阶段证据 |
| join/submit/resume/revoke/toggle | API/WS integration | 真实 Nest、固定 PostgreSQL、`ws` | 扩展现有 collaboration/access-change tests | 补容量、撤权迟到、开关收敛 |
| 两用户可见协作链 | Playwright e2e | 真实 API/Kernel/Web/WSS | 复用 P5 supervisor 与诊断 | 新增认证专用用户路径，不复制 L2 评论路径 |
| 10/20/64 会话与资源 | performance/integration | 固定数据集、真实连接和指标 | 先盘点现有 observability | 补统一容量报告与 teardown |
| 回滚、日志、敏感边界 | integration/static/ops | 受控进程、真实 logger/audit、产物检查 | 复用现有审计和 supervisor | 补发布 runbook 与证据报告 |
| 多进程制品切换 | integration/ops | 真实三进程 supervisor、固定 schema、端口/PID/健康检查 | 复用 P5 stack supervisor；不新增进程启动器 | `l3-supervisor-rollback-drill.mjs` 由 L3 aggregate 调用 |

阶段内可做一次最小诊断；全部生产代码/fixture/文档完成并通过 code-review/test-governance 后，只执行一次正式 aggregate。每个永久 case 必须由标准 runner 发现、可按名称过滤、独立 setup/cleanup，并指向单一业务合同。

## Completion Definition

- Certification aggregate 已注册且只编排标准 runner；无孤儿脚本、逐文件子进程、完整内部 mock 链或第二数据库。
- Acceptance matrix L3-REL-01..12 全部有结构化通过证据；失败根因与残余风险已记录。
- API/Kernel/Web/DB/固定服务/浏览器进程与连接按 runner hook 清理；用户要求保留的固定 PostgreSQL 不停止。
- `docs/verification/l3.1-realtime-collaboration.md` 新增“技术验证/生产认证”分栏与发布判定，不误称默认开放。
- 认证完成后才能进入 L4 architecture；若认证阻塞，只推进认证主线，不实现 L4。

## References

1. [L3.1 产品需求](../product/l3.1-realtime-collaboration.md)
2. [L3.1 架构方案](./l3.1-realtime-collaboration.md)
3. [L3.1 生产协作 ADR](../adr/0031-l3-production-collaboration.md)
4. [L3 生产认证计划](../../plans/2026-07-23-l3-production-certification.md)
5. [L3.1 技术验证报告](../verification/l3.1-realtime-collaboration.md)
