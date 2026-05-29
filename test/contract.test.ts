import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// ───────────────────────────────────────────────────────────────────────────
// IPC 契约测试 —— 不启动 Electron,以 electron/ipc-contract.cjs 的 manifest 为期望,
// 静态比对 main / d.ts 是否对齐。拦"重构后某层改名另两层没跟上"。
//
//   ipc-contract.cjs (唯一源)
//        │ preload.cjs 从它生成(见 preload.smoke.test.js 验证运行时)
//        ├── main.cjs:每个 invoke channel 必须有 ipcMain.handle;每个 event channel 必须有发射点
//        └── electron-api.d.ts:顶层 + 各 namespace 的方法集必须与 manifest 一致
// ───────────────────────────────────────────────────────────────────────────

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");
const requireCjs = createRequire(import.meta.url);

type Entry = { ns?: string; method: string; channel: string | null; kind: "invoke" | "event" | "special" };
const { CHANNELS, INVOKE_CHANNELS, EVENT_CHANNELS } = requireCjs("../electron/ipc-contract.cjs") as {
  CHANNELS: Entry[];
  INVOKE_CHANNELS: string[];
  EVENT_CHANNELS: string[];
};

const dtsSrc = read("src/electron-api.d.ts");

// main + 所有 electron 子模块 (.cjs),事件可能在 runtime 文件里发射
const electronCjs = readdirSync(resolve(root, "electron"))
  .filter((f) => f.endsWith(".cjs"))
  .map((f) => read(`electron/${f}`))
  .join("\n");

function captureAll(src: string, re: RegExp): Set<string> {
  return new Set([...src.matchAll(re)].map((m) => m[1]));
}

function stripStringsAndComments(s: string): string {
  return s
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/`(?:\\.|[^`\\])*`/g, "``");
}

// 取某个 `{...}` 块里"深度 1 且括号深度 0"的对象 key(排除函数签名里的参数名、嵌套类型字面量)
function topLevelKeys(src: string, openerRe: RegExp): Set<string> {
  const clean = stripStringsAndComments(src);
  const m = openerRe.exec(clean);
  if (!m) throw new Error(`找不到块开头: ${openerRe}`);
  const start = clean.indexOf("{", m.index);
  let brace = 0;
  let paren = 0;
  let stream = "";
  for (let i = start; i < clean.length; i++) {
    const ch = clean[i];
    if (ch === "{") { brace++; continue; }
    if (ch === "}") { brace--; if (brace === 0) break; continue; }
    if (ch === "(") { paren++; continue; }
    if (ch === ")") { paren--; continue; }
    if (brace === 1 && paren === 0) stream += ch;
  }
  return new Set([...stream.matchAll(/(?:^|[,{;；\n])\s*([A-Za-z_$][\w$]*)\s*[:(]/g)].map((x) => x[1]));
}

const sorted = (s: Iterable<string>) => [...s].sort();

describe("IPC 契约: manifest invoke channel ⊆ main handler", () => {
  const handlerChannels = captureAll(electronCjs, /ipcMain\.(?:handle|on)\(\s*["'`]([^"'`]+)["'`]/g);

  it("manifest 自检(没空)", () => {
    expect(INVOKE_CHANNELS.length).toBeGreaterThan(30);
    expect(handlerChannels.size).toBeGreaterThan(30);
  });

  it("每个 invoke channel 都有 ipcMain handler", () => {
    const missing = INVOKE_CHANNELS.filter((c) => !handlerChannels.has(c));
    expect(missing, `manifest 声明但 main 没 handler(renderer 调用会挂):\n${missing.join("\n")}`).toEqual([]);
  });
});

describe("IPC 契约: manifest event channel ⊆ main 发射点", () => {
  const emitted = captureAll(
    electronCjs,
    /(?:\.send|broadcast(?:ToWindows)?)\(\s*["'`]([^"'`]+)["'`]/g,
  );
  // 已知"只监听、main 当前不发射"的死通道(重构期残留,日志流没接到 UI)。
  const KNOWN_UNEMITTED = new Set(["llama:log", "whisperCpp:log"]);

  it("每个 event channel 都有 main 发射点", () => {
    const orphans = EVENT_CHANNELS.filter((c) => !emitted.has(c) && !KNOWN_UNEMITTED.has(c));
    expect(orphans, `manifest 声明 event 但 main 从不发射(UI 收不到):\n${orphans.join("\n")}`).toEqual([]);
  });

  it("allowlist 里的死通道仍然没人发射(发射了就该删 allowlist)", () => {
    const reborn = [...KNOWN_UNEMITTED].filter((c) => emitted.has(c));
    expect(reborn, `这些已有发射点,请从 KNOWN_UNEMITTED 删除:\n${reborn.join("\n")}`).toEqual([]);
  });
});

describe("IPC 契约: manifest ↔ d.ts 方法集", () => {
  const nsList = [...new Set(CHANNELS.filter((c) => c.ns).map((c) => c.ns as string))];
  const dtsTopKeys = topLevelKeys(dtsSrc, /videoAnalyzer\?\s*:/);

  it("顶层:manifest 顶层方法 ∪ namespace 名 === d.ts 顶层键", () => {
    const expected = new Set<string>([
      ...CHANNELS.filter((c) => !c.ns).map((c) => c.method),
      ...nsList,
    ]);
    expect(sorted(dtsTopKeys), "d.ts 顶层与 manifest 不一致").toEqual(sorted(expected));
  });

  for (const ns of nsList) {
    it(`namespace ${ns}:manifest 方法集 === d.ts 该 namespace 方法集`, () => {
      const expected = new Set(CHANNELS.filter((c) => c.ns === ns).map((c) => c.method));
      const dtsNsKeys = topLevelKeys(dtsSrc, new RegExp(`\\b${ns}\\s*:`));
      expect(sorted(dtsNsKeys), `${ns} 的 d.ts 声明与 manifest 不一致`).toEqual(sorted(expected));
    });
  }
});

describe("IPC 契约: manifest 自身一致性", () => {
  it("invoke/event 条目都有非空 channel,special 才允许 channel=null", () => {
    const bad = CHANNELS.filter((c) => c.kind !== "special" && !c.channel);
    expect(bad.map((c) => c.method), "这些非 special 条目缺 channel").toEqual([]);
  });

  it("channel 无重复", () => {
    const chans = CHANNELS.map((c) => c.channel).filter(Boolean) as string[];
    const dup = chans.filter((c, i) => chans.indexOf(c) !== i);
    expect([...new Set(dup)], "重复 channel").toEqual([]);
  });
});
