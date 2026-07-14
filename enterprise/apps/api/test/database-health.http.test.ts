import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import {
  DATABASE_READINESS_PATH,
  DATABASE_READY_OPENAPI_SCHEMA,
  DATABASE_READY_RESPONSE,
  DATABASE_UNAVAILABLE_OPENAPI_SCHEMA,
  DATABASE_UNAVAILABLE_RESPONSE,
  OPENAPI_DOCUMENT_PATH,
} from "@singularity/contracts";
import { DatabaseRuntime } from "@singularity/database";
import {
  createPostgresHandshakeBlackhole,
  isolatedDatabaseUrl,
} from "@singularity/database/testing/postgres";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { createApiApplication } from "../src/application.js";
import { CapturingLogger } from "./support/capturing-logger.js";

const requestIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const publicOrigin = "https://singularity.test/";

const configurationErrorCases: ReadonlyArray<{
  databaseUrl: string | undefined;
  forbiddenFragments: readonly string[];
  name: string;
}> = [
  {
    name: "missing PostgreSQL URL",
    databaseUrl: undefined,
    forbiddenFragments: [],
  },
  {
    name: "malformed PostgreSQL URL",
    databaseUrl: "postgresql://singularity:malformed-secret-sentinel@[",
    forbiddenFragments: ["malformed-secret-sentinel"],
  },
  {
    name: "unsupported database protocol",
    databaseUrl:
      "mysql://singularity:protocol-secret-sentinel@127.0.0.1:3306/singularity",
    forbiddenFragments: ["protocol-secret-sentinel"],
  },
];

interface ReadinessOpenApiDocument {
  openapi: string;
  paths: Record<
    string,
    {
      get: {
        responses: Record<
          string,
          {
            content: Record<string, { schema: unknown }>;
          }
        >;
      };
    }
  >;
}

describe("database readiness HTTP contract", () => {
  let app: NestFastifyApplication;
  let baseUrl: string;

  beforeAll(async () => {
    app = await createApiApplication({
      databaseUrl: isolatedDatabaseUrl(),
      publicOrigin,
    });
    await app.listen(0, "127.0.0.1");
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  test("returns ready through real HTTP and replaces a client request ID", async () => {
    const response = await fetch(`${baseUrl}${DATABASE_READINESS_PATH}`, {
      headers: {
        "X-Request-Id": "client-controlled",
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-request-id")).toMatch(requestIdPattern);
    expect(response.headers.get("x-request-id")).not.toBe("client-controlled");
    await expect(response.json()).resolves.toEqual(DATABASE_READY_RESPONSE);
  });

  test.each(configurationErrorCases)(
    "keeps readiness HTTP available for $name",
    async ({ databaseUrl, forbiddenFragments }) => {
      const logger = new CapturingLogger();
      const unavailableApp = await createApiApplication({
        databaseUrl,
        logger,
        publicOrigin,
      });

      try {
        await unavailableApp.listen(0, "127.0.0.1");
        const unavailableBaseUrl = await unavailableApp.getUrl();
        const response = await fetch(
          `${unavailableBaseUrl}${DATABASE_READINESS_PATH}`,
        );
        const responseText = await response.text();
        const observedOutput = [
          JSON.stringify(Object.fromEntries(response.headers)),
          responseText,
          logger.output,
        ].join("\n");

        expect(response.status).toBe(503);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("x-request-id")).toMatch(requestIdPattern);
        expect(JSON.parse(responseText)).toEqual(DATABASE_UNAVAILABLE_RESPONSE);
        for (const fragment of forbiddenFragments) {
          expect(observedOutput).not.toContain(fragment);
        }
      } finally {
        await unavailableApp.close();
      }
    },
  );

  test("returns unavailable when PostgreSQL does not finish its handshake", async () => {
    const blackhole = await createPostgresHandshakeBlackhole();
    const unavailableUrl = new URL(isolatedDatabaseUrl());
    unavailableUrl.hostname = "127.0.0.1";
    unavailableUrl.port = String(blackhole.port);
    unavailableUrl.searchParams.set("connect_timeout", "1");
    unavailableUrl.searchParams.set("connectionTimeoutMillis", "250");
    let unavailableApp: NestFastifyApplication | undefined;

    try {
      unavailableApp = await createApiApplication({
        databaseUrl: unavailableUrl.toString(),
        publicOrigin,
      });
      await unavailableApp.listen(0, "127.0.0.1");
      const unavailableBaseUrl = await unavailableApp.getUrl();
      const startedAt = performance.now();
      const response = await fetch(
        `${unavailableBaseUrl}${DATABASE_READINESS_PATH}`,
        { signal: AbortSignal.timeout(8_000) },
      );
      const elapsedMilliseconds = performance.now() - startedAt;
      const responseText = await response.text();

      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(JSON.parse(responseText)).toEqual(DATABASE_UNAVAILABLE_RESPONSE);
      expect(responseText).not.toContain("127.0.0.1");
      expect(responseText).not.toContain("singularity_test");
      expect(elapsedMilliseconds).toBeGreaterThanOrEqual(2_500);
      expect(elapsedMilliseconds).toBeLessThan(5_000);
    } finally {
      try {
        await blackhole.dispose();
      } finally {
        await unavailableApp?.close();
      }
    }
  });

  test("disconnects PostgreSQL only after the HTTP server closes", async () => {
    const shutdownApp = await createApiApplication({
      databaseUrl: isolatedDatabaseUrl(),
      publicOrigin,
    });
    await shutdownApp.listen(0, "127.0.0.1");
    const server = shutdownApp.getHttpServer();
    const database = shutdownApp.get(DatabaseRuntime).client;
    const disconnect = database.$disconnect.bind(database);
    let serverClosed = false;
    server.once("close", () => {
      serverClosed = true;
    });
    const disconnectSpy = vi
      .spyOn(database, "$disconnect")
      .mockImplementation(async () => {
        expect(serverClosed).toBe(true);
        await disconnect();
      });

    try {
      await shutdownApp.close();
      expect(disconnectSpy).toHaveBeenCalledOnce();
    } finally {
      disconnectSpy.mockRestore();
      if (server.listening) {
        await shutdownApp.close();
      }
    }
  });

  test("publishes complete OpenAPI response schemas for database readiness", async () => {
    const response = await fetch(`${baseUrl}${OPENAPI_DOCUMENT_PATH}`);
    const document = (await response.json()) as ReadinessOpenApiDocument;
    const responses = document.paths[DATABASE_READINESS_PATH]?.get.responses;

    expect(response.status).toBe(200);
    expect(document.openapi).toBe("3.1.0");
    expect(responses?.["200"]?.content).toEqual({
      "application/json": {
        schema: DATABASE_READY_OPENAPI_SCHEMA,
      },
    });
    expect(responses?.["503"]?.content).toEqual({
      "application/json": {
        schema: DATABASE_UNAVAILABLE_OPENAPI_SCHEMA,
      },
    });
  });
});
