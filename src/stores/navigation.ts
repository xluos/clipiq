import { create } from "zustand";
import type { AppLocation, AppModule, ScreenState } from "../types";
import { legacyScreenToLocation } from "../types";

const SIDEBAR_COLLAPSED_KEY = "clipiq-sidebar-collapsed";

const MODULE_DEFAULT_SCREEN: Record<Exclude<AppModule, "settings" | "diagnostics">, AppLocation> = {
  analysis: { module: "analysis", screen: "home" },
  video: { module: "video", screen: "list" },
  library: { module: "library", screen: "list" },
  account: { module: "account", screen: "hub" },
  studio: { module: "studio", screen: "list" },
};

const HOME_LOCATION: AppLocation = { module: "analysis", screen: "home" };
const HISTORY_CAP = 50;

const locScreen = (loc: AppLocation): string | undefined =>
  "screen" in loc ? loc.screen : undefined;

const locEqual = (a: AppLocation, b: AppLocation): boolean =>
  a.module === b.module && locScreen(a) === locScreen(b);

// 临时屏:不该成为返回目标。离开它们时用 replace 语义(不进历史栈)。
const isTransient = (loc: AppLocation): boolean =>
  loc.module === "analysis" && (locScreen(loc) === "progress" || locScreen(loc) === "url_pull");

// workspace 与 report 是同一分析的兄弟视图;互跳用 replace,
// 这样从 workspace 返回不会卡在 workspace↔report 之间,而是回到真正的入口。
const DETAIL_SIBLINGS = new Set(["workspace", "report"]);
const isSiblingMove = (from: AppLocation, to: AppLocation): boolean =>
  from.module === "analysis" &&
  to.module === "analysis" &&
  DETAIL_SIBLINGS.has(locScreen(from) ?? "") &&
  DETAIL_SIBLINGS.has(locScreen(to) ?? "");

// 统一的导航落点:决定把离开的 location 压栈(push)还是丢弃(replace)。
function navigate(
  state: { currentLocation: AppLocation; history: AppLocation[] },
  to: AppLocation,
): { currentLocation: AppLocation; history: AppLocation[] } {
  const from = state.currentLocation;
  if (locEqual(from, to)) return { currentLocation: to, history: state.history };
  const replace = isTransient(from) || isSiblingMove(from, to);
  const history = replace ? state.history : [...state.history, from].slice(-HISTORY_CAP);
  return { currentLocation: to, history };
}

interface NavigationState {
  currentLocation: AppLocation;
  /** 返回栈:不含当前 location,栈顶是上一级。 */
  history: AppLocation[];
  sidebarCollapsed: boolean;

  setLocation: (loc: AppLocation) => void;
  goModule: (m: AppModule) => void;
  /** 返回上一级;栈空时落到 fallback(默认首页)。 */
  goBack: (fallback?: AppLocation) => void;
  setSidebarCollapsed: (v: boolean) => void;

  /** @deprecated v2 compat */
  currentScreen: ScreenState;
  /** @deprecated v2 compat */
  setCurrentScreen: (s: ScreenState) => void;
}

export const useNavigationStore = create<NavigationState>((set) => ({
  currentLocation: HOME_LOCATION,
  history: [],
  sidebarCollapsed: (() => {
    try { return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1"; } catch { return false; }
  })(),

  setLocation: (loc) => set((s) => navigate(s, loc)),

  goModule: (m) => set((s) => {
    if (m === "settings") return navigate(s, { module: "settings" });
    if (m === "diagnostics") return navigate(s, { module: "diagnostics" });
    return navigate(s, MODULE_DEFAULT_SCREEN[m]);
  }),

  goBack: (fallback) => set((s) => {
    const history = [...s.history];
    let prev = history.pop();
    // 跳过历史里可能残留的临时屏,避免返回到 progress 这种过渡页。
    while (prev && isTransient(prev)) prev = history.pop();
    return { currentLocation: prev ?? fallback ?? HOME_LOCATION, history };
  }),

  setSidebarCollapsed: (v) => {
    try { window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, v ? "1" : "0"); } catch { /* noop */ }
    set({ sidebarCollapsed: v });
  },

  currentScreen: "home" as ScreenState,
  setCurrentScreen: (s) => set((st) => navigate(st, legacyScreenToLocation(s))),
}));
