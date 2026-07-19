---
title: "ADR-028: 请求关联与稳定可观测性"
description: "定义跨 HTTP、WebSocket、浏览器运行时与生命周期日志的真实请求关联语义"
author: "Codex"
date: "2026-07-19"
version: "1.0.0"
status: "accepted"
tags: ["adr", "observability", "request-correlation", "websocket"]
---

# ADR-028: 请求关联与稳定可观测性

## Status

Accepted；本纵切进入 implementation，正式 runner 由整个 L1 大阶段的 code-review/verification 集中执行。

## Context

L1 的 HTTP、WebSocket 和浏览器运行时跨越多个进程与异步边界。身份、空间、笔记本和文档必须由上游显式传递，日志只能关联真实产生过的请求，不能从 DOM、全局状态、首个响应、session generation 或本地随机数推断请求身份。当前链路存在三类风险：服务端路由日志没有记录授权后实际使用的 Kernel 实例；浏览器在网络失败、响应缺字段或 WebSocket 关闭时用随机 UUID 冒充请求源；运行时错误合同把生命周期事件的代次误当作请求 ID。

## Decision

1. **真实请求源只有两类。** HTTP 使用 Fastify `request.id`，由入口生成并贯穿 Controller、授权、Kernel client、响应头和日志。WebSocket upgrade 使用服务端边缘生成的 `requestId`，并贯穿 Identity、访问重验、上游 Kernel client、active connection 与 `kernel.route` 日志。浏览器不得为没有网络请求源的本地生命周期或协议错误生成新的 request ID。
2. **requestId 与 triggeringRequestId 语义分离。** `requestId` 只表示当前边界实际接收或发起的请求；`triggeringRequestId` 表示一个后续浏览器事件可追溯到的上游真实请求。事件若没有可达上游请求，字段省略，不以 session generation、connection ID、文档 ID 或随机 UUID 填充。
3. **Kernel 实例只在授权成功后记录。** 服务端 `kernel.route` 日志在存在授权 deployment 时附带 `authorized.deployment.kernelInstanceId`。Admission、身份认证或授权失败阶段没有可信 deployment，日志省略该字段，不从目标路径、首个部署或旧状态推断。
4. **内容身份只由内容请求携带。** Gateway request、upload 和 subscribe 事件可附带显式 `documentId`；空间 Discovery、ContentDirectory、Session 创建/销毁和无请求源的生命周期事件不制造 documentId。`spaceId`、`notebookId`、`documentId` 继续由各自公开合同显式传递，不从 DOM 或响应内容派生。
5. **运行时错误采用最小可选合同。** `ProtyleRuntimeErrorEvent` 使用 `category`、可选 `documentId` 和可选 `triggeringRequestId`。Gateway 失败事件保留其真实内容身份；Discovery、目录和 WebSocket 本地错误只报告可达的触发请求，缺失时保持 undefined。生命周期日志保留 `generation` 作为代次，但绝不把它当作 requestId。
6. **响应缺失关联字段不回退。** HTTP/上传仅消费服务端 `ApiProblem.requestId` 或 `X-Request-Id`；缺失时 `GatewayResponseError.triggeringRequestId` 为 undefined。网络失败、协议解析失败、WebSocket message/close 事件和 Discovery contract failure 没有真实请求源时也保持 undefined。
7. **日志脱敏且字段稳定。** 日志只记录公开 UUID、事件类别、路由、状态、结果、耗时和必要的 deployment UUID；不记录正文、令牌、Cookie、地址、标题、路径或上游原始响应。可选字段不存在时省略，而不是写空字符串或近似值。

## Data Flow

```text
HTTP Fastify request.id ─┬─> Controller/authorization ─> Kernel client ─> kernel.route log
                         └─> ApiProblem/X-Request-Id ─> browser triggeringRequestId

WebSocket upgrade UUID ──> Identity/access revalidation ─> Kernel WS client
                         └─> pending/active registry ─> websocket-active kernel.route log

Gateway document request ─> transport event(documentId, triggeringRequestId)
Discovery/directory/session lifecycle ─> event only with fields that have a real source
```

## Ownership and ordering

| Module | Owner | Allowed files | Dependency |
| --- | --- | --- | --- |
| Browser event contract | Protyle browser owner | `enterprise/packages/protyle-browser/src/contracts.ts` and its contract tests | First; defines optional field names |
| Browser transport and discovery | Gateway lifecycle owner | `enterprise/apps/web/src/spaces/gateway-transport.ts`, `discovery-api.ts`, `ContentDirectory.tsx`, related tests | After event contract |
| Session lifecycle projection | Space session owner | `enterprise/apps/web/src/spaces/SpaceSessionRoot.tsx`, related tests and architecture docs | After transport event contract |
| HTTP Gateway logging | Content audit owner | `enterprise/apps/api/src/kernel/kernel-gateway.service.ts`, `kernel-gateway.http.test.ts` | After content-audit hunk is released |
| WebSocket active logging | Access-change owner | `enterprise/apps/api/src/kernel/kernel-websocket.gateway.ts`, `access-change.http.test.ts` | Independent after service contract; pending close may omit deployment |
| Documentation integration | Root integration owner | `docs/architecture/protyle-browser-host.md`, `docs/architecture/space-session-composition-root.md`, authoritative L1 plan | After production contracts settle |

No two owners edit the same file concurrently. Shared contract changes land before consumers; API log changes land after the content-audit owner releases its hunk. The root integration owner performs the final static consistency pass.

## Alternatives considered

- **Browser-generated UUID fallback:** rejected; it creates an untraceable identity and makes late responses appear to originate from a request that never existed.
- **Use session generation or WebSocket connection ID as requestId:** rejected; these identify lifecycle state, not a network request, and collapse independent events.
- **Infer deployment or document identity from route/DOM/first response:** rejected; inference breaks after space switching and allows stale responses to cross the explicit identity boundary.
- **Make every field mandatory:** rejected; lifecycle, Discovery and local protocol failures genuinely have no content or request source. Optionality expresses reachability rather than weakening authorization.

## Testing and verification gate

This is one L1 implementation slice with one concentrated verification gate. Tests are written with the existing runners during implementation and are not executed per file:

| Contract | Permanent evidence | Required assertion |
| --- | --- | --- |
| HTTP Gateway route log | `enterprise/apps/api/test/kernel-gateway.http.test.ts` | Success and failure retain the real request ID; authorized success includes the deployment `kernelInstanceId`; pre-authorization failure omits it |
| WebSocket active route log | `enterprise/apps/api/test/access-change.http.test.ts` | Upgrade request ID reaches active log and authorized deployment ID; pending close does not fabricate deployment |
| Browser Gateway transport | `enterprise/apps/web/src/spaces/gateway-transport.test.ts` | API problem/request header and document ID are preserved; network/protocol/close paths do not create random IDs |
| Session lifecycle | `enterprise/apps/web/src/spaces/SpaceSessionRoot.test.tsx` | Terminal disposal projects only real document/request fields; generation remains a lifecycle value |
| Discovery and directory | Existing discovery/content directory tests | Space-level failures omit document ID and preserve a real API problem request ID when present |

The verification stage runs the standard API and web runners as one matrix after implementation and review. Static checks during implementation are limited to type-shape inspection, `rg`, formatting and `git diff --check`; no service, database, browser or formal test runner is started in this stage.

## Completion checklist

- [ ] Add this ADR to the authoritative L1 plan and architecture references.
- [ ] Update browser runtime event and transport contracts; remove random request-ID fallbacks.
- [ ] Add explicit document/request fields to Gateway events and session lifecycle projection.
- [ ] Add authorized deployment instance IDs to HTTP and active WebSocket route logs.
- [ ] Update permanent contract tests without creating a second runner or duplicate boundary owner.
- [ ] Run one concentrated verification matrix after full L1 code review.

## References

1. [ADR-018：跨进程访问失效通知](./0018-cross-process-access-change.md)
2. [ADR-024：审计与空间观测投影](./0024-audit-observability-projection.md)
3. [Protyle browser host](../architecture/protyle-browser-host.md)
4. [Space session composition root](../architecture/space-session-composition-root.md)
