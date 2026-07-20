import {addScript} from "../util/addScript";
import {Constants} from "../../constants";
import {hasClosestByClassName} from "../util/hasClosest";
import {genRendererIconHTML, type ProtyleRendererContext} from "./renderContext";

const renderPlantUMLElement = (
    element: HTMLDivElement,
    context: ProtyleRendererContext,
    wysiwygElement: false | HTMLElement,
    servePath: string,
) => {
    let renderElement: HTMLElement | undefined;
    try {
        element.setAttribute("data-render", "true");
        if (!element.firstElementChild.classList.contains("protyle-icons")) {
            element.insertAdjacentHTML("afterbegin", genRendererIconHTML(context, wysiwygElement));
        }
        renderElement = element.firstElementChild.nextElementSibling as HTMLElement;
        if (servePath === "") {
            renderElement.classList.add("ft__error");
            renderElement.textContent = context.localization.text("mcpStatusDisabled");
            return;
        }
        if (!element.getAttribute("data-content")) {
            renderElement.innerHTML = `<span style="position: absolute;left:0;top:0;width: 1px;">${Constants.ZWSP}</span>`;
            return;
        }
        const image = document.createElement("img");
        image.alt = "PlantUML";
        image.src = `${servePath}${window.plantumlEncoder.encode(Lute.UnEscapeHTMLStr(element.getAttribute("data-content")))}`;
        renderElement.replaceChildren(image);
        renderElement.classList.remove("ft__error");
    } catch (error) {
        console.error("[protyle.render] PlantUML rendering failed", error);
        if (renderElement) {
            renderElement.classList.add("ft__error");
            renderElement.textContent = context.localization.text("mcpStatusFailed");
        }
    }
};

export const plantumlRender = (element: Element, context: ProtyleRendererContext, cdn = Constants.PROTYLE_CDN) => {
    let plantumlElements: Element[] | NodeListOf<Element> = [];
    if (element.getAttribute("data-subtype") === "plantuml" && element.getAttribute("data-render") !== "true") {
        plantumlElements = [element];
    } else {
        plantumlElements = element.querySelectorAll('[data-subtype="plantuml"]:not([data-render="true"])');
    }
    if (plantumlElements.length === 0) {
        return;
    }
    const servePath = context.settings.editor.plantUMLServePath;
    const wysiwygElement = hasClosestByClassName(element, "protyle-wysiwyg", true);
    if (servePath === "") {
        plantumlElements.forEach((e: HTMLDivElement) => {
            renderPlantUMLElement(e, context, wysiwygElement, servePath);
        });
        return;
    }
    void addScript(`${cdn}/js/plantuml/plantuml-encoder.min.js?v=0.0.0`, "protylePlantumlScript").then(() => {
        plantumlElements.forEach((e: HTMLDivElement) => {
            renderPlantUMLElement(e, context, wysiwygElement, servePath);
        });
    }).catch((error) => {
        console.error("[protyle.render] PlantUML renderer initialization failed", error);
    });
};
