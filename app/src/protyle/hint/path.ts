export const contentPathBasename = (path: string): string => path.split("/").pop()!;

export const contentPathExtension = (path: string): string => {
    const basename = contentPathBasename(path);
    const index = basename.lastIndexOf(".");
    return index > 0 ? basename.slice(index).toLowerCase() : "";
};

export const contentPathWithoutExtension = (path: string): string => {
    const extension = contentPathExtension(path);
    return extension ? path.slice(0, -extension.length) : path;
};

export const joinContentPath = (parent: string, child: string): string =>
    `${parent.replace(/\/+$/, "")}/${child.replace(/^\/+/, "")}`;

export const assetDisplayName = (path: string): string => {
    const extension = contentPathExtension(path);
    const basename = contentPathBasename(path);
    return basename.slice(0, extension ? -extension.length : undefined).replace(/-\d{14}-\w{7}$/, "");
};
