import { PrismaPg } from "@prisma/adapter-pg";
import type { PoolConfig } from "pg";

import { Prisma, PrismaClient } from "./generated/prisma/client.js";

export { Prisma };

const DATABASE_CONNECTION_TIMEOUT_MS = 3_000;
const DATABASE_QUERY_TIMEOUT_MS = 5_000;
const DATABASE_STATEMENT_TIMEOUT_MS = 4_000;
const DATABASE_POOL_MAX_CONNECTIONS = 5;
const DATABASE_SCHEMA_NAME_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;

export class DatabaseConfigurationError extends Error {
  constructor() {
    super("PostgreSQL database configuration is unavailable");
    this.name = "DatabaseConfigurationError";
  }
}

function parseDatabaseUrl(databaseUrl: string | undefined): {
  poolConfig: PoolConfig;
  schema: string | undefined;
} {
  if (databaseUrl === undefined) {
    throw new DatabaseConfigurationError();
  }

  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new DatabaseConfigurationError();
  }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new DatabaseConfigurationError();
  }

  const schema = url.searchParams.get("schema") ?? undefined;
  if (schema !== undefined && !DATABASE_SCHEMA_NAME_PATTERN.test(schema)) {
    throw new DatabaseConfigurationError();
  }
  url.searchParams.delete("schema");
  url.searchParams.delete("connect_timeout");
  url.searchParams.delete("connectionTimeoutMillis");
  url.searchParams.delete("query_timeout");
  url.searchParams.delete("statement_timeout");
  url.searchParams.delete("options");

  return {
    poolConfig: {
      connectionString: url.toString(),
      connectionTimeoutMillis: DATABASE_CONNECTION_TIMEOUT_MS,
      max: DATABASE_POOL_MAX_CONNECTIONS,
      query_timeout: DATABASE_QUERY_TIMEOUT_MS,
      statement_timeout: DATABASE_STATEMENT_TIMEOUT_MS,
      ...(schema === undefined
        ? {}
        : { options: `-c search_path=${schema}` }),
    },
    schema,
  };
}

export class DatabaseClient extends PrismaClient {
  constructor(databaseUrl: string | undefined) {
    const { poolConfig, schema } = parseDatabaseUrl(databaseUrl);
    const adapter = new PrismaPg(
      poolConfig,
      schema === undefined ? undefined : { schema },
    );

    super({ adapter });
  }
}

export class DatabaseRuntime {
  readonly #state: DatabaseClient | DatabaseConfigurationError;

  constructor(databaseUrl: string | undefined) {
    try {
      this.#state = new DatabaseClient(databaseUrl);
    } catch (error) {
      if (error instanceof DatabaseConfigurationError) {
        this.#state = error;
        return;
      }

      throw error;
    }
  }

  get client(): DatabaseClient {
    if (this.#state instanceof DatabaseConfigurationError) {
      throw this.#state;
    }

    return this.#state;
  }

  async onApplicationShutdown(): Promise<void> {
    if (!(this.#state instanceof DatabaseConfigurationError)) {
      await this.#state.$disconnect();
    }
  }
}
