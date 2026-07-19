import { isIP } from "node:net";
import { isAbsolute } from "node:path";

export const DEFAULT_CONTENT_AUDIT_INDETERMINATE_AFTER_MILLISECONDS = 120_000;

export class ApiConfigurationError extends Error {
  constructor() {
    super("API deployment configuration is unavailable");
    this.name = "ApiConfigurationError";
  }
}

export interface ApiConfiguration {
  contentAuditIndeterminateAfterMilliseconds: number;
  oidcClientSecretFiles: Readonly<Record<string, string>>;
  publicOrigin: string;
  trustedProxyCidrs: readonly string[];
}

export function parseContentAuditIndeterminateAfterMilliseconds(
  value: string | undefined,
): number {
  const text =
    value ?? String(DEFAULT_CONTENT_AUDIT_INDETERMINATE_AFTER_MILLISECONDS);
  if (!/^[1-9][0-9]*$/.test(text)) {
    throw new ApiConfigurationError();
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ApiConfigurationError();
  }
  return parsed;
}

export function parseOidcClientSecretFiles(
  value: string | undefined,
): Readonly<Record<string, string>> {
  if (value === undefined || value.length === 0) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ApiConfigurationError();
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    throw new ApiConfigurationError();
  }
  const result: Record<string, string> = {};
  for (const [reference, path] of Object.entries(parsed)) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(reference) ||
      typeof path !== "string" ||
      !isAbsolute(path)
    ) {
      throw new ApiConfigurationError();
    }
    result[reference] = path;
  }
  return result;
}

export function parsePublicOrigin(value: string | undefined): string {
  if (value === undefined || value.length === 0) {
    throw new ApiConfigurationError();
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApiConfigurationError();
  }

  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.pathname !== "/" ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new ApiConfigurationError();
  }

  return url.origin;
}

function isTrustedProxyAddress(value: string): boolean {
  if (isIP(value) !== 0) {
    return true;
  }

  const separator = value.lastIndexOf("/");
  if (separator <= 0 || separator === value.length - 1) {
    return false;
  }

  const address = value.slice(0, separator);
  const addressFamily = isIP(address);
  const prefixText = value.slice(separator + 1);
  if (!/^\d+$/.test(prefixText) || addressFamily === 0) {
    return false;
  }

  const prefix = Number(prefixText);
  const maximumPrefix = addressFamily === 4 ? 32 : 128;
  return prefix > 0 && prefix <= maximumPrefix;
}

export function parseTrustedProxyCidrs(
  value: string | undefined,
): readonly string[] {
  if (value === undefined || value.length === 0) {
    return [];
  }

  const entries = value.split(",").map((entry) => entry.trim());
  if (
    entries.length === 0 ||
    entries.some(
      (entry, index) =>
        entry.length === 0 ||
        !isTrustedProxyAddress(entry) ||
        entries.indexOf(entry) !== index,
    )
  ) {
    throw new ApiConfigurationError();
  }

  return entries;
}
