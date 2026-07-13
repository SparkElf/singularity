import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";

import { App } from "./app/App.tsx";
import { queryClient } from "./app/query-client.ts";
import { TooltipProvider } from "./components/ui/tooltip.tsx";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Missing #root application mount point");
}

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
);
