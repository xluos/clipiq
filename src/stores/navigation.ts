import { create } from "zustand";
import type { AppLocation, AppModule, ScreenState } from "../types";
import { legacyScreenToLocation, locationToLegacyScreen } from "../types";

const SIDEBAR_COLLAPSED_KEY = "clipiq-sidebar-collapsed";

const MODULE_DEFAULT_SCREEN: Record<Exclude<AppModule, "settings" | "diagnostics">, AppLocation> = {
  analysis: { module: "analysis", screen: "home" },
  video: { module: "video", screen: "list" },
  library: { module: "library", screen: "list" },
  account: { module: "account", screen: "list" },
  studio: { module: "studio", screen: "list" },
};

interface NavigationState {
  currentLocation: AppLocation;
  sidebarCollapsed: boolean;

  setLocation: (loc: AppLocation) => void;
  goModule: (m: AppModule) => void;
  setSidebarCollapsed: (v: boolean) => void;

  /** @deprecated v2 compat */
  currentScreen: ScreenState;
  /** @deprecated v2 compat */
  setCurrentScreen: (s: ScreenState) => void;
}

export const useNavigationStore = create<NavigationState>((set, get) => ({
  currentLocation: { module: "analysis", screen: "home" },
  sidebarCollapsed: (() => {
    try { return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1"; } catch { return false; }
  })(),

  setLocation: (loc) => set({ currentLocation: loc }),

  goModule: (m) => {
    if (m === "settings") set({ currentLocation: { module: "settings" } });
    else if (m === "diagnostics") set({ currentLocation: { module: "diagnostics" } });
    else set({ currentLocation: MODULE_DEFAULT_SCREEN[m] });
  },

  setSidebarCollapsed: (v) => {
    try { window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, v ? "1" : "0"); } catch { /* noop */ }
    set({ sidebarCollapsed: v });
  },

  currentScreen: "home" as ScreenState,
  setCurrentScreen: (s) => set({ currentLocation: legacyScreenToLocation(s) }),
}));
