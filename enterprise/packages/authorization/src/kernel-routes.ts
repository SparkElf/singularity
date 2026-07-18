export const kernelActions = ["read", "write", "admin"] as const;
export type KernelAction = (typeof kernelActions)[number];

export const kernelContentModes = [
  "json",
  "asset",
  "upload",
  "export",
  "websocket",
  "readiness",
] as const;
export type KernelContentMode = (typeof kernelContentModes)[number];

export type KernelIdentityRequirement = "content" | "service";
export const kernelAuditModes = [
  "content.edit",
  "content.delete",
  "content.export",
  "content.mutation",
] as const;
export type KernelAuditMode = (typeof kernelAuditModes)[number];

export interface KernelRoutePolicy {
  readonly action: KernelAction;
  readonly audit?: KernelAuditMode;
  readonly contentMode: KernelContentMode;
  readonly identity: KernelIdentityRequirement;
  readonly method: string;
  readonly path: `/${string}`;
  readonly requestHeaders: readonly string[];
  readonly responseHeaders: readonly string[];
}

const JSON_REQUEST_HEADERS = ["accept", "content-type"] as const;
const JSON_RESPONSE_HEADERS = ["content-type"] as const;
const RESOURCE_REQUEST_HEADERS = [
  "accept",
  "if-modified-since",
  "if-none-match",
  "range",
] as const;
const RESOURCE_RESPONSE_HEADERS = [
  "accept-ranges",
  "cache-control",
  "content-disposition",
  "content-length",
  "content-range",
  "content-type",
  "etag",
  "last-modified",
] as const;

function jsonPolicy(
  path: `/${string}`,
  action: KernelAction,
  audit?: KernelAuditMode,
): KernelRoutePolicy {
  return {
    action,
    ...(audit === undefined ? {} : { audit }),
    contentMode: "json",
    identity: "content",
    method: "POST",
    path,
    requestHeaders: JSON_REQUEST_HEADERS,
    responseHeaders: JSON_RESPONSE_HEADERS,
  };
}

const PROTYLE_READ_ROUTES = [
  "/api/asset/getDocImageAssets",
  "/api/attr/getBlockAttrs",
  "/api/av/getAttributeView",
  "/api/av/getAttributeViewAddingBlockDefaultValues",
  "/api/av/getAttributeViewKeys",
  "/api/av/getAttributeViewKeysByAvID",
  "/api/av/getAttributeViewKeysByID",
  "/api/av/getAttributeViewPrimaryKeyValues",
  "/api/av/getCurrentAttrViewImages",
  "/api/av/getMirrorDatabaseBlocks",
  "/api/av/renderAttributeView",
  "/api/av/renderHistoryAttributeView",
  "/api/av/renderSnapshotAttributeView",
  "/api/av/searchAttributeView",
  "/api/av/searchAttributeViewRelationKey",
  "/api/av/searchAttributeViewRollupDestKeys",
  "/api/block/checkBlockExist",
  "/api/block/checkBlockFold",
  "/api/block/checkBlocksExist",
  "/api/block/getBlockBreadcrumb",
  "/api/block/getBlockDOM",
  "/api/block/getBlockIndex",
  "/api/block/getBlockInfo",
  "/api/block/getBlockRelevantIDs",
  "/api/block/getBlocksWordCount",
  "/api/block/getContentWordCount",
  "/api/block/getDocInfo",
  "/api/block/getDOMText",
  "/api/block/getHeadingChildrenDOM",
  "/api/block/getHeadingChildrenIDs",
  "/api/block/getHeadingDeleteTransaction",
  "/api/block/getHeadingInsertTransaction",
  "/api/block/getHeadingLevelTransaction",
  "/api/block/getRefText",
  "/api/block/getTreeStat",
  "/api/filetree/authFilePublishAccess",
  "/api/filetree/getDoc",
  "/api/filetree/getDocCreateSavePath",
  "/api/filetree/getHPathByID",
  "/api/filetree/getHPathByPath",
  "/api/filetree/getHPathsByPaths",
  "/api/filetree/getIDsByHPath",
  "/api/filetree/getPublishAccess",
  "/api/lute/copyStdMarkdown",
  "/api/lute/html2BlockDOM",
  "/api/outline/getDocOutline",
  "/api/ref/getBacklinkDoc",
  "/api/ref/getBackmentionDoc",
  "/api/search/getEmbedBlock",
  "/api/search/searchAsset",
  "/api/search/searchEmbedBlock",
  "/api/search/searchRefBlock",
  "/api/search/searchTag",
  "/api/search/searchTemplate",
  "/api/search/searchWidget",
  "/api/storage/getLocalStorage",
  "/api/template/render",
  "/api/transactions/undoState",
] as const;

const PROTYLE_ADMIN_ROUTES = [
  "/api/asset/uploadCloud",
  "/api/setting/setEditor",
  "/api/storage/setLocalStorageVal",
] as const;

const PROTYLE_CONTENT_EDIT_ROUTES = [
  "/api/asset/insertCover",
  "/api/asset/insertLocalAssets",
  "/api/attr/setBlockAttrs",
  "/api/av/changeAttrViewLayout",
  "/api/av/duplicateAttributeViewBlock",
  "/api/av/setAttributeViewBlockAttr",
  "/api/av/setAttrViewGroup",
  "/api/block/updateTaskListItemMarker",
  "/api/filetree/createDoc",
  "/api/filetree/createDocWithMd",
  "/api/filetree/renameDoc",
  "/api/format/autoSpace",
  "/api/format/netAssets2LocalAssets",
  "/api/format/netImg2LocalAssets",
  "/api/transactions/redo",
  "/api/transactions/undo",
] as const;

const PROTYLE_CONTENT_DELETE_ROUTES = [
  "/api/filetree/doc2Heading",
] as const;

const PROTYLE_WRITE_ROUTES = ["/api/search/removeTemplate"] as const;

const PROTYLE_EXPORT_ROUTES = [
  "/api/export/exportMdContent",
  "/api/export/exportAsFile",
  "/api/export/exportAttributeView",
  "/api/export/exportBrowserHTML",
  "/api/export/exportCodeBlock",
  "/api/export/exportHTML",
  "/api/export/exportMd",
  "/api/export/exportMdHTML",
  "/api/export/exportMds",
  "/api/export/exportNotebookMd",
  "/api/export/exportPreviewHTML",
  "/api/export/preview",
] as const;

export const kernelRoutePolicies: readonly KernelRoutePolicy[] = Object.freeze([
  ...PROTYLE_READ_ROUTES.map((path) => jsonPolicy(path, "read")),
  ...PROTYLE_WRITE_ROUTES.map((path) => jsonPolicy(path, "write")),
  ...PROTYLE_CONTENT_EDIT_ROUTES.map((path) =>
    jsonPolicy(path, "write", "content.edit"),
  ),
  ...PROTYLE_CONTENT_DELETE_ROUTES.map((path) =>
    jsonPolicy(path, "write", "content.delete"),
  ),
  jsonPolicy("/api/transactions", "write", "content.mutation"),
  ...PROTYLE_EXPORT_ROUTES.map((path) =>
    jsonPolicy(path, "read", "content.export"),
  ),
  jsonPolicy("/api/export/export2Liandi", "admin", "content.export"),
  ...PROTYLE_ADMIN_ROUTES.map((path) => jsonPolicy(path, "admin")),
  {
    action: "read",
    contentMode: "asset",
    identity: "content",
    method: "GET",
    path: "/assets/*path",
    requestHeaders: RESOURCE_REQUEST_HEADERS,
    responseHeaders: RESOURCE_RESPONSE_HEADERS,
  },
  {
    action: "read",
    contentMode: "asset",
    identity: "content",
    method: "GET",
    path: "/emojis/*path",
    requestHeaders: RESOURCE_REQUEST_HEADERS,
    responseHeaders: RESOURCE_RESPONSE_HEADERS,
  },
  {
    action: "write",
    audit: "content.edit",
    contentMode: "upload",
    identity: "content",
    method: "POST",
    path: "/upload",
    requestHeaders: ["accept", "content-length", "content-type"],
    responseHeaders: JSON_RESPONSE_HEADERS,
  },
  {
    action: "read",
    audit: "content.export",
    contentMode: "export",
    identity: "content",
    method: "GET",
    path: "/export/*filepath",
    requestHeaders: RESOURCE_REQUEST_HEADERS,
    responseHeaders: RESOURCE_RESPONSE_HEADERS,
  },
  {
    action: "read",
    contentMode: "websocket",
    identity: "content",
    method: "GET",
    path: "/ws",
    requestHeaders: [],
    responseHeaders: [],
  },
  {
    action: "admin",
    contentMode: "readiness",
    identity: "service",
    method: "GET",
    path: "/internal/readyz",
    requestHeaders: ["accept"],
    responseHeaders: ["cache-control", "content-type"],
  },
  {
    action: "read",
    contentMode: "json",
    identity: "service",
    method: "GET",
    path: "/internal/enterprise/directory/notebooks",
    requestHeaders: ["accept"],
    responseHeaders: ["cache-control", "content-type"],
  },
  {
    action: "read",
    contentMode: "json",
    identity: "service",
    method: "GET",
    path: "/internal/enterprise/directory/documents",
    requestHeaders: ["accept"],
    responseHeaders: ["cache-control", "content-type"],
  },
  {
    action: "read",
    contentMode: "json",
    identity: "content",
    method: "POST",
    path: "/internal/enterprise/share/verify",
    requestHeaders: [],
    responseHeaders: ["cache-control", "content-type"],
  },
  {
    action: "read",
    contentMode: "json",
    identity: "content",
    method: "POST",
    path: "/internal/enterprise/share/document",
    requestHeaders: [],
    responseHeaders: ["cache-control", "content-type"],
  },
  {
    action: "read",
    contentMode: "asset",
    identity: "content",
    method: "GET",
    path: "/internal/enterprise/share/asset",
    requestHeaders: [],
    responseHeaders: [
      "cache-control",
      "content-disposition",
      "content-length",
      "content-type",
      "x-singularity-asset-disposition",
      "x-singularity-asset-filename",
    ],
  },
  {
    action: "admin",
    contentMode: "export",
    identity: "service",
    method: "POST",
    path: "/internal/enterprise/backup",
    requestHeaders: [],
    responseHeaders: [
      "cache-control",
      "content-length",
      "content-type",
      "x-singularity-backup-format-version",
      "x-singularity-backup-sha256",
      "x-singularity-kernel-version",
    ],
  },
  {
    action: "admin",
    contentMode: "readiness",
    identity: "service",
    method: "GET",
    path: "/internal/enterprise/observation",
    requestHeaders: [],
    responseHeaders: ["cache-control", "content-type"],
  },
]);

const ROLE_ACTIONS = {
  admin: new Set<KernelAction>(kernelActions),
  editor: new Set<KernelAction>(["read", "write"]),
  viewer: new Set<KernelAction>(["read"]),
} as const;

export function spaceRoleAllowsKernelAction(
  role: "admin" | "editor" | "viewer",
  action: KernelAction,
): boolean {
  return ROLE_ACTIONS[role].has(action);
}
