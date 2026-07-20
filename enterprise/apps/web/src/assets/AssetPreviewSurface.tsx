import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.tsx";
import { AssetPreview } from "@/assets/AssetPreview.tsx";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet.tsx";
import {
  buildSpaceGatewayAssetDownloadPath,
  buildSpaceGatewayAssetPath,
} from "@/spaces/gateway-paths.ts";

export interface AssetPreviewSurfaceRequest {
  readonly assetPath: string;
  readonly documentId: string;
  readonly initialPage?: number | string;
  readonly notebookId: string;
  readonly organizationId: string;
  readonly spaceId: string;
  readonly title: string;
}

export interface AssetPreviewSurfaceProps {
  readonly onClose: () => void;
  readonly request: AssetPreviewSurfaceRequest | null;
}

export function AssetPreviewSurface({
  onClose,
  request,
}: AssetPreviewSurfaceProps) {
  let source: { readonly download: string; readonly preview: string } | null = null;
  if (request) {
    try {
      const space = {
        organizationId: request.organizationId,
        spaceId: request.spaceId,
      };
      const identity = {
        documentId: request.documentId,
        notebookId: request.notebookId,
      };
      source = {
        download: buildSpaceGatewayAssetDownloadPath(
          space,
          identity,
          request.assetPath,
        ),
        preview: buildSpaceGatewayAssetPath(space, identity, request.assetPath),
      };
    } catch (error) {
      console.error(
        "[asset.preview]",
        { operation: "resolve-source", result: "failed" },
        error,
      );
      source = null;
    }
  }

  return (
    <Sheet
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open={request !== null}
    >
      {request ? (
        <SheetContent
          className="w-full sm:max-w-5xl"
          data-asset-preview
          side="right"
        >
          <SheetHeader className="shrink-0 pr-12">
            <SheetTitle className="truncate">{request.title}</SheetTitle>
            <SheetDescription>受控附件预览</SheetDescription>
          </SheetHeader>
          <div className="flex min-h-0 flex-1 flex-col px-4 pb-4" data-asset-preview-content>
            {source ? (
              <AssetPreview
                downloadSrc={source.download}
                {...(request.initialPage === undefined
                  ? {}
                  : { initialPage: request.initialPage })}
                key={source.preview}
                src={source.preview}
              />
            ) : (
              <Alert data-asset-error variant="destructive">
                <AlertTitle>附件地址无效</AlertTitle>
                <AlertDescription>无法读取该附件。</AlertDescription>
              </Alert>
            )}
          </div>
        </SheetContent>
      ) : null}
    </Sheet>
  );
}
