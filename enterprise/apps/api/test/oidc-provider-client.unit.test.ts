import {
  generateKeyPairSync,
  randomUUID,
  sign,
  type KeyObject,
} from "node:crypto";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  FetchOidcProviderClient,
  FileOidcClientSecretResolver,
  type OidcClientSecretResolver,
  type OidcHttpTransport,
} from "../src/identity/oidc.service.js";
import { SecureOidcHttpTransport } from "../src/identity/oidc-http-transport.js";

const ISSUER = "https://identity.example.test/tenant";
const AUTHORIZATION_ENDPOINT = `${ISSUER}/authorize`;
const TOKEN_ENDPOINT = `${ISSUER}/token`;
const JWKS_URI = `${ISSUER}/jwks`;
const REDIRECT_URI = "https://singularity.test/api/v1/auth/oidc/callback";
const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

function discoveryResponse(): Response {
  return jsonResponse({
    authorization_endpoint: AUTHORIZATION_ENDPOINT,
    issuer: ISSUER,
    jwks_uri: JWKS_URI,
    token_endpoint: TOKEN_ENDPOINT,
  });
}

function provider(input: {
  clientId?: string;
  clientSecretReference?: string | null;
} = {}) {
  return {
    clientId: input.clientId ?? "singularity-enterprise",
    clientSecretReference: input.clientSecretReference ?? null,
    issuer: ISSUER,
    organizationId: ORGANIZATION_ID,
  };
}

function fetchTransport(): OidcHttpTransport {
  return {
    async request(input) {
      const response = await fetch(input.url, {
        ...(input.body === undefined ? {} : { body: input.body }),
        headers: input.headers,
        method: input.method,
      });
      const body = Buffer.from(await response.arrayBuffer());
      if (body.byteLength > input.maximumBodyBytes) {
        throw new Error("OIDC response exceeded the byte limit");
      }
      return { body, status: response.status };
    },
  };
}

function publicClientSecretResolver(): OidcClientSecretResolver {
  return {
    assertBound: vi.fn(),
    resolve: vi.fn(async () => "unused"),
  };
}

function exchangeInput(currentTime: () => Date) {
  return {
    code: "authorization-code",
    codeVerifier: "code-verifier",
    currentTime,
    redirectUri: REDIRECT_URI,
  };
}

function signedRs256Token(
  privateKey: KeyObject,
  keyId: string,
  claims: Readonly<Record<string, unknown>>,
  additionalHeader: Readonly<Record<string, unknown>> = {},
): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: keyId, typ: "JWT", ...additionalHeader }),
    "utf8",
  ).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString(
    "base64url",
  );
  const signingInput = Buffer.from(`${header}.${payload}`, "ascii");
  const signature = sign("sha256", signingInput, privateKey).toString(
    "base64url",
  );
  return `${header}.${payload}.${signature}`;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("FetchOidcProviderClient OAuth and JOSE boundary", () => {
  test("requires a secret reference to match its deployment-bound organization, issuer, and client", () => {
    const resolver = new FileOidcClientSecretResolver([
      {
        clientId: "singularity-enterprise",
        issuer: ISSUER,
        organizationId: ORGANIZATION_ID,
        reference: "corporate",
        secretFile: "/run/secrets/corporate",
      },
    ]);

    expect(() =>
      resolver.assertBound(
        provider({ clientSecretReference: "corporate" }),
      ),
    ).not.toThrow();
    for (const unbound of [
      {
        ...provider({ clientSecretReference: "corporate" }),
        organizationId: "22222222-2222-4222-8222-222222222222",
      },
      {
        ...provider({ clientSecretReference: "corporate" }),
        issuer: "https://attacker.example.test/tenant",
      },
      provider({
        clientId: "attacker-client",
        clientSecretReference: "corporate",
      }),
    ]) {
      let rejection: unknown;
      try {
        resolver.assertBound(unbound);
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toMatchObject({
        cause: expect.any(Error),
        code: "service-unavailable",
        status: 503,
      });
    }
  });

  test("form-encodes client_secret_basic and maps an upstream 5xx to service unavailable", async () => {
    const clientId = "client:id %";
    const secret = "secret:value %";
    const resolver: OidcClientSecretResolver = {
      assertBound: vi.fn(),
      resolve: vi.fn(async () => secret),
    };
    let tokenRequest: Request | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        if (request.url.endsWith("/.well-known/openid-configuration")) {
          return discoveryResponse();
        }
        if (request.url === TOKEN_ENDPOINT) {
          tokenRequest = request;
          return jsonResponse({ error: "temporarily_unavailable" }, 503);
        }
        throw new Error(`Unexpected OIDC request: ${request.url}`);
      }),
    );
    const client = new FetchOidcProviderClient(resolver, fetchTransport());

    await expect(
      client.exchangeAuthorizationCode(
        provider({ clientId, clientSecretReference: "corporate" }),
        exchangeInput(() => new Date("2026-07-20T00:00:00.000Z")),
      ),
    ).rejects.toMatchObject({ code: "service-unavailable", status: 503 });

    expect(tokenRequest).toBeDefined();
    expect(tokenRequest?.headers.get("authorization")).toBe(
      `Basic ${Buffer.from("client%3Aid+%25:secret%3Avalue+%25", "utf8").toString("base64")}`,
    );
    if (tokenRequest === undefined) {
      throw new Error("The token request was not captured");
    }
    expect(
      new URLSearchParams(await tokenRequest.clone().text()).has("client_id"),
    ).toBe(false);
  });

  test("maps an OAuth invalid_grant response to unauthenticated", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        return request.url.endsWith("/.well-known/openid-configuration")
          ? discoveryResponse()
          : jsonResponse({ error: "invalid_grant" }, 400);
      }),
    );
    const client = new FetchOidcProviderClient(
      publicClientSecretResolver(),
      fetchTransport(),
    );

    await expect(
      client.exchangeAuthorizationCode(
        provider(),
        exchangeInput(() => new Date("2026-07-20T00:00:00.000Z")),
      ),
    ).rejects.toMatchObject({ code: "unauthenticated", status: 401 });
  });

  test("rejects an oversized OIDC discovery response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        new Response("x".repeat(64 * 1_024 + 1), { status: 200 }),
      ),
    );
    const client = new FetchOidcProviderClient(
      publicClientSecretResolver(),
      fetchTransport(),
    );

    await expect(
      client.createAuthorizationUrl(provider(), {
        codeChallenge: "challenge",
        nonce: "nonce",
        redirectUri: REDIRECT_URI,
        state: "state",
      }),
    ).rejects.toMatchObject({
      cause: expect.any(Error),
      code: "service-unavailable",
      status: 503,
    });
  });

  test("enforces the wall-clock deadline while hostname resolution is pending", async () => {
    vi.useFakeTimers();
    const transport = new SecureOidcHttpTransport(
      () =>
        new Promise<
          readonly { readonly address: string; readonly family: number }[]
        >(() => undefined),
    );
    const pending = transport.request({
      headers: { Accept: "application/json" },
      maximumBodyBytes: 1_024,
      method: "GET",
      timeoutMilliseconds: 100,
      url: ISSUER,
    });
    const rejection = expect(pending).rejects.toMatchObject({
      message: "OIDC request exceeded the time limit",
      name: "OidcHttpTransportError",
    });

    await vi.advanceTimersByTimeAsync(100);
    await rejection;
  });

  test("accepts RS256 only with one matching RSA key of at least 2048 bits", async () => {
    const keyId = randomUUID();
    const keys = generateKeyPairSync("rsa", { modulusLength: 2_048 });
    const now = new Date("2026-07-20T00:00:00.000Z");
    const nonce = "oidc-nonce";
    const subject = randomUUID();
    const token = signedRs256Token(keys.privateKey, keyId, {
      aud: "singularity-enterprise",
      exp: Math.floor(now.getTime() / 1_000) + 300,
      iat: Math.floor(now.getTime() / 1_000),
      iss: ISSUER,
      nonce,
      sub: subject,
    });
    let jwksCompleted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        if (request.url.endsWith("/.well-known/openid-configuration")) {
          return discoveryResponse();
        }
        if (request.url === TOKEN_ENDPOINT) {
          return jsonResponse({ id_token: token });
        }
        if (request.url === JWKS_URI) {
          jwksCompleted = true;
          return jsonResponse({
            keys: [
              {
                ...keys.publicKey.export({ format: "jwk" }),
                alg: "RS256",
                key_ops: ["verify"],
                kid: keyId,
                use: "sig",
              },
            ],
          });
        }
        throw new Error(`Unexpected OIDC request: ${request.url}`);
      }),
    );
    const client = new FetchOidcProviderClient(
      publicClientSecretResolver(),
      fetchTransport(),
    );
    const currentTime = vi.fn(() => {
      expect(jwksCompleted).toBe(true);
      return now;
    });

    await expect(
      client.exchangeAuthorizationCode(provider(), exchangeInput(currentTime)),
    ).resolves.toEqual({
      email: null,
      emailVerified: false,
      nonce,
      subject,
    });
    expect(currentTime).toHaveBeenCalledTimes(1);
  });

  test.each([
    {
      additionalHeader: { crit: ["unsupported"] },
      claims: {},
      label: "an unsupported critical JOSE header",
    },
    {
      additionalHeader: { b64: false, crit: ["b64"] },
      claims: {},
      label: "an unencoded JOSE payload extension",
    },
    {
      additionalHeader: {},
      claims: {
        nbf:
          Math.floor(
            new Date("2026-07-20T00:00:00.000Z").getTime() / 1_000,
          ) + 120,
      },
      label: "a future not-before claim",
    },
    {
      additionalHeader: {},
      claims: { sub: "s".repeat(256) },
      label: "a subject longer than the OIDC persistence contract",
    },
  ])("rejects $label", async ({ additionalHeader, claims }) => {
    const keyId = randomUUID();
    const keys = generateKeyPairSync("rsa", { modulusLength: 2_048 });
    const now = new Date("2026-07-20T00:00:00.000Z");
    const token = signedRs256Token(
      keys.privateKey,
      keyId,
      {
        aud: "singularity-enterprise",
        exp: Math.floor(now.getTime() / 1_000) + 300,
        iat: Math.floor(now.getTime() / 1_000),
        iss: ISSUER,
        nonce: "oidc-nonce",
        sub: randomUUID(),
        ...claims,
      },
      additionalHeader,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        if (request.url.endsWith("/.well-known/openid-configuration")) {
          return discoveryResponse();
        }
        if (request.url === TOKEN_ENDPOINT) {
          return jsonResponse({ id_token: token });
        }
        if (request.url === JWKS_URI) {
          return jsonResponse({
            keys: [
              {
                ...keys.publicKey.export({ format: "jwk" }),
                alg: "RS256",
                key_ops: ["verify"],
                kid: keyId,
                use: "sig",
              },
            ],
          });
        }
        throw new Error(`Unexpected OIDC request: ${request.url}`);
      }),
    );
    const client = new FetchOidcProviderClient(
      publicClientSecretResolver(),
      fetchTransport(),
    );

    await expect(
      client.exchangeAuthorizationCode(
        provider(),
        exchangeInput(() => now),
      ),
    ).rejects.toMatchObject({ code: "unauthenticated", status: 401 });
  });

  test("rejects an RS256 token when the matching JWKS key is elliptic-curve", async () => {
    const keyId = randomUUID();
    const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const header = Buffer.from(
      JSON.stringify({ alg: "RS256", kid: keyId }),
      "utf8",
    ).toString("base64url");
    const payload = Buffer.from("{}", "utf8").toString("base64url");
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        if (request.url.endsWith("/.well-known/openid-configuration")) {
          return discoveryResponse();
        }
        if (request.url === TOKEN_ENDPOINT) {
          return jsonResponse({ id_token: `${header}.${payload}.AA` });
        }
        if (request.url === JWKS_URI) {
          return jsonResponse({
            keys: [
              {
                ...keys.publicKey.export({ format: "jwk" }),
                kid: keyId,
                use: "sig",
              },
            ],
          });
        }
        throw new Error(`Unexpected OIDC request: ${request.url}`);
      }),
    );
    const client = new FetchOidcProviderClient(
      publicClientSecretResolver(),
      fetchTransport(),
    );

    await expect(
      client.exchangeAuthorizationCode(
        provider(),
        exchangeInput(() => new Date("2026-07-20T00:00:00.000Z")),
      ),
    ).rejects.toMatchObject({ code: "unauthenticated", status: 401 });
  });

  test.each([
    "https://127.0.0.1/oidc",
    "https://[::1]/oidc",
    "https://localhost/oidc",
    "https://169.254.169.254/latest/meta-data",
  ])("rejects a non-public OIDC endpoint before connecting: %s", async (url) => {
    const transport = new SecureOidcHttpTransport();

    await expect(
      transport.request({
        headers: { Accept: "application/json" },
        maximumBodyBytes: 1_024,
        method: "GET",
        timeoutMilliseconds: 100,
        url,
      }),
    ).rejects.toMatchObject({
      name: "OidcHttpTransportError",
    });
  });
});
