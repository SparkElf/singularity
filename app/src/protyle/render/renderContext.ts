import type {
    ProtyleApplicationSettings,
} from "../../../../enterprise/packages/protyle-browser/src/contracts";
import {Constants} from "../../constants";
import {addStyle} from "../util/addStyle";

export type ProtyleRendererMessageKey = "copy" | "edit" | "mcpStatusDisabled" | "mcpStatusFailed" | "more" | "refresh";

export interface ProtyleRendererContext {
    readonly localization: {
        readonly text: (key: ProtyleRendererMessageKey) => string;
    };
    readonly settings: {
        readonly appearance: ProtyleApplicationSettings["appearance"];
        readonly editor: Pick<
            ProtyleApplicationSettings["editor"],
            | "codeLigatures"
            | "codeLineWrap"
            | "codeSyntaxHighlightLineNum"
            | "fontSize"
            | "katexMacros"
            | "plantUMLServePath"
        >;
    };
}

type RenderAction = Exclude<ProtyleRendererMessageKey, "copy">;

export const genRendererIconHTML = (
    context: ProtyleRendererContext,
    element?: false | HTMLElement,
    actions: readonly RenderAction[] = ["edit", "more"],
) => {
    let enable = true;
    if (element) {
        const readonly = element.getAttribute("data-readonly");
        if (typeof readonly === "string") {
            enable = readonly === "false";
        } else {
            return '<div class="protyle-icons"></div>';
        }
    }
    if (actions.length === 3) {
        return `<div class="protyle-icons">
    <span aria-label="${context.localization.text("refresh")}" data-position="4north" class="ariaLabel protyle-icon protyle-icon--first protyle-action__reload"><svg><use xlink:href="#iconRefresh"></use></svg></span>
    <span aria-label="${context.localization.text("edit")}" data-position="4north" class="ariaLabel protyle-icon protyle-action__edit${enable ? "" : " fn__none"}"><svg><use xlink:href="#iconEdit"></use></svg></span>
    <span aria-label="${context.localization.text("more")}" data-position="4north" class="ariaLabel protyle-icon protyle-action__menu protyle-icon--last"><svg><use xlink:href="#iconMore"></use></svg></span>
</div>`;
    }
    return `<div class="protyle-icons">
    <span aria-label="${context.localization.text("edit")}" data-position="4north" class="ariaLabel protyle-icon protyle-icon--first protyle-action__edit${enable ? "" : " fn__none"}"><svg><use xlink:href="#iconEdit"></use></svg></span>
    <span aria-label="${context.localization.text("more")}" data-position="4north" class="ariaLabel protyle-icon protyle-action__menu protyle-icon--last${enable ? "" : " protyle-icon--first"}"><svg><use xlink:href="#iconMore"></use></svg></span>
</div>`;
};

export const setCodeTheme = (
    appearance: ProtyleApplicationSettings["appearance"],
    cdn = Constants.PROTYLE_CDN,
) => {
    const protyleHljsStyle = document.getElementById("protyleHljsStyle") as HTMLLinkElement;
    let css: string;
    if (appearance.theme === "light") {
        css = appearance.codeBlockThemeLight;
        if (!Constants.SIYUAN_CONFIG_APPEARANCE_LIGHT_CODE.includes(css)) {
            css = "default";
        }
    } else {
        css = appearance.codeBlockThemeDark;
        if (!Constants.SIYUAN_CONFIG_APPEARANCE_DARK_CODE.includes(css)) {
            css = "github-dark";
        }
    }
    const href = `${cdn}/js/highlight.js/styles/${css}.min.css?v=11.11.2`;
    if (!protyleHljsStyle) {
        addStyle(href, "protyleHljsStyle");
    } else if (!protyleHljsStyle.href.includes(href)) {
        protyleHljsStyle.remove();
        addStyle(href, "protyleHljsStyle");
    }
};
