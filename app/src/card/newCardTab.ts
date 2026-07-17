import {Tab} from "../layout/Tab";
import {Custom} from "../layout/dock/Custom";
import {bindCardEvent, genCardHTML} from "./openCard";
import {fetchPost} from "../util/fetch";
import {EmbeddedProtyleOwner} from "../protyle/EmbeddedProtyleOwner";
import {setPanelFocus} from "../layout/util";
import {App} from "../index";
import {clearOBG} from "../layout/dock/util";
import {OwnerGeneration, OwnerLifecycle} from "../protyle/runtime/ownerLifecycle";

export const newCardModel = (options: {
    app: App,
    tab: Tab,
    data: {
        cardType: TCardType,
        id: string,
        title?: string
        cardsData?: ICardData,
        index?: number,
    }
}) => {
    let editor: EmbeddedProtyleOwner | undefined;
    const lifecycle = new OwnerLifecycle();

    const releaseEditor = (custom: Custom) => {
        const currentEditor = editor;
        editor = undefined;
        custom.editors.length = 0;
        currentEditor?.destroy();
    };

    const mountCards = async (custom: Custom, sourceCardsData: ICardData,
                              ownerGeneration: OwnerGeneration, index?: number) => {
        let cardsData = sourceCardsData;
        for (let i = 0; i < options.app.plugins.length; i++) {
            cardsData = await options.app.plugins[i].updateCards(cardsData);
            if (!lifecycle.isCurrent(ownerGeneration, custom.element.isConnected)) {
                return false;
            }
        }
        if (!lifecycle.isCurrent(ownerGeneration, custom.element.isConnected)) {
            return false;
        }

        releaseEditor(custom);
        custom.element.innerHTML = genCardHTML({
            id: custom.data.id,
            cardType: custom.data.cardType,
            cardsData,
            isTab: true,
        });

        const nextEditor = bindCardEvent({
            app: options.app,
            element: custom.element,
            id: custom.data.id,
            title: custom.data.title,
            cardType: custom.data.cardType,
            cardsData,
            index,
            lifecycle,
        });

        editor = nextEditor;
        custom.editors.push(nextEditor);
        nextEditor.resize();
        return true;
    };

    const customObj = new Custom({
        app: options.app,
        type: "siyuan-card",
        tab: options.tab,
        data: options.data,
        async init(custom) {
            const ownerGeneration = lifecycle.begin();
            if (custom.data.cardsData) {
                if (await mountCards(custom, custom.data.cardsData, ownerGeneration, custom.data.index)) {
                    // https://github.com/siyuan-note/siyuan/issues/9561#issuecomment-1794473512
                    delete custom.data.cardsData;
                    delete custom.data.index;
                }
            } else {
                const requestData: IObject = {
                    rootID: custom.data.id,
                    deckID: custom.data.id,
                };
                if (custom.data.cardType === "notebook") {
                    requestData.notebook = custom.data.id;
                }
                fetchPost(custom.data.cardType === "all" ? "/api/riff/getRiffDueCards" :
                    (custom.data.cardType === "doc" ? "/api/riff/getTreeRiffDueCards" : "/api/riff/getNotebookRiffDueCards"), requestData, (response) => {
                    if (lifecycle.isCurrent(ownerGeneration, custom.element.isConnected)) {
                        void mountCards(custom, response.data, ownerGeneration);
                    }
                }, undefined, undefined, ownerGeneration.signal);
            }
        },
        destroy() {
            if (lifecycle.ended) {
                return;
            }
            lifecycle.destroy();
            releaseEditor(customObj);
        },
        resize() {
            if (editor) {
                editor.resize();
            }
        },
        update() {
            if (lifecycle.ended) {
                return;
            }
            const ownerGeneration = lifecycle.begin();
            const requestData: IObject = {
                rootID: customObj.data.id,
                deckID: customObj.data.id,
            };
            if (customObj.data.cardType === "notebook") {
                requestData.notebook = customObj.data.id;
            }
            fetchPost(customObj.data.cardType === "all" ? "/api/riff/getRiffDueCards" :
                (customObj.data.cardType === "doc" ? "/api/riff/getTreeRiffDueCards" : "/api/riff/getNotebookRiffDueCards"), requestData, (response) => {
                if (lifecycle.isCurrent(ownerGeneration, customObj.element.isConnected)) {
                    void mountCards(customObj, response.data, ownerGeneration);
                }
            }, undefined, undefined, ownerGeneration.signal);
        }
    });
    customObj.element.addEventListener("click", () => {
        if (lifecycle.ended) {
            return;
        }
        clearOBG();
        setPanelFocus(customObj.element.parentElement.parentElement);
    });
    return customObj;
};
