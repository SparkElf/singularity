import type {ProtyleLocalizationPort} from "../../../enterprise/packages/protyle-browser/src/contracts";

export const createAppProtyleLocalization = (): ProtyleLocalizationPort => ({
    get language() {
        return window.siyuan.config.appearance.lang;
    },
    kernelText: (index) => window.siyuan.languages["_kernel"][index],
    text: (key) => window.siyuan.languages[key],
});
