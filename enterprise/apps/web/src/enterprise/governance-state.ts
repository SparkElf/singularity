import { create } from "zustand";

export type GovernanceView = "overview" | "templates" | "identity" | "discovery";

interface GovernanceState {
  activeView: GovernanceView;
  organizationId: string | null;
  query: string;
  selectedSpaceIds: string[];
  setOrganizationScope: (organizationId: string) => void;
  setActiveView: (activeView: GovernanceView) => void;
  setQuery: (query: string) => void;
  setSelectedSpaceIds: (selectedSpaceIds: string[]) => void;
}

// 只保存治理页面的当前作用域筛选，不保存正文、凭据或跨组织数据。
export const useGovernanceStore = create<GovernanceState>((set) => ({
  activeView: "overview",
  organizationId: null,
  query: "",
  selectedSpaceIds: [],
  setOrganizationScope: (organizationId) => set((state) => state.organizationId === organizationId ? state : { activeView: "overview", organizationId, query: "", selectedSpaceIds: [] }),
  setActiveView: (activeView) => set({ activeView }),
  setQuery: (query) => set({ query }),
  setSelectedSpaceIds: (selectedSpaceIds) => set({ selectedSpaceIds }),
}));
