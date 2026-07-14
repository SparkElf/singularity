---
title: "ADR-012: 企业Node工具链与集成测试时限基线"
description: "统一企业工作区与L0 CI的Node版本，并保证数据库迁移watchdog先于Vitest case超时收敛"
author: "Codex"
date: "2026-07-14"
version: "1.1.0"
status: "accepted"
tags: ["adr", "node", "pnpm", "vitest", "ci"]
---

# ADR-012: 企业Node工具链与集成测试时限基线

## Change Log

| Version | Date | Author | Changes |
| --- | --- | --- | --- |
| 1.0.0 | 2026-07-14 | Codex | 统一Node 24工具链并对齐数据库集成测试时限 |
| 1.1.0 | 2026-07-15 | Codex | 对齐S1落地后的browser integration门禁并删除失效shell配置引用 |

## Status

Accepted

## Context

企业工作区已锁定React Router 8.2.0，其运行时要求Node不低于22.22.0；L0 CI仍固定使用22.21.1，无法作为后续Web纳入`verify:s0-s3`后的受支持环境。仓库正式CD已经使用Node 24，企业工作区与L0 CI继续保留不同基线只会增加本地、CI和发布三套解释。

数据库集成测试通过Vitest运行真实PostgreSQL迁移回放。迁移helper允许20秒后触发`SIGTERM -> SIGKILL -> close`的有限watchdog，但database Vitest case当前只允许15秒，慢速CI可能先终止case，使失败清理和结构化报告无法完整收敛。

## Decision

1. 企业工作区的运行时基线固定为Node 24；`engines.node`使用`>=24.0.0 <25.0.0`，`pnpm-workspace.yaml`通过`engineStrict: true`拒绝范围外运行时。根工具链和Node目标importer直接锁定`@types/node` 24.13.3，workspace `overrides`将Vite与Vitest optional peer固定到同一版本。浏览器安全基础tsconfig固定`types: []`，Node tsconfig显式使用`types: ["node"]`。Web生产`tsconfig.json`只包含非测试`src`并使用`types: ["vite/client"]`，`tsconfig.test.json`拥有Vitest测试和setup，`tsconfig.tooling.json`拥有Vite/Playwright配置及浏览器测试；Web `build`只检查生产配置，`typecheck`聚合三套配置。Protyle生产`tsconfig.json`排除同目录测试，`tsconfig.test.json`拥有Vitest tests。ESLint对浏览器TypeScript显式列出Web三套与Protyle两套project，不使用`allowDefaultProject`或把测试重新并入生产配置。L0的enterprise Web和space-session job均使用Node 24。
2. pnpm以企业工作区`packageManager`锁定11.9.0，CI setup保持同值；Playwright browser integration的Vite `webServer`直接调用工作区`pnpm build && pnpm preview`并消费该工作区事实源，不再硬编码第三份版本。
3. database integration默认`testTimeout`和`hookTimeout`分别保持15秒、30秒；仅完整迁移回放case使用60秒上限，以覆盖20秒迁移watchdog、1秒强制终止宽限以及有界的schema创建、Prisma探测、业务探针和清理。
4. API HTTP contract case本身不回放迁移，继续使用15秒`testTimeout`；API `globalSetup`仍消费共享PostgreSQL support执行迁移，并由support自身20秒watchdog约束，不受case timeout替代。
5. 保留现有真实PostgreSQL测试、随机schema隔离、失败清理support与`test:s0-s3 -> verify:s0-s3`聚合入口；Web与React Router继续由`verify:b4`覆盖。不新增helper、runner、fallback或重复suite。

测试矩阵如下：

| 稳定合同 | 风险 | 最低充分层级 | 边界与入口 |
| --- | --- | --- | --- |
| 锁定依赖在受支持Node上安装、检查和构建 | CI版本低于依赖最低要求 | static/build | Node 24 CI，冻结lockfile，`verify:b4`与`verify:s0-s3` |
| 迁移回放在超时或失败后完整清理schema与子进程 | runner先于watchdog中断清理 | integration | 真实PostgreSQL，迁移回放case 60秒，其他case 15秒 |
| readiness HTTP在数据库故障时有限返回 | 全局超时放宽掩盖API回归 | contract | 真实HTTP与受控TCP黑洞，API Vitest保持15秒 |

## Alternatives

- **只把CI提高到22.22.0**：拒绝。虽然满足当前React Router最低要求，但与正式CD的Node 24形成两个维护基线。
- **CI使用Node 24、`engines`继续允许旧版本**：拒绝。本地安装仍可进入依赖不支持的运行时，错误延迟到构建或运行阶段。
- **缩短迁移watchdog以适配15秒case**：拒绝。迁移进程在慢速CI需要独立的有限退出窗口，压缩watchdog会增加误杀和清理不完整风险。
- **把database或所有Vitest case统一放宽到30秒**：拒绝。30秒没有覆盖完整迁移生命周期的足够余量，同时会削弱普通database与API合同的15秒回归信号。
- **让ESLint以`allowDefaultProject`接纳测试与tooling文件**：拒绝。该路径绕过已定义的TypeScript project，无法证明生产、测试和Node tooling类型边界。

## Consequences

- 开发机、TypeScript类型面、L0 CI和正式CD使用同一Node主版本，依赖最低版本冲突在安装边界直接暴露。
- Web与Protyle继续由浏览器专用`types`和源码边界约束，不因第三方构建工具的Node peer而获得Node全局类型。
- Node主版本升级需要显式更新本ADR、`engines`和CI，不依赖浮动的最低兼容假设。
- 专用迁移回放case允许watchdog与资源清理先完成并由Vitest报告真实失败；普通database与API慢请求仍受原15秒上限保护。
- 该决策不改变生产请求超时、数据库连接时限、模块边界或业务数据流。

## References

1. [奇点企业知识库完整方案](../../output/md/Singularity_Enterprise_Knowledge_Base_v1.0.0_2026-07-13.md)
2. [L0 CI工作流](../../.github/workflows/singularity-l0.yml)
3. [企业工作区清单](../../enterprise/package.json)
4. [pnpm工作区配置](../../enterprise/pnpm-workspace.yaml)
5. [数据库Vitest配置](../../enterprise/packages/database/vitest.integration.config.ts)
6. [Playwright browser integration配置](../../enterprise/apps/web/playwright.integration.config.ts)
