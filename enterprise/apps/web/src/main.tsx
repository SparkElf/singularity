import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { createProtyleFactory } from "@singularity/protyle-browser";
import {
  cancelTouchDragBridgeGesture,
  createRealProtyleBrowserCoreFactory,
  installTouchDragBridge,
} from "@singularity/protyle-browser/core";

import { App } from "./app/App.tsx";
import { queryClient } from "./app/query-client.ts";
import { TooltipProvider } from "./components/ui/tooltip.tsx";
import { createProtyleApplicationPort } from "./editor/protyle-application-port.ts";
import type { SpaceProtyleFactoryProvider } from "./spaces/SpacePage.tsx";
import type { SpaceProtyleRuntime } from "./spaces/space-session.ts";
import "./styles.css";

const createProtyleFactoryForSpace: SpaceProtyleFactoryProvider = (spaceId) => {
  const application = createProtyleApplicationPort({
    spaceId,
    storage: window.localStorage,
  });
  const coreFactory = createRealProtyleBrowserCoreFactory<SpaceProtyleRuntime>({
    application,
  });
  return createProtyleFactory(coreFactory, {});
};

const root = document.getElementById("root");

if (!root) {
  throw new Error("Missing #root application mount point");
}

const disposeTouchDragBridge = installTouchDragBridge();
const handleTouchDragBridgePageHide = (event: PageTransitionEvent) => {
  if (event.persisted) {
    cancelTouchDragBridgeGesture();
    return;
  }
  disposeTouchDragBridge();
  window.removeEventListener("pagehide", handleTouchDragBridgePageHide);
};
window.addEventListener("pagehide", handleTouchDragBridgePageHide);

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <BrowserRouter>
          <App createProtyleFactoryForSpace={createProtyleFactoryForSpace} />
        </BrowserRouter>
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
);
