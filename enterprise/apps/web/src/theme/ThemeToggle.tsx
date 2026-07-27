import { MoonIcon, SunIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip.tsx";

const THEME_STORAGE_KEY = "singularity-theme";

function readDarkThemePreference(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  const embeddedTheme = new URLSearchParams(window.location.search).get("theme");
  if (embeddedTheme === "dark" || embeddedTheme === "light") {
    return embeddedTheme === "dark";
  }
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  return stored === "dark" ||
    (stored === null && window.matchMedia("(prefers-color-scheme: dark)").matches);
}

/** 将思源风格的明暗外观同步到根节点，保证空间页和企业管理页使用同一组主题变量。 */
export function ThemeToggle() {
  const [dark, setDark] = useState(readDarkThemePreference);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
    window.localStorage.setItem(THEME_STORAGE_KEY, dark ? "dark" : "light");
  }, [dark]);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={dark ? "切换浅色主题" : "切换深色主题"}
          onClick={() => setDark((current) => !current)}
          size="icon-sm"
          variant="ghost"
        >
          {dark ? <SunIcon aria-hidden="true" /> : <MoonIcon aria-hidden="true" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{dark ? "浅色主题" : "深色主题"}</TooltipContent>
    </Tooltip>
  );
}
