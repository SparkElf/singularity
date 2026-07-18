import type {
  ProtyleCoreCreateOptions,
  ProtyleCoreDocumentOptions,
  ProtyleCoreFactory,
  ProtyleHostDispatchEvent,
  ProtyleHostEvent,
  ProtyleSession,
} from "./contracts.ts";
import { createProtyleFactory } from "./factory.ts";

interface TestOptions extends ProtyleCoreDocumentOptions {
  readonly render: { readonly title: boolean };
}

declare const coreFactory: ProtyleCoreFactory<TestOptions, unknown>;
declare const host: HTMLElement;
declare const session: ProtyleSession<unknown>;
declare const signal: AbortSignal;

const assetEvent: ProtyleHostEvent = {
  assetPath: "assets/example.png",
  disposition: "current",
  documentId: "document-a",
  notebookId: "notebook-a",
  type: "open-asset",
};

const workspaceEvent: ProtyleHostEvent = {
  documentId: "document-a",
  notebookId: "notebook-a",
  type: "activate-document",
};

const dispatchedWorkspaceEvent: ProtyleHostDispatchEvent = {
  ...workspaceEvent,
  sourceEditorId: "editor-primary",
};

// @ts-expect-error Session dispatches of editor events require an exact source instance.
const dispatchedWorkspaceWithoutSource: ProtyleHostDispatchEvent = workspaceEvent;

// @ts-expect-error 内容事件必须同时携带源文档身份。
const assetWithoutDocument: ProtyleHostEvent = {
  assetPath: "assets/example.png",
  disposition: "current",
  notebookId: "notebook-a",
  type: "open-asset",
};

// @ts-expect-error 工作台文档事件不能省略内容库身份。
const workspaceWithoutNotebook: ProtyleHostEvent = {
  documentId: "document-a",
  type: "activate-document",
};

void assetEvent;
void workspaceEvent;
void dispatchedWorkspaceEvent;
void dispatchedWorkspaceWithoutSource;
void assetWithoutDocument;
void workspaceWithoutNotebook;

const defaultsWithNotebook = {
  notebookId: "notebook-shadow",
  render: { title: true },
};

// @ts-expect-error 内容库身份只能由 Factory 的 notebookId 参数提供。
createProtyleFactory(coreFactory, defaultsWithNotebook);

const localContentWithNotebook = {
  mode: "local-only" as const,
  notebookId: "notebook-shadow",
};

const localWithNotebook: ProtyleCoreCreateOptions<TestOptions, unknown> = {
  // @ts-expect-error local-only 表面不能携带内容库身份。
  content: localContentWithNotebook,
  host,
  options: { render: { title: true } },
  participation: "detached",
  readOnly: true,
  signal,
  surface: "embedded",
};

// @ts-expect-error local-only 表面不能取得 Session 内容能力。
const localWithSession: ProtyleCoreCreateOptions<TestOptions, unknown> = {
  content: { mode: "local-only" },
  host,
  options: { render: { title: true } },
  participation: "detached",
  readOnly: true,
  session,
  signal,
  surface: "embedded",
};

void localWithNotebook;
void localWithSession;

const detachedOwner: ProtyleCoreCreateOptions<TestOptions, unknown> = {
  content: { mode: "bound", notebookId: "notebook-a" },
  host,
  initialLoad: "owner",
  options: { blockId: "document-a", render: { title: true } },
  participation: "detached",
  readOnly: true,
  session,
  signal,
  surface: "embedded",
};

// @ts-expect-error bound detached Core 必须在构造时绑定文档 blockId。
const detachedWithoutBlockId: ProtyleCoreCreateOptions<TestOptions, unknown> = {
  content: { mode: "bound", notebookId: "notebook-a" },
  host,
  initialLoad: "owner",
  options: { render: { title: true } },
  participation: "detached",
  readOnly: true,
  session,
  signal,
  surface: "embedded",
};

void detachedOwner;
void detachedWithoutBlockId;
