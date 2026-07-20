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
- [ ] 整阶段 code-review、安全/许可证复评。
- [ ] 全量 `verify:s0-s3`、浏览器/P3-P5、Kernel、构建、SBOM/漏洞/许可证验证。
- [ ] 固定测试库可接受连接但当前约 31 个测试/诊断后端仍自 06:22 起持有或等待锁，聚合诊断查询 3 秒超时；未停止、重启或重配服务，待环境恢复后集中跑矩阵。
- [ ] 以真实证据更新方案 11.4、L1 状态及完成定义。

# Next Steps

1. 先做整阶段静态/架构/安全/许可证复评，集中修复发现项；不在评审期跑验收 runner。
2. 复评通过后，按方案矩阵一次性运行 `verify:s0-s3`、API/database/contracts、Web/component/browser、Worker、Kernel、build、SBOM、漏洞和许可证检查。
3. 固定库恢复可用后，重跑组织并发全文件及所有 PostgreSQL 集成；记录服务版本、schema、命令和结果。
4. 对照 9.3 逐项形成证据；若失败，回 implementation 修共同根因，再整阶段复评。
5. 更新方案 11.4 与阶段状态；必要修复形成独立提交。

# Risks

- 固定测试库历史长事务/连接耗尽，可能污染集成结果；不得把环境超时误判为业务通过或失败。
- 远程 CI 旧证据早于 `a4c74d744`，不能替代本批锁序和递归诊断验证。
- L1 范围跨 API、Web、Kernel、Worker、容器，单模块绿色不足以证明 9.3。

# Verification

- 静态：typecheck、ESLint、architecture boundary、关键注释/异常堆栈/旧入口审查。
- 服务：Nest HTTP/HTTPS/WSS、Prisma migration/random schema、API contracts/integration、Worker。
- 前端：Web component、Playwright desktop/mobile/320px、真实 DOM/编辑/分享/权限及错误健康。
- Kernel：serviceauth、model/API/filesys、race；构建：Docker cold build、SBOM 闭包、漏洞/许可证零拒绝/未知。
- 证据须来自标准 runner、真实运行结果和可复现命令；不以源码字符串、截图或旧 CI 结果替代。

# Resume Guide

下次先读本文件、方案 9.3/10/11.4，再 `git status`、`git log -8`、固定库 `pg_stat_activity`；确认数据库服务未被擅动。若连接恢复，跳到 Next Steps 2；若仍耗尽，只做静态复评并记录阻塞，不重启服务。
