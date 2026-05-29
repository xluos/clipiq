import { create } from "zustand";

interface SelectionState {
  activeVideoId: string | null;
  activeAnalysisId: string | null;

  setActiveVideoId: (id: string | null) => void;
  setActiveAnalysisId: (id: string | null) => void;
}

export const useSelectionStore = create<SelectionState>((set) => ({
  activeVideoId: null,
  activeAnalysisId: null,
  setActiveVideoId: (id) => set({ activeVideoId: id }),
  setActiveAnalysisId: (id) => set({ activeAnalysisId: id }),
}));
