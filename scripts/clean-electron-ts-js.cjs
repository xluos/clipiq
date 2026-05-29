#!/usr/bin/env node
// 删除 electron/ 下由 build-electron 生成的 .js / .js.map(即每个 .ts 的同名产物)。
//
// 为什么要清:prod build 会在 electron/ 落同名 .js。之后跑 electron:dev 时,
// dev 的 tsx require-hook 解析 require("./foo") 会让默认的 .js 优先级高于补进来的 .ts,
// 于是误加载到旧的编译产物。dev 启动前先清掉,确保跑的是 .ts 源码。
//
// 只删"有同名 .ts 的 .js" —— *.test.js 是真源码且没有同名 .ts,不会被误伤。

const fs = require("fs");
const path = require("path");

const ELECTRON_DIR = path.join(__dirname, "..", "electron");

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
  const removed = [];
  for (const ts of collectTsFiles(ELECTRON_DIR)) {
    for (const ext of [".js", ".js.map"]) {
      const target = ts.replace(/\.ts$/, ext);
      if (fs.existsSync(target)) {
        fs.rmSync(target);
        removed.push(path.relative(ELECTRON_DIR, target));
      }
    }
  }
  if (removed.length) {
    console.log("[clean-electron-ts-js] 已清理编译产物:\n" + removed.map((f) => "  " + f).join("\n"));
  }
}

main();
