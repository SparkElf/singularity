import {hideMessage, showMessage} from "../../dialog/message";
import {Constants} from "../../constants";
import {confirmDialog} from "../../dialog/confirmDialog";
import {getThemeMode, setInlineStyle} from "../../util/assets";
import {fetchPost, fetchSyncPost} from "../../util/fetch";
import {getScreenWidth, isInMobileApp, saveExportFile} from "../util/compatibility";
import {getFrontend} from "../../util/functions";
import {isEncryptedBox} from "../../util/pathName";

const getPluginStyle = async () => {
    const response = await fetchSyncPost("/api/petal/loadPetals", {frontend: getFrontend()});
    let css = "";
    // 为加快启动速度，不进行 await
    response.data.forEach((item: IPluginData) => {
        css += item.css || "";
    });
    return css;
};

const getIconScript = (servePath: string) => {
    const isBuiltInIcon = ["litheness"].includes(window.siyuan.config.appearance.icon);
    const html = isBuiltInIcon ? "" : `<script src="${servePath}appearance/icons/litheness/icon.js?v=${Constants.SIYUAN_VERSION}"></script>`;
    return html + `<script src="${servePath}appearance/icons/${window.siyuan.config.appearance.icon}/icon.js?v=${Constants.SIYUAN_VERSION}"></script>`;
};

export const saveExport = (option: IExportOptions) => {
    if (!["html", "htmlmd"].includes(option.type)) {
        return;
    }
    const startExport = () => {
        const msgId = showMessage(window.siyuan.languages.exporting, -1);
        const url = option.type === "htmlmd" ? "/api/export/exportMdHTML" : "/api/export/exportHTML";
        fetchPost(url, {
            id: option.id,
            pdf: false,
            removeAssets: false,
            merge: true,
            savePath: ""
        }, async exportResponse => {
            const html = await onExport(exportResponse, undefined, "", option);
            fetchPost("/api/export/exportBrowserHTML", {
                folder: exportResponse.data.folder,
                html,
                name: exportResponse.data.name
            }, zipResponse => {
                if (zipResponse.code === -1) {
                    hideMessage(msgId);
                    showMessage(window.siyuan.languages._kernel[14].replace("%s", zipResponse.msg), 0, "error");
                    return;
                }
                saveExportFile(zipResponse.data.zip, msgId);
            });
        });
    };
    fetchPost("/api/block/getBlockInfo", {id: option.id}, (response) => {
        if (response.code !== 0) {
            showMessage(response.msg, 0, "error");
            return;
        }
        if (isEncryptedBox(response.data.box)) {
            confirmDialog("⚠️ " + window.siyuan.languages.export, window.siyuan.languages.encryptedExportRiskTip, startExport);
            return;
        }
        startExport();
    });
};

const getSnippetCSS = () => {
    let snippetCSS = "";
    document.querySelectorAll("style").forEach((item) => {
        if (item.id.startsWith("snippetCSS")) {
            snippetCSS += item.outerHTML;
        }
    });
    return snippetCSS;
};

const getSnippetJS = () => {
    let snippetScript = "";
    document.querySelectorAll("script").forEach((item) => {
        if (item.id.startsWith("snippetJS")) {
            snippetScript += item.outerHTML;
        }
    });
    return snippetScript;
};

export const onExport = async (data: IWebSocketData, filePath: string, servePath: string, exportOption: IExportOptions, msgId?: string) => {
    let themeName = window.siyuan.config.appearance.themeLight;
    let mode = 0;
    if (["html", "htmlmd"].includes(exportOption.type) && window.siyuan.config.appearance.mode === 1) {
        themeName = window.siyuan.config.appearance.themeDark;
        mode = 1;
    }
    const isDefault = (window.siyuan.config.appearance.mode === 1 && window.siyuan.config.appearance.themeDark === "midnight") || (window.siyuan.config.appearance.mode === 0 && window.siyuan.config.appearance.themeLight === "daylight");
    let themeStyle = "";
    if (!isDefault) {
        themeStyle = `<link rel="stylesheet" type="text/css" id="themeStyle" href="${servePath}appearance/themes/${themeName}/theme.css?${Constants.SIYUAN_VERSION}"/>`;
    }
    const screenWidth = getScreenWidth();
    const isInMobile = isInMobileApp();
    const mobileHtml = isInMobile ? {
        js: `document.body.style.minWidth = "${screenWidth}px";`,
        css: `@page { size: A4; margin: 10mm 0 10mm 0; background-color: var(--b3-theme-background); }
.protyle-wysiwyg {padding: 0; margin: 0;}`
    } : {js: "", css: ""};
    const html = `<!DOCTYPE html>
<html lang="${window.siyuan.config.appearance.lang}" data-theme-mode="${isInMobile ? "light" : getThemeMode()}" data-light-theme="${window.siyuan.config.appearance.themeLight}" data-dark-theme="${window.siyuan.config.appearance.themeDark}">
<head>
    <base href="${servePath}">
    <meta charset="utf-8">
    <meta http-equiv="X-UA-Compatible" content="IE=edge">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=0"/>
    <meta name="mobile-web-app-capable" content="yes"/>
    <meta name="apple-mobile-web-app-status-bar-style" content="black">
    <link rel="stylesheet" type="text/css" id="baseStyle" href="${servePath}stage/build/export/base.css?v=${Constants.SIYUAN_VERSION}"/>
    <link rel="stylesheet" type="text/css" id="themeDefaultStyle" href="${servePath}appearance/themes/${themeName}/theme.css?v=${Constants.SIYUAN_VERSION}"/>
    <script src="${servePath}stage/protyle/js/protyle-html.js?v=${Constants.SIYUAN_VERSION}"></script>
    ${themeStyle}
    <title>${data.data.name}</title>
    <!-- Exported by SiYuan v${Constants.SIYUAN_VERSION} -->
    <style>
        body {font-family: var(--b3-font-family);background-color: var(--b3-theme-background);color: var(--b3-theme-on-background)}
        ${await setInlineStyle(false, servePath)}
        ${await getPluginStyle()}
        ${mobileHtml.css}
    </style>
    ${getSnippetCSS()}
</head>
<body>
<div class="${["htmlmd", "word"].includes(exportOption.type) ? "b3-typography" : "protyle-wysiwyg" + (window.siyuan.config.editor.displayBookmarkIcon ? " protyle-wysiwyg--attr" : "")}" 
style="max-width: 800px;margin: 0 auto;" id="preview">${data.data.content}</div>
${getIconScript(servePath)}
<script src="${servePath}stage/build/export/protyle-method.js?v=${Constants.SIYUAN_VERSION}"></script>
<script src="${servePath}stage/protyle/js/lute/lute.min.js?v=${Constants.SIYUAN_VERSION}"></script>  
<script>
    ${mobileHtml.js}
    window.siyuan = {
      config: {
        appearance: { mode: ${mode}, codeBlockThemeDark: "${window.siyuan.config.appearance.codeBlockThemeDark}", codeBlockThemeLight: "${window.siyuan.config.appearance.codeBlockThemeLight}" },
        editor: { 
          codeLineWrap: true,
          fontSize: ${window.siyuan.config.editor.fontSize},
          codeLigatures: ${window.siyuan.config.editor.codeLigatures},
          plantUMLServePath: "${window.siyuan.config.editor.plantUMLServePath}",
          codeSyntaxHighlightLineNum: ${window.siyuan.config.editor.codeSyntaxHighlightLineNum},
          katexMacros: decodeURI(\`${encodeURI(window.siyuan.config.editor.katexMacros)}\`),
        }
      },
      languages: {copy:"${window.siyuan.languages.copy}"}
    };
    const previewElement = document.getElementById('preview');
    Protyle.highlightRender(previewElement, "stage/protyle");
    Protyle.mathRender(previewElement, "stage/protyle", ${exportOption.type === "pdf"});
    Protyle.mermaidRender(previewElement, "stage/protyle");
    Protyle.flowchartRender(previewElement, "stage/protyle");
    Protyle.graphvizRender(previewElement, "stage/protyle");
    Protyle.chartRender(previewElement, "stage/protyle");
    Protyle.mindmapRender(previewElement, "stage/protyle");
    Protyle.abcRender(previewElement, "stage/protyle");
    Protyle.htmlRender(previewElement);
    Protyle.plantumlRender(previewElement, "stage/protyle");
    document.querySelectorAll(".protyle-action__copy").forEach((item) => {
      item.addEventListener("click", (event) => {
            navigator.clipboard.writeText(item.parentElement.nextElementSibling.textContent.trimEnd().replace(/\u00A0/g, " ").replace(/\u200D\`\`\`/g, "\`\`\`"));
            event.preventDefault();
            event.stopPropagation();
      })
    });
</script>
${getSnippetJS()}</body></html>`;
    void filePath;
    void msgId;
    return html;
};
