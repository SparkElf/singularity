export interface HttpRequestBoundary {
  cookies: Record<string, string | undefined>;
  headers: Record<string, string | string[] | undefined>;
  id: string;
  ip: string;
  url: string;
}

export interface HttpReplyBoundary {
  clearCookie(
    name: string,
    options: {
      httpOnly?: boolean;
      expires?: Date;
      path?: string;
      sameSite?: "lax" | "none" | "strict" | boolean;
      secure?: boolean;
    },
  ): HttpReplyBoundary;
  header(name: string, value: string | number): HttpReplyBoundary;
  setCookie(
    name: string,
    value: string,
    options: {
      httpOnly?: boolean;
      expires?: Date;
      path?: string;
      sameSite?: "lax" | "none" | "strict" | boolean;
      secure?: boolean;
    },
  ): HttpReplyBoundary;
  status(code: number): HttpReplyBoundary;
}

export function singleHeader(
  value: string | readonly string[] | undefined,
): string | undefined {
  return typeof value === "string" ? value : undefined;
}
