---
title: "P5真实全链E2E与企业Web入口收口"
description: "定义React、NestJS、Worker、PostgreSQL、Gateway与Go Kernel的真实Playwright链路、生命周期和旧入口边界"
author: "Codex"
date: "2026-07-20"
version: "1.5.0"
status: "working"
tags: ["l1", "p5", "e2e", "playwright", "vite"]
---

# P5真实全链E2E与企业Web入口收口

## 范围

本入口为L1 P5提供不替换目标链的真实浏览器证据：Chromium通过HTTPS Vite预览加载企业React应用，同源`/api`和WebSocket请求转发到真实NestJS控制面，NestJS从固定PostgreSQL测试库的专用schema读取身份、授权和Kernel部署事实，再以mTLS与短期Ed25519服务JWT访问真实Go Kernel；同一入口还启动声明式Nest Worker，由它从PostgreSQL领取任务、调用源Kernel生成归档、写入测试私有对象存储、执行真实Go恢复命令并启动隔离恢复Kernel。测试不得使用`page.route`、`context.route`、HAR或`route.fulfill`替代React、API、Worker、Gateway或Kernel。

本入口不启动、停止或重配固定PostgreSQL服务；数据库必须由操作者按固定测试库runbook预先启动。P5启动器只拥有本轮API、Worker、源Kernel、恢复Kernel、Vite子进程、专用schema、测试私有对象目录和临时工作区。

## 运行拓扑

```text
Playwright Chromium
  -> https://127.0.0.1:4174
  -> Vite preview，HTTPS与同源HTTP/WS代理
  -> http://127.0.0.1:3012
  -> NestJS身份、空间授权与Kernel Gateway
  -> PostgreSQL 127.0.0.1:55432 / singularity_p5_e2e_<runner PID>
  -> mTLS + Ed25519 service JWT
  -> https://127.0.0.1:6807
  -> 真实Go Kernel与隔离SiYuan工作区

PostgreSQL worker_jobs
  -> Nest Worker声明式handler discovery
  -> 到期内容审计intent最终化为唯一HMAC审计事件
  -> 源Kernel backup archive
  -> 测试私有FileObjectStore
  -> 真实Go workspace restore-archive
  -> https://127.0.0.1:6810-6819
  -> 隔离恢复Kernel与PostgreSQL runtime endpoint
```

## 固定合同

| 项目 | 默认值 | 所有者 |
| --- | --- | --- |
| PostgreSQL基础库 | `postgresql://singularity_test:singularity_test@127.0.0.1:55432/singularity_test` | 固定测试库runbook，P5不负责启动 |
| PostgreSQL schema | `singularity_p5_e2e_<Playwright runner PID>` | `playwright.e2e.config.ts`生成，P5启动器重建并在退出时删除 |
| NestJS端口 | `3012` | `start-stack.mjs` |
| 源Go Kernel端口 | `6807` | `start-stack.mjs` |
| 恢复Go Kernel端口范围 | `6810-6819` | Worker恢复平台，从范围内独占分配 |
| Vite HTTPS端口 | `4174` | `start-web.mjs` |
| 对象存储 | 本轮`0700`运行目录下的`object-store` | Nest Worker，退出时删除 |
| Playwright并发 | 单worker、`fullyParallel: false` | `playwright.e2e.config.ts` |
| E2E目录 | `enterprise/apps/web/tests/e2e` | P5 Playwright入口 |
| Browser integration目录 | `enterprise/apps/web/tests/browser-integration` | 可替换外部HTTP边界的独立入口 |

端口可以分别通过`SINGULARITY_E2E_API_PORT`、`SINGULARITY_E2E_KERNEL_PORT`、`SINGULARITY_E2E_RESTORE_PORT_FIRST`、`SINGULARITY_E2E_RESTORE_PORT_LAST`和`SINGULARITY_E2E_WEB_PORT`覆盖。基础测试库只在显式提供`SINGULARITY_TEST_DATABASE_URL`时覆盖，覆盖URL仍必须使用`postgres:`或`postgresql:`并以`_test`数据库名结尾。schema按Playwright runner PID隔离；默认端口仍是独占资源，并发入口必须显式分配互不重叠的全部端口。

## 生命周期

1. Playwright `globalSetup`按runner PID生成运行目录、状态文件和专用schema，先拒绝已占用端口，再启动受其拥有的stack supervisor。
2. 构建NestJS API、Nest Worker、企业Vite Web和真实Go Kernel二进制；同一可信Go二进制同时承担源Kernel、归档恢复命令和恢复Kernel职责。
3. 通过生产Access Operations stdin入口初始化owner、组织、空间、viewer及空间角色，不直写业务表或伪造Cookie。
4. 通过真实Kernel CLI在隔离工作区创建笔记本与文档，取得真实`notebookId + documentId`。
5. 生成临时Ed25519服务身份，使用受控测试证书启动企业mTLS Kernel，并等待认证后的`/internal/readyz`。
6. 通过生产Access Operations把源Kernel状态切为`ready`，写入部署文件并启动NestJS API。
7. API数据库readiness成功后启动真实Nest Worker；Worker使用同一个专用schema、源Kernel部署、临时服务身份、测试私有对象目录和真实恢复平台配置，不注入测试handler或内存repository。
8. Worker声明式producer写入真实`sample-kernel`任务，启动器等待Worker成功消费，以数据库中的`succeeded`结果证明producer/handler discovery、领取和Kernel调用均可用；进程仅存活不算readiness。
9. 源Kernel、API和Worker均仍存活后，以原子rename发布权限为`0600`的状态文件；`globalSetup`取得完整状态后才启动Vite HTTPS supervisor并等待真实页面readiness。
10. Playwright结束、进程异常或收到终止信号时，`globalSetup`先停止Vite，再由stack supervisor停止Worker及其在途任务、恢复Kernel、NestJS API和源Kernel，最后删除状态文件、专用schema、对象目录和临时工作区。任何清理失败使入口失败，不把残留资源当作通过。

状态文件只在本机测试进程间传递生成ID、测试账号和临时证书路径，不进入仓库、日志、浏览器localStorage或产品数据库。私钥、证书、服务key ring和状态文件均使用`0600`权限；运行目录按启动进程PID隔离。

## 当前证据代码

| 稳定合同 | Playwright case | 真实结果 |
| --- | --- | --- |
| 内容身份、持久化与审计最终化链 | `content-chain.e2e.spec.ts` | 登录、选择空间、加载真实Protyle，观察`getDoc`和`transactions`均携带当前`notebookId + documentId`；在当前正文后追加本case UUID marker并在重载后读取同一持久化结果，再以同一响应`requestId`在真实空间审计页轮询声明式Worker最终追加的唯一`content.edit/succeeded`事件 |
| 搜索与引用/反链 | `discovery-content.e2e.spec.ts` | 通过真实空间搜索查找进程唯一marker并导航；从真实Kernel反链结果看到引用文档并导航，不替换React、Gateway、索引或Kernel |
| 主动内容默认隔离 | `active-content.e2e.spec.ts` | 真实PlantUML显示未启用，HTML block只保留惰性`data-content`；DOM不生成`img/iframe/object/embed/script`，sentinel不执行且浏览器无跨源HTTP(S)请求 |
| viewer只读与上传拒绝 | `authorization.e2e.spec.ts` | viewer取得真实编辑器DOM，但键盘、文本paste、文件paste和drop均不改变DOM且产生零事务/上传；携带真实CSRF和内容身份的multipart上传由真实Gateway返回403 |
| 退出后的历史隔离 | `authorization.e2e.spec.ts` | 退出后返回登录页，浏览器后退只得到真实401并再次收敛到登录页，旧`ProtyleHost`不恢复 |
| 分享创建、公开读取与撤销 | `sharing.e2e.spec.ts` | 管理员通过真实分享管理页选择文档并创建无密码只读分享；匿名浏览器读取真实公开页面且不呈现组织、空间、笔记本、文档或Kernel内部地址；管理员在真实UI撤销后同一公开地址立即收到404 |
| 备份、隔离恢复与激活 | `backup-restore.e2e.spec.ts` | 在真实Protyle提交本case唯一内容标记，经管理UI创建备份和恢复；PostgreSQL Worker任务、对象归档、真实Go恢复命令、恢复Kernel authenticated readyz及runtime endpoint完成后显式激活目标空间，再从目标目录和Gateway读取同一内容及原始`notebookId + documentId` |

这些case共享的support只承担登录、空间入口定位、状态文件读取和浏览器技术诊断，不封装业务断言。每个case直接保留身份、授权、DOM和持久化结论。

## 分层场景矩阵

| 场景 | 最低充分层级与标准入口 | 证据边界 |
| --- | --- | --- |
| 空间搜索 | P5 `discovery-content.e2e.spec.ts`，`pnpm test:e2e` | 真实React、Nest、PostgreSQL部署事实和Go Kernel索引；按唯一marker搜索并导航 |
| 引用与反链 | P5 `discovery-content.e2e.spec.ts`，`pnpm test:e2e` | 真实引用文档、Kernel反链和用户导航；P3 `protyle-complex-content.spec.ts`补跨笔记本显式身份细节 |
| 属性视图 | P3 `protyle-complex-content.spec.ts`，`pnpm test:browser-integration`；Kernel `api/av_test.go`与`model/attribute_view_isolation_test.go`，Kernel标准Go入口 | 真实Protyle渲染与cell transaction保护`notebookId + documentId`，Kernel层保护公开API和隔离；P5不复制同一交互 |
| 插件 | P3 `protyle-plugins.spec.ts`，`pnpm test:browser-integration`；`packages/protyle-browser/src/plugins.test.ts`，workspace Vitest入口 | 真实菜单、快捷键、slash、异步paste和持久化净化；企业P5生产组合根为零插件，不用空组合伪证非空贡献 |
| 主动内容 | P5 `active-content.e2e.spec.ts`；P4 `active-content.spec.ts`，browser integration入口 | P5保护默认PlantUML/HTML惰性与零跨源请求；P4保护PDF.js canvas、Gateway批准图片MIME、OCR canonical path及危险MIME下载 |
| 双实例`sourceEditorId`/exclude-self | P3 `protyle-editor.spec.ts`，`pnpm test:browser-integration` | 同文档两个真实Core实例提交来源editor ID；同源push更新两个实例且不触发`getBlockDOM` fallback，证明exclude-self不误排兄弟实例 |
| canonical HTTP/push | P3 `protyle-complex-content.spec.ts`，`pnpm test:browser-integration` | rename先采用HTTP canonical响应；错误内容身份push被忽略，匹配身份push更新标题与目录 |

P5只承担必须穿过真实控制面和Kernel的纵向风险；browser integration允许替换明确的外部Gateway边界，以更低成本覆盖Protyle多实例、插件和push精细时序。static门禁只保护入口、依赖和禁用API，不能替代上述运行时证据。

## 企业Web入口收口

企业Web的`index.html`只加载`enterprise/apps/web/src/main.tsx`，唯一构建器是Vite，企业Web镜像只构建并复制`enterprise/apps/web/dist`。旧静态shell Playwright config、`tests/shell`、空E2E入口和企业Web目录下的Webpack config均物理不存在；browser integration与真实E2E拥有互斥目录、config和输出目录。

上游`app/webpack.config.js`、`app/webpack.desktop.js`、`app/webpack.mobile.js`和`app/webpack.export.js`仍分别服务思源desktop/mobile/export客户端，不是企业Web生产入口，P5不得删除。`app/src/index.ts`、`app/src/host/plugin.ts`、`app/src/host/protyle.ts`、`app/src/protyle/EmbeddedProtyleOwner.ts`和`app/src/block/Panel.ts`仍有这些共享客户端的真实调用方；当前收口门禁要求它们不进入企业Vite生产依赖图，而不是猜测性删除并破坏上游客户端。

企业Web不再拥有直接导入上游旧壳的测试路径：PluginPort Adapter的稳定顺序、身份和paste合同已迁回`app/src/host/plugin.test.js`的App标准runner，`ModelReconnectLifecycle.test.js`因只证明旧`layout/Model`而不保护企业Session Transport合同被删除。上游Adapter与Model生产源码仍按上一段保留给思源客户端，不进入企业Vite闭包，也不通过企业Vitest形成第二个测试owner。

`enterprise/scripts/p5-entry-closure.test.mjs`使用现有TypeScript生产闭包审计证明企业入口不加载上述旧壳和迁移Adapter，检查HTML module入口、package构建器与旧企业测试路径的物理状态，并复用module-load AST证明全部Web源码只有`main.tsx`加载公共Core子入口且没有旧壳owner导入；同一文件使用AST检查E2E源码未调用目标链替代API，并通过结构化Dockerfile检查证明镜像只交付Vite产物。该static证据只保护入口和禁用依赖，不能替代Playwright运行结果。

`@singularity/web test:space-access`固定为单次`vitest run src/app/App.test.tsx src/spaces`：`src/spaces`目录过滤由Vitest原生发现`ContentDirectory.test.tsx`、`SpaceSessionRoot.test.tsx`及同目录其余原生case，root `test:s0-s3`只委托该leaf一次。不得为两个组件建立逐文件子进程、额外script或第二套runner；是否真实收集和独立报告由集中verification验证。

## 标准入口

集中verification阶段在Node.js 24、pnpm 11.9.0、仓库锁定依赖、Go工具链、`psql`、`openssl`、Playwright Chromium和已经运行的固定PostgreSQL测试库就绪后，从企业工作区的唯一root入口执行：

```bash
cd /root/projects/singularity/enterprise
pnpm test:e2e
```

root `test:e2e`只直接委托`@singularity/web test:e2e`，不进入`test:browser-integration`、`test:s0-s3`或其他聚合门禁；Web package仍只保留一个真实E2E leaf入口。Playwright `globalSetup`要求全部API、源/恢复Kernel和Web端口空闲，只启动并清理本轮supervisor，不接管或复用未知本地服务。当前L1仍处于code-review，本文件及测试代码落盘不表示上述命令已经运行或通过。

## CI门禁

`.github/workflows/singularity-l0.yml`以独立`p5-e2e` job执行同一个root `test:e2e`入口。该job固定Node.js 24与pnpm 11.9.0，从`kernel/go.mod`读取Go版本，安装仓库锁定的enterprise与SiYuan app依赖及Playwright Chromium，并拥有独立的PostgreSQL 17 service container。runner step允许失败后继续收集证据；`always()`步骤结构化校验`e2e-report.json`至少包含suite、spec和test，上传JSON report、trace与附件，最终gate同时要求runner和报告校验均为success。它不依赖或复用`space-session`、browser integration、API、Worker、Kernel或Vite服务；Playwright仍由唯一E2E config启动并清理本轮API、Worker、源/恢复Kernel与Vite进程，数据库service只由GitHub job生命周期拥有。

## 剩余验收

当前代码已建立内容持久化与审计最终化、搜索、引用/反链、主动内容默认隔离、viewer输入与上传拒绝、撤权清屏、分享即时撤销、备份隔离恢复等真实纵向闭环，并把AV、插件、双实例与canonical HTTP/push映射到最低充分的P3/P4/Kernel证据。是否完成P5仍由整阶段verification在Node.js 24和完整依赖服务下运行上述矩阵后决定；新增真实全链场景只能扩展同一个E2E入口，不建立第二套runner、测试Kernel或目标链fallback。

## References

1. [Protyle浏览器宿主与Vite抽取方案](protyle-browser-host.md)
2. [企业空间Session组合根与Kernel Gateway启动方案](space-session-composition-root.md)
3. [L1实现重启交接](l1-implementation-handoff.md)
4. [固定PostgreSQL测试库runbook](../runbooks/singularity-test-postgres.md)
