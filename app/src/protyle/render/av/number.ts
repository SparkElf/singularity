import {transaction} from "../../wysiwyg/transaction";
import {Constants} from "../../../constants";
import {type AVMenuSurface, openAVMenu} from "./menu";
import {closeOwnedAVOverlay} from "./overlay";

const addFormatItem = (options: {
    menu: AVMenuSurface,
    protyle: IProtyle,
    colId: string,
    avID: string,
    format: string,
    oldFormat: string
    avPanelElement: Element
}) => {
    options.menu.addItem({
        iconHTML: "",
        label: getLabelByNumberFormat(options.format, options.protyle.localization),
        click() {
            transaction(options.protyle, [{
                action: "updateAttrViewColNumberFormat",
                id: options.colId,
                avID: options.avID,
                format: options.format,
                type: "number",
            }], [{
                action: "updateAttrViewColNumberFormat",
                id: options.colId,
                avID: options.avID,
                format: options.oldFormat,
                type: "number",
            }]);
            closeOwnedAVOverlay(options.protyle, "panel", options.avPanelElement);
        }
    });
};

export const formatNumber = (options: {
    avPanelElement: Element,
    element: HTMLElement,
    protyle: IProtyle,
    colId: string,
    avID: string,
    oldFormat: string
}) => {
    const menuHandle = openAVMenu(options.protyle, Constants.MENU_AV_COL_FORMAT_NUMBER);
    if (!menuHandle) {
        return;
    }
    const {menu} = menuHandle;
    addFormatItem({
        menu,
        protyle: options.protyle,
        colId: options.colId,
        avID: options.avID,
        format: "",
        oldFormat: options.oldFormat,
        avPanelElement: options.avPanelElement,
    });
    addFormatItem({
        menu,
        protyle: options.protyle,
        colId: options.colId,
        avID: options.avID,
        format: "commas",
        oldFormat: options.oldFormat,
        avPanelElement: options.avPanelElement,
    });
    addFormatItem({
        menu,
        protyle: options.protyle,
        colId: options.colId,
        avID: options.avID,
        format: "percent",
        oldFormat: options.oldFormat,
        avPanelElement: options.avPanelElement,
    });
    addFormatItem({
        menu,
        protyle: options.protyle,
        colId: options.colId,
        avID: options.avID,
        format: "USD",
        oldFormat: options.oldFormat,
        avPanelElement: options.avPanelElement,
    });
    addFormatItem({
        menu,
        protyle: options.protyle,
        colId: options.colId,
        avID: options.avID,
        format: "CNY",
        oldFormat: options.oldFormat,
        avPanelElement: options.avPanelElement,
    });
    addFormatItem({
        menu,
        protyle: options.protyle,
        colId: options.colId,
        avID: options.avID,
        format: "EUR",
        oldFormat: options.oldFormat,
        avPanelElement: options.avPanelElement,
    });
    addFormatItem({
        menu,
        protyle: options.protyle,
        colId: options.colId,
        avID: options.avID,
        format: "GBP",
        oldFormat: options.oldFormat,
        avPanelElement: options.avPanelElement,
    });
    addFormatItem({
        menu,
        protyle: options.protyle,
        colId: options.colId,
        avID: options.avID,
        format: "JPY",
        oldFormat: options.oldFormat,
        avPanelElement: options.avPanelElement,
    });
    addFormatItem({
        menu,
        protyle: options.protyle,
        colId: options.colId,
        avID: options.avID,
        format: "RUB",
        oldFormat: options.oldFormat,
        avPanelElement: options.avPanelElement,
    });
    addFormatItem({
        menu,
        protyle: options.protyle,
        colId: options.colId,
        avID: options.avID,
        format: "INR",
        oldFormat: options.oldFormat,
        avPanelElement: options.avPanelElement,
    });
    addFormatItem({
        menu,
        protyle: options.protyle,
        colId: options.colId,
        avID: options.avID,
        format: "KRW",
        oldFormat: options.oldFormat,
        avPanelElement: options.avPanelElement,
    });
    addFormatItem({
        menu,
        protyle: options.protyle,
        colId: options.colId,
        avID: options.avID,
        format:"TRY",
        oldFormat: options.oldFormat,
        avPanelElement: options.avPanelElement,
    });
    addFormatItem({
        menu,
        protyle: options.protyle,
        colId: options.colId,
        avID: options.avID,
        format: "CAD",
        oldFormat: options.oldFormat,
        avPanelElement: options.avPanelElement,
    });
    addFormatItem({
        menu,
        protyle: options.protyle,
        colId: options.colId,
        avID: options.avID,
        format: "CHF",
        oldFormat: options.oldFormat,
        avPanelElement: options.avPanelElement,
    });
    addFormatItem({
        menu,
        protyle: options.protyle,
        colId: options.colId,
        avID: options.avID,
        format: "THB",
        oldFormat: options.oldFormat,
        avPanelElement: options.avPanelElement,
    });
    addFormatItem({
        menu,
        protyle: options.protyle,
        colId: options.colId,
        avID: options.avID,
        format: "AUD",
        oldFormat: options.oldFormat,
        avPanelElement: options.avPanelElement,
    });
    addFormatItem({
        menu,
        protyle: options.protyle,
        colId: options.colId,
        avID: options.avID,
        format: "HKD",
        oldFormat: options.oldFormat,
        avPanelElement: options.avPanelElement,
    });
    addFormatItem({
        menu,
        protyle: options.protyle,
        colId: options.colId,
        avID: options.avID,
        format: "TWD",
        oldFormat: options.oldFormat,
        avPanelElement: options.avPanelElement,
    });
    addFormatItem({
        menu,
        protyle: options.protyle,
        colId: options.colId,
        avID: options.avID,
        format: "MOP",
        oldFormat: options.oldFormat,
        avPanelElement: options.avPanelElement,
    });
    addFormatItem({
        menu,
        protyle: options.protyle,
        colId: options.colId,
        avID: options.avID,
        format: "SGD",
        oldFormat: options.oldFormat,
        avPanelElement: options.avPanelElement,
    });
    addFormatItem({
        menu,
        protyle: options.protyle,
        colId: options.colId,
        avID: options.avID,
        format: "NZD",
        oldFormat: options.oldFormat,
        avPanelElement: options.avPanelElement,
    });
    addFormatItem({
        menu,
        protyle: options.protyle,
        colId: options.colId,
        avID: options.avID,
        format:"ILS",
        oldFormat: options.oldFormat,
        avPanelElement: options.avPanelElement,
    });

    const rect = options.element.getBoundingClientRect();
    menu.popup({
        x: rect.left,
        y: rect.bottom,
        h: rect.height,
        w: rect.width,
        isLeft: true,
    });
};

export const getLabelByNumberFormat = (format: string, localization: IProtyle["localization"]) => {
    if ("" === format) {
        return localization.text("numberFormatNone");
    } else if ("commas" === format) {
        return localization.text("numberFormatCommas");
    } else if ("percent" === format) {
        return localization.text("numberFormatPercent");
    }

    return localization.text("numberFormat" + format);
};
