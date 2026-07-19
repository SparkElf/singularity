---
title: "P5真实全链E2E与企业Web入口收口"
description: "定义React、NestJS、PostgreSQL、Gateway与Go Kernel的真实Playwright链路、生命周期和旧入口边界"
author: "Codex"
date: "2026-07-19"
version: "1.0.0"
status: "working"
tags: ["l1", "p5", "e2e", "playwright", "vite"]
---

# P5真实全链E2E与企业Web入口收口

## 范围

本入口为L1 P5提供首个不替换目标链的真实浏览器证据：Chromium通过HTTPS Vite预览加载企业React应用，同源`/api`和WebSocket请求转发到真实NestJS控制面，NestJS从固定PostgreSQL测试库的专用schema读取身份、授权和Kernel部署事实，再以mTLS与短期Ed25519服务JWT访问真实Go Kernel。测试不得使用`page.route`、`context.route`、HAR或`route.fulfill`替代React、Gateway或Kernel。

本入口不启动、停止或重配固定PostgreSQL服务；数据库必须由操作者按固定测试库runbook预先启动。P5启动器只拥有本轮API、Kernel、Vite子进程、专用schema和临时工作区。

## 运行拓扑

```text
Playwright Chromium
  -> https://127.0.0.1:4174
  -> Vite preview，HTTPS与同源HTTP/WS代理
  -> http://127.0.0.1:3012
  -> NestJS身份、空间授权与Kernel Gateway
  -> PostgreSQL 127.0.0.1:55432 / singularity_p5_e2e
  -> mTLS + Ed25519 service JWT
  -> https://127.0.0.1:6807
  -> 真实Go Kernel与隔离SiYuan工作区
```

## 固定合同

| 项目 | 默认值 | 所有者 |
| --- | --- | --- |
| PostgreSQL基础库 | `postgresql://singularity_test:singularity_test@127.0.0.1:55432/singularity_test` | 固定测试库runbook，P5不负责启动 |
| PostgreSQL schema | `singularity_p5_e2e` | P5启动器，每次运行前重建，退出时删除 |
| NestJS端口 | `3012` | `start-stack.mjs` |
| Go Kernel端口 | `6807` | `start-stack.mjs` |
| Vite HTTPS端口 | `4174` | `start-web.mjs` |
| Playwright并发 | 单worker、`fullyParallel: false` | `playwright.e2e.config.ts` |
| E2E目录 | `enterprise/apps/web/tests/e2e` | P5 Playwright入口 |
| Browser integration目录 | `enterprise/apps/web/tests/browser-integration` | 可替换外部HTTP边界的独立入口 |

端口可以分别通过`SINGULARITY_E2E_API_PORT`、`SINGULARITY_E2E_KERNEL_PORT`和`SINGULARITY_E2E_WEB_PORT`覆盖。基础测试库只在显式提供`SINGULARITY_TEST_DATABASE_URL`时覆盖，覆盖URL仍必须使用`postgres:`或`postgresql:`并以`_test`数据库名结尾。schema固定且每次运行会被删除重建，因此同一固定库不支持两个P5入口并发执行。

## 生命周期

1. 删除本进程PID隔离的临时运行目录和状态文件，重建固定专用schema并执行现有Prisma migration。
2. 构建NestJS API、企业Vite Web和真实Go Kernel二进制。
3. 通过生产Access Operations stdin入口初始化owner、组织、空间、viewer及空间角色，不直写业务表或伪造Cookie。
4. 通过真实Kernel CLI在隔离工作区创建笔记本与文档，取得真实`notebookId + documentId`。
5. 生成临时Ed25519服务身份，使用受控测试证书启动企业mTLS Kernel，并等待认证后的`/internal/readyz`。
6. 通过生产Access Operations把Kernel状态切为`ready`，写入部署文件并启动NestJS API。
7. API数据库readiness成功后，以原子rename发布权限为`0600`的状态文件；Vite进程只在状态文件完整后启动HTTPS预览。
8. Playwright结束、进程异常或收到终止信号时，停止准备命令、NestJS和Kernel，删除状态文件、专用schema与临时工作区。任何清理失败使入口失败，不把残留资源当作通过。

状态文件只在本机测试进程间传递生成ID、测试账号和临时证书路径，不进入仓库、日志、浏览器localStorage或产品数据库。私钥、证书、服务key ring和状态文件均使用`0600`权限；运行目录按启动进程PID隔离。

## 当前证据代码

| 稳定合同 | Playwright case | 真实结果 |
| --- | --- | --- |
| 内容身份与持久化链 | `content-chain.e2e.spec.ts` | 登录、选择空间、加载真实Protyle，观察`getDoc`和`transactions`均携带当前`notebookId + documentId`，提交固定正文并在重载后读取同一持久化结果 |
| viewer只读 | `authorization.e2e.spec.ts` | viewer取得真实编辑器DOM，但WYSIWYG与段落不可编辑，键盘输入不改变DOM且浏览器不发出事务请求 |
| 退出后的历史隔离 | `authorization.e2e.spec.ts` | 退出后返回登录页，浏览器后退只得到真实401并再次收敛到登录页，旧`ProtyleHost`不恢复 |

三项case共享的support只承担登录、空间入口定位、状态文件读取和浏览器技术诊断，不封装业务断言。每个case直接保留身份、授权、DOM和持久化结论。

## 企业Web入口收口

企业Web唯一生产入口是`enterprise/apps/web/src/main.tsx`，唯一构建器是Vite，企业Web镜像只构建并复制`enterprise/apps/web/dist`。旧静态shell Playwright config、`tests/shell`、空E2E入口和企业Web目录下的Webpack config均物理不存在；browser integration与真实E2E拥有互斥目录、config和输出目录。

上游`app/webpack.config.js`、`app/webpack.desktop.js`、`app/webpack.mobile.js`和`app/webpack.export.js`仍分别服务思源desktop/mobile/export客户端，不是企业Web生产入口，P5不得删除。`app/src/index.ts`、`app/src/host/plugin.ts`、`app/src/host/protyle.ts`、`app/src/protyle/EmbeddedProtyleOwner.ts`和`app/src/block/Panel.ts`仍有这些共享客户端的真实调用方；当前收口门禁要求它们不进入企业Vite生产依赖图，而不是猜测性删除并破坏上游客户端。

`enterprise/scripts/p5-entry-closure.test.mjs`使用现有TypeScript生产闭包审计证明企业入口不加载上述旧壳和迁移Adapter，使用AST检查E2E源码未调用目标链替代API，并通过结构化Dockerfile检查证明镜像只交付Vite产物。该static证据只保护入口和禁用依赖，不能替代Playwright运行结果。

## 标准入口

集中verification阶段在Node.js 24、pnpm 11.9.0、仓库锁定依赖、Go工具链、`psql`、`openssl`、Playwright Chromium和已经运行的固定PostgreSQL测试库就绪后执行：

```bash
cd /root/projects/singularity/enterprise
pnpm --filter @singularity/web test:e2e
```

入口要求默认三个端口空闲，`reuseExistingServer`固定为`false`，不会接管或复用未知本地服务。当前L1仍处于implementation，本文件及测试代码落盘不表示上述命令已经运行或通过。

## 剩余验收

当前代码只建立P5首个真实纵向闭环，尚未宣告P5或L1完成。最终P5 verification仍需与P3/P4既有browser integration共同覆盖搜索、块引用、属性视图、插件、主动内容隔离和撤权清屏，并在集中代码评审后运行完整矩阵。若其中某项必须增加真实全链证据，应扩展同一个E2E入口，不建立第二套runner、测试Kernel或目标链fallback。

## References

1. [Protyle浏览器宿主与Vite抽取方案](protyle-browser-host.md)
2. [企业空间Session组合根与Kernel Gateway启动方案](space-session-composition-root.md)
3. [L1实现重启交接](l1-implementation-handoff.md)
4. [固定PostgreSQL测试库runbook](../runbooks/singularity-test-postgres.md)
