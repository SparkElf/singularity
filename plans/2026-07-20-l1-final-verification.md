# Objective

依方案文件闭合 L1 企业基础版：整阶段代码/安全/许可证复评，统一运行 API、Web、Kernel、浏览器、构建、供应链矩阵；更新 11.4 证据，验收 9.3 后再宣告完成。

# Background

L0 已验收。L1 全功能 implementation 已落盘并提交至 `a4c74d744`；上一批修正组织→用户→成员锁序、PostgreSQL 锁等待链诊断、测试限流注入及用户组 SQL 保留字。正式评审与本波 verification 尚未闭合。

# Locked Assumptions

- 方案权威：`output/md/Singularity_Enterprise_Knowledge_Base_v1.0.0_2026-07-13.md`。
- Node 以 `.nvmrc`/CI 要求 24.18.0；企业 pnpm 11.9.0。
- 固定测试库：`postgresql://singularity_test:singularity_test@127.0.0.1:55432/singularity_test`；不创建临时库，不擅停/重配既有服务。
- 不启用子代理；跨模块共享合同只由主线程修改。
- 数据身份显式携带 `organizationId + spaceId + notebookId + documentId`；不以 DOM、全局首响应或 active 实例推断。

# Compatibility / Contracts

- L1 9.3 全部验收：隔离、授权、撤权、分享、审计、备份恢复、内容身份及主动内容安全。
- Nest 声明式装配、Prisma/PostgreSQL、React/Vite/Tailwind、唯一企业入口、Kernel mTLS/JWT 合同不可回退。
- 关键函数须有必要中文备注；异常保留完整堆栈；不新增重复边界校验、fallback、旧双路径。
- 变更验证完整后才提交；本批已提交，不默认 push。

# Current Progress

- [x] L0 及 L1 implementation 主体落盘；L0 证据已在方案 11.4 记录。
- [x] 组织并发锁序修复、用户组 SQL、限流器测试注入已提交 `a4c74d744`。
- [x] 整阶段静态复评发现并修复目录 JSON 响应正文进入异常日志的问题，提交 `e5f86c8d5`；合同测试同时保留原始解析堆栈并断言正文不泄露。
- [x] 复评发现文档 Discovery 面板未跟随当前选择收敛，修复为唯一 `spaceId + notebookId + documentId` 归属边界并取消迟到请求；Web 类型与 ESLint 诊断通过，已提交 `b2ed38be5`。
- [x] API typecheck、相关 ESLint、API unit `123/123`；4 个组织并发合同在干净库曾通过。
- [x] 整阶段代码、架构与安全静态复评通过：Gateway/目录/Discovery/Session/Protyle/Worker 的身份链、异常堆栈、日志脱敏、声明式装配、旧入口和重复 fallback 已复核；发现项已分别提交 `e5f86c8d5`、`b2ed38be5`。
- [x] 企业生产构建 `pnpm build:s0-s3` 通过：Worker 直接声明 `@singularity/contracts`，并为 Worker/Database/Kernel Client 构建配置清空继承的 `paths`，消除跨 `rootDir` 编译失败。
- [x] 上游 Web 生产构建通过：40 个 Protyle 相关模块统一使用 `dayjs` 默认导入，清除 Vite `CANNOT_CALL_NAMESPACE` 运行时警告；仅保留既有大于 500KB 的 bundle 提示。
- [x] App 定向 ESLint 0 error、3 个既有 warning；全量 lint 仍受既有 browser-entry 三条 triple-slash 与三个 `prefer-const` 诊断阻塞，未扩大本批修复范围。
- [x] Kernel 集中验证通过：`go test -vet=off -tags='fts5 sqlcipher' ./...`，API、model、MCP、server、SQL、serviceauth、filesys、treenode、util 等全部通过；本批修复已提交 `248aa65f1`。
- [x] P5 真实 E2E 修复后重新执行通过：`11 expected / 0 unexpected / 0 skipped`；授权 stale-result、备份导航取消和 restored Kernel 清理均按结构化终止路径收敛。
- [x] 当前提交构建产物已完成 Docker 冷构建、三镜像元数据核验、API/Worker/Web 原始 CycloneDX、canonical 许可证证据和生产依赖闭包；`production-sbom-policy` 为 `0 dependency closure violations`。
- [x] 漏洞策略真实检查通过：企业源码、API、Worker、Web 四份报告均有非空扫描目标，合计 `0 fixable / 0 unfixed High/Critical findings`。
- [x] 许可证策略真实检查已闭合：源码 workspace 物化完整跨架构可选依赖，Worker canonical SBOM 按精确 PURL/name/version 引用 source canonical SBOM，并锁定 Go stdlib 正文；真实结果 `2642 allowed / 0 denied / 0 unknown`。
- [x] `pnpm verify:s0-s3` 已通过：lint、typecheck、contracts `24/24`、database `53/53`、API unit `123/123`、API integration `221/221`、Worker `59/59`、Web component `78/78`、browser integration `59 passed / 64 skipped / 0 failed`、Kernel serviceauth 与 enterprise production build。
- [x] 标准供应链治理 runner `node --test scripts/singularity/*.test.mjs` 已通过 `112/112`；同时修复 watchdog 目录锁释放在 Node 24 下的 `EISDIR`，恢复/退避合同全部通过。
- [x] 固定测试库本轮可用，未停止、重启或重配服务；数据库、API、Worker、Web、浏览器和构建矩阵均在固定库上完成。
- [x] 已以真实证据更新本方案的验证状态；L0 供应链许可证门禁已闭合，L1 仍按第 9.3 节逐项验收。

# Next Steps

1. 固定测试库本轮已完成矩阵验证；后续若修改许可证脚本或策略，需重新执行固定库相关门禁和供应链矩阵。
2. 对照 9.3 逐项形成证据；若出现失败，回 implementation 修共同根因，再整阶段复评。
3. 更新方案 11.4 与阶段状态，并形成独立提交。

# Risks

- 固定测试库历史长事务/连接耗尽，可能污染集成结果；不得把环境超时误判为业务通过或失败。
- 远程 CI 旧证据早于 `a4c74d744`，不能替代本批锁序和递归诊断验证。
- L1 范围跨 API、Web、Kernel、Worker、容器，单模块绿色不足以证明 9.3。

# Verification

- 静态：typecheck、ESLint、architecture boundary、关键注释/异常堆栈/旧入口审查。
- 服务：Nest HTTP/HTTPS/WSS、Prisma migration/random schema、API contracts/integration、Worker。
- 前端：Web component、Playwright desktop/mobile/320px、真实 DOM/编辑/分享/权限及错误健康。
- Kernel：serviceauth、model/API/filesys、race；构建：Docker cold build、SBOM 闭包、漏洞零 High/Critical、许可证零拒绝/未知；本轮供应链结果已闭合。
- 证据须来自标准 runner、真实运行结果和可复现命令；不以源码字符串、截图或旧 CI 结果替代。

本轮本地证据（均由固定测试库、Node 24.18.0 和 `singularity-api:l1-final`、`singularity-worker:l1-final`、`singularity-web:l1-final` 生成）：

- `verify-production-sbom.mjs`：`PASS production SBOM policy: 0 dependency closure violations`。
- `check-vulnerability-reports.mjs`：`PASS vulnerability policy: 0 fixable, 0 unfixed High/Critical findings`。
- `check-license-reports.mjs`：`PASS license policy: 2642 allowed, 0 denied, 0 unknown`。
- `enterprise/apps/web/test-results/e2e-report.json`：`11 expected / 0 unexpected / 0 skipped`。

# Resume Guide

下次先读本文件、方案 9.3/10/11.4，再 `git status`、`git log -8`、固定库 `pg_stat_activity`；确认数据库服务未被擅动。若连接恢复，跳到 Next Steps 2；若仍耗尽，只做静态复评并记录阻塞，不重启服务。
