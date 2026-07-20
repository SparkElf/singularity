import type { Location } from "react-router";

export const LOGIN_PATH = "/login";
export const SPACES_PATH = "/spaces";

export function locationTarget(
  location: Pick<Location, "hash" | "pathname" | "search">,
): string {
  return `${location.pathname}${location.search}${location.hash}`;
}

export function loginPath(returnTo?: string): string {
  if (!returnTo) {
    return LOGIN_PATH;
  }

  const search = new URLSearchParams({ returnTo });
  return `${LOGIN_PATH}?${search.toString()}`;
}

export function parseReturnTo(search: string, publicOrigin: string): string | null {
  const candidate = new URLSearchParams(search).get("returnTo");
  if (!candidate?.startsWith("/") || candidate.startsWith("//")) {
    return null;
  }

  if (!URL.canParse(candidate, publicOrigin)) {
    return null;
  }
  const target = new URL(candidate, publicOrigin);
  if (
    target.origin !== publicOrigin ||
    target.username !== "" ||
    target.password !== ""
  ) {
    return null;
  }

  return `${target.pathname}${target.search}${target.hash}`;
}
