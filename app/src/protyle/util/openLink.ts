import {protyleContentIdentity} from "./contentLoad";

export const parseProtyleAssetTarget = (linkAddress: string) => {
    const pathAndQuery = linkAddress.split("?", 2);
    const path = pathAndQuery[0];
    const pathSegments = path.split("/");
    if (pathSegments.length === 3 && pathSegments[0] === "assets" &&
        pathSegments[1].toLowerCase().endsWith(".pdf") && /\d{14}-\w{7}/.test(pathSegments[2])) {
        return {
            assetPath: `assets/${pathSegments[1]}`,
            page: pathSegments[2],
        };
    }
    const page = pathAndQuery[1] ? new URLSearchParams(pathAndQuery[1]).get("page") : null;
    return {
        assetPath: path,
        page: page ? Number.parseInt(page, 10) : undefined,
    };
};

export const openProtyleLink = (protyle: IProtyle, link: string) => {
    let linkAddress = Lute.UnEscapeHTMLStr(link).trim();
    if (!linkAddress) {
        return;
    }
    if (linkAddress.toLowerCase().startsWith("assets/")) {
        const identity = protyleContentIdentity(protyle);
        const target = parseProtyleAssetTarget(linkAddress);
        protyle.host.dispatch({
            type: "open-asset",
            documentId: identity.documentId,
            notebookId: identity.notebookId,
            assetPath: target.assetPath,
            page: target.page,
            disposition: protyle.settings.navigation.noSplitScreenWhenOpenTab ? "current" : "split-right",
        });
        return;
    }
    if (!linkAddress.includes(":")) {
        linkAddress = `https://${linkAddress}`;
    }
    protyle.host.dispatch({type: "open-external", url: linkAddress});
};
