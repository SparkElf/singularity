import { readFileSync } from "node:fs";

export interface P5E2EStackState {
  readonly apiOrigin: string;
  readonly certificateFile: string;
  readonly documentId: string;
  readonly documentInitialText: string;
  readonly documentTitle: string;
  readonly editor: {
    readonly loginIdentifier: string;
    readonly password: string;
  };
  readonly kernelInstanceId: string;
  readonly kernelPort: number;
  readonly notebookId: string;
  readonly notebookName: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly privateKeyFile: string;
  readonly schema: string;
  readonly spaceId: string;
  readonly spaceName: string;
  readonly stateVersion: 1;
  readonly viewer: {
    readonly loginIdentifier: string;
    readonly password: string;
  };
  readonly webOrigin: string;
  readonly webPort: number;
}

let cachedState: P5E2EStackState | undefined;

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`P5 E2E stack state field ${field} is invalid`);
  }
  return value;
}

function requiredPort(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 65_535
  ) {
    throw new Error(`P5 E2E stack state field ${field} is invalid`);
  }
  return value;
}

function requiredCredentials(
  value: unknown,
  field: string,
): P5E2EStackState["editor"] {
  if (typeof value !== "object" || value === null) {
    throw new Error(`P5 E2E stack state field ${field} is invalid`);
  }
  const credentials = value as Record<string, unknown>;
  return {
    loginIdentifier: requiredString(
      credentials.loginIdentifier,
      `${field}.loginIdentifier`,
    ),
    password: requiredString(credentials.password, `${field}.password`),
  };
}

export function parseP5E2EStackState(value: unknown): P5E2EStackState {
  if (typeof value !== "object" || value === null) {
    throw new Error("P5 E2E stack state is invalid");
  }
  const state = value as Record<string, unknown>;
  if (state.stateVersion !== 1) {
    throw new Error("Unsupported P5 E2E stack state");
  }
  return {
    apiOrigin: requiredString(state.apiOrigin, "apiOrigin"),
    certificateFile: requiredString(state.certificateFile, "certificateFile"),
    documentId: requiredString(state.documentId, "documentId"),
    documentInitialText: requiredString(
      state.documentInitialText,
      "documentInitialText",
    ),
    documentTitle: requiredString(state.documentTitle, "documentTitle"),
    editor: requiredCredentials(state.editor, "editor"),
    kernelInstanceId: requiredString(state.kernelInstanceId, "kernelInstanceId"),
    kernelPort: requiredPort(state.kernelPort, "kernelPort"),
    notebookId: requiredString(state.notebookId, "notebookId"),
    notebookName: requiredString(state.notebookName, "notebookName"),
    organizationId: requiredString(state.organizationId, "organizationId"),
    organizationName: requiredString(state.organizationName, "organizationName"),
    privateKeyFile: requiredString(state.privateKeyFile, "privateKeyFile"),
    schema: requiredString(state.schema, "schema"),
    spaceId: requiredString(state.spaceId, "spaceId"),
    spaceName: requiredString(state.spaceName, "spaceName"),
    stateVersion: 1,
    viewer: requiredCredentials(state.viewer, "viewer"),
    webOrigin: requiredString(state.webOrigin, "webOrigin"),
    webPort: requiredPort(state.webPort, "webPort"),
  };
}

export function readP5E2EStackState(): P5E2EStackState {
  if (cachedState !== undefined) {
    return cachedState;
  }
  const path = process.env.SINGULARITY_E2E_STATE_FILE;
  if (path === undefined || path.length === 0) {
    throw new Error("SINGULARITY_E2E_STATE_FILE is not configured");
  }
  const parsed = parseP5E2EStackState(JSON.parse(readFileSync(path, "utf8")));
  cachedState = parsed;
  return parsed;
}
