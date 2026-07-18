import {
  PUBLIC_SHARE_CHALLENGE_PATH_TEMPLATE,
  PUBLIC_SHARE_ASSET_PATH_TEMPLATE,
  PUBLIC_SHARE_PATH_TEMPLATE,
  sharedDocumentPayloadSchema,
  type CreateShareChallengeRequest,
} from "@singularity/contracts";

import { requestJson, requestNoContent } from "@/api/http.ts";
import { buildApiPath } from "@/api/path.ts";

export const publicShareQueryKey = (shareToken: string) =>
  ["public-share", shareToken] as const;

export function publicShareAssetPath(shareToken: string, assetId: string): string {
  return buildApiPath(PUBLIC_SHARE_ASSET_PATH_TEMPLATE, { assetId, shareToken });
}

export function getPublicShare(shareToken: string, signal?: AbortSignal) {
  return requestJson(
    sharedDocumentPayloadSchema,
    buildApiPath(PUBLIC_SHARE_PATH_TEMPLATE, { shareToken }),
    { signal: signal ?? null },
  );
}

export async function createPublicShareChallenge(
  shareToken: string,
  request: CreateShareChallengeRequest,
) {
  return requestNoContent(
    buildApiPath(PUBLIC_SHARE_CHALLENGE_PATH_TEMPLATE, { shareToken }),
    {
      body: JSON.stringify(request),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
  );
}
