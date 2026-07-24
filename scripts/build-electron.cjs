#!/usr/bin/env node
// 把 electron/**/*.ts 逐文件预编译成同名 .js(给打包后的 prod 用)。
// dev 不跑这个 —— dev 走 main.cjs 顶部的 tsx require-hook 直接加载 .ts。
//
// bundle:false:不打包,保持 require 图与 native 模块(better-sqlite3 / ffmpeg)原样,
// 零外部化配置。format:cjs / platform:node,输出同名 .js + .js.map 落在源文件旁,
// electron-builder 的 files:["electron/**"] 会把它们带进 asar。
//
// 没有 .ts 时为 no-op(初期就是这样,直到第一个模块被迁移)。

const fs = require("fs");
const path = require("path");
const esbuild = require("esbuild");

const ELECTRON_DIR = path.join(__dirname, "..", "electron");

/** 递归收集 electron/ 下要编译的 .ts(排除 .d.ts 与 *.test.ts)。 */
function collectTsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "assets") continue;
      out.push(...collectTsFiles(full));
    } else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".d.ts") &&
      !entry.name.endsWith(".test.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

function main() {
  const entryPoints = collectTsFiles(ELECTRON_DIR);
  if (entryPoints.length === 0) {
    console.log("[build-electron] 无 .ts 文件,跳过");
    return;
  }

  esbuild.buildSync({
    entryPoints,
    outdir: ELECTRON_DIR,
    outbase: ELECTRON_DIR, // 保持目录结构,输出落在源文件同目录
    bundle: false,
    format: "cjs",
    platform: "node",
    target: "node20", // Electron 42 的 Node 运行时,node20 是安全子集
    sourcemap: true,
    logLevel: "info",
  });

  console.log(
    `[build-electron] 已编译 ${entryPoints.length} 个 .ts → .js:\n` +
      entryPoints.map((f) => "  " + path.relative(ELECTRON_DIR, f)).join("\n"),
  );
}

main();
