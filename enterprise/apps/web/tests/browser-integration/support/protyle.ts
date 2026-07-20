import type { Locator } from "@playwright/test";

// 返回内容块本体，排除同样携带 data-node-id 的无障碍操作按钮。
export function contentBlock(root: Locator, nodeId: string): Locator {
  return root.locator(`[data-node-id="${nodeId}"]:not(.ariaLabel)`);
}
