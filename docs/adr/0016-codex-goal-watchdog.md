---
title: "ADR-016: Codex Active Goal异常恢复Watchdog"
description: "定义只读识别异常停止Active Goal并以受控Codex resume恢复的一次性检查器"
author: "Codex"
date: "2026-07-18"
version: "1.0.0"
status: "accepted"
tags: ["adr", "operations", "codex", "goal", "watchdog", "recovery"]
---

# ADR-016: Codex Active Goal异常恢复Watchdog

> watchdog不直接修改Codex数据库、session或目标状态，只识别已经明确异常终止且仍有Active Goal的线程，并通过受控的`codex exec resume`恢复一次。

## Change Log

| Version | Date | Author | Changes |
| --- | --- | --- | --- |
| 1.0.0 | 2026-07-18 | Codex | 接受只读检查、显式执行、生命周期门禁、并发锁与指数退避方案 |

## Table of Contents

1. [Status](#status)
2. [Context](#context)
3. [Decision](#decision)
4. [Data Flow](#data-flow)
5. [Safety Invariants](#safety-invariants)
6. [Test Matrix](#test-matrix)
7. [Implementation Tasks](#implementation-tasks)
8. [Alternatives](#alternatives)
9. [Consequences](#consequences)
10. [References](#references)

## Status

Accepted

## Context

Codex线程可能因模型容量、请求限流或进程中断而停止，但关联Goal仍保持`active`。仅凭Goal状态或更新时间不能证明线程已经停止：正常长任务、等待模型响应和仍在执行的工具调用也可能暂时不更新。直接定时调用`resume`会造成同一线程并发执行、重复副作用和rollout竞争。

本机Codex事实源由两个SQLite数据库和线程rollout组成：`$CODEX_HOME/goals_1.sqlite`中的`thread_goals`拥有Goal状态，`$CODEX_HOME/state_5.sqlite`中的`threads`拥有归档状态和`rollout_path`，JSONL rollout拥有turn及工具调用生命周期。当前Node 24提供`node:sqlite`，因此无需增加运行依赖或调用外部`sqlite3`进程。

仓库已有`enterprise/package.json`入口`node --test ../scripts/singularity/*.test.mjs`，会自动发现本决策新增的`node:test`合同。现有Singularity治理脚本采用ES module、Node标准库、参数数组子进程和结构化数据处理，可直接沿用。本决策只使用仓库与本机Codex只读证据，没有进行网页搜索。

## Decision

1. 实现`scripts/singularity/codex-goal-watchdog.mjs`作为一次性检查器，不实现常驻daemon，不创建cron、systemd timer或其他计划任务。调度频率和启用时点由后续独立运维决策拥有。
2. 运行时固定为Node 24，使用`node:sqlite`的只读`DatabaseSync`读取`goals_1.sqlite`和`state_5.sqlite`，不安装第三方依赖，不调用外部SQLite CLI。watchdog自身不执行INSERT、UPDATE、DELETE、DDL、PRAGMA写操作或Codex内部状态迁移；执行前关闭只读连接，恢复后的正常状态写入只由官方Codex进程拥有。
3. 只读取`thread_goals`与`threads`。检查器对两个被消费表的列顺序、名称、类型、null约束、默认值和主键位置执行完整schema合同比较；缺表、缺列、增列、改类型或默认值漂移均阻断整次检查，不能以旧查询或近似字段继续执行。
4. 候选线程必须同时满足：Goal状态精确为`active`；线程记录存在且`archived = 0`；Goal、线程和rollout文件最后活动时间的最大值已超过静默阈值；rollout位于`$CODEX_HOME/sessions`真实路径内；最新turn存在可识别的`task_started`，并以可识别的`turn_aborted`明确结束；该turn不存在未配对的工具调用。
5. 无终止事件的静默turn不自动恢复。它可能仍在模型请求、GUI进程或未知执行器中，生命周期不可证明；即使静默时间超过阈值也以`lifecycle_unrecognized`拒绝。`task_complete`表示正常完成，同样不恢复。JSONL损坏、未知调用类型、重复调用ID、无对应调用的输出或未知终止结构均fail closed。
6. 工具调用只识别当前有明确配对合同的`function_call`/`function_call_output`、`custom_tool_call`/`custom_tool_call_output`和`tool_search_call`/`tool_search_output`。每个调用按当前`call_`加24位标识的`call_id`跟踪；出现未知标识结构、未知`*_call`类型或任一未完成调用时不恢复该线程。
7. 静默时间取Goal `updated_at_ms`、Thread `updated_at_ms`和rollout文件`mtime`的最大值，避免数据库时间落后于rollout追加。候选选择后，在执行前重新读取Goal、Thread和文件元数据；任一状态、时间、路径、文件大小或mtime变化即拒绝，避免扫描与执行之间的迟到更新。
8. 默认模式永远是dry-run。只有显式`--execute`才允许启动恢复命令；其他参数只允许配置正整数`--silent-minutes`。未知参数、重复参数和非法数值直接失败，不能把用户输入拼入命令或继续提示。
9. 执行模式使用watchdog自己的全局原子目录锁；锁已存在时本次退出，不自动删除或猜测“陈旧锁”。恢复失败写入watchdog独立状态目录的版本化全局退避记录，按1分钟起始、指数增长、1小时封顶计算下一次允许时间；成功后删除退避记录。未知或损坏的退避schema阻断执行。dry-run只读取锁和退避状态，不创建目录或写状态。
10. 每次执行最多恢复一个候选，按最后活动时间从新到旧选择，避免一次调度唤醒多个陈旧线程。子进程固定以`shell: false`和参数数组调用`codex`, `exec`, `resume`, `<threadId>`, `<固定继续提示>`；thread ID必须符合UUID合同，提示文本不可由数据库、rollout、CLI参数或环境变量覆盖。
11. 子进程不继承可产生正文的输出流，watchdog只记录成功、退出码类别和退避时间，不记录Codex stderr/stdout。日志采用单行JSON，只有稳定事件名、模式、计数、拒绝原因、时间量和thread ID的SHA-256短引用；禁止输出Goal objective、线程标题、首条消息、rollout路径、工作目录、提示正文、工具参数、工具输出、异常stack或环境秘密。
12. watchdog自己的锁和退避状态默认位于`$XDG_STATE_HOME/singularity/codex-goal-watchdog`，未设置时使用用户目录下`.local/state/singularity/codex-goal-watchdog`。该目录不属于`$CODEX_HOME`；watchdog自身在dry-run、执行前、失败及异常路径上只读Codex事实源，成功恢复后的官方写入属于Codex进程。

## Data Flow

```text
watchdog lock/backoff gate
  -> $CODEX_HOME/goals_1.sqlite (read-only thread_goals)
  + $CODEX_HOME/state_5.sqlite (read-only threads)
  -> exact consumed-table schema gate
  -> active + unarchived thread projection
  -> rollout real-path and silence gate
  -> latest turn lifecycle + tool-pair parser
  -> candidate ordered by latest activity
  -> dry-run summary
     or execute-time revalidation
       -> codex exec resume <threadId> <fixed prompt>
       -> success clears watchdog backoff
          / failure advances watchdog backoff
```

Goal状态由`thread_goals.status`唯一拥有，归档状态和rollout定位由`threads`唯一拥有，turn是否明确异常终止由rollout唯一拥有。检查器只投影判断所需字段，不读取或复制objective、title、preview、message正文和工具payload。锁与退避是watchdog自身的运维状态，不回写Codex事实源。

该低频运维路径逐行读取rollout，只保留最新turn的最小状态：turn ID、终止类型和未完成`call_id`集合。没有全量JSON对象缓存、同形转换层、兼容schema或备用事实源。设计模式只采用Command边界：通过一个固定参数数组表达唯一允许的恢复副作用，并在测试中替换该外部进程边界；额外Factory、Adapter、daemon状态机或插件机制不会降低当前复杂度，因此不采用。

## Safety Invariants

- 不以Goal状态单独推断线程可恢复，也不从objective、错误文案、模型输出或相邻消息猜测容量错误。
- 不恢复归档线程、正常完成turn、无明确终止turn、仍有未完成工具调用的turn或schema未知的线程。
- 不把静默等同于进程死亡；只有显式`turn_aborted`提供终止证据。
- 不使用shell字符串，不接受可变继续提示，不把rollout内容带入子进程参数。
- watchdog文件与SQLite访问不修改Codex数据库、WAL、session、rollout或Goal状态；显式执行后只允许官方Codex进程按`resume`合同拥有正常写入。
- 执行前重新验证候选，任一迟到活动使本次恢复失效。
- 日志只输出结论和必要诊断，不包含正文、凭证、隐藏推理或内部提示。

## Test Matrix

| Stable contract | Risk | Minimum layer | Real / simulated boundary | Standard runner |
| --- | --- | --- | --- | --- |
| dry-run识别候选但不启动进程、不写状态 | 默认执行造成意外副作用 | integration | 真实临时SQLite/JSONL/文件系统，模拟进程边界 | Node 24 `node:test` |
| execute只对完整候选使用固定参数数组恢复一次 | shell注入、重复恢复或提示漂移 | integration | 真实临时事实源，捕获模拟`spawnSync`参数 | Node 24 `node:test` |
| inactive、archived、未达静默、task complete、未知生命周期均拒绝 | 错误唤醒活跃或已完成线程 | integration | 每个case自备真实临时SQLite/JSONL | Node 24 `node:test` |
| 未配对或未知工具调用拒绝恢复 | 与仍在执行的工具产生重复副作用 | integration | 真实JSONL生命周期，模拟进程边界 | Node 24 `node:test` |
| consumed-table schema漂移阻断整次执行 | Codex升级后按旧字段误判 | integration | 真实SQLite schema变体 | Node 24 `node:test` |
| 并发锁和有效退避均拒绝启动 | 调度重叠或容量错误形成请求风暴 | integration | 真实原子锁/状态文件，模拟时钟和进程 | Node 24 `node:test` |
| 失败按1m、2m指数退避且成功清除 | 高频失败重试或永久旧状态 | integration | 真实watchdog状态目录，模拟时钟和退出码 | Node 24 `node:test` |
| watchdog不直接修改数据库/rollout且日志无正文泄露 | 状态污染或敏感信息外泄 | integration | 模拟恢复进程时执行前后字节比较与结构化日志断言 | Node 24 `node:test` |

测试文件直接进入现有`scripts/singularity/*.test.mjs`聚合，不新增helper、fixture目录、逐文件子进程或顶层断言。每个case同步注册并独立创建、关闭和清理临时数据库；测试只模拟时钟与恢复进程两个外部副作用边界。完整批量命令为`cd enterprise && pnpm test:l0-governance`，本次按用户要求只编写合同并完成静态复评，不运行测试命令。

## Implementation Tasks

- [x] 建立精确SQLite schema合同和只读投影。
- [x] 实现rollout路径、静默、最新turn和工具配对门禁。
- [x] 实现dry-run、执行前重验证、固定Command调用和精简日志。
- [x] 实现独立全局锁、版本化指数退避及失败关闭。
- [x] 编写进入现有聚合入口的独立`node:test`合同。
- [x] 完成静态复评并记录未运行测试的残余风险。

静态复评已检查模块边界、单向数据流、只读Codex访问、参数数组执行、日志字段、测试价值、case独立性和现有聚合入口。按用户要求没有运行Node测试、真实dry-run或`--execute`；因此Node 24实际加载、临时SQLite合同、真实本机schema扫描和Codex CLI退出码语义仍是未验证风险，启用调度前必须集中验证。

## Alternatives

- **只增加模型请求重试次数**：不采用。它能缓解单次HTTP失败，但不能恢复已经结束、Goal仍active的线程，也不能处理进程中断。
- **从错误消息搜索429或capacity文本**：拒绝。正文格式不稳定且可能包含用户内容；它会形成敏感数据读取和脆弱的字符串推断。
- **静默超过阈值且无工具调用就恢复**：拒绝。无法区分仍在等待模型响应的进程，会产生同线程并发执行。
- **直接把active Goal改为paused再resume**：拒绝。Goal状态属于Codex，外部写入会破坏产品生命周期并依赖私有schema。
- **在Codex数据库中保存watchdog锁和退避**：拒绝。外部工具不能向Codex事实源增加私有状态或触发WAL写入。
- **一次并行恢复全部候选**：拒绝。会放大容量故障并同时唤醒长期遗留目标；一次一个候选更容易审计和退避。
- **自动清理陈旧锁**：拒绝。仅凭PID或mtime不能跨容器、WSL重启和PID复用证明锁无主，人工确认后删除更安全。
- **现在直接创建cron/systemd timer**：拒绝。先交付默认dry-run的一次性检查器；启用调度需要单独确定频率、日志保留和运维所有者。

## Consequences

- 明确终止的Active Goal可以由外部调度低频恢复，模型容量或限流继续失败时不会形成紧密重试循环。
- fail-closed策略会漏掉没有写出`turn_aborted`的进程崩溃；这是避免并发恢复的有意取舍，后续只有在Codex提供权威运行租约时才能扩大范围。
- Codex升级只要改变被消费表或工具生命周期合同，watchdog就会停止执行并要求复审，而不是静默沿用旧推断。
- 脚本拥有少量独立运维状态；异常退出遗留锁需要人工确认和清理，不会自动猜测。
- 本决策不启用任何调度，也不承诺所有429或capacity错误都可恢复；它只为可证明终止的线程提供受控入口。

## References

1. [奇点企业知识库完整方案](../../output/md/Singularity_Enterprise_Knowledge_Base_v1.0.0_2026-07-13.md)
2. [L0治理聚合入口](../../enterprise/package.json)
3. [Singularity治理脚本](../../scripts/singularity/)
