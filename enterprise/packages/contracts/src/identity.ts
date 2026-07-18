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

export const OIDC_PROVIDER_NAME_MAX_LENGTH = 120;
export const OIDC_CLIENT_ID_MAX_LENGTH = 512;
export const OIDC_CLIENT_SECRET_REFERENCE_MAX_LENGTH = 128;
export const oidcProviderStatuses = ["active", "disabled"] as const;
export const oidcProviderStatusSchema = z.enum(oidcProviderStatuses);

export const oidcIssuerSchema = z
  .string()
  .url()
  .max(2_048)
  .refine((value) => {
    const issuer = new URL(value);
    return (
      issuer.protocol === "https:" &&
      issuer.username.length === 0 &&
      issuer.password.length === 0 &&
      issuer.search.length === 0 &&
      issuer.hash.length === 0
    );
  });
export const oidcClientIdSchema = z
  .string()
  .min(1)
  .max(OIDC_CLIENT_ID_MAX_LENGTH);
export const oidcClientSecretReferenceSchema = z
  .string()
  .min(1)
  .max(OIDC_CLIENT_SECRET_REFERENCE_MAX_LENGTH)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
export const oidcProviderNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(OIDC_PROVIDER_NAME_MAX_LENGTH);

export const oidcProviderSummarySchema = z
  .object({ providerId: z.string().uuid(), name: oidcProviderNameSchema })
  .strict();
export type OidcProviderSummary = z.infer<typeof oidcProviderSummarySchema>;

export const oidcProvidersResponseSchema = z
  .object({ providers: z.array(oidcProviderSummarySchema) })
  .strict();
export type OidcProvidersResponse = z.infer<typeof oidcProvidersResponseSchema>;

export const managedOidcProviderSchema = z
  .object({
    clientId: oidcClientIdSchema,
    clientSecretReference: oidcClientSecretReferenceSchema.optional(),
    issuer: oidcIssuerSchema,
    name: oidcProviderNameSchema,
    organizationId: z.string().uuid(),
    providerId: z.string().uuid(),
    status: oidcProviderStatusSchema,
  })
  .strict();
export type ManagedOidcProvider = z.infer<typeof managedOidcProviderSchema>;

export const managedOidcProvidersResponseSchema = z
  .object({ providers: z.array(managedOidcProviderSchema) })
  .strict();
export type ManagedOidcProvidersResponse = z.infer<
  typeof managedOidcProvidersResponseSchema
>;

export const createOidcProviderRequestSchema = z
  .object({
    clientId: oidcClientIdSchema,
    clientSecretReference: oidcClientSecretReferenceSchema.optional(),
    issuer: oidcIssuerSchema,
    name: oidcProviderNameSchema,
  })
  .strict();
export type CreateOidcProviderRequest = z.infer<
  typeof createOidcProviderRequestSchema
>;

export const updateOidcProviderRequestSchema = z
  .object({
    clientId: oidcClientIdSchema.optional(),
    clientSecretReference: oidcClientSecretReferenceSchema.nullable().optional(),
    issuer: oidcIssuerSchema.optional(),
    name: oidcProviderNameSchema.optional(),
    status: oidcProviderStatusSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.clientId !== undefined ||
      value.clientSecretReference !== undefined ||
      value.issuer !== undefined ||
      value.name !== undefined ||
      value.status !== undefined,
  );
export type UpdateOidcProviderRequest = z.infer<
  typeof updateOidcProviderRequestSchema
>;

const sameOriginReturnToSchema = z
  .string()
  .max(2_048)
  .refine(
    (value) =>
      value.startsWith("/") &&
      !value.startsWith("//") &&
      !value.includes("\\") &&
      !value.includes("\u0000"),
  );

export const oidcStartRequestSchema = z
  .object({
    invitationToken: sessionTokenSchema.optional(),
    providerId: z.string().uuid(),
    returnTo: sameOriginReturnToSchema.optional(),
  })
  .strict();
export type OidcStartRequest = z.infer<typeof oidcStartRequestSchema>;

export const oidcStartResponseSchema = z
  .object({ authorizationUrl: z.string().url() })
  .strict();
export type OidcStartResponse = z.infer<typeof oidcStartResponseSchema>;

export const oidcCallbackQuerySchema = z
  .object({
    code: z.string().min(1).max(4_096),
    session_state: z.string().max(4_096).optional(),
    state: sessionTokenSchema,
  })
  .strict();
export type OidcCallbackQuery = z.infer<typeof oidcCallbackQuerySchema>;

export const oidcProviderPathParametersSchema = z
  .object({ organizationId: z.string().uuid(), providerId: z.string().uuid() })
  .strict();

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

const OIDC_PROVIDER_STATUS_OPENAPI_SCHEMA: OpenApiSchema = {
  type: "string",
  enum: [...oidcProviderStatuses],
};
const OIDC_PROVIDER_SUMMARY_OPENAPI_SCHEMA = strictObjectOpenApiSchema({
  providerId: { type: "string", format: "uuid" },
  name: {
    type: "string",
    minLength: 1,
    maxLength: OIDC_PROVIDER_NAME_MAX_LENGTH,
  },
});
export const OIDC_PROVIDERS_RESPONSE_OPENAPI_SCHEMA =
  strictObjectOpenApiSchema({
    providers: { type: "array", items: OIDC_PROVIDER_SUMMARY_OPENAPI_SCHEMA },
  });
export const MANAGED_OIDC_PROVIDER_OPENAPI_SCHEMA = strictObjectOpenApiSchema(
  {
    clientId: { type: "string", minLength: 1, maxLength: OIDC_CLIENT_ID_MAX_LENGTH },
    clientSecretReference: {
      type: "string",
      minLength: 1,
      maxLength: OIDC_CLIENT_SECRET_REFERENCE_MAX_LENGTH,
    },
    issuer: { type: "string", format: "uri", maxLength: 2_048 },
    name: {
      type: "string",
      minLength: 1,
      maxLength: OIDC_PROVIDER_NAME_MAX_LENGTH,
    },
    organizationId: { type: "string", format: "uuid" },
    providerId: { type: "string", format: "uuid" },
    status: OIDC_PROVIDER_STATUS_OPENAPI_SCHEMA,
  },
  ["clientId", "issuer", "name", "organizationId", "providerId", "status"],
);
export const MANAGED_OIDC_PROVIDERS_RESPONSE_OPENAPI_SCHEMA =
  strictObjectOpenApiSchema({
    providers: { type: "array", items: MANAGED_OIDC_PROVIDER_OPENAPI_SCHEMA },
  });
export const CREATE_OIDC_PROVIDER_REQUEST_OPENAPI_SCHEMA =
  strictObjectOpenApiSchema(
    {
      clientId: {
        type: "string",
        minLength: 1,
        maxLength: OIDC_CLIENT_ID_MAX_LENGTH,
      },
      clientSecretReference: {
        type: "string",
        minLength: 1,
        maxLength: OIDC_CLIENT_SECRET_REFERENCE_MAX_LENGTH,
      },
      issuer: { type: "string", format: "uri", maxLength: 2_048 },
      name: {
        type: "string",
        minLength: 1,
        maxLength: OIDC_PROVIDER_NAME_MAX_LENGTH,
      },
    },
    ["clientId", "issuer", "name"],
  );
export const UPDATE_OIDC_PROVIDER_REQUEST_OPENAPI_SCHEMA =
  strictObjectOpenApiSchema(
    {
      clientId: {
        type: "string",
        minLength: 1,
        maxLength: OIDC_CLIENT_ID_MAX_LENGTH,
      },
      clientSecretReference: {
        type: "string",
        minLength: 1,
        maxLength: OIDC_CLIENT_SECRET_REFERENCE_MAX_LENGTH,
      },
      issuer: { type: "string", format: "uri", maxLength: 2_048 },
      name: {
        type: "string",
        minLength: 1,
        maxLength: OIDC_PROVIDER_NAME_MAX_LENGTH,
      },
      status: OIDC_PROVIDER_STATUS_OPENAPI_SCHEMA,
    },
    [],
  );
export const OIDC_START_REQUEST_OPENAPI_SCHEMA = strictObjectOpenApiSchema(
  {
    invitationToken: CSRF_TOKEN_OPENAPI_SCHEMA,
    providerId: { type: "string", format: "uuid" },
    returnTo: { type: "string", maxLength: 2_048 },
  },
  ["providerId"],
);
export const OIDC_START_RESPONSE_OPENAPI_SCHEMA = strictObjectOpenApiSchema({
  authorizationUrl: { type: "string", format: "uri" },
});
