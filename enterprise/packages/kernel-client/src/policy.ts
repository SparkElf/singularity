import type { KernelRoutePolicy } from "@singularity/authorization";

export interface ResolvedKernelRoutePolicy extends KernelRoutePolicy {
  method: Uppercase<string>;
  requestHeaders: readonly string[];
  responseHeaders: readonly string[];
}

const ENCODED_PATH_SEPARATOR = /%2f|%5c/i;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const TERMINAL_WILDCARD = /\/\*[A-Za-z][A-Za-z0-9_]*$/;

function normalizeHeaders(headers: readonly string[]): readonly string[] {
  const normalized = headers.map((header) => header.toLowerCase());
  if (
    normalized.some(
      (header, index) =>
        !HEADER_NAME.test(header) || normalized.indexOf(header) !== index,
    )
  ) {
    throw new Error("Kernel route policy is unavailable");
  }
  return Object.freeze(normalized);
}

export function canonicalKernelPath(value: string): `/${string}` {
  const rawPath = value.split("?", 1)[0] ?? "";
  let decodedSegments: string[];
  try {
    decodedSegments = rawPath.split("/").map((segment) => decodeURIComponent(segment));
  } catch (error) {
    throw new Error("Kernel route is unavailable", { cause: error });
  }
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    value.includes("//") ||
    ENCODED_PATH_SEPARATOR.test(value) ||
    decodedSegments.some(
      (segment) =>
        segment === "." ||
        segment === ".." ||
        segment.includes("/") ||
        segment.includes("\\"),
    )
  ) {
    throw new Error("Kernel route is unavailable");
  }

  const parsed = new URL(value, "https://kernel.invalid");
  if (
    parsed.origin !== "https://kernel.invalid" ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new Error("Kernel route is unavailable");
  }
  return parsed.pathname as `/${string}`;
}

function canonicalPolicyPath(value: `/${string}`): {
  path: `/${string}`;
  wildcardPrefix?: `/${string}`;
} {
  const wildcard = value.match(TERMINAL_WILDCARD);
  if (wildcard === null) {
    return { path: canonicalKernelPath(value) };
  }
  const prefix = value.slice(0, wildcard.index);
  const canonicalPrefix = canonicalKernelPath(prefix);
  return {
    path: value,
    wildcardPrefix: `${canonicalPrefix}/` as `/${string}`,
  };
}

function policyKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

export class KernelRoutePolicyRegistry {
  readonly #policies = new Map<string, ResolvedKernelRoutePolicy>();
  readonly #wildcardPolicies: Array<{
    method: Uppercase<string>;
    policy: ResolvedKernelRoutePolicy;
    prefix: `/${string}`;
  }> = [];

  constructor(policies: Iterable<KernelRoutePolicy>) {
    for (const policy of policies) {
      const { path, wildcardPrefix } = canonicalPolicyPath(policy.path);
      const method = policy.method.toUpperCase() as Uppercase<string>;
      if (method.length === 0) {
        throw new Error("Kernel route policy is unavailable");
      }
      const resolved = Object.freeze({
        ...policy,
        method,
        path,
        requestHeaders: normalizeHeaders(policy.requestHeaders),
        responseHeaders: normalizeHeaders(policy.responseHeaders),
      });
      if (wildcardPrefix === undefined) {
        const key = policyKey(method, path);
        if (this.#policies.has(key)) {
          throw new Error("Kernel route policy is unavailable");
        }
        this.#policies.set(key, resolved);
      } else {
        if (
          this.#wildcardPolicies.some(
            (candidate) =>
              candidate.method === method && candidate.prefix === wildcardPrefix,
          )
        ) {
          throw new Error("Kernel route policy is unavailable");
        }
        this.#wildcardPolicies.push({
          method,
          policy: resolved,
          prefix: wildcardPrefix,
        });
      }
    }
  }

  resolve(method: string, path: string): ResolvedKernelRoutePolicy {
    const canonicalPath = canonicalKernelPath(path);
    const canonicalMethod = method.toUpperCase() as Uppercase<string>;
    const policy =
      this.#policies.get(policyKey(canonicalMethod, canonicalPath)) ??
      this.#wildcardPolicies.find(
        (candidate) =>
          candidate.method === canonicalMethod &&
          canonicalPath.startsWith(candidate.prefix) &&
          canonicalPath.length > candidate.prefix.length,
      )?.policy;
    if (policy === undefined) {
      throw new Error("Kernel route is unavailable");
    }
    return policy;
  }
}
