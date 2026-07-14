import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createServer, type Socket } from "node:net";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";

import { Pool } from "pg";
import { inject } from "vitest";

import { DatabaseClient } from "../../src/index.js";

declare module "vitest" {
  export interface ProvidedContext {
    isolatedDatabaseUrl: string;
  }
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const defaultPrismaConfigPath = resolve(packageRoot, "prisma.config.ts");
const defaultMigrationTimeoutMilliseconds = 20_000;
const migrationKillGraceMilliseconds = 1_000;
const testDatabaseConnectionTimeoutMilliseconds = 3_000;
const testDatabaseQueryTimeoutMilliseconds = 5_000;
const testDatabaseStatementTimeoutMilliseconds = 4_000;
const schemaNamePattern = /^[a-z][a-z0-9_]{0,62}$/;

export interface IsolatedPostgres {
  databaseUrl: string;
  schemaName: string;
  dispose(): Promise<void>;
}

export interface IsolatedPostgresOptions {
  migrationTimeoutMilliseconds?: number;
  purpose?: string;
  prismaConfigPath?: string;
}

export interface PostgresHandshakeBlackhole {
  port: number;
  dispose(): Promise<void>;
}

interface GlobalSetupProject {
  name?: string;
  provide(key: "isolatedDatabaseUrl", value: string): void;
}

export async function createPostgresHandshakeBlackhole(): Promise<PostgresHandshakeBlackhole> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    const handleError = (error: Error): void => rejectListen(error);
    server.once("error", handleError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", handleError);
      resolveListen();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => {
        if (error === undefined) {
          resolveClose();
          return;
        }
        rejectClose(error);
      });
    });
    throw new Error("The PostgreSQL handshake blackhole has no TCP port");
  }

  let disposed = false;
  return {
    port: address.port,
    async dispose(): Promise<void> {
      if (disposed) {
        return;
      }

      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error === undefined) {
            disposed = true;
            resolveClose();
            return;
          }
          rejectClose(error);
        });
      });
    },
  };
}

function getBaseTestDatabaseUrl(): URL {
  const configuredUrl = process.env.SINGULARITY_TEST_DATABASE_URL;
  if (configuredUrl === undefined) {
    throw new Error("SINGULARITY_TEST_DATABASE_URL is required");
  }

  const url = new URL(configuredUrl);
  const databaseName = decodeURIComponent(url.pathname.slice(1));
  if (!databaseName.endsWith("_test")) {
    throw new Error("The PostgreSQL test database name must end with _test");
  }

  url.searchParams.delete("schema");
  url.searchParams.delete("connect_timeout");
  url.searchParams.delete("connectionTimeoutMillis");
  url.searchParams.delete("query_timeout");
  url.searchParams.delete("statement_timeout");
  return url;
}

function createSchemaName(purpose: string): string {
  const normalizedPurpose = purpose
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 16);
  const safePurpose = normalizedPurpose.length === 0 ? "project" : normalizedPurpose;
  const schemaName = `sg_${safePurpose}_${randomBytes(8).toString("hex")}`;

  if (!schemaNamePattern.test(schemaName)) {
    throw new Error("Generated PostgreSQL schema name is invalid");
  }

  return schemaName;
}

async function runMigrations(
  databaseUrl: string,
  prismaConfigPath: string,
  timeoutMilliseconds: number,
): Promise<void> {
  const prismaCliPath = createRequire(import.meta.url).resolve(
    "prisma/build/index.js",
  );

  await new Promise<void>((resolveMigration, rejectMigration) => {
    const child = spawn(
      process.execPath,
      [prismaCliPath, "migrate", "deploy", "--config", prismaConfigPath],
      {
        cwd: packageRoot,
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
        },
        stdio: "ignore",
      },
    );
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    let migrationTimedOut = false;
    let startError: Error | undefined;
    const migrationTimer = setTimeout(() => {
      migrationTimedOut = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, migrationKillGraceMilliseconds);
    }, timeoutMilliseconds);

    child.once("error", (error) => {
      startError = new Error("Unable to start Prisma migrate deploy", {
        cause: error,
      });
    });
    child.once("close", (code, signal) => {
      clearTimeout(migrationTimer);
      if (forceKillTimer !== undefined) {
        clearTimeout(forceKillTimer);
      }

      if (startError !== undefined) {
        rejectMigration(startError);
        return;
      }

      if (migrationTimedOut) {
        rejectMigration(
          new Error(
            `Prisma migrate deploy timed out after ${String(timeoutMilliseconds)}ms`,
          ),
        );
        return;
      }

      if (code === 0) {
        resolveMigration();
        return;
      }

      rejectMigration(
        new Error(
          signal === null
            ? `Prisma migrate deploy exited with code ${String(code)}`
            : `Prisma migrate deploy exited after signal ${signal}`,
        ),
      );
    });
  });
}

async function dropSchema(pool: Pool, schemaName: string): Promise<void> {
  if (!schemaNamePattern.test(schemaName)) {
    throw new Error("PostgreSQL schema name is invalid");
  }

  await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
}

export async function createIsolatedPostgres(
  options: IsolatedPostgresOptions = {},
): Promise<IsolatedPostgres> {
  const baseUrl = getBaseTestDatabaseUrl();
  const schemaName = createSchemaName(options.purpose ?? "project");
  const isolatedUrl = new URL(baseUrl);
  isolatedUrl.searchParams.set("schema", schemaName);
  const databaseUrl = isolatedUrl.toString();
  const pool = new Pool({
    connectionString: baseUrl.toString(),
    connectionTimeoutMillis: testDatabaseConnectionTimeoutMilliseconds,
    query_timeout: testDatabaseQueryTimeoutMilliseconds,
    statement_timeout: testDatabaseStatementTimeoutMilliseconds,
  });
  let schemaCreated = false;

  try {
    await pool.query(`CREATE SCHEMA "${schemaName}"`);
    schemaCreated = true;
    await runMigrations(
      databaseUrl,
      options.prismaConfigPath ?? defaultPrismaConfigPath,
      options.migrationTimeoutMilliseconds ??
        defaultMigrationTimeoutMilliseconds,
    );

    const probe = new DatabaseClient(databaseUrl);
    try {
      await probe.$connect();
      await probe.$queryRaw`SELECT 1`;
    } finally {
      await probe.$disconnect();
    }
  } catch (setupError) {
    if (schemaCreated) {
      try {
        await dropSchema(pool, schemaName);
      } catch (cleanupError) {
        throw new AggregateError(
          [setupError, cleanupError],
          "PostgreSQL project setup and cleanup both failed",
          { cause: cleanupError },
        );
      }
    }
    throw setupError;
  } finally {
    await pool.end();
  }

  let disposed = false;

  return {
    databaseUrl,
    schemaName,
    async dispose(): Promise<void> {
      if (disposed) {
        return;
      }

      const cleanupPool = new Pool({
        connectionString: baseUrl.toString(),
        connectionTimeoutMillis: testDatabaseConnectionTimeoutMilliseconds,
        query_timeout: testDatabaseQueryTimeoutMilliseconds,
        statement_timeout: testDatabaseStatementTimeoutMilliseconds,
      });
      try {
        await dropSchema(cleanupPool, schemaName);
        disposed = true;
      } finally {
        await cleanupPool.end();
      }
    },
  };
}

export function isolatedDatabaseUrl(): string {
  return inject("isolatedDatabaseUrl");
}

export default async function setupPostgresProject(
  project: GlobalSetupProject,
): Promise<() => Promise<void>> {
  const isolatedPostgres = await createIsolatedPostgres({
    purpose: project.name ?? "project",
  });
  project.provide("isolatedDatabaseUrl", isolatedPostgres.databaseUrl);

  return async () => {
    await isolatedPostgres.dispose();
  };
}
