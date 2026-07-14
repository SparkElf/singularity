import {
  AUTH_CSRF_PATH,
  AUTH_LOGIN_PATH,
  AUTH_LOGOUT_PATH,
  CSRF_HEADER_NAME,
  csrfResponseSchema,
  loginResponseSchema,
  type CsrfResponse,
  type LoginRequest,
  type LoginResponse,
} from "@singularity/contracts";

import { requestJson, requestNoContent } from "@/api/http.ts";

export function login(
  request: LoginRequest,
  signal?: AbortSignal,
): Promise<LoginResponse> {
  return requestJson(loginResponseSchema, AUTH_LOGIN_PATH, {
    body: JSON.stringify(request),
    headers: { "Content-Type": "application/json" },
    method: "POST",
    signal: signal ?? null,
  });
}

export function getCsrfToken(signal?: AbortSignal): Promise<CsrfResponse> {
  return requestJson(csrfResponseSchema, AUTH_CSRF_PATH, {
    signal: signal ?? null,
  });
}

export function logout(csrfToken: string, signal?: AbortSignal): Promise<void> {
  return requestNoContent(AUTH_LOGOUT_PATH, {
    headers: { [CSRF_HEADER_NAME]: csrfToken },
    method: "POST",
    signal: signal ?? null,
  });
}
