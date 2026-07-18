---
title: "Singularity fixed PostgreSQL test service"
description: "Run the persistent PostgreSQL 17 service used by Enterprise integration tests"
author: "Codex"
date: "2026-07-18"
version: "1.0.0"
status: "approved"
tags: ["testing", "postgresql", "docker"]
---

# Fixed PostgreSQL test service

Enterprise integration tests use one PostgreSQL 17 database named
`singularity_test`. The local service is deliberately bound to
`127.0.0.1:55432`, so it does not depend on or modify a PostgreSQL service on
the default `5432` port.

## Start and stop

From the repository root:

```sh
./scripts/singularity/test-postgres.sh up
eval "$(./scripts/singularity/test-postgres.sh env)"
```

The compose file uses the persistent Docker volume
`singularity-postgres-test-data`. `stop` stops the container and keeps that
volume:

```sh
./scripts/singularity/test-postgres.sh stop
```

The test runner does not start or stop PostgreSQL. It only creates and removes
isolated schemas inside this fixed database. Keep the service running while
running more than one integration command.

## Connection contract

```text
SINGULARITY_TEST_DATABASE_URL=postgresql://singularity_test:singularity_test@127.0.0.1:55432/singularity_test
DATABASE_URL=postgresql://singularity_test:singularity_test@127.0.0.1:55432/singularity_test
```

`SINGULARITY_TEST_DATABASE_URL` may be overridden for an explicitly isolated
CI or diagnostic environment. The normal local and CI entry points use the
fixed URL above. Do not point it at a production database.

To intentionally discard the persistent test data, stop the service first and
remove only the named test volume:

```sh
docker volume rm singularity-postgres-test-data
```
