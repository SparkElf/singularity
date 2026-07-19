---
title: "L1控制面组织、用户组与空间管理"
description: "奇点企业控制面的组织邀请、用户组、空间生命周期与RBAC合同"
author: "Codex"
date: "2026-07-19"
version: "1.0.0"
status: "working"
tags: ["l1", "control-plane", "rbac", "organization"]
---

# L1控制面组织、用户组与空间管理

## 范围

本切片负责组织成员与邀请、用户组、空间生命周期以及空间直接成员/用户组授权。组织是成员治理边界，空间是内容与Kernel隔离边界；`organizationId`和`spaceId`始终由路径合同显式携带，角色不由浏览器声明之外的字段推断。

持久化事实由 Prisma 模型拥有：`Organization`、`OrganizationMembership`、`OrganizationInvitation`、`UserGroup`、`UserGroupMembership`、`Space`、`SpaceMembership`、`SpaceGroupGrant`。复合外键和唯一键负责组织归属与并发写入完整性，服务层不以“先查再写”代替数据库约束。

## API合同

Nest Controller 通过 `@Authenticated()`、`@SessionMutation()` 和 `ZodValidationPipe` 声明访问、同源写入和输入边界；领域状态转移只在对应 `@Injectable` service 的事务中执行。

| 能力 | 公共入口 | 权限事实 |
| --- | --- | --- |
| 成员与邀请 | `/api/v1/organizations/{organizationId}/members`、`/invitations` | 活跃组织 owner/admin；owner 转移单独授权 |
| 用户组 | `/api/v1/organizations/{organizationId}/groups` | 活跃组织 owner/admin；组成员必须是同组织活跃成员 |
| 空间生命周期 | `/api/v1/organizations/{organizationId}/spaces` | 组织 owner/admin，或该空间的有效 `admin` |
| 空间成员/组授权 | `/.../spaces/{spaceId}/members`、`/groups` | 组织 manager 或空间 `admin`；目标用户/组必须属于同一组织 |
| 委派候选读取 | `/.../spaces/{spaceId}/member-candidates`、`/group-candidates` | 与空间管理相同；只返回活跃组织用户/用户组 |

管理页面的 TanStack Query 键包含完整组织与空间身份。委派空间管理员使用候选读取入口，不访问需要组织管理能力的全量组织目录，因此新增授权不会因缺少组织级能力而退化为不可用状态。

## 授权与状态转移

有效空间角色取直接成员和活跃用户组授权中的最高角色：`admin > editor > viewer`。每次读取同时约束 User、Organization、OrganizationMembership、Space 和对应成员/组状态；归档空间保留管理事实，但不进入普通授权空间列表。

空间管理写事务按 `User -> Organization -> OrganizationMembership -> Space -> SpaceMembership` 的稳定顺序锁定相关行。已有账号和 OIDC 邀请消费先以令牌或邀请 ID 取得显式组织身份，再按 `User -> Organization -> OrganizationMembership -> OrganizationInvitation` 锁定并在同一事务复验组织、期限、撤销和接受状态；本地新账号入口锁定邀请后创建唯一 User，不存在可被更早锁定的成员行。接受动作确实把既有活跃成员的角色改为新角色时，事务提交后发布一个带 `organization` 与 `user` selector 的 `close/forbidden` 事件。重复角色写入不发布重复撤权通知。

权限变化写入组织审计链；事件发布和审计记录与业务状态同事务提交，消费者只依赖公开事件合同，不读取数据库模型或原始请求载荷。

## 前端消费

`MembersPage` 管理成员、邀请、会话撤销与所有权转移；`GroupsPage` 管理用户组和成员；`SpacesManagementPage` 管理创建、重命名、归档/恢复；`SpaceAccessPage` 管理直接成员和用户组授权。页面只使用 contracts 中的 Zod schema 解析表单，成功后失效相应查询键和授权摘要，不复制领域事实到全局 store。

## 永久证据

- `enterprise/apps/api/test/organization-management.http.test.ts`：邀请、成员角色/状态、会话撤销、所有权转移、用户组和提交后撤权通知。
- `enterprise/apps/api/test/spaces.http.test.ts`：空间生命周期、跨组织隐藏式 404、直接/用户组授权和委派候选读取。
- `enterprise/apps/web/src/enterprise/SpaceAccessPage.test.tsx`：委派空间管理员只请求空间范围候选入口，不请求组织管理目录。
- `enterprise/packages/contracts/test/contracts.test.mjs`：角色、状态、路径和严格响应合同。

实现阶段只编写合同与静态检查；整阶段代码评审通过后，统一运行 API HTTP/数据库、contracts、React component 和浏览器矩阵。

## 边界与协作

本切片不拥有 ACL notification 基础设施、空间发现 contracts 聚合文件、编辑器内容链或其他企业页面的数据生产者。ACL 事件只消费公开 selector 合同；发现 owner 负责 `paths.ts`、`openapi.ts` 和 `index.ts` 的共享聚合，控制面只消费已有常量。
