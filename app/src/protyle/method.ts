import { graphvizRender } from "./render/graphvizRender";
import { highlightRender } from "./render/highlightRender";
import { mathRender } from "./render/mathRender";
import { mermaidRender } from "./render/mermaidRender";
import { flowchartRender } from "./render/flowchartRender";
import { chartRender } from "./render/chartRender";
import { abcRender } from "./render/abcRender";
import { htmlRender } from "./render/htmlRender";
import { mindmapRender } from "./render/mindmapRender";
import { plantumlRender } from "./render/plantumlRender";
import type { ProtyleRendererContext } from "./render/renderContext";
import "../assets/scss/export.scss";

const rendererContext: ProtyleRendererContext = {
    localization: {
        text: (key) => window.siyuan.languages[key],
    },
    get settings() {
        const {appearance, editor} = window.siyuan.config;
        return {
            appearance: {
                codeBlockThemeDark: appearance.codeBlockThemeDark,
                codeBlockThemeLight: appearance.codeBlockThemeLight,
                theme: appearance.mode === 1 ? "dark" as const : "light" as const,
            },
            editor: {
                codeLigatures: editor.codeLigatures,
                codeLineWrap: editor.codeLineWrap,
                codeSyntaxHighlightLineNum: editor.codeSyntaxHighlightLineNum,
                fontSize: editor.fontSize,
                katexMacros: editor.katexMacros,
                plantUMLServePath: editor.plantUMLServePath,
            },
        };
    },
};

class Protyle {
    /** 对 graphviz 进行渲染 */
    public static graphvizRender = (element: Element, cdn?: string) => graphvizRender(element, rendererContext, cdn);
    /** 为 element 中的代码块进行高亮渲染 */
    public static highlightRender = (element: Element, cdn?: string, zoom?: number) =>
        highlightRender(element, rendererContext, cdn, zoom);
    /** 对数学公式进行渲染 */
    public static mathRender = (element: Element, cdn?: string, maxWidth?: boolean) =>
        mathRender(element, rendererContext, cdn, maxWidth);
    /** 流程图/时序图/甘特图渲染 */
    public static mermaidRender = (element: Element, cdn?: string) => mermaidRender(element, rendererContext, cdn);
    /** flowchart.js 渲染 */
    public static flowchartRender = (element: Element, cdn?: string) => flowchartRender(element, rendererContext, cdn);
    /** 图表渲染 */
    public static chartRender = (element: Element, cdn?: string) => chartRender(element, rendererContext, cdn);
    /** 五线谱渲染 */
    public static abcRender = (element: Element, cdn?: string) => abcRender(element, rendererContext, cdn);
    /** 脑图渲染 */
    public static mindmapRender = (element: Element, cdn?: string) => mindmapRender(element, rendererContext, cdn);
    /** UML 渲染 */
    public static plantumlRender = (element: Element, cdn?: string) => plantumlRender(element, rendererContext, cdn);
    /** html 块渲染 */
    public static htmlRender = (element: Element) => htmlRender(element, rendererContext);
}

// 由于 https://github.com/siyuan-note/siyuan/issues/7800，先临时解决一下
window.Protyle = Protyle;

export default Protyle;
