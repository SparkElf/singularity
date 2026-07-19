import { create } from "zustand";

interface CsrfState {
  csrfRevision: number;
  csrfToken: string | null;
  clearCsrfToken: () => void;
  setCsrfToken: (csrfToken: string) => void;
}

export const useCsrfStore = create<CsrfState>((set) => ({
  csrfRevision: 0,
  csrfToken: null,
  clearCsrfToken: () =>
    set((state) => ({
      csrfRevision: state.csrfRevision + 1,
      csrfToken: null,
    })),
  setCsrfToken: (csrfToken) =>
    set((state) => ({
      csrfRevision: state.csrfRevision + 1,
      csrfToken,
    })),
}));
