import {preserveBlockRefNotebookIDs} from "../util/blockRefIdentity";

export const getLute = (options: IProtyleLuteOptions, settings: TProtyleApplicationSettingsPort): Lute =>
    setLute(options, settings);

export const configureProtyleLuteEmojis = (
    lute: Lute,
    groups: TProtyleApplicationSettingsPort["emojis"],
    resolveEmojiPath: (path: string) => string,
) => {
    const customGroup = groups.find((group) => group.id === "custom");
    if (!customGroup) {
        return;
    }
    const emojis: IObject = {};
    customGroup.items.forEach((item) => {
        emojis[item.keywords] = resolveEmojiPath(item.unicode);
    });
    lute.PutEmojis(emojis);
};

/**
 * 为智能体（AgentChat）构建独立的 Lute 实例。
 *
 * 与共享单例不同：不读取应用编辑器 settings 的语法开关，
 * 而是把所有 Markdown 行内语法（斜体/粗体/删除线/上下标/标签/行内公式/标记）硬编码启用，
 * 使 LLM 输出始终按标准 Markdown 渲染，不受用户「编辑器 → Markdown 语法设置」的影响。
 * 每次调用都返回新实例，与编辑器渲染相互隔离。
 */
export const getAgentLute = (options: ILuteOptions): Lute => {
    const lute: Lute = Lute.New();
    lute.SetSpellcheck(false);
    lute.SetProtyleMarkNetImg(false);
    lute.SetFileAnnotationRef(true);
    lute.SetHTMLTag2TextMark(true);
    lute.SetTextMark(true);
    lute.SetHeadingID(false);
    lute.SetYamlFrontMatter(false);
    lute.PutEmojis(options.emojis);
    lute.SetEmojiSite(options.emojiSite);
    lute.SetHeadingAnchor(options.headingAnchor);
    lute.SetInlineMathAllowDigitAfterOpenMarker(true);
    lute.SetToC(false);
    lute.SetIndentCodeBlock(false);
    lute.SetParagraphBeginningSpace(true);
    lute.SetSetext(false);
    lute.SetFootnotes(false);
    lute.SetLinkRef(false);
    lute.SetSanitize(options.sanitize);
    lute.SetChineseParagraphBeginningSpace(options.paragraphBeginningSpace);
    lute.SetRenderListStyle(options.listStyle);
    lute.SetImgPathAllowSpace(true);
    lute.SetKramdownIAL(true);
    lute.SetSuperBlock(true);
    lute.SetCallout(true);
    // 行内语法全部启用，不随编辑器设置变化。
    lute.SetInlineAsterisk(true);
    lute.SetInlineUnderscore(true);
    lute.SetSup(true);
    lute.SetSub(true);
    lute.SetTag(true);
    lute.SetInlineMath(true);
    lute.SetGFMStrikethrough1(false);
    lute.SetGFMStrikethrough(true);
    lute.SetMark(true);
    lute.SetSpin(true);
    lute.SetProtyleWYSIWYG(true);
    if (options.lazyLoadImage) {
        lute.SetImageLazyLoading(options.lazyLoadImage);
    }
    lute.SetBlockRef(true);
    lute.SetUnorderedListMarker("-");
    lute.SetDataTask(true);
    lute.SetExportNormalizeTaskListMarker(true);
    lute.SetArbitraryTaskListItemMarker(true);
    lute.SetEnsureListItemParagraph(true);
    return lute;
};

/** 根据当前编辑器的 settings 与资源解析器构建独立 Lute 实例。 */
const setLute = (options: IProtyleLuteOptions, settings: TProtyleApplicationSettingsPort) => {
    const lute: Lute = Lute.New();
    const spinBlockDOM = lute.SpinBlockDOM.bind(lute);
    lute.SpinBlockDOM = (html: string) => preserveBlockRefNotebookIDs(html, spinBlockDOM(html));
    lute.SetSpellcheck(settings.editor.spellcheck);
    lute.SetProtyleMarkNetImg(settings.editor.displayNetImgMark);
    lute.SetFileAnnotationRef(true);
    lute.SetHTMLTag2TextMark(true);
    lute.SetTextMark(true);
    lute.SetHeadingID(false);
    lute.SetYamlFrontMatter(false);
    lute.PutEmojis(options.emojis);
    lute.SetHeadingAnchor(options.headingAnchor);
    lute.SetInlineMathAllowDigitAfterOpenMarker(true);
    lute.SetToC(false);
    lute.SetIndentCodeBlock(false);
    lute.SetParagraphBeginningSpace(true);
    lute.SetSetext(false);
    lute.SetFootnotes(false);
    lute.SetLinkRef(false);
    lute.SetSanitize(options.sanitize);
    lute.SetChineseParagraphBeginningSpace(options.paragraphBeginningSpace);
    lute.SetRenderListStyle(options.listStyle);
    lute.SetImgPathAllowSpace(true);
    lute.SetKramdownIAL(true);
    lute.SetTag(true);
    lute.SetSuperBlock(true);
    lute.SetCallout(true);
    lute.SetInlineAsterisk(settings.editor.markdown.inlineAsterisk);
    lute.SetInlineUnderscore(settings.editor.markdown.inlineUnderscore);
    lute.SetSup(settings.editor.markdown.inlineSup);
    lute.SetSub(settings.editor.markdown.inlineSub);
    lute.SetTag(settings.editor.markdown.inlineTag);
    lute.SetInlineMath(settings.editor.markdown.inlineMath);
    lute.SetGFMStrikethrough1(false);
    lute.SetGFMStrikethrough(settings.editor.markdown.inlineStrikethrough);
    lute.SetMark(settings.editor.markdown.inlineMark);
    lute.SetSpin(true);
    lute.SetProtyleWYSIWYG(true);
    if (options.lazyLoadImage) {
        lute.SetImageLazyLoading(options.lazyLoadImage);
    }
    lute.SetBlockRef(true);
    configureProtyleLuteEmojis(lute, settings.emojis, options.resolveEmojiPath);
    lute.SetUnorderedListMarker("-");
    lute.SetDataTask(true);
    lute.SetExportNormalizeTaskListMarker(true);
    lute.SetArbitraryTaskListItemMarker(true);
    lute.SetEnsureListItemParagraph(true); // 空列表项下创建子列表前补一个空段落
    return lute;
};
