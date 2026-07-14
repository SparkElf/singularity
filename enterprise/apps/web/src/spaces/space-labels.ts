import type { AuthorizedSpaceSummary } from "@singularity/contracts";

export function roleLabel(role: AuthorizedSpaceSummary["role"]): string {
  switch (role) {
    case "admin":
      return "管理员";
    case "editor":
      return "编辑者";
    case "viewer":
      return "阅读者";
  }
}

export function roleBadgeVariant(
  role: AuthorizedSpaceSummary["role"],
): "default" | "outline" | "secondary" {
  switch (role) {
    case "admin":
      return "default";
    case "editor":
      return "secondary";
    case "viewer":
      return "outline";
  }
}
