import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildApi } from "./preload.cjs";
import { CHANNELS } from "./ipc-contract.cjs";

describe("preload sandbox 约束: 只能 require('electron')", () => {
  // Electron sandbox 下 preload 的 require 只支持 "electron"(+少数内置 polyfill),
  // require 本地文件会让 preload 加载即崩 → window.videoAnalyzer 挂不上 → 退回浏览器预览。
  // 这条测试在 node 里跑(本地 require 正常),所以必须用静态扫描守住,别让人再踩。
  it("preload.cjs 不 require 任何本地文件", () => {
    const src = readFileSync(fileURLToPath(new URL("./preload.cjs", import.meta.url)), "utf8");
    const specs = [...src.matchAll(/require\(\s*["'`]([^"'`]+)["'`]\s*\)/g)].map((m) => m[1]);
    const local = specs.filter((s) => s.startsWith(".") || s.startsWith("/"));
    expect(local, `preload 只能 require 'electron',这些本地 require 会在 sandbox 下崩:\n${local.join("\n")}`).toEqual([]);
    expect(specs).toContain("electron");
  });
});

// 直接用注入的 fake 依赖调 buildApi,验证"从 manifest 生成 api"在运行时正确
// (静态契约测试管不到生成逻辑本身的 bug,如 override 漏接、命名空间没建)。
let ipcRenderer;
let webUtils;
let api;
beforeEach(() => {
  ipcRenderer = {
    invoke: vi.fn(() => Promise.resolve("ok")),
    on: vi.fn(),
    removeListener: vi.fn(),
  };
  webUtils = { getPathForFile: vi.fn(() => "/real/path.mp4") };
  api = buildApi(ipcRenderer, webUtils);
});

const resolve = (e) => (e.ns ? api[e.ns]?.[e.method] : api[e.method]);

describe("preload 生成: 所有 manifest 方法都被建出来", () => {
  it("每个 entry 在 api 上都是 function", () => {
    const missing = CHANNELS.filter((e) => typeof resolve(e) !== "function").map((e) => (e.ns ? `${e.ns}.${e.method}` : e.method));
    expect(missing, `这些方法没生成:\n${missing.join("\n")}`).toEqual([]);
  });

  it("命名空间都建成了对象", () => {
    for (const ns of new Set(CHANNELS.filter((e) => e.ns).map((e) => e.ns))) {
      expect(typeof api[ns], `${ns} 应是对象`).toBe("object");
    }
  });
});

describe("preload 生成: invoke 透传到正确 channel", () => {
  it("顶层 invoke", () => {
    api.listAnalyses("v1");
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("analyses:list", "v1");
  });

  it("命名空间 invoke", () => {
    api.llama.start("model-x");
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("llama:start", "model-x");
  });

  it("多参数 invoke 全部透传", () => {
    api.updateAnalysisResult("a1", { nodes: [] });
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("analyses:updateResult", "a1", { nodes: [] });
  });
});

describe("preload 生成: event 注册/解绑", () => {
  it("onTaskProgress 注册到 task:progress 并返回解绑函数", () => {
    const off = api.onTaskProgress(() => {});
    expect(ipcRenderer.on).toHaveBeenCalledWith("task:progress", expect.any(Function));
    expect(typeof off).toBe("function");
    off();
    expect(ipcRenderer.removeListener).toHaveBeenCalled();
  });

  it("event 回调只收 payload(剥掉 event 对象)", () => {
    const cb = vi.fn();
    api.onAnalysisProgress(cb);
    const listener = ipcRenderer.on.mock.calls.at(-1)[1];
    listener({ sender: "ipc-event" }, { analysisId: "a1", progress: 50 });
    expect(cb).toHaveBeenCalledWith({ analysisId: "a1", progress: 50 });
  });
});

describe("preload 生成: OVERRIDES 特例", () => {
  it("getPathForFile 走 webUtils(非 ipc)", () => {
    expect(api.getPathForFile({})).toBe("/real/path.mp4");
    expect(webUtils.getPathForFile).toHaveBeenCalled();
  });

  it("listVideos 省略参数时回填 {}", () => {
    api.listVideos();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("videos:list", {});
  });

  it("llama.recomputeFit 把两个标量包成对象", () => {
    api.llama.recomputeFit("m1", 4096);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("llama:recomputeFit", { modelKey: "m1", contextSize: 4096 });
  });

  it("cache.list 省略参数时回填 {}", () => {
    api.cache.list();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("cache:list", {});
  });
});
