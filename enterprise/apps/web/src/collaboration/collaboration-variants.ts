import { cva } from "class-variance-authority";

/** 协作状态只使用奇点语义 token，避免评论、通知和历史页面各自定义颜色。 */
export const collaborationStatusVariants = cva(
  "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px]",
  {
    variants: {
      status: {
        open: "border-primary/30 bg-accent text-accent-foreground",
        resolved: "border-border bg-muted text-muted-foreground",
        unread: "border-primary/30 bg-accent text-accent-foreground",
        read: "border-border bg-background text-muted-foreground",
      },
    },
  },
);
