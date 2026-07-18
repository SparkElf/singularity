export const getIconByType = (type: string, sub?: string) => {
    let iconName = "";
    switch (type) {
        case "NodeDocument":
            iconName = "iconFile";
            break;
        case "NodeThematicBreak":
            iconName = "iconLine";
            break;
        case "NodeParagraph":
            iconName = "iconParagraph";
            break;
        case "NodeHeading":
            iconName = sub ? "icon" + sub.toUpperCase() : "iconHeadings";
            break;
        case "NodeBlockquote":
            iconName = "iconQuote";
            break;
        case "NodeCallout":
            iconName = "iconCallout";
            break;
        case "NodeList":
            iconName = sub === "t" ? "iconCheck" : sub === "o" ? "iconOrderedList" : "iconList";
            break;
        case "NodeListItem":
            iconName = "iconListItem";
            break;
        case "NodeCodeBlock":
        case "NodeYamlFrontMatter":
            iconName = "iconCode";
            break;
        case "NodeTable":
            iconName = "iconTable";
            break;
        case "NodeBlockQueryEmbed":
            iconName = "iconSQL";
            break;
        case "NodeSuperBlock":
            iconName = "iconSuper";
            break;
        case "NodeMathBlock":
            iconName = "iconMath";
            break;
        case "NodeHTMLBlock":
            iconName = "iconHTML5";
            break;
        case "NodeWidget":
            iconName = "iconBoth";
            break;
        case "NodeIFrame":
            iconName = "iconGlobe";
            break;
        case "NodeVideo":
            iconName = "iconVideo";
            break;
        case "NodeAudio":
            iconName = "iconRecord";
            break;
        case "NodeAttributeView":
            iconName = "iconDatabase";
            break;
    }
    return iconName;
};
