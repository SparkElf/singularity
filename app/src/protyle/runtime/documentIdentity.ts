import type {ProtyleEditorRegistry} from "../../../../enterprise/packages/protyle-browser/src/contracts";

export interface ProtyleDocumentInstance {
    readonly block: {readonly rootID?: string};
    readonly content: TProtyleBoundContent | TProtyleLocalOnlyContent;
}

export interface ProtyleDocumentIdentity {
    readonly documentId: string;
    readonly notebookId: string;
}

/** 判断编辑器实例是否绑定到指定 notebook/document，身份只取实例合同字段。 */
export const isProtyleDocumentInstance = (
    editor: ProtyleDocumentInstance,
    identity: ProtyleDocumentIdentity,
) => editor.content.mode === "bound" &&
    editor.content.notebookId === identity.notebookId &&
    editor.block.rootID === identity.documentId;

/** 遍历并处理当前文档的所有实例，用于区分同文档多编辑器和来源实例。 */
export const forEachProtyleDocumentInstance = <TEditor extends ProtyleDocumentInstance>(
    editors: Pick<ProtyleEditorRegistry<TEditor>, "forEach">,
    identity: ProtyleDocumentIdentity,
    visitor: (editor: TEditor) => void,
) => editors.forEach((editor) => {
    if (isProtyleDocumentInstance(editor, identity)) {
        visitor(editor);
    }
});
