import { describe, it, expect, beforeEach } from "vitest";
import { useNavigationStore } from "./navigation";
import type { AppLocation } from "../types";

const HOME: AppLocation = { module: "analysis", screen: "home" };
const PROGRESS: AppLocation = { module: "analysis", screen: "progress" };
const WORKSPACE: AppLocation = { module: "analysis", screen: "workspace" };
const REPORT: AppLocation = { module: "analysis", screen: "report" };
const VIDEO_LIST: AppLocation = { module: "video", screen: "list" };

const nav = () => useNavigationStore.getState();

beforeEach(() => {
  useNavigationStore.setState({ currentLocation: HOME, history: [] });
});

describe("navigation: goBack 回到真正的上一级", () => {
  it("入口→workspace,返回回到入口(home)", () => {
    nav().setLocation(WORKSPACE);
    expect(nav().currentLocation).toEqual(WORKSPACE);
    nav().goBack();
    expect(nav().currentLocation).toEqual(HOME);
  });

  it("video→workspace,返回回到 video(多入口:不写死 home)", () => {
    nav().setLocation(VIDEO_LIST);
    nav().setLocation(WORKSPACE);
    nav().goBack();
    expect(nav().currentLocation).toEqual(VIDEO_LIST);
  });

  it("栈空时落到 fallback(默认 home)", () => {
    nav().goBack();
    expect(nav().currentLocation).toEqual(HOME);
    nav().goBack({ module: "settings" });
    expect(nav().currentLocation).toEqual({ module: "settings" });
  });
});

describe("navigation: workspace↔report 兄弟视图用 replace,不污染返回栈", () => {
  it("home→workspace→report→workspace 后,返回回到 home(跳过兄弟互跳)", () => {
    nav().setLocation(WORKSPACE); // push home
    nav().setLocation(REPORT);    // sibling replace
    nav().setLocation(WORKSPACE); // sibling replace
    expect(nav().history).toEqual([HOME]);
    nav().goBack();
    expect(nav().currentLocation).toEqual(HOME);
  });

  it("video→report→workspace(report 的 seek-to-node),返回回到 video", () => {
    nav().setLocation(VIDEO_LIST);
    nav().setLocation(REPORT);    // 从 video 直接进 report:push video
    nav().setLocation(WORKSPACE); // sibling replace
    nav().goBack();
    expect(nav().currentLocation).toEqual(VIDEO_LIST);
  });
});

describe("navigation: 临时屏(progress)不作为返回目标", () => {
  it("home→progress→workspace,返回跳过 progress 回到 home", () => {
    nav().setLocation(PROGRESS);  // push home
    nav().setLocation(WORKSPACE); // 离开 transient → replace
    expect(nav().history).toEqual([HOME]);
    nav().goBack();
    expect(nav().currentLocation).toEqual(HOME);
  });

  it("goBack 跳过栈里残留的 progress", () => {
    useNavigationStore.setState({ currentLocation: WORKSPACE, history: [HOME, PROGRESS] });
    nav().goBack();
    expect(nav().currentLocation).toEqual(HOME);
    expect(nav().history).toEqual([]);
  });
});

describe("navigation: 内容库默认落 hub", () => {
  it("goModule('account') 落到 hub(内容库三 Tab 落地页)", () => {
    nav().goModule("account");
    expect(nav().currentLocation).toEqual({ module: "account", screen: "hub" });
  });

  it("从内容库 hub 进收藏夹详情,返回回到 hub", () => {
    nav().goModule("account"); // hub
    nav().setLocation({ module: "account", screen: "collection" });
    nav().goBack();
    expect(nav().currentLocation).toEqual({ module: "account", screen: "hub" });
  });
});

describe("navigation: 去重 + 兼容", () => {
  it("连续导航到相同 location 不压栈", () => {
    nav().setLocation(WORKSPACE);
    nav().setLocation(WORKSPACE);
    expect(nav().history).toEqual([HOME]);
  });

  it("setCurrentScreen(legacy) 也走历史栈", () => {
    nav().setCurrentScreen("workspace");
    expect(nav().currentLocation).toEqual(WORKSPACE);
    nav().goBack();
    expect(nav().currentLocation).toEqual(HOME);
  });
});
