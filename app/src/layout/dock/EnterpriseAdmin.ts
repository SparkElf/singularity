import {App} from "../../index";
import {Custom} from "./Custom";
import {Tab} from "../Tab";

const ENTERPRISE_WEB_ORIGIN_KEY = "singularity.enterprise.webOrigin";
const ENTERPRISE_ENTRY_PATH = "/spaces";

/**
 * 解析企业 React 页面地址：生产默认同源，浏览器开发基线允许用 localStorage 指向 Vite 预览端口。
 * 该函数只决定 iframe 的网络边界，不参与原生工作区的身份、布局或文档状态。
 */
const resolveEnterpriseWebOrigin = () => {
    const configuredOrigin = window.localStorage.getItem(ENTERPRISE_WEB_ORIGIN_KEY)?.trim();
    if (configuredOrigin) {
        try {
            const url = new URL(configuredOrigin);
            if (url.protocol === "http:" || url.protocol === "https:") {
                return url.origin;
            }
        } catch (error) {
            console.warn("[Singularity/Enterprise] Invalid web origin override", {
                configuredOrigin,
                error,
            });
        }
    }

    // 原生 6808/6807 体验端口与企业 Vite 4174 并行运行；正式部署不会命中这个开发端口分支。
    if (window.location.port === "6808" || window.location.port === "6807") {
        return `${window.location.protocol}//${window.location.hostname}:4174`;
    }
    return window.location.origin;
};

const createEnterpriseEntryURL = () => {
    const url = new URL(ENTERPRISE_ENTRY_PATH, resolveEnterpriseWebOrigin());
    // 跨源 iframe 无法读取思源主题，入口 URL 显式携带已解析的外观模式。
    url.searchParams.set("theme", window.siyuan.config.appearance.mode === 1 ? "dark" : "light");
    return url.toString();
};

export class EnterpriseAdmin extends Custom {
    private frame?: HTMLIFrameElement;

    /** 创建企业页面 iframe；实例只允许保留一个挂载节点。 */
    private mountFrame(custom: Custom) {
        if (this.frame) {
            return;
        }
        this.frame = document.createElement("iframe");
        this.frame.className = "singularity-enterprise__frame";
        this.frame.title = "企业管理";
        this.frame.loading = "eager";
        this.frame.referrerPolicy = "same-origin";
        this.frame.src = createEnterpriseEntryURL();
        custom.element.append(this.frame);
    }

    /** 释放企业页面及其网络上下文，关闭 Dock 或销毁 Tab 时调用。 */
    private unmountFrame() {
        if (!this.frame) {
            return;
        }
        // 先导航到空文档再移除，终止跨源 React 页面及其未完成请求。
        this.frame.src = "about:blank";
        this.frame.remove();
        this.frame = undefined;
    }

    constructor(options: { app: App; tab: Tab }) {
        super({
            app: options.app,
            tab: options.tab,
            type: "enterprise",
            data: {entryPath: ENTERPRISE_ENTRY_PATH},
            init(custom) {
                custom.element.classList.add("fn__flex-column", "dockPanel", "sy__enterprise");
                custom.element.innerHTML = "";
                (custom as EnterpriseAdmin).mountFrame(custom);
            },
            destroy() {
                (this as EnterpriseAdmin).unmountFrame();
            },
            resize() {
                // iframe 由 flex 容器自动填充；保留生命周期钩子以匹配原生 Dock model 合同。
            },
        });
    }

    /**
     * 原生 Dock 隐藏 panel 时释放 iframe；再次显示时复用同一个 model 重新挂载企业页面。
     * 这样切换 Dock 不会让不可见的 React 页面继续持有网络请求或事件循环。
     */
    public setVisible(visible: boolean) {
        if (visible) {
            this.mountFrame(this);
            return;
        }
        this.unmountFrame();
    }
}
