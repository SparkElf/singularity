import { graphvizRender } from "../protyle/render/graphvizRender";
import { highlightRender } from "../protyle/render/highlightRender";
import { mathRender } from "../protyle/render/mathRender";
import { mermaidRender } from "../protyle/render/mermaidRender";
import { flowchartRender } from "../protyle/render/flowchartRender";
import { chartRender } from "../protyle/render/chartRender";
import { abcRender } from "../protyle/render/abcRender";
import { htmlRender } from "../protyle/render/htmlRender";
import { mindmapRender } from "../protyle/render/mindmapRender";
import { plantumlRender } from "../protyle/render/plantumlRender";
import { avRender } from "../protyle/render/av/render";

export class ProtyleMethod {
    /** 对 graphviz 进行渲染 */
    public static graphvizRender = (element: Element, cdn?: string) =>
        graphvizRender(element, window.siyuan.ws.app, cdn);
    /** 为 element 中的代码块进行高亮渲染 */
    public static highlightRender = (element: Element, cdn?: string, zoom?: number) =>
        highlightRender(element, window.siyuan.ws.app, cdn, zoom);
    /** 对数学公式进行渲染 */
    public static mathRender = (element: Element, cdn?: string, maxWidth?: boolean) =>
        mathRender(element, window.siyuan.ws.app, cdn, maxWidth);
    /** 流程图/时序图/甘特图渲染 */
    public static mermaidRender = (element: Element, cdn?: string) =>
        mermaidRender(element, window.siyuan.ws.app, cdn);
    /** flowchart.js 渲染 */
    public static flowchartRender = (element: Element, cdn?: string) =>
        flowchartRender(element, window.siyuan.ws.app, cdn);
    /** 图表渲染 */
    public static chartRender = (element: Element, cdn?: string) =>
        chartRender(element, window.siyuan.ws.app, cdn);
    /** 五线谱渲染 */
    public static abcRender = (element: Element, cdn?: string) =>
        abcRender(element, window.siyuan.ws.app, cdn);
    /** 脑图渲染 */
    public static mindmapRender = (element: Element, cdn?: string) =>
        mindmapRender(element, window.siyuan.ws.app, cdn);
    /** UML 渲染 */
    public static plantumlRender = (element: Element, cdn?: string) =>
        plantumlRender(element, window.siyuan.ws.app, cdn);
    public static avRender = avRender;
    public static htmlRender = (element: Element) => htmlRender(element, window.siyuan.ws.app);
}
