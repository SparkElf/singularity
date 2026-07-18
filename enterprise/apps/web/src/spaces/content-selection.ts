import { create } from "zustand";

export interface ContentSelection {
  readonly documentId: string;
  readonly notebookId: string;
  readonly spaceId: string;
}

interface ContentSelectionState {
  readonly selection: ContentSelection | null;
  readonly clearSelection: () => void;
  readonly selectDocument: (selection: ContentSelection) => void;
}

export const useContentSelectionStore = create<ContentSelectionState>((set) => ({
  selection: null,
  clearSelection: () => set({ selection: null }),
  selectDocument: (selection) => set((current) => {
    if (
      current.selection?.spaceId === selection.spaceId &&
      current.selection.notebookId === selection.notebookId &&
      current.selection.documentId === selection.documentId
    ) {
      return current;
    }
    return { selection };
  }),
}));
