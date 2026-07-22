import type {
  CollaborationBroadcast,
  CollaborationOperation,
  DocumentIdentity,
} from "@singularity/contracts";

export interface ProtyleTransactionOperation {
  readonly action: string;
  readonly data?: unknown;
  readonly id?: string;
  readonly parentID?: string;
  readonly previousID?: string;
  readonly avID?: string;
  readonly keyID?: string;
  readonly rowID?: string;
  readonly context?: Readonly<Record<string, string>>;
}

function htmlElement(html: string): HTMLElement | null {
  const template = document.createElement("template");
  template.innerHTML = html;
  return template.content.firstElementChild as HTMLElement | null;
}

function plainBlockText(html: string): { readonly block: HTMLElement; readonly text: string } | null {
  const block = htmlElement(html);
  if (!block) {
    return null;
  }
  const editable = block.querySelector<HTMLElement>("[contenteditable='true']");
  if (!editable || /<[^>]+>/.test(editable.innerHTML.replace(/<br\s*\/?>(?=$|\n)/gi, ""))) {
    return null;
  }
  return {block, text: editable.textContent ?? ""};
}

function blockType(element: HTMLElement): "paragraph" | "heading" | "list" | "container" | null {
  switch (element.dataset.type) {
    case "NodeParagraph":
      return "paragraph";
    case "NodeHeading":
      return "heading";
    case "NodeList":
      return "list";
    case "NodeBlockquote":
    case "NodeCallout":
    case "NodeSuperBlock":
      return "container";
    default:
      return null;
  }
}

function indexFromContext(operation: ProtyleTransactionOperation): number | null {
  const raw = operation.context?.collaborationIndex;
  if (raw === undefined) {
    return null;
  }
  const index = Number(raw);
  return Number.isSafeInteger(index) && index >= 0 ? index : null;
}

function textChange(oldText: string, newText: string, blockId: string): readonly CollaborationOperation[] {
  const oldRunes = Array.from(oldText);
  const newRunes = Array.from(newText);
  let prefix = 0;
  while (prefix < oldRunes.length && prefix < newRunes.length && oldRunes[prefix] === newRunes[prefix]) {
    prefix += 1;
  }
  let oldEnd = oldRunes.length;
  let newEnd = newRunes.length;
  while (oldEnd > prefix && newEnd > prefix && oldRunes[oldEnd - 1] === newRunes[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  const removed = oldRunes.slice(prefix, oldEnd).join("");
  const inserted = newRunes.slice(prefix, newEnd).join("");
  const operations: CollaborationOperation[] = [];
  if (removed) {
    operations.push({blockId, from: prefix, kind: "text.delete", to: oldEnd});
  }
  if (inserted) {
    operations.push({blockId, kind: "text.insert", position: prefix, text: inserted});
  }
  return operations;
}

interface ExtractedTarget {
  readonly present: boolean;
  readonly target: {
    readonly blockId: string;
    readonly documentId: string;
    readonly notebookId: string;
  } | null;
  readonly valid: boolean;
}

function targetFromReferenceElement(root: HTMLElement): ExtractedTarget {
  const references = root.querySelectorAll<HTMLElement>('[data-type~="block-ref"]');
  if (references.length === 0) {
    return {present: false, target: null, valid: true};
  }
  if (references.length !== 1) {
    return {present: true, target: null, valid: false};
  }
  const reference = references.item(0);
  if (reference === null) {
    return {present: true, target: null, valid: false};
  }
  const blockId = reference.getAttribute("data-id");
  const documentId = reference.getAttribute("data-document-id");
  const notebookId = reference.getAttribute("data-notebook-id");
  if (!blockId || !documentId || !notebookId) {
    return {present: true, target: null, valid: false};
  }
  return {present: true, target: {blockId, documentId, notebookId}, valid: true};
}

function targetFromContext(context: Readonly<Record<string, string>> | undefined): ExtractedTarget {
  const blockId = context?.collaborationTargetBlockID;
  const documentId = context?.collaborationTargetDocumentID;
  const notebookId = context?.collaborationTargetNotebookID;
  if (blockId === undefined && documentId === undefined && notebookId === undefined) {
    return {present: false, target: null, valid: true};
  }
  if (blockId === "" && documentId === "" && notebookId === "") {
    return {present: true, target: null, valid: true};
  }
  if (!blockId || !documentId || !notebookId) {
    return {present: true, target: null, valid: false};
  }
  return {present: true, target: {blockId, documentId, notebookId}, valid: true};
}

function sameTarget(left: ExtractedTarget["target"], right: ExtractedTarget["target"]): boolean {
  return left?.blockId === right?.blockId && left?.documentId === right?.documentId &&
    left?.notebookId === right?.notebookId;
}

function mapStructuredUpdate(
  operation: ProtyleTransactionOperation,
  previous: HTMLElement,
  next: HTMLElement,
): readonly CollaborationOperation[] | null | undefined {
  const previousIsEmbed = previous.dataset.type === "NodeBlockQueryEmbed";
  const nextIsEmbed = next.dataset.type === "NodeBlockQueryEmbed";
  if (nextIsEmbed || previousIsEmbed) {
    if (!nextIsEmbed) {
      return null;
    }
    const target = targetFromContext(operation.context);
    if (!target.valid || !target.present) {
      return null;
    }
    return [{
      blockId: operation.id!,
      embedType: "block-query",
      kind: "embed.update",
      target: target.target,
    }];
  }

  const previousReference = targetFromReferenceElement(previous);
  const nextReference = targetFromReferenceElement(next);
  if (previousReference.present || nextReference.present) {
    if (!previousReference.valid || !nextReference.valid || sameTarget(previousReference.target, nextReference.target)) {
      return previousReference.present || nextReference.present
        ? previousReference.valid && nextReference.valid
          ? []
          : null
        : undefined;
    }
    return [{
      blockId: operation.id!,
      kind: "reference.update",
      target: nextReference.target,
    }];
  }

  return undefined;
}

function isAttributeViewValue(value: unknown): value is string | number | boolean | Record<string, unknown> | null {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean" ||
    (typeof value === "object" && !Array.isArray(value));
}

/** 把 Protyle 已提交的低层操作转换为最小语义操作；无法证明纯文本语义时显式拒绝。 */
export function mapProtyleOperation(
  operation: ProtyleTransactionOperation,
): readonly CollaborationOperation[] | null {
  if (!operation.id) {
    return null;
  }
  switch (operation.action) {
    case "insert": {
      if (typeof operation.data !== "string" || indexFromContext(operation) === null) {
        return null;
      }
      const parsed = plainBlockText(operation.data);
      const type = parsed ? blockType(parsed.block) : null;
      if (!parsed || !type) {
        return null;
      }
      return [{
        blockId: operation.id,
        blockType: type,
        content: parsed.text,
        index: indexFromContext(operation)!,
        kind: "block.insert",
        parentBlockId: operation.parentID || null,
      }];
    }
    case "delete":
      return [{blockId: operation.id, kind: "block.delete"}];
    case "move": {
      const index = indexFromContext(operation);
      if (index === null) {
        return null;
      }
      return [{
        blockId: operation.id,
        index,
        kind: "block.move",
        parentBlockId: operation.parentID || null,
      }];
    }
    case "update": {
      if (typeof operation.data !== "string" || typeof operation.context?.collaborationPreviousHTML !== "string") {
        return null;
      }
      const previous = plainBlockText(operation.context.collaborationPreviousHTML);
      const next = plainBlockText(operation.data);
      const previousElement = htmlElement(operation.context.collaborationPreviousHTML);
      const nextElement = htmlElement(operation.data);
      if (!previousElement || !nextElement) {
        return null;
      }
      const structured = mapStructuredUpdate(operation, previousElement, nextElement);
      if (structured !== undefined) {
        return structured;
      }
      if (!previous || !next || blockType(previous.block) !== blockType(next.block)) {
        return null;
      }
      return textChange(previous.text, next.text, operation.id);
    }
    case "updateAttrViewCell": {
      if (!operation.avID || !operation.keyID || !operation.rowID || !isAttributeViewValue(operation.data)) {
        return null;
      }
      return [{
        attributeViewId: operation.avID,
        columnId: operation.keyID,
        kind: "attribute-view.cell-set",
        rowId: operation.rowID,
        value: operation.data,
      }];
    }
    default:
      return null;
  }
}

function sameIdentity(left: DocumentIdentity, right: DocumentIdentity): boolean {
  return left.organizationId === right.organizationId && left.spaceId === right.spaceId &&
    left.notebookId === right.notebookId && left.documentId === right.documentId;
}

export interface ProtyleCollaborationOperationMessage {
  readonly cmd: "collaboration-operation";
  readonly data: {
    readonly identity: DocumentIdentity;
    readonly operation: CollaborationOperation;
    readonly operationId: string;
    readonly serverSequence: number;
  };
  readonly sid: string;
}

/** 将远端广播转换为 Protyle 的语义消息；消费点只应用增量，不触发整篇文档刷新。 */
export function collaborationBroadcastToProtyleMessage(
  identity: DocumentIdentity,
  broadcast: CollaborationBroadcast,
): ProtyleCollaborationOperationMessage {
  if (!sameIdentity(identity, broadcast.identity) || !sameIdentity(identity, broadcast.operation.identity)) {
    throw new Error("Collaboration broadcast identity does not match the bound Protyle document");
  }
  return {
    cmd: "collaboration-operation",
    data: {
      identity: broadcast.identity,
      operation: broadcast.operation.operation,
      operationId: broadcast.operation.operationId,
      serverSequence: broadcast.serverSequence,
    },
    sid: `collaboration:${broadcast.operation.clientId}`,
  };
}
