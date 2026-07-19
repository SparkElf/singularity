import {transaction} from "../../wysiwyg/transaction";
import {hasClosestBlock, hasClosestByClassName} from "../../util/hasClosest";
import {getFieldsByData} from "./view";
import {Constants} from "../../../constants";
import {openProtyleDialog} from "../../wysiwyg/dialogOwner";
import {escapeAttr} from "../../../util/escape";
import {beginAVRenderLoad, reportAVLoadFailure, requestAVRender} from "./load";
import {type AVMenuSurface, openAVMenu} from "./menu";

const calcItem = (options: {
    menu: AVMenuSurface,
    protyle: IProtyle,
    operator: string,
    oldOperator: string,
    colId: string,
    data?: IAV, // rollup
    target: HTMLElement,
    avId: string,
    blockID: string,
    template?: string,
    oldTemplate?: string
}) => {
    const {localization} = options.protyle;
    options.menu.addItem({
        iconHTML: "",
        label: getNameByOperator(options.operator, !!options.data, localization),
        click() {
            if (!options.data) {
                const doData: IAVCalc = {operator: options.operator};
                if (options.operator === "Template" && options.template) {
                    doData.template = options.template;
                }
                const undoData: IAVCalc = {operator: options.oldOperator};
                if (options.oldOperator === "Template" && options.oldTemplate) {
                    undoData.template = options.oldTemplate;
                }
                transaction(options.protyle, [{
                    action: "setAttrViewColCalc",
                    avID: options.avId,
                    id: options.colId,
                    data: doData,
                    blockID: options.blockID
                }], [{
                    action: "setAttrViewColCalc",
                    avID: options.avId,
                    id: options.colId,
                    data: undoData,
                    blockID: options.blockID
                }]);
            } else {
                options.target.querySelector(".b3-menu__accelerator").textContent = getNameByOperator(
                    options.operator,
                    true,
                    localization,
                );
                const colData = getFieldsByData(options.data).find((item) => {
                    if (item.id === options.colId) {
                        if (!item.rollup) {
                            item.rollup = {};
                        }
                        return true;
                    }
                });
                colData.rollup.calc = {
                    operator: options.operator
                };
                transaction(options.protyle, [{
                    action: "updateAttrViewColRollup",
                    id: options.colId,
                    avID: options.avId,
                    parentID: colData.rollup.relationKeyID,
                    keyID: colData.rollup.keyID,
                    data: {
                        calc: colData.rollup.calc,
                    },
                }], [{
                    action: "updateAttrViewColRollup",
                    id: options.colId,
                    avID: options.avId,
                    parentID: colData.rollup.relationKeyID,
                    keyID: colData.rollup.keyID,
                    data: {
                        calc: {
                            operator: options.oldOperator
                        },
                    }
                }]);
            }
        }
    });
};

export const openCalcMenu = async (protyle: IProtyle, calcElement: HTMLElement, panelData?: {
    data: IAV,
    colId: string,
    blockID: string
}, x?: number) => {
    const {localization} = protyle;
    const load = beginAVRenderLoad(protyle, calcElement);
    let rowElement: HTMLElement | false;
    let type;
    let colId: string;
    let avId: string;
    let oldOperator: string;
    let blockID: string;
    if (panelData) {
        avId = panelData.data.id;
        type = calcElement.dataset.colType as TAVCol;
        oldOperator = calcElement.dataset.calc;
        colId = panelData.colId;
        blockID = panelData.blockID;
    } else {
        const blockElement = hasClosestBlock(calcElement);
        if (!blockElement) {
            return;
        }
        rowElement = hasClosestByClassName(calcElement, "av__row--footer");
        if (!rowElement) {
            return;
        }
        rowElement.classList.add("av__row--show");
        type = calcElement.dataset.dtype as TAVCol;
        colId = calcElement.dataset.colId;
        avId = blockElement.dataset.avId;
        oldOperator = calcElement.dataset.operator;
        blockID = blockElement.dataset.nodeId;
    }
    if (type === "lineNumber") {
        return;
    }
    const menuHandle = openAVMenu(protyle, Constants.MENU_AV_CALC, () => {
        if (rowElement) {
            rowElement.classList.remove("av__row--show");
        }
    });
    if (!menuHandle) {
        return;
    }
    const {menu} = menuHandle;
    calcItem({
        menu,
        protyle,
        colId,
        avId,
        oldOperator,
        operator: "",
        data: panelData?.data,
        blockID,
        target: calcElement
    });
    if (panelData?.data && type !== "checkbox") {
        // 汇总字段汇总方式中才有“显示唯一值”选项 Add "Show unique values" to the calculation of the database rollup field https://github.com/siyuan-note/siyuan/issues/15852
        calcItem({
            menu,
            protyle,
            colId,
            avId,
            oldOperator,
            operator: "Unique values",
            data: panelData?.data,
            blockID,
            target: calcElement
        });
    }
    calcItem({
        menu,
        protyle,
        colId,
        avId,
        oldOperator,
        operator: "Count all",
        data: panelData?.data,
        blockID,
        target: calcElement
    });
    if (type !== "checkbox") {
        calcItem({
            menu,
            protyle,
            colId,
            avId,
            oldOperator,
            operator: "Count empty",
            data: panelData?.data,
            blockID,
            target: calcElement
        });
        calcItem({
            menu,
            protyle,
            colId,
            avId,
            oldOperator,
            operator: "Count not empty",
            data: panelData?.data,
            blockID,
            target: calcElement
        });
        calcItem({
            menu,
            protyle,
            colId,
            avId,
            oldOperator,
            operator: "Count values",
            data: panelData?.data,
            blockID,
            target: calcElement
        });
        calcItem({
            menu,
            protyle,
            colId,
            avId,
            oldOperator,
            operator: "Count unique values",
            data: panelData?.data,
            blockID,
            target: calcElement
        });
        calcItem({
            menu,
            protyle,
            colId,
            avId,
            oldOperator,
            operator: "Percent empty",
            data: panelData?.data,
            blockID,
            target: calcElement
        });
        calcItem({
            menu,
            protyle,
            colId,
            avId,
            oldOperator,
            operator: "Percent not empty",
            data: panelData?.data,
            blockID,
            target: calcElement
        });
        calcItem({
            menu,
            protyle,
            colId,
            avId,
            oldOperator,
            operator: "Percent unique values",
            data: panelData?.data,
            blockID,
            target: calcElement
        });
    } else {
        calcItem({
            menu,
            protyle,
            colId,
            avId,
            oldOperator,
            operator: "Checked",
            data: panelData?.data,
            blockID,
            target: calcElement
        });
        calcItem({
            menu,
            protyle,
            colId,
            avId,
            oldOperator,
            operator: "Unchecked",
            data: panelData?.data,
            blockID,
            target: calcElement
        });
        calcItem({
            menu,
            protyle,
            colId,
            avId,
            oldOperator,
            operator: "Percent checked",
            data: panelData?.data,
            blockID,
            target: calcElement
        });
        calcItem({
            menu,
            protyle,
            colId,
            avId,
            oldOperator,
            operator: "Percent unchecked",
            data: panelData?.data,
            blockID,
            target: calcElement
        });
    }
    let rollupIsNumber = false;
    if (type === "rollup") {
        // 行级汇总结果本身就是数字的操作（如计数、百分比、复选统计），即使目标字段不是数字类型，
        // 底部计算也应支持 Sum/Average 等数字计算方式
        const numericRowCalcOperators = [
            "Count all", "Count values", "Count unique values", "Count empty", "Count not empty",
            "Percent empty", "Percent not empty", "Percent unique values",
            "Checked", "Unchecked", "Percent checked", "Percent unchecked",
        ];
        let relationKeyID: string;
        let keyID: string;
        let rowCalcOperator: string;
        let avData = panelData?.data;
        if (!avData) {
            let avResponse: IWebSocketData;
            try {
                avResponse = await requestAVRender<IWebSocketData>(protyle, load, "/api/av/renderAttributeView", {
                    id: avId,
                    notebook: load.identity.notebookId,
                });
            } catch (error) {
                reportAVLoadFailure(load, "attribute view calculation metadata", error);
                return;
            }
            if (!load.isCurrent()) {
                return;
            }
            avData = avResponse.data;
        }

        getFieldsByData(avData).find((item) => {
            if (item.id === colId) {
                relationKeyID = item.rollup?.relationKeyID;
                keyID = item.rollup?.keyID;
                rowCalcOperator = item.rollup?.calc?.operator;
                return true;
            }
        });
        if (numericRowCalcOperators.includes(rowCalcOperator)) {
            rollupIsNumber = true;
        }
        if (relationKeyID && keyID) {
            let relationAvId: string;
            getFieldsByData(avData).find((item) => {
                if (item.id === relationKeyID) {
                    relationAvId = item.relation?.avID;
                    return true;
                }
            });
            if (relationAvId) {
                let colResponse: IWebSocketData;
                try {
                    colResponse = await requestAVRender<IWebSocketData>(protyle, load,
                        "/api/av/getAttributeView", {id: relationAvId});
                } catch (error) {
                    reportAVLoadFailure(load, "attribute view rollup calculation metadata", error);
                    return;
                }
                if (!load.isCurrent()) {
                    return;
                }
                colResponse.data.av.keyValues.find((item: { key: { id: string, name: string, type: TAVCol } }) => {
                    if (item.key.id === keyID) {
                        rollupIsNumber = item.key.type === "number" || rollupIsNumber;
                        return true;
                    }
                });
            }
        }
    }
    if (["number", "template"].includes(type) || rollupIsNumber) {
        calcItem({
            menu,
            protyle,
            colId,
            avId,
            oldOperator,
            operator: "Sum",
            data: panelData?.data,
            blockID,
            target: calcElement
        });
        calcItem({
            menu,
            protyle,
            colId,
            avId,
            oldOperator,
            operator: "Average",
            data: panelData?.data,
            blockID,
            target: calcElement
        });
        calcItem({
            menu,
            protyle,
            colId,
            avId,
            oldOperator,
            operator: "Median",
            data: panelData?.data,
            blockID,
            target: calcElement
        });
        calcItem({
            menu,
            protyle,
            colId,
            avId,
            oldOperator,
            operator: "Min",
            data: panelData?.data,
            blockID,
            target: calcElement
        });
        calcItem({
            menu,
            protyle,
            colId,
            avId,
            oldOperator,
            operator: "Max",
            data: panelData?.data,
            blockID,
            target: calcElement
        });
        calcItem({
            menu,
            protyle,
            colId,
            avId,
            oldOperator,
            operator: "Range",
            data: panelData?.data,
            blockID,
            target: calcElement
        });
    } else if (["date", "created", "updated"].includes(type)) {
        calcItem({
            menu,
            protyle,
            colId,
            avId,
            oldOperator,
            operator: "Earliest",
            data: panelData?.data,
            blockID,
            target: calcElement
        });
        calcItem({
            menu,
            protyle,
            colId,
            avId,
            oldOperator,
            operator: "Latest",
            data: panelData?.data,
            blockID,
            target: calcElement
        });
        calcItem({
            menu,
            protyle,
            colId,
            avId,
            oldOperator,
            operator: "Range",
            data: panelData?.data,
            blockID,
            target: calcElement
        });
    }
    // 底部计算支持自定义模板统计
    // 获取当前列已有的模板内容（footer 路径下需异步拉取列数据）
    let currentTemplate = "";
    if (panelData?.data) {
        const colData = getFieldsByData(panelData.data).find((item) => item.id === colId);
        currentTemplate = colData?.calc?.template || "";
    } else {
        let avResponse: IWebSocketData;
        try {
            avResponse = await requestAVRender<IWebSocketData>(protyle, load, "/api/av/renderAttributeView", {
                id: avId,
                notebook: load.identity.notebookId,
            });
        } catch (error) {
            reportAVLoadFailure(load, "attribute view calculation template", error);
            return;
        }
        if (!load.isCurrent()) {
            return;
        }
        const colData = getFieldsByData(avResponse.data).find((item) => item.id === colId);
        currentTemplate = colData?.calc?.template || "";
    }
    // 提交模板统计：将底部计算切换为 Template 并写入模板内容；模板为空时恢复为“无”
    const submitTemplate = (templateContent: string) => {
        const isEmpty = "" === templateContent.trim();
        const doData: IAVCalc = isEmpty ? {operator: ""} : {operator: "Template", template: templateContent};
        const undoData: IAVCalc = {operator: oldOperator || ""};
        if (oldOperator === "Template" && currentTemplate) {
            undoData.template = currentTemplate;
        }
        transaction(protyle, [{
            action: "setAttrViewColCalc",
            avID: avId,
            id: colId,
            data: doData,
            blockID
        }], [{
            action: "setAttrViewColCalc",
            avID: avId,
            id: colId,
            data: undoData,
            blockID
        }]);
    };
    menu.addItem({
        iconHTML: "",
        label: getNameByOperator("Template", !!panelData?.data, localization),
        click() {
            menuHandle.close();
            const dialog = openProtyleDialog({
                protyle,
                title: localization.text("calcOperatorTemplate"),
                width: "520px",
            });
            dialog.bodyElement.innerHTML = `<div class="b3-dialog__content">
    <textarea spellcheck="false" class="fn__block b3-text-field" placeholder="${escapeAttr(localization.text("rollupTemplateTip"))}" rows="8" style="resize: vertical;font-family: var(--b3-font-family-code);"></textarea>
</div>
<div class="b3-dialog__action">
    <button class="b3-button b3-button--cancel">${localization.text("cancel")}</button><div class="fn__space"></div>
    <button class="b3-button b3-button--text">${localization.text("confirm")}</button>
</div>`;
            const textarea = dialog.bodyElement.querySelector("textarea") as HTMLTextAreaElement;
            const confirmBtn = dialog.bodyElement.querySelector(".b3-button--text") as HTMLButtonElement;
            const cancelBtn = dialog.bodyElement.querySelector(".b3-button--cancel") as HTMLButtonElement;
            textarea.value = currentTemplate;
            const confirm = () => {
                submitTemplate(textarea.value);
                dialog.close();
            };
            confirmBtn.addEventListener("click", confirm, {signal: dialog.signal});
            cancelBtn.addEventListener("click", dialog.close, {signal: dialog.signal});
            textarea.addEventListener("keydown", (event) => {
                if (!event.isComposing && !event.shiftKey && event.key === "Enter" && !event.repeat) {
                    event.preventDefault();
                    event.stopPropagation();
                    confirm();
                }
            }, {signal: dialog.signal});
            textarea.focus();
        }
    });
    const calcRect = calcElement.getBoundingClientRect();
    menu.popup({x: Math.max(x || 0, calcRect.left), y: calcRect.bottom, h: calcRect.height});
};

export const getCalcValue = (column: IAVColumn, localization: IProtyle["localization"]) => {
    if (!column.calc || !column.calc.result) {
        return "";
    }
    let resultCalc: any = column.calc.result.number;
    if (column.calc.operator === "Earliest" || column.calc.operator === "Latest" ||
        (column.calc.operator === "Range" && ["date", "created", "updated"].includes(column.type))) {
        resultCalc = column.calc.result[column.type as "date"];
    } else if (column.calc.operator === "Template") {
        // 自定义模板统计：数字输出走 number，文本输出走 text
        resultCalc = column.calc.result.number || column.calc.result.text;
    }
    let value = "";
    switch (column.calc.operator) {
        case "Count all":
            value = `<span>${resultCalc.formattedContent}</span><small>${localization.text("calcResultCountAll")}</small>`;
            break;
        case "Count values":
            value = `<span>${resultCalc.formattedContent}</span><small>${localization.text("calcResultCountValues")}</small>`;
            break;
        case "Count unique values":
            value = `<span>${resultCalc.formattedContent}</span><small>${localization.text("calcResultCountUniqueValues")}</small>`;
            break;
        case "Count empty":
            value = `<span>${resultCalc.formattedContent}</span><small>${localization.text("calcResultCountEmpty")}</small>`;
            break;
        case "Count not empty":
            value = `<span>${resultCalc.formattedContent}</span><small>${localization.text("calcResultCountNotEmpty")}</small>`;
            break;
        case "Percent empty":
            value = `<span>${resultCalc.formattedContent}</span><small>${localization.text("calcResultPercentEmpty")}</small>`;
            break;
        case "Percent not empty":
            value = `<span>${resultCalc.formattedContent}</span><small>${localization.text("calcResultPercentNotEmpty")}</small>`;
            break;
        case "Percent unique values":
            value = `<span>${resultCalc.formattedContent}</span><small>${localization.text("calcResultPercentUniqueValues")}</small>`;
            break;
        case "Sum":
            value = `<span>${resultCalc.formattedContent}</span><small>${localization.text("calcResultSum")}</small>`;
            break;
        case  "Average":
            value = `<span>${resultCalc.formattedContent}</span><small>${localization.text("calcResultAverage")}</small>`;
            break;
        case  "Median":
            value = `<span>${resultCalc.formattedContent}</span><small>${localization.text("calcResultMedian")}</small>`;
            break;
        case  "Min":
            value = `<span>${resultCalc.formattedContent}</span><small>${localization.text("calcResultMin")}</small>`;
            break;
        case  "Max":
            value = `<span>${resultCalc.formattedContent}</span><small>${localization.text("calcResultMax")}</small>`;
            break;
        case  "Range":
            value = `<span>${resultCalc.formattedContent}</span><small>${localization.text("calcResultRange")}</small>`;
            break;
        case  "Earliest":
            value = `<span>${resultCalc.formattedContent}</span><small>${localization.text("calcOperatorEarliest")}</small>`;
            break;
        case  "Latest":
            value = `<span>${resultCalc.formattedContent}</span><small>${localization.text("calcOperatorLatest")}</small>`;
            break;
        case  "Checked":
            value = `<span>${resultCalc.formattedContent}</span><small>${localization.text("checked")}</small>`;
            break;
        case  "Unchecked":
            value = `<span>${resultCalc.formattedContent}</span><small>${localization.text("unchecked")}</small>`;
            break;
        case  "Percent checked":
            value = `<span>${resultCalc.formattedContent}</span><small>${localization.text("percentChecked")}</small>`;
            break;
        case  "Percent unchecked":
            value = `<span>${resultCalc.formattedContent}</span><small>${localization.text("percentUnchecked")}</small>`;
            break;
        case  "Template":
            value = `<span>${resultCalc.formattedContent ?? resultCalc.content}</span><small>${localization.text("calcResultTemplate")}</small>`;
            break;
    }
    return value;
};

export const getNameByOperator = (
    operator: string,
    isRollup: boolean,
    localization: IProtyle["localization"],
) => {
    switch (operator) {
        case undefined:
        case "":
            return isRollup ? localization.text("original") : localization.text("calcOperatorNone");
        case "Unique values": // 仅汇总字段的汇总方式在使用
            return localization.text("uniqueValues");
        case "Count all":
            return localization.text("calcOperatorCountAll");
        case "Count values":
            return localization.text("calcOperatorCountValues");
        case "Count unique values":
            return localization.text("calcOperatorCountUniqueValues");
        case "Count empty":
            return localization.text("calcOperatorCountEmpty");
        case "Count not empty":
            return localization.text("calcOperatorCountNotEmpty");
        case "Percent empty":
            return localization.text("calcOperatorPercentEmpty");
        case "Percent not empty":
            return localization.text("calcOperatorPercentNotEmpty");
        case "Percent unique values":
            return localization.text("calcOperatorPercentUniqueValues");
        case "Checked":
            return localization.text("checked");
        case "Unchecked":
            return localization.text("unchecked");
        case "Percent checked":
            return localization.text("percentChecked");
        case "Percent unchecked":
            return localization.text("percentUnchecked");
        case "Sum":
            return localization.text("calcOperatorSum");
        case "Average":
            return localization.text("calcOperatorAverage");
        case "Median":
            return localization.text("calcOperatorMedian");
        case "Min":
            return localization.text("calcOperatorMin");
        case "Max":
            return localization.text("calcOperatorMax");
        case "Range":
            return localization.text("calcOperatorRange");
        case "Earliest":
            return localization.text("calcOperatorEarliest");
        case "Latest":
            return localization.text("calcOperatorLatest");
        case "Template":
            return localization.text("calcOperatorTemplate");
        default:
            return "";
    }
};
