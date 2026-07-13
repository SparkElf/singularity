import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { App } from "./App.tsx";
import { TooltipProvider } from "@/components/ui/tooltip.tsx";

describe("App", () => {
  it("renders the workspace and toggles the sidebar", () => {
    const { container } = render(
      <TooltipProvider>
        <MemoryRouter initialEntries={["/workspace"]}>
          <App />
        </MemoryRouter>
      </TooltipProvider>,
    );

    expect(screen.getByRole("heading", { name: "选择一篇文档开始阅读" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "切换侧栏" }));
    expect(container.querySelector("[data-slot=sidebar]")).toHaveAttribute("data-state", "collapsed");
  });
});
