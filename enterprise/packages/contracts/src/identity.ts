import { z } from "zod";

import {
  type OpenApiSchema,
  strictObjectOpenApiSchema,
} from "./openapi.js";

export const AUTH_SESSION_COOKIE_NAME = "__Host-singularity_session";
export const CSRF_HEADER_NAME = "X-CSRF-Token";

export const LOGIN_IDENTIFIER_MIN_LENGTH = 3;
export const LOGIN_IDENTIFIER_MAX_LENGTH = 254;
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

const normalizedLoginIdentifierSchema = z
  .string()
  .max(4_096)
  .transform((value) => value.trim().normalize("NFKC").toLowerCase())
  .pipe(
    z
      .string()
      .min(LOGIN_IDENTIFIER_MIN_LENGTH)
      .max(LOGIN_IDENTIFIER_MAX_LENGTH),
  );

export const loginIdentifierSchema = normalizedLoginIdentifierSchema;

export const passwordSchema = z
  .string()
  .max(PASSWORD_MAX_LENGTH * 2)
  .superRefine((value, context) => {
    const length = Array.from(value).length;
    if (length < PASSWORD_MIN_LENGTH || length > PASSWORD_MAX_LENGTH) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Password must contain ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} Unicode characters`,
      });
    }
  });

const token32ByteBase64UrlPattern =
  /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

export const sessionTokenSchema = z.string().regex(token32ByteBase64UrlPattern);
export const csrfTokenSchema = sessionTokenSchema;

export const loginRequestSchema = z
  .object({
    loginIdentifier: loginIdentifierSchema,
    password: passwordSchema,
  })
  .strict();

export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const csrfTokenResponseSchema = z
  .object({
    csrfToken: csrfTokenSchema,
  })
  .strict();

export const loginResponseSchema = csrfTokenResponseSchema;
export const csrfResponseSchema = csrfTokenResponseSchema;

export type CsrfTokenResponse = z.infer<typeof csrfTokenResponseSchema>;
export type LoginResponse = CsrfTokenResponse;
export type CsrfResponse = CsrfTokenResponse;

export const LOGIN_REQUEST_OPENAPI_SCHEMA = strictObjectOpenApiSchema({
  loginIdentifier: {
    type: "string",
    minLength: LOGIN_IDENTIFIER_MIN_LENGTH,
    maxLength: LOGIN_IDENTIFIER_MAX_LENGTH,
  },
  password: {
    type: "string",
    minLength: PASSWORD_MIN_LENGTH,
    maxLength: PASSWORD_MAX_LENGTH,
  },
});

export const CSRF_TOKEN_OPENAPI_SCHEMA = {
  type: "string" as const,
  pattern: token32ByteBase64UrlPattern.source,
};

export const CSRF_TOKEN_RESPONSE_OPENAPI_SCHEMA = strictObjectOpenApiSchema({
  csrfToken: CSRF_TOKEN_OPENAPI_SCHEMA,
});

export const LOGIN_RESPONSE_OPENAPI_SCHEMA: OpenApiSchema =
  CSRF_TOKEN_RESPONSE_OPENAPI_SCHEMA;
export const CSRF_RESPONSE_OPENAPI_SCHEMA: OpenApiSchema =
  CSRF_TOKEN_RESPONSE_OPENAPI_SCHEMA;
