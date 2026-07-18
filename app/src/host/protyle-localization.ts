import type {ProtyleLocalizationPort} from "../../../enterprise/packages/protyle-browser/src/contracts";

export const createAppProtyleLocalization = (): ProtyleLocalizationPort => ({
    attributeViewText: (key) => window.siyuan.languages._attrView[key],
    get language() {
        return window.siyuan.config.appearance.lang;
    },
    kernelText: (index) => window.siyuan.languages["_kernel"][index],
    text: (key) => window.siyuan.languages[key],
});
