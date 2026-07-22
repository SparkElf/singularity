import { isIP } from "node:net";
import { isAbsolute } from "node:path";

export const DEFAULT_CONTENT_AUDIT_INDETERMINATE_AFTER_MILLISECONDS = 120_000;

export class ApiConfigurationError extends Error {
  constructor(options?: ErrorOptions) {
    super("API deployment configuration is unavailable", options);
    this.name = "ApiConfigurationError";
  }
}

export interface OidcClientSecretBinding {
  readonly clientId: string;
  readonly issuer: string;
  readonly organizationId: string;
  readonly reference: string;
  readonly secretFile: string;
}

export interface ApiConfiguration {
  collaborationEnabled: boolean;
  contentAuditIndeterminateAfterMilliseconds: number;
  oidcClientSecretBindings: readonly OidcClientSecretBinding[];
  publicOrigin: string;
  trustedProxyCidrs: readonly string[];
}

export function parseBooleanFlag(value: string | undefined, defaultValue = false): boolean {
  if (value === undefined) return defaultValue;
  if (value === "1" || value.toLowerCase() === "true") return true;
  if (value === "0" || value.toLowerCase() === "false") return false;
  throw new ApiConfigurationError();
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

function parseOidcBindingIssuer(value: string): string {
  let issuer: URL;
  try {
    issuer = new URL(value);
  } catch (error) {
    throw new ApiConfigurationError({ cause: error });
  }
  if (
    issuer.protocol !== "https:" ||
    issuer.username.length > 0 ||
    issuer.password.length > 0 ||
    issuer.search.length > 0 ||
    issuer.hash.length > 0
  ) {
    throw new ApiConfigurationError();
  }
  return issuer.toString();
}

export function parseOidcClientSecretBindings(
  value: string | undefined,
): readonly OidcClientSecretBinding[] {
  if (value === undefined || value.length === 0) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new ApiConfigurationError({ cause: error });
  }
  if (!Array.isArray(parsed)) {
    throw new ApiConfigurationError();
  }
  const references = new Set<string>();
  const result: OidcClientSecretBinding[] = [];
  for (const value of parsed) {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value)
    ) {
      throw new ApiConfigurationError();
    }
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(",") !==
        "clientId,issuer,organizationId,reference,secretFile" ||
      typeof record.clientId !== "string" ||
      record.clientId.length === 0 ||
      record.clientId.length > 512 ||
      typeof record.organizationId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        record.organizationId,
      ) ||
      typeof record.reference !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(record.reference) ||
      references.has(record.reference) ||
      typeof record.secretFile !== "string" ||
      !isAbsolute(record.secretFile) ||
      typeof record.issuer !== "string"
    ) {
      throw new ApiConfigurationError();
    }
    references.add(record.reference);
    result.push({
      clientId: record.clientId,
      issuer: parseOidcBindingIssuer(record.issuer),
      organizationId: record.organizationId,
      reference: record.reference,
      secretFile: record.secretFile,
    });
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
  } catch (error) {
    throw new ApiConfigurationError({ cause: error });
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
