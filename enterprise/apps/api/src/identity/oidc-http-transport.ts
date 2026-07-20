import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";

const blockedAddresses = new BlockList();

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv4");
}

for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:2::", 48],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv6");
}

export interface OidcHttpRequest {
  readonly body?: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly maximumBodyBytes: number;
  readonly method: "GET" | "POST";
  readonly timeoutMilliseconds: number;
  readonly url: string | URL;
}

export interface OidcHttpResponse {
  readonly body: Buffer;
  readonly status: number;
}

export interface OidcHttpTransport {
  request(input: OidcHttpRequest): Promise<OidcHttpResponse>;
}

export class OidcHttpTransportError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OidcHttpTransportError";
  }
}

interface ApprovedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

type OidcHostnameResolver = (
  hostname: string,
) => Promise<readonly { readonly address: string; readonly family: number }[]>;

const systemHostnameResolver: OidcHostnameResolver = (hostname) =>
  lookup(hostname, { all: true, verbatim: true });

function hostnameWithoutBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function isPublicAddress(address: string, family: 4 | 6): boolean {
  return !blockedAddresses.check(address, family === 4 ? "ipv4" : "ipv6");
}

function deadlineError(signal: AbortSignal): OidcHttpTransportError {
  return signal.reason instanceof OidcHttpTransportError
    ? signal.reason
    : new OidcHttpTransportError("OIDC request exceeded the time limit", {
        cause: signal.reason,
      });
}

function waitWithinDeadline<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(deadlineError(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(deadlineError(signal));
    };
    signal.addEventListener("abort", abort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

async function resolveApprovedAddress(
  hostname: string,
  resolveHostname: OidcHostnameResolver,
  signal: AbortSignal,
): Promise<ApprovedAddress> {
  if (signal.aborted) {
    throw deadlineError(signal);
  }
  const literalFamily = isIP(hostname);
  if (literalFamily !== 0) {
    const family = literalFamily as 4 | 6;
    if (!isPublicAddress(hostname, family)) {
      throw new OidcHttpTransportError("OIDC endpoint address is not public");
    }
    return { address: hostname, family };
  }

  let addresses: readonly { readonly address: string; readonly family: number }[];
  try {
    addresses = await waitWithinDeadline(resolveHostname(hostname), signal);
  } catch (error) {
    if (signal.aborted) {
      throw deadlineError(signal);
    }
    throw new OidcHttpTransportError("OIDC endpoint lookup failed", {
      cause: error,
    });
  }
  if (addresses.length === 0) {
    throw new OidcHttpTransportError("OIDC endpoint lookup returned no address");
  }
  if (addresses.some(({ family }) => family !== 4 && family !== 6)) {
    throw new OidcHttpTransportError("OIDC endpoint address family is invalid");
  }
  const approvedAddresses = addresses as readonly ApprovedAddress[];
  if (
    approvedAddresses.some(
      ({ address, family }) => !isPublicAddress(address, family),
    )
  ) {
    throw new OidcHttpTransportError("OIDC endpoint address is not public");
  }
  const selected = approvedAddresses[0];
  if (selected === undefined) {
    throw new OidcHttpTransportError("OIDC endpoint lookup returned no address");
  }
  return selected;
}

export class SecureOidcHttpTransport implements OidcHttpTransport {
  constructor(
    private readonly resolveHostname: OidcHostnameResolver =
      systemHostnameResolver,
  ) {}

  /** 解析并固定 HTTPS 目标地址，拒绝私网 DNS、重定向、超大响应和总时限外的外连。 */
  async request(input: OidcHttpRequest): Promise<OidcHttpResponse> {
    let url: URL;
    try {
      url = new URL(input.url);
    } catch (error) {
      throw new OidcHttpTransportError("OIDC endpoint URL is invalid", {
        cause: error,
      });
    }
    if (
      url.protocol !== "https:" ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.hash.length > 0
    ) {
      throw new OidcHttpTransportError("OIDC endpoint URL is not allowed");
    }
    if (
      !Number.isSafeInteger(input.maximumBodyBytes) ||
      input.maximumBodyBytes <= 0 ||
      !Number.isSafeInteger(input.timeoutMilliseconds) ||
      input.timeoutMilliseconds <= 0
    ) {
      throw new OidcHttpTransportError("OIDC request limits are invalid");
    }

    const hostname = hostnameWithoutBrackets(url.hostname);
    const port = url.port.length === 0 ? 443 : Number(url.port);
    if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
      throw new OidcHttpTransportError("OIDC endpoint port is invalid");
    }
    const requestBody =
      input.body === undefined ? undefined : Buffer.from(input.body, "utf8");
    const deadline = new AbortController();
    const timeout = setTimeout(() => {
      deadline.abort(
        new OidcHttpTransportError("OIDC request exceeded the time limit"),
      );
    }, input.timeoutMilliseconds);
    try {
      const approvedAddress = await resolveApprovedAddress(
        hostname,
        this.resolveHostname,
        deadline.signal,
      );
      return await new Promise<OidcHttpResponse>((resolve, reject) => {
        let request: ReturnType<typeof httpsRequest> | null = null;
        let settled = false;
        let abortRequest = (): void => undefined;
        const finish = (
          outcome:
            | { readonly error: OidcHttpTransportError }
            | { readonly response: OidcHttpResponse },
        ): void => {
          if (settled) {
            return;
          }
          settled = true;
          deadline.signal.removeEventListener("abort", abortRequest);
          if ("error" in outcome) {
            reject(outcome.error);
          } else {
            resolve(outcome.response);
          }
        };
        abortRequest = () => {
          const error = deadlineError(deadline.signal);
          request?.destroy(error);
          finish({ error });
        };
        request = httpsRequest(
          {
            headers: {
              ...input.headers,
              Host: url.host,
              ...(requestBody === undefined
                ? {}
                : { "Content-Length": String(requestBody.byteLength) }),
            },
            hostname: approvedAddress.address,
            method: input.method,
            path: `${url.pathname}${url.search}`,
            port,
            ...(isIP(hostname) === 0 ? { servername: hostname } : {}),
          },
          (response) => {
            if (deadline.signal.aborted) {
              response.destroy();
              finish({ error: deadlineError(deadline.signal) });
              return;
            }
            const contentEncoding = response.headers["content-encoding"];
            if (
              contentEncoding !== undefined &&
              (typeof contentEncoding !== "string" ||
                contentEncoding.toLowerCase() !== "identity")
            ) {
              response.destroy();
              finish({
                error: new OidcHttpTransportError(
                  "OIDC response content encoding is not allowed",
                ),
              });
              return;
            }
            const contentLength = response.headers["content-length"];
            if (
              contentLength !== undefined &&
              (typeof contentLength !== "string" ||
                !/^\d+$/.test(contentLength) ||
                Number(contentLength) > input.maximumBodyBytes)
            ) {
              response.destroy();
              finish({
                error: new OidcHttpTransportError(
                  "OIDC response exceeded the byte limit",
                ),
              });
              return;
            }

            const chunks: Buffer[] = [];
            let totalBytes = 0;
            response.on("data", (chunk: Buffer | string) => {
              const bytes = Buffer.isBuffer(chunk)
                ? chunk
                : Buffer.from(chunk, "utf8");
              totalBytes += bytes.byteLength;
              if (totalBytes > input.maximumBodyBytes) {
                response.destroy();
                finish({
                  error: new OidcHttpTransportError(
                    "OIDC response exceeded the byte limit",
                  ),
                });
                return;
              }
              chunks.push(bytes);
            });
            response.once("aborted", () => {
              finish({
                error: deadline.signal.aborted
                  ? deadlineError(deadline.signal)
                  : new OidcHttpTransportError("OIDC response was aborted"),
              });
            });
            response.once("error", (error) => {
              finish({
                error: deadline.signal.aborted
                  ? deadlineError(deadline.signal)
                  : new OidcHttpTransportError("OIDC response failed", {
                      cause: error,
                    }),
              });
            });
            response.once("end", () => {
              if (deadline.signal.aborted) {
                finish({ error: deadlineError(deadline.signal) });
                return;
              }
              const status = response.statusCode;
              if (status === undefined) {
                finish({
                  error: new OidcHttpTransportError(
                    "OIDC response status is unavailable",
                  ),
                });
                return;
              }
              finish({
                response: { body: Buffer.concat(chunks, totalBytes), status },
              });
            });
          },
        );
        deadline.signal.addEventListener("abort", abortRequest, { once: true });
        request.once("error", (error) => {
          finish({
            error:
              error instanceof OidcHttpTransportError
                ? error
                : new OidcHttpTransportError("OIDC request failed", {
                    cause: error,
                  }),
          });
        });
        if (deadline.signal.aborted) {
          abortRequest();
        } else if (requestBody === undefined) {
          request.end();
        } else {
          request.end(requestBody);
        }
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
