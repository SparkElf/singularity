import type {
  ProtyleContentIdentity,
  ProtyleResourcePort,
} from "@singularity/protyle-browser";

export const DOCUMENT_ID_HEADER_NAME = "X-Singularity-Document-Id";
export const NOTEBOOK_ID_HEADER_NAME = "X-Singularity-Notebook-Id";

export interface SpaceGatewayIdentity {
  readonly organizationId: string;
  readonly spaceId: string;
}

function encodeResourcePath(path: string): string {
  if (
    path === "" ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("//") ||
    path.includes("?") ||
    path.includes("#")
  ) {
    throw new Error("[protyle.gateway] resource path is not canonical");
  }

  return path.split("/").map((segment) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch (error) {
      console.error(
        "[protyle.gateway]",
        { phase: "resource-path-decode" },
        error,
      );
      throw new Error("[protyle.gateway] resource path is not canonical", {
        cause: error,
      });
    }
    if (
      decoded === "" ||
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("/") ||
      decoded.includes("\\")
    ) {
      throw new Error("[protyle.gateway] resource path is not canonical");
    }
    return encodeURIComponent(decoded);
  }).join("/");
}

function encodeKernelExportPath(path: string): string {
  const prefix = "/export/";
  if (!path.startsWith(prefix)) {
    throw new Error("[protyle.gateway] Kernel export path must start with /export/");
  }
  return encodeResourcePath(path.slice(prefix.length));
}

function contentQuery(identity: ProtyleContentIdentity): string {
  // 目录合同已经在网络入口解析并收敛身份；这里仅序列化已收敛值。
  return new URLSearchParams({
    documentId: identity.documentId,
    notebookId: identity.notebookId,
  }).toString();
}

function buildAssetPath(
  space: SpaceGatewayIdentity,
  identity: ProtyleContentIdentity,
  path: string,
  download: boolean,
): string {
  const encodedPath = encodeResourcePath(path);
  if (!encodedPath.startsWith("assets/")) {
    throw new Error("[protyle.gateway] asset path must start with assets/");
  }

  const query = contentQuery(identity);
  return `${buildSpaceGatewayBasePath(space)}/${encodedPath}?${
    download ? `${query}&download=true` : query
  }`;
}

export function buildSpaceGatewayBasePath(identity: SpaceGatewayIdentity): string {
  const organizationId = encodeURIComponent(identity.organizationId);
  const spaceId = encodeURIComponent(identity.spaceId);
  return `/api/v1/organizations/${organizationId}/spaces/${spaceId}`;
}

export function buildKernelApiPath(
  space: SpaceGatewayIdentity,
  path: string,
): string {
  if (
    !path.startsWith("/api/") ||
    path.includes("//") ||
    path.includes("\\") ||
    path.includes("?") ||
    path.includes("#") ||
    /(?:^|\/)\.{1,2}(?:\/|$)/.test(path) ||
    /%(?:2e|2f|5c)/i.test(path)
  ) {
    throw new Error("[protyle.gateway] Kernel API path is not canonical");
  }
  return `${buildSpaceGatewayBasePath(space)}/kernel/api${path}`;
}

export function buildKernelUploadPath(space: SpaceGatewayIdentity): string {
  return `${buildSpaceGatewayBasePath(space)}/upload`;
}

/**
 * 生成当前空间的附件读取地址；路径与内容身份在同一调用边界收敛。
 */
export function buildSpaceGatewayAssetPath(
  space: SpaceGatewayIdentity,
  identity: ProtyleContentIdentity,
  path: string,
): string {
  return buildAssetPath(space, identity, path, false);
}

/**
 * 生成强制下载地址；它仍携带同一内容身份，不能被当作公共文件地址。
 */
export function buildSpaceGatewayAssetDownloadPath(
  space: SpaceGatewayIdentity,
  identity: ProtyleContentIdentity,
  path: string,
): string {
  return buildAssetPath(space, identity, path, true);
}

export function buildKernelWebSocketUrl(
  space: SpaceGatewayIdentity,
  identity: ProtyleContentIdentity,
): string {
  const path = `${buildSpaceGatewayBasePath(space)}/kernel/ws`;
  const url = new URL(path, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.search = contentQuery(identity);
  url.searchParams.set("type", "protyle");
  return url.href;
}

export function createSpaceGatewayResourcePort(
  space: SpaceGatewayIdentity,
): ProtyleResourcePort {
  const basePath = buildSpaceGatewayBasePath(space);

  return {
    resolveAsset: (identity, path) =>
      buildSpaceGatewayAssetPath(space, identity, path),
    resolveEmoji: (identity, path) =>
      `${basePath}/emojis/${encodeResourcePath(path)}?${contentQuery(identity)}`,
    resolveExport: (identity, path) =>
      `${basePath}/exports/${encodeKernelExportPath(path)}?${contentQuery(identity)}&download=true`,
  };
}
