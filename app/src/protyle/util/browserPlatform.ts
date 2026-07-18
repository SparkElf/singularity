/** Browser platform facts shared by the canonical Protyle Core. */
export const isIPhone = () => navigator.userAgent.includes("iPhone");

export const isIPad = () => navigator.userAgent.includes("iPad");

export const isIOSDevice = () => isIPhone() || isIPad();

export const isMac = () => navigator.platform.toUpperCase().includes("MAC");

export const isWindows = () => navigator.platform.toUpperCase().includes("WIN");

export const isSafari = () => {
    const userAgent = navigator.userAgent;
    return userAgent.includes("Safari") && !userAgent.includes("Chrome") && !userAgent.includes("Chromium");
};

export const isPhablet = () =>
    /Android|webOS|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|Tablet/i.test(navigator.userAgent) ||
    isIPhone() || isIPad();

export const isTouchInput = () => navigator.maxTouchPoints > 0;

export const isNarrowViewport = () => document.documentElement.clientWidth <= 768;

export const getViewportWidth = () => document.documentElement.clientWidth;

export const getEventName = () => isIPhone() ? "touchstart" : "click";

export const isInEdge = () => {
    const userAgent = navigator.userAgent;
    return userAgent.includes("EdgA/") || userAgent.includes("Edge/");
};

export const isChromeBrowser = (): boolean => {
    const nav = navigator as Navigator & {
        userAgentData?: {
            brands: Array<{brand: string; version: string}>;
        };
    };
    const browserBrands = nav.userAgentData?.brands;
    if (Array.isArray(browserBrands)) {
        const names = browserBrands.map((brand) => brand.brand);
        if (names.some((brand) => /Edge|Opera|OPR/i.test(brand))) {
            return false;
        }
        return names.some((brand) => /Chrome|Chromium/i.test(brand));
    }

    const userAgent = nav.userAgent;
    const isChromium = /\bChrome\/\d+/i.test(userAgent) || /\bChromium\/\d+/i.test(userAgent);
    const isEdge = /\bEdg(e|A|iOS)?\/\d+/i.test(userAgent);
    const isOpera = /\b(OPR|Opera)\/\d+/i.test(userAgent);
    return isChromium && !isEdge && !isOpera;
};

export const isWin11 = async () => {
    const nav = navigator as Navigator & {
        userAgentData?: {
            platform: string;
            getHighEntropyValues?: (hints: string[]) => Promise<{platformVersion: string}>;
        };
    };
    const userAgentData = nav.userAgentData;
    if (!userAgentData?.getHighEntropyValues) {
        return false;
    }
    const values = await userAgentData.getHighEntropyValues(["platformVersion"]);
    return userAgentData.platform === "Windows" &&
        parseInt(values.platformVersion.split(".")[0], 10) >= 13;
};
