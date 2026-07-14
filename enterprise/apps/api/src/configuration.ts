import { isIP } from "node:net";

export class ApiConfigurationError extends Error {
  constructor() {
    super("API deployment configuration is unavailable");
    this.name = "ApiConfigurationError";
  }
}

export interface ApiConfiguration {
  publicOrigin: string;
  trustedProxyCidrs: readonly string[];
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

export function parseApiConfiguration(environment: NodeJS.ProcessEnv): ApiConfiguration {
  return {
    publicOrigin: parsePublicOrigin(environment.SINGULARITY_PUBLIC_ORIGIN),
    trustedProxyCidrs: parseTrustedProxyCidrs(
      environment.SINGULARITY_TRUSTED_PROXY_CIDRS,
    ),
  };
}
