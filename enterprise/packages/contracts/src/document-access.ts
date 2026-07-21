import { z } from "zod";

import {
  DOCUMENT_IDENTITY_OPENAPI_SCHEMA,
  documentIdentitySchema,
} from "./document-identity.js";
import {
  strictObjectOpenApiSchema,
  UUID_OPENAPI_SCHEMA,
} from "./openapi.js";
import { uuidSchema } from "./spaces.js";

export const documentAccessModes = ["inherit", "restricted"] as const;
export const documentAccessModeSchema = z.enum(documentAccessModes);
export type DocumentAccessMode = z.infer<typeof documentAccessModeSchema>;

export const documentAccessRoles = ["viewer", "commenter", "editor"] as const;
export const documentAccessRoleSchema = z.enum(documentAccessRoles);
export type DocumentAccessRole = z.infer<typeof documentAccessRoleSchema>;

export const documentAccessGrantKinds = ["user", "group"] as const;
export const documentAccessGrantKindSchema = z.enum(documentAccessGrantKinds);

const userGrantSchema = z
  .object({
    kind: z.literal("user"),
    role: documentAccessRoleSchema,
    userId: uuidSchema,
  })
  .strict();
const groupGrantSchema = z
  .object({
    groupId: uuidSchema,
    kind: z.literal("group"),
    role: documentAccessRoleSchema,
  })
  .strict();

export const documentAccessGrantInputSchema = z.discriminatedUnion("kind", [
  userGrantSchema,
  groupGrantSchema,
]);
export type DocumentAccessGrantInput = z.infer<
  typeof documentAccessGrantInputSchema
>;

export const documentAccessGrantSchema = z
  .object({
    createdAt: z.string().datetime({ offset: true }),
    grantId: uuidSchema,
    groupId: uuidSchema.nullable(),
    kind: documentAccessGrantKindSchema,
    role: documentAccessRoleSchema,
    userId: uuidSchema.nullable(),
  })
  .strict();
export type DocumentAccessGrant = z.infer<typeof documentAccessGrantSchema>;

export const documentAccessPolicySchema = z
  .object({
    ...documentIdentitySchema.shape,
    grants: z.array(documentAccessGrantSchema),
    mode: documentAccessModeSchema,
  })
  .strict();
export type DocumentAccessPolicy = z.infer<typeof documentAccessPolicySchema>;

export const updateDocumentAccessPolicyRequestSchema = z
  .object({
    grants: z.array(documentAccessGrantInputSchema).max(500),
    mode: documentAccessModeSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Set<string>();
    for (const [index, grant] of value.grants.entries()) {
      const subjectId = grant.kind === "user" ? grant.userId : grant.groupId;
      const key = `${grant.kind}:${subjectId}`;
      if (seen.has(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "A document access subject may only have one grant",
          path: ["grants", index],
        });
      }
      seen.add(key);
    }
  });
export type UpdateDocumentAccessPolicyRequest = z.infer<
  typeof updateDocumentAccessPolicyRequestSchema
>;

const NULLABLE_UUID_OPENAPI_SCHEMA = { ...UUID_OPENAPI_SCHEMA, nullable: true };
const DOCUMENT_ACCESS_GRANT_INPUT_OPENAPI_SCHEMA = {
  oneOf: [
    strictObjectOpenApiSchema({
      kind: { type: "string", enum: ["user"] },
      role: { type: "string", enum: [...documentAccessRoles] },
      userId: UUID_OPENAPI_SCHEMA,
    }),
    strictObjectOpenApiSchema({
      groupId: UUID_OPENAPI_SCHEMA,
      kind: { type: "string", enum: ["group"] },
      role: { type: "string", enum: [...documentAccessRoles] },
    }),
  ],
};
export const DOCUMENT_ACCESS_GRANT_OPENAPI_SCHEMA = strictObjectOpenApiSchema({
  createdAt: { type: "string", format: "date-time" },
  grantId: UUID_OPENAPI_SCHEMA,
  groupId: NULLABLE_UUID_OPENAPI_SCHEMA,
  kind: { type: "string", enum: [...documentAccessGrantKinds] },
  role: { type: "string", enum: [...documentAccessRoles] },
  userId: NULLABLE_UUID_OPENAPI_SCHEMA,
});
export const DOCUMENT_ACCESS_POLICY_OPENAPI_SCHEMA = strictObjectOpenApiSchema({
  ...DOCUMENT_IDENTITY_OPENAPI_SCHEMA.properties,
  grants: { type: "array", items: DOCUMENT_ACCESS_GRANT_OPENAPI_SCHEMA },
  mode: { type: "string", enum: [...documentAccessModes] },
});
export const UPDATE_DOCUMENT_ACCESS_POLICY_REQUEST_OPENAPI_SCHEMA =
  strictObjectOpenApiSchema({
    grants: {
      type: "array",
      items: DOCUMENT_ACCESS_GRANT_INPUT_OPENAPI_SCHEMA,
      maxItems: 500,
    },
    mode: { type: "string", enum: [...documentAccessModes] },
  });
