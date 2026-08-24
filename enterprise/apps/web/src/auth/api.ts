import {
  AUTH_CSRF_PATH,
  AUTH_INVITATION_ACCEPT_LOCAL_PATH,
  AUTH_INVITATION_ACCEPT_PATH,
  AUTH_LOGIN_PATH,
  AUTH_PASSWORD_RESET_PATH,
  AUTH_PASSWORD_RESET_REQUEST_PATH,
  AUTH_REGISTER_PATH,
  AUTH_SETUP_PATH,
  AUTH_LOGOUT_PATH,
  CSRF_HEADER_NAME,
  csrfResponseSchema,
  loginResponseSchema,
  passwordResetRequestedResponseSchema,
  type PasswordResetConfirmRequest,
  type PasswordResetRequest,
  type PasswordResetRequestedResponse,
  type AcceptLocalOrganizationInvitationRequest,
  type AcceptOrganizationInvitationRequest,
  type LoginRequest,
  type LoginResponse,
  type RegisterRequest,
  type SetupStatusResponse,
  setupStatusResponseSchema,
} from "@singularity/contracts";

import {
  requestJson,
  requestNoContent,
} from "@/api/http.ts";
import { useCsrfStore } from "@/auth/csrf-store.ts";

interface ActiveCsrfFetch {
  readonly controller: AbortController;
  readonly lifecycle: {
    settled: boolean;
    waiters: number;
  };
  readonly promise: Promise<string>;
  readonly revision: number;
}

let activeCsrfFetch: ActiveCsrfFetch | null = null;

class CsrfRequestInvalidatedError extends Error {
  constructor(cause?: unknown) {
    super("The browser session changed during the CSRF request", { cause });
    this.name = "AbortError";
  }
}

function callerAbortReason(signal: AbortSignal | undefined): Error {
  const reason: unknown =
    signal?.reason ?? new DOMException("The request was aborted", "AbortError");
  return reason instanceof Error
    ? reason
    : new Error(String(reason), { cause: reason });
}

function createCsrfFetch(revision: number): ActiveCsrfFetch {
  const controller = new AbortController();
  const lifecycle = {
    settled: false,
    waiters: 0,
  };
  const promise = requestJson(csrfResponseSchema, AUTH_CSRF_PATH, {
    signal: controller.signal,
  })
    .then(
      ({ csrfToken }) => {
        const state = useCsrfStore.getState();
        if (state.csrfRevision !== revision) {
          throw new CsrfRequestInvalidatedError();
        }
        state.setCsrfToken(csrfToken);
        return csrfToken;
      },
      (error: unknown) => {
        if (useCsrfStore.getState().csrfRevision !== revision) {
          throw new CsrfRequestInvalidatedError(error);
        }
        throw error;
      },
    )
    .finally(() => {
      lifecycle.settled = true;
      if (activeCsrfFetch?.controller === controller) {
        activeCsrfFetch = null;
      }
    });
  return { controller, lifecycle, promise, revision };
}

function waitForCsrfFetch(
  active: ActiveCsrfFetch,
  signal?: AbortSignal,
): Promise<string> {
  active.lifecycle.waiters += 1;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (outcome: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener("abort", abort);
      active.lifecycle.waiters -= 1;
      if (active.lifecycle.waiters === 0 && !active.lifecycle.settled) {
        active.controller.abort();
      }
      outcome();
    };
    const abort = () => {
      finish(() => reject(callerAbortReason(signal)));
    };
    signal?.addEventListener("abort", abort, { once: true });
    void active.promise.then(
      (csrfToken) => finish(() => resolve(csrfToken)),
      (error: unknown) =>
        finish(() =>
          reject(
            error instanceof Error
              ? error
              : new Error(String(error), { cause: error }),
          ),
        ),
    );
    if (signal?.aborted) {
      abort();
    }
  });
}

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

export function getSetupStatus(
  signal?: AbortSignal,
): Promise<SetupStatusResponse> {
  return requestJson(setupStatusResponseSchema, AUTH_SETUP_PATH, {
    signal: signal ?? null,
  });
}

/** 创建不带组织归属的本地账号；注册入口始终开放，组织归属由邀请或管理员分配建立。 */
export function register(
  request: RegisterRequest,
  signal?: AbortSignal,
): Promise<LoginResponse> {
  return requestJson(loginResponseSchema, AUTH_REGISTER_PATH, {
    body: JSON.stringify(request),
    headers: { "Content-Type": "application/json" },
    method: "POST",
    signal: signal ?? null,
  });
}

export function requestPasswordReset(
  request: PasswordResetRequest,
  signal?: AbortSignal,
): Promise<PasswordResetRequestedResponse> {
  return requestJson(
    passwordResetRequestedResponseSchema,
    AUTH_PASSWORD_RESET_REQUEST_PATH,
    {
      body: JSON.stringify(request),
      headers: { "Content-Type": "application/json" },
      method: "POST",
      signal: signal ?? null,
    },
  );
}

export function confirmPasswordReset(
  request: PasswordResetConfirmRequest,
  signal?: AbortSignal,
): Promise<void> {
  return requestNoContent(AUTH_PASSWORD_RESET_PATH, {
    body: JSON.stringify(request),
    headers: { "Content-Type": "application/json" },
    method: "POST",
    signal: signal ?? null,
  });
}

export function getOrFetchCsrfToken(signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) {
    return Promise.reject(callerAbortReason(signal));
  }
  const state = useCsrfStore.getState();
  if (state.csrfToken !== null) {
    return Promise.resolve(state.csrfToken);
  }
  if (
    activeCsrfFetch === null ||
    activeCsrfFetch.revision !== state.csrfRevision ||
    activeCsrfFetch.controller.signal.aborted
  ) {
    activeCsrfFetch?.controller.abort();
    activeCsrfFetch = createCsrfFetch(state.csrfRevision);
  }
  return waitForCsrfFetch(activeCsrfFetch, signal);
}

export function logout(csrfToken: string, signal?: AbortSignal): Promise<void> {
  return requestNoContent(AUTH_LOGOUT_PATH, {
    headers: { [CSRF_HEADER_NAME]: csrfToken },
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
