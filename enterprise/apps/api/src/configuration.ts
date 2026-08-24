import { isIP } from "node:net";

export const DEFAULT_CONTENT_AUDIT_INDETERMINATE_AFTER_MILLISECONDS = 120_000;

export class ApiConfigurationError extends Error {
  constructor(options?: ErrorOptions) {
    super("API deployment configuration is unavailable", options);
    this.name = "ApiConfigurationError";
  }
}

export interface ApiConfiguration {
  collaborationEnabled: boolean;
  contentAuditIndeterminateAfterMilliseconds: number;
  publicOrigin: string;
  passwordResetFrom: string | undefined;
  passwordResetSmtpUrl: string | undefined;
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

/** 解析密码找回 SMTP 地址；缺少配置时保留未配置状态，由业务入口统一返回 503。 */
export function parsePasswordResetSmtpUrl(
  value: string | undefined,
): string | undefined {
  if (value === undefined || value.length === 0) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new ApiConfigurationError({ cause: error });
  }
  if (
    (url.protocol !== "smtp:" && url.protocol !== "smtps:") ||
    url.hostname.length === 0 ||
    url.hash.length > 0
  ) {
    throw new ApiConfigurationError();
  }
  if (url.pathname.length === 0) {
    url.pathname = "/";
  }
  return url.toString();
}

/** 解析发件人地址并归一化为 SMTP provider 使用的单一配置字段。 */
export function parsePasswordResetFrom(
  value: string | undefined,
): string | undefined {
  if (value === undefined || value.length === 0) {
    return undefined;
  }
  const normalized = value.trim().normalize("NFKC").toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new ApiConfigurationError();
  }
  return normalized;
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
