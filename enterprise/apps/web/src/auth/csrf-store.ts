import { create } from "zustand";

interface CsrfState {
  csrfToken: string | null;
  clearCsrfToken: () => void;
  setCsrfToken: (csrfToken: string) => void;
}

export const useCsrfStore = create<CsrfState>((set) => ({
  csrfToken: null,
  clearCsrfToken: () => set({ csrfToken: null }),
  setCsrfToken: (csrfToken) => set({ csrfToken }),
}));
