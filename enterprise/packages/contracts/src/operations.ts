import { z } from "zod";

import { loginIdentifierSchema, passwordSchema } from "./identity.js";
import {
  kernelInstanceStateSchema,
  organizationNameInputSchema,
  spaceNameInputSchema,
  spaceRoleSchema,
  uuidSchema,
} from "./spaces.js";

export const ACCESS_OPERATION_INPUT_MAX_BYTES = 16 * 1_024;

export const accessOperationNames = [
  "initialize",
  "create-user",
  "create-space",
  "set-kernel-state",
  "set-space-member",
  "revoke-space-member",
  "disable-organization",
  "disable-space",
  "revoke-organization-member",
  "disable-user",
  "revoke-user-sessions",
] as const;

export type AccessOperationName = (typeof accessOperationNames)[number];

export const deploymentHandleSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

export const kernelVersionSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9.+_-]*$/);

const initializeOperationSchema = z
  .object({
    operation: z.literal("initialize"),
    loginIdentifier: loginIdentifierSchema,
    password: passwordSchema,
    organizationName: organizationNameInputSchema,
    spaceName: spaceNameInputSchema,
  })
  .strict();

const createUserOperationSchema = z
  .object({
    operation: z.literal("create-user"),
    organizationId: uuidSchema,
    loginIdentifier: loginIdentifierSchema,
    password: passwordSchema,
  })
  .strict();

const createSpaceOperationSchema = z
  .object({
    operation: z.literal("create-space"),
    organizationId: uuidSchema,
    name: spaceNameInputSchema,
    adminUserId: uuidSchema,
  })
  .strict();

const setKernelStartingOperationSchema = z
  .object({
    operation: z.literal("set-kernel-state"),
    spaceId: uuidSchema,
    kernelState: z.literal(kernelInstanceStateSchema.enum.starting),
  })
  .strict();

const setKernelReadyOperationSchema = z
  .object({
    operation: z.literal("set-kernel-state"),
    spaceId: uuidSchema,
    kernelState: z.literal(kernelInstanceStateSchema.enum.ready),
    deploymentHandle: deploymentHandleSchema,
    version: kernelVersionSchema,
  })
  .strict();

const setKernelUnavailableOperationSchema = z
  .object({
    operation: z.literal("set-kernel-state"),
    spaceId: uuidSchema,
    kernelState: z.literal(kernelInstanceStateSchema.enum.unavailable),
    deploymentHandle: deploymentHandleSchema,
    version: kernelVersionSchema,
  })
  .strict();

const setSpaceMemberOperationSchema = z
  .object({
    operation: z.literal("set-space-member"),
    spaceId: uuidSchema,
    userId: uuidSchema,
    role: spaceRoleSchema,
  })
  .strict();

const revokeSpaceMemberOperationSchema = z
  .object({
    operation: z.literal("revoke-space-member"),
    spaceId: uuidSchema,
    userId: uuidSchema,
  })
  .strict();

const disableOrganizationOperationSchema = z
  .object({
    operation: z.literal("disable-organization"),
    organizationId: uuidSchema,
  })
  .strict();

const disableSpaceOperationSchema = z
  .object({
    operation: z.literal("disable-space"),
    spaceId: uuidSchema,
  })
  .strict();

const revokeOrganizationMemberOperationSchema = z
  .object({
    operation: z.literal("revoke-organization-member"),
    organizationId: uuidSchema,
    userId: uuidSchema,
  })
  .strict();

const disableUserOperationSchema = z
  .object({
    operation: z.literal("disable-user"),
    userId: uuidSchema,
  })
  .strict();

const revokeUserSessionsOperationSchema = z
  .object({
    operation: z.literal("revoke-user-sessions"),
    userId: uuidSchema,
  })
  .strict();

export const accessOperationSchema = z.union([
  initializeOperationSchema,
  createUserOperationSchema,
  createSpaceOperationSchema,
  setKernelStartingOperationSchema,
  setKernelReadyOperationSchema,
  setKernelUnavailableOperationSchema,
  setSpaceMemberOperationSchema,
  revokeSpaceMemberOperationSchema,
  disableOrganizationOperationSchema,
  disableSpaceOperationSchema,
  revokeOrganizationMemberOperationSchema,
  disableUserOperationSchema,
  revokeUserSessionsOperationSchema,
]);

export type AccessOperation = z.infer<typeof accessOperationSchema>;
export type InitializeAccessOperation = Extract<
  AccessOperation,
  { operation: "initialize" }
>;
export type CreateUserAccessOperation = Extract<
  AccessOperation,
  { operation: "create-user" }
>;
export type CreateSpaceAccessOperation = Extract<
  AccessOperation,
  { operation: "create-space" }
>;
export type SetKernelStateAccessOperation = Extract<
  AccessOperation,
  { operation: "set-kernel-state" }
>;
export type SetSpaceMemberAccessOperation = Extract<
  AccessOperation,
  { operation: "set-space-member" }
>;

export const accessOperationSuccessOutcomes = [
  "created",
  "updated",
  "revoked",
] as const;
export const accessOperationRejectionOutcomes = [
  "already-initialized",
  "conflict",
  "not-found",
] as const;
export const accessOperationFailureOutcomes = ["failed"] as const;
export const accessOperationOutcomes = [
  ...accessOperationSuccessOutcomes,
  ...accessOperationRejectionOutcomes,
  ...accessOperationFailureOutcomes,
] as const;

export type AccessOperationOutcome = (typeof accessOperationOutcomes)[number];
export type AccessOperationBareResult = {
  [Outcome in AccessOperationOutcome]: {
    operationId: string;
    outcome: Outcome;
  };
}[AccessOperationOutcome];

const resultBaseShape = {
  operationId: uuidSchema,
};

const initializeCreatedResultSchema = z
  .object({
    ...resultBaseShape,
    outcome: z.literal("created"),
    userId: uuidSchema,
    organizationId: uuidSchema,
    spaceId: uuidSchema,
  })
  .strict();

const userCreatedResultSchema = z
  .object({
    ...resultBaseShape,
    outcome: z.literal("created"),
    userId: uuidSchema,
  })
  .strict();

const spaceCreatedResultSchema = z
  .object({
    ...resultBaseShape,
    outcome: z.literal("created"),
    spaceId: uuidSchema,
  })
  .strict();

const createdResultSchema = z
  .object({
    ...resultBaseShape,
    outcome: z.literal("created"),
  })
  .strict();

const updatedResultSchema = z
  .object({
    ...resultBaseShape,
    outcome: z.literal("updated"),
  })
  .strict();

const revokedResultSchema = z
  .object({
    ...resultBaseShape,
    outcome: z.literal("revoked"),
  })
  .strict();

const alreadyInitializedResultSchema = z
  .object({
    ...resultBaseShape,
    outcome: z.literal("already-initialized"),
  })
  .strict();

const conflictResultSchema = z
  .object({
    ...resultBaseShape,
    outcome: z.literal("conflict"),
  })
  .strict();

const notFoundResultSchema = z
  .object({
    ...resultBaseShape,
    outcome: z.literal("not-found"),
  })
  .strict();

const failedResultSchema = z
  .object({
    ...resultBaseShape,
    outcome: z.literal("failed"),
  })
  .strict();

export const accessOperationResultSchemaByOperation = {
  initialize: z.union([
    initializeCreatedResultSchema,
    alreadyInitializedResultSchema,
    conflictResultSchema,
    failedResultSchema,
  ]),
  "create-user": z.union([
    userCreatedResultSchema,
    conflictResultSchema,
    notFoundResultSchema,
    failedResultSchema,
  ]),
  "create-space": z.union([
    spaceCreatedResultSchema,
    conflictResultSchema,
    notFoundResultSchema,
    failedResultSchema,
  ]),
  "set-kernel-state": z.union([
    updatedResultSchema,
    conflictResultSchema,
    notFoundResultSchema,
    failedResultSchema,
  ]),
  "set-space-member": z.union([
    createdResultSchema,
    updatedResultSchema,
    conflictResultSchema,
    notFoundResultSchema,
    failedResultSchema,
  ]),
  "revoke-space-member": z.union([
    revokedResultSchema,
    notFoundResultSchema,
    failedResultSchema,
  ]),
  "disable-organization": z.union([
    updatedResultSchema,
    notFoundResultSchema,
    failedResultSchema,
  ]),
  "disable-space": z.union([
    updatedResultSchema,
    notFoundResultSchema,
    failedResultSchema,
  ]),
  "revoke-organization-member": z.union([
    revokedResultSchema,
    conflictResultSchema,
    notFoundResultSchema,
    failedResultSchema,
  ]),
  "disable-user": z.union([
    updatedResultSchema,
    conflictResultSchema,
    notFoundResultSchema,
    failedResultSchema,
  ]),
  "revoke-user-sessions": z.union([
    revokedResultSchema,
    notFoundResultSchema,
    failedResultSchema,
  ]),
} as const satisfies Record<AccessOperationName, z.ZodTypeAny>;

export type AccessOperationResultFor<
  Operation extends AccessOperationName,
> = z.infer<(typeof accessOperationResultSchemaByOperation)[Operation]>;
export type AccessOperationResult = {
  [Operation in AccessOperationName]: AccessOperationResultFor<Operation>;
}[AccessOperationName];
export type AccessOperationSuccessResult = Extract<
  AccessOperationResult,
  { outcome: (typeof accessOperationSuccessOutcomes)[number] }
>;
export type AccessOperationRejectionResult = Extract<
  AccessOperationResult,
  { outcome: (typeof accessOperationRejectionOutcomes)[number] }
>;
export type AccessOperationFailureResult = Extract<
  AccessOperationResult,
  { outcome: "failed" }
>;

export const accessOperationExitCodeByOutcome = {
  created: 0,
  updated: 0,
  revoked: 0,
  "already-initialized": 2,
  conflict: 2,
  "not-found": 2,
  failed: 1,
} as const satisfies Record<AccessOperationOutcome, 0 | 1 | 2>;
