interface TransactionPersistenceOperation {
    data?: unknown;
    retData?: unknown;
}

// 将编辑器展示态 HTML 收敛为可持久化的本地资源和无焦点状态，不修改 live DOM。
const persistTransactionHTML = (html: string) => {
    if (!html.includes("data-src") && !html.includes("protyle-wysiwyg--hl")) {
        return html;
    }
    const template = document.createElement("template");
    template.innerHTML = html;
    let changed = false;
    template.content.querySelectorAll<HTMLImageElement>(".img img[data-src]").forEach((image) => {
        const persistedSource = image.getAttribute("data-src") ?? "";
        if (image.getAttribute("src") !== persistedSource) {
            image.setAttribute("src", persistedSource);
            changed = true;
        }
    });
    template.content.querySelectorAll(".protyle-wysiwyg--hl").forEach((element) => {
        element.classList.remove("protyle-wysiwyg--hl");
        changed = true;
    });
    return changed ? template.innerHTML : html;
};

// 只复制发生变化的 transaction operation，避免在撤销/重做热路径复制完整操作数组。
const persistTransactionOperation = <TOperation extends TransactionPersistenceOperation>(operation: TOperation) => {
    const data = typeof operation.data === "string" ? persistTransactionHTML(operation.data) : operation.data;
    const retData = typeof operation.retData === "string" ? persistTransactionHTML(operation.retData) : operation.retData;
    if (data === operation.data && retData === operation.retData) {
        return operation;
    }
    const persistedOperation = {...operation};
    if (data !== operation.data) {
        persistedOperation.data = data;
    }
    if (retData !== operation.retData) {
        persistedOperation.retData = retData;
    }
    return persistedOperation;
};

// 在唯一事务发送边界净化 do/undo 数据，保持未变化操作和原对象身份不变。
export const persistTransactionOperations = <TOperation extends TransactionPersistenceOperation>(
    operations: TOperation[] | undefined,
) => {
    if (!operations) {
        return operations;
    }
    let persistedOperations: TOperation[] | undefined;
    operations.forEach((operation, index) => {
        const persistedOperation = persistTransactionOperation(operation);
        if (persistedOperation === operation) {
            return;
        }
        if (!persistedOperations) {
            persistedOperations = operations.slice();
        }
        persistedOperations[index] = persistedOperation;
    });
    return persistedOperations ?? operations;
};
