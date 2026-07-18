export const downloadExportFile = (uri: string) => {
    const target = new URL(uri, `${location.origin}/`);
    target.searchParams.set("download", "true");
    window.open(target.href);
};
