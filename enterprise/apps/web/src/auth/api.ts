import {
  AUTH_CSRF_PATH,
  AUTH_INVITATION_ACCEPT_LOCAL_PATH,
  AUTH_INVITATION_ACCEPT_PATH,
  AUTH_LOGIN_PATH,
  AUTH_LOGOUT_PATH,
  AUTH_OIDC_PROVIDERS_PATH,
  AUTH_OIDC_START_PATH,
  CSRF_HEADER_NAME,
  csrfResponseSchema,
  loginResponseSchema,
  oidcProvidersResponseSchema,
  oidcStartResponseSchema,
  type CsrfResponse,
  type AcceptLocalOrganizationInvitationRequest,
  type AcceptOrganizationInvitationRequest,
  type LoginRequest,
  type LoginResponse,
  type OidcProvidersResponse,
  type OidcStartRequest,
  type OidcStartResponse,
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

export function getOidcProviders(
  signal?: AbortSignal,
): Promise<OidcProvidersResponse> {
  return requestJson(oidcProvidersResponseSchema, AUTH_OIDC_PROVIDERS_PATH, {
    signal: signal ?? null,
  });
}

export function startOidc(
  request: OidcStartRequest,
  signal?: AbortSignal,
): Promise<OidcStartResponse> {
  return requestJson(oidcStartResponseSchema, AUTH_OIDC_START_PATH, {
    body: JSON.stringify(request),
    headers: { "Content-Type": "application/json" },
    method: "POST",
    signal: signal ?? null,
  });
}

export function acceptOrganizationInvitation(
  request: AcceptOrganizationInvitationRequest,
  csrfToken: string,
  signal?: AbortSignal,
): Promise<void> {
  return requestNoContent(AUTH_INVITATION_ACCEPT_PATH, {
    body: JSON.stringify(request),
    headers: {
      [CSRF_HEADER_NAME]: csrfToken,
      "Content-Type": "application/json",
    },
    method: "POST",
    signal: signal ?? null,
  });
}

export function acceptLocalOrganizationInvitation(
  request: AcceptLocalOrganizationInvitationRequest,
  signal?: AbortSignal,
): Promise<LoginResponse> {
  return requestJson(loginResponseSchema, AUTH_INVITATION_ACCEPT_LOCAL_PATH, {
    body: JSON.stringify(request),
    headers: { "Content-Type": "application/json" },
    method: "POST",
    signal: signal ?? null,
  });
}
