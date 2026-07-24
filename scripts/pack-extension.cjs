#!/usr/bin/env node
// 打包 Chrome 插件成 zip, 供 GitHub Release 分发用.
// 1) 把 package.json version 同步到 chrome-extension/manifest.json
// 2) zip -r release/clipiq-bridge-v<version>.zip chrome-extension/
//
// 同步 manifest version 让插件版本和主包版本对齐, 不用单独维护.
// CI 在 tag 触发时跑这个; 本地用 npm run dist:extension 也能跑 (需 zip 命令).

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const pkgPath = path.join(repoRoot, "package.json");
const manifestPath = path.join(repoRoot, "chrome-extension", "manifest.json");
const releaseDir = path.join(repoRoot, "release");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function main() {
  const pkg = readJson(pkgPath);
  const version = String(pkg.version || "").trim();
  if (!version) {
    console.error("package.json 缺 version");
    process.exit(1);
  }

  const manifest = readJson(manifestPath);
  if (manifest.version !== version) {
    manifest.version = version;
    writeJson(manifestPath, manifest);
    console.log(`[pack-extension] manifest.version → ${version}`);
  } else {
    console.log(`[pack-extension] manifest.version 已是 ${version}, 跳过同步`);
  }

  if (!fs.existsSync(releaseDir)) fs.mkdirSync(releaseDir, { recursive: true });
  const zipName = `clipiq-bridge-v${version}.zip`;
  const zipPath = path.join(releaseDir, zipName);
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

  // 在 chrome-extension/ 内部 zip, 不带顶层目录 — 用户解压后直接是 manifest.json + background.js,
  // chrome://extensions 加载已解压扩展直接选解压目录即可.
  // 用系统 zip 命令; Linux / macOS 自带, Windows 用户跑 dist:extension 会失败 (CI 在 ubuntu 跑没问题).
  try {
    execFileSync(
      "zip",
      ["-r", "-q", zipPath, ".", "-x", ".DS_Store", "**/.DS_Store", "node_modules/*"],
      { cwd: path.join(repoRoot, "chrome-extension"), stdio: "inherit" },
    );
  } catch (e) {
    console.error("[pack-extension] zip 失败:", e?.message || String(e));
    console.error("Windows 用户请用 PowerShell 的 Compress-Archive 手动打包, 或在 WSL 里跑.");
    process.exit(1);
  }

  const stat = fs.statSync(zipPath);
  console.log(`[pack-extension] 输出 ${zipPath} (${(stat.size / 1024).toFixed(1)} KB)`);
}

main();
