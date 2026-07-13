---
title: "ADR-003: NestJS企业控制面与Go内容内核"
description: "划分企业业务与内容引擎的长期模块边界"
author: "Codex"
date: "2026-07-13"
version: "1.0.0"
status: "accepted"
tags: ["adr", "nestjs", "go-kernel"]
---

# ADR-003: NestJS企业控制面与Go内容内核

## Status

Accepted

## Context

企业组织、权限和分享属于服务端CRUD及策略域；文档AST、块事务、索引、引用和属性视图属于内容引擎域。二者数据、协议与生命周期不同。

## Decision

NestJS、Prisma与PostgreSQL管理企业域。思源Go Kernel管理内容域。Kernel Gateway承担空间路由、服务认证、错误转换、HTTP/WebSocket生命周期与诊断。

## Consequences

- 企业模块可使用统一TypeScript技术栈。
- 内容能力保留思源兼容性与性能特征。
- 系统须部署和观测两类服务。
- Gateway不是薄转发层，必须承担真实信任边界职责。

## References

1. [NestJS documentation](https://docs.nestjs.com/)
2. [SiYuan official repository](https://github.com/siyuan-note/siyuan)

