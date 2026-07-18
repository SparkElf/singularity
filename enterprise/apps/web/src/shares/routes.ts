export function publicSharePagePath(shareToken: string): string {
  return `/shares/${encodeURIComponent(shareToken)}`;
}
