import * as React from "react";

import { cn } from "@/lib/utils.ts";

function Select({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      data-slot="select"
      className={cn(
        "h-8 min-w-0 rounded-md border border-input bg-background px-2 py-1 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 max-md:h-10 dark:bg-input/30",
        className,
      )}
      {...props}
    />
  );
}

export { Select };
