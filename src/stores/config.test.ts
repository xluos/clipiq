import { describe, it, expect, beforeEach } from "vitest";
import { useConfigStore } from "./config";
import type { AppConfig } from "../types";

// 每个用例前重置到默认(hydrate 空 config = 回默认值)
beforeEach(() => {
  useConfigStore.getState().hydrate({} as AppConfig);
});

describe("config store: getPipelineSlot 回退链", () => {
  it("pipeline 有自己的 slot 时优先返回它", () => {
    const s = useConfigStore.getState();
    // 默认 content pipeline 的 complex_vision = default-video/gpt-4o-mini
    expect(s.getPipelineSlot("content", "complex_vision")).toEqual({
      providerId: "default-video",
      modelId: "gpt-4o-mini",
    });
  });

  it("pipeline 没配该 slot 时回退到全局 taskSlots", () => {
    const s = useConfigStore.getState();
    // content pipeline 默认只配了 complex_vision,没配 simple_text → 回退全局(默认 null)
    expect(s.getPipelineSlot("content", "simple_text")).toBeNull();
  });

  it("显式 null override 不再回退全局(null ≠ 未设置)", () => {
    const s = useConfigStore.getState();
    // 先给全局 complex_vision 一个值
    s.setTaskSlot("complex_vision", { providerId: "g", modelId: "gm" });
    // pipeline 上显式置 null
    s.setPipelineSlot("content", "complex_vision", null);
    expect(useConfigStore.getState().getPipelineSlot("content", "complex_vision")).toBeNull();
  });

  it("__audio__ 回退:pipeline 未设 → 用全局 audioSlot", () => {
    const s = useConfigStore.getState();
    s.setAudioSlot({ providerId: "audio-p", modelId: "audio-m" });
    // pipeline pipeline 默认有 audioSlot=null(buildDefault 里 audio 传的是 null)→ 这是显式 null
    // 用一个全新没配过的 pipelineId 才能验证回退
    expect(useConfigStore.getState().getPipelineSlot("nope" as never, "__audio__")).toEqual({
      providerId: "audio-p",
      modelId: "audio-m",
    });
  });
});

describe("config store: setPipelineSlot 写入", () => {
  it("写 taskSlot 后读得到", () => {
    useConfigStore.getState().setPipelineSlot("content", "medium_text", { providerId: "x", modelId: "y" });
    expect(useConfigStore.getState().getPipelineSlot("content", "medium_text")).toEqual({ providerId: "x", modelId: "y" });
  });

  it("写 __audio__ 后读得到", () => {
    useConfigStore.getState().setPipelineSlot("content", "__audio__", { providerId: "a", modelId: "b" });
    expect(useConfigStore.getState().getPipelineSlot("content", "__audio__")).toEqual({ providerId: "a", modelId: "b" });
  });
});

describe("config store: hydrate", () => {
  it("空 config 回默认 providers", () => {
    const s = useConfigStore.getState();
    expect(s.providers[0].id).toBe("default-video");
    expect(s._hydrated).toBe(true);
  });

  it("传入的 providers 覆盖默认", () => {
    useConfigStore.getState().hydrate({
      providers: [{ id: "p2", name: "P2", source: "remote", baseUrl: "", apiKeyRef: "", endpointType: "openai_chat_completions", inputMode: "auto", models: [], model: "", kind: "video" }],
    } as AppConfig);
    expect(useConfigStore.getState().providers[0].id).toBe("p2");
  });

  it("localModelOverrides 非对象时兜底成空对象", () => {
    useConfigStore.getState().hydrate({ localModelOverrides: null } as unknown as AppConfig);
    expect(useConfigStore.getState().localModelOverrides).toEqual({});
  });
});

describe("config store: updateLocalModelOverride 校验", () => {
  it("正 contextSize 写入,非正值删除", () => {
    const s = useConfigStore.getState();
    s.updateLocalModelOverride("m1", { contextSize: 4096 });
    expect(useConfigStore.getState().localModelOverrides.m1).toEqual({ contextSize: 4096 });
    s.updateLocalModelOverride("m1", { contextSize: 0 });
    expect(useConfigStore.getState().localModelOverrides.m1).toBeUndefined();
  });

  it("传 null 删除", () => {
    const s = useConfigStore.getState();
    s.updateLocalModelOverride("m2", { contextSize: 8192 });
    s.updateLocalModelOverride("m2", null);
    expect(useConfigStore.getState().localModelOverrides.m2).toBeUndefined();
  });
});

describe("config store: 废弃 setter 仍维持兼容", () => {
  it("setActiveVideoProviderId(null) 清空 complex_vision", () => {
    const s = useConfigStore.getState();
    s.setActiveVideoProviderId(null);
    expect(useConfigStore.getState().taskSlots.complex_vision).toBeNull();
  });
});
