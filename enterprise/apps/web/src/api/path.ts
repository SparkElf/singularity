export type ApiPathParameters = Readonly<Record<string, string>>;

export function buildApiPath(
  template: string,
  parameters: ApiPathParameters,
): string {
  let path = template;
  for (const [name, value] of Object.entries(parameters)) {
    path = path.replace(`{${name}}`, encodeURIComponent(value));
  }
  return path;
}
