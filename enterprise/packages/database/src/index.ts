import { PrismaPg } from "@prisma/adapter-pg";
import {
  Client,
  escapeIdentifier,
  type ClientConfig,
  type Notification,
  type PoolConfig,
} from "pg";

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
  notificationConfig: ClientConfig;
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

  const connectionConfig = {
    connectionString: url.toString(),
    connectionTimeoutMillis: DATABASE_CONNECTION_TIMEOUT_MS,
    query_timeout: DATABASE_QUERY_TIMEOUT_MS,
    statement_timeout: DATABASE_STATEMENT_TIMEOUT_MS,
    ...(schema === undefined ? {} : { options: `-c search_path=${schema}` }),
  } satisfies ClientConfig;

  return {
    notificationConfig: connectionConfig,
    poolConfig: { ...connectionConfig, max: DATABASE_POOL_MAX_CONNECTIONS },
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

export interface DatabaseNotificationSubscription {
  close(): Promise<void>;
}

export class DatabaseRuntime {
  readonly #notificationSubscriptions =
    new Set<DatabaseNotificationSubscription>();
  readonly #notificationConfig: ClientConfig | undefined;
  readonly #state: DatabaseClient | DatabaseConfigurationError;

  constructor(databaseUrl: string | undefined) {
    try {
      const { notificationConfig } = parseDatabaseUrl(databaseUrl);
      this.#notificationConfig = notificationConfig;
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

  async listen(
    channel: string,
    onNotification: (payload: string) => void,
    onFailure: (error: Error) => void,
  ): Promise<DatabaseNotificationSubscription> {
    if (this.#notificationConfig === undefined) {
      throw this.#state;
    }

    const client = new Client(this.#notificationConfig);
    let state: "opening" | "listening" | "failed" | "closing" | "closed" =
      "opening";
    let openingFailure: Error | undefined;
    let closePromise: Promise<void> | undefined;
    let subscription: DatabaseNotificationSubscription;
    const close = async (): Promise<void> => {
      if (closePromise !== undefined) {
        await closePromise;
        return;
      }
      closePromise = (async () => {
        state = "closing";
        this.#notificationSubscriptions.delete(subscription);
        client.removeAllListeners();
        try {
          await client.end();
        } finally {
          state = "closed";
        }
      })();
      await closePromise;
    };
    subscription = { close };
    const fail = (error: Error): void => {
      if (state === "opening") {
        openingFailure ??= error;
        return;
      }
      if (state !== "listening") {
        return;
      }
      state = "failed";
      onFailure(error);
    };
    client.on("notification", (notification: Notification) => {
      if (
        state === "listening" &&
        notification.channel === channel &&
        notification.payload !== undefined
      ) {
        onNotification(notification.payload);
      }
    });
    client.on("error", fail);
    client.on("end", () => {
      fail(new Error("PostgreSQL notification connection ended unexpectedly"));
    });

    try {
      await client.connect();
      await client.query(`LISTEN ${escapeIdentifier(channel)}`);
      if (openingFailure !== undefined) {
        throw openingFailure;
      }
    } catch (error) {
      await close();
      throw error;
    }
    state = "listening";
    this.#notificationSubscriptions.add(subscription);
    return subscription;
  }

  async onApplicationShutdown(): Promise<void> {
    const notificationSubscriptions = [...this.#notificationSubscriptions];
    await Promise.allSettled(
      notificationSubscriptions.map((subscription) => subscription.close()),
    );
    if (!(this.#state instanceof DatabaseConfigurationError)) {
      await this.#state.$disconnect();
    }
  }
}
