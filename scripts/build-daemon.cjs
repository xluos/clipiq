#!/usr/bin/env node
// 交叉编译 ai-model-daemon,输出到 build/daemon/<os>-<arch>/ 供 electron-builder 打包。
// 用法:
//   node scripts/build-daemon.cjs              # 当前平台
//   node scripts/build-daemon.cjs --mac        # macOS arm64 + x64
//   node scripts/build-daemon.cjs --win        # Windows x64
//   node scripts/build-daemon.cjs --all        # 全部目标
//   node scripts/build-daemon.cjs --mac-arm64  # 单个目标

const { execSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const DAEMON_SRC = process.env.AI_MODEL_DAEMON_SRC
  || path.resolve(__dirname, "../../ai-model-daemon");
const OUT_BASE = path.resolve(__dirname, "../build/daemon");

const TARGETS = {
  "mac-arm64":   { GOOS: "darwin",  GOARCH: "arm64", exe: "ai-model-daemon" },
  "mac-x64":     { GOOS: "darwin",  GOARCH: "amd64", exe: "ai-model-daemon" },
  "win-x64":     { GOOS: "windows", GOARCH: "amd64", exe: "ai-model-daemon.exe" },
  "linux-x64":   { GOOS: "linux",   GOARCH: "amd64", exe: "ai-model-daemon" },
  "linux-arm64":  { GOOS: "linux",   GOARCH: "arm64", exe: "ai-model-daemon" },
};

function currentTarget() {
  const osMap = { darwin: "mac", linux: "linux", win32: "win" };
  const archMap = { arm64: "arm64", x64: "x64" };
  const key = `${osMap[process.platform]}-${archMap[process.arch]}`;
  if (!TARGETS[key]) {
    console.error(`Unsupported platform: ${process.platform}-${process.arch}`);
    process.exit(1);
  }
  return key;
}

function build(targetKey) {
  const t = TARGETS[targetKey];
  if (!t) {
    console.error(`Unknown target: ${targetKey}`);
    process.exit(1);
  }

  if (!fs.existsSync(path.join(DAEMON_SRC, "go.mod"))) {
    console.error(`Daemon source not found at ${DAEMON_SRC}`);
    console.error("Set AI_MODEL_DAEMON_SRC env or place ai-model-daemon alongside clipiq.");
    process.exit(1);
  }

  const outDir = path.join(OUT_BASE, targetKey);
  fs.mkdirSync(outDir, { recursive: true });

  const outPath = path.join(outDir, t.exe);
  console.log(`[build-daemon] ${targetKey} → ${outPath}`);

  execSync(`go build -buildvcs=false -trimpath -ldflags="-s -w" -o "${outPath}" .`, {
    cwd: DAEMON_SRC,
    stdio: "inherit",
    env: { ...process.env, GOOS: t.GOOS, GOARCH: t.GOARCH, CGO_ENABLED: "0" },
  });

  console.log(`[build-daemon] ${targetKey} done`);
}

function killRunningDaemon() {
  const storageDir = process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Application Support", "AIModels")
    : process.platform === "win32"
      ? path.join(process.env.LOCALAPPDATA || "", "AIModels")
      : path.join(os.homedir(), ".local", "share", "AIModels");
  const pidFile = path.join(storageDir, ".daemon.pid");
  try {
    const pid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
    if (!pid) return;
    process.kill(pid, "SIGTERM");
    console.log(`[build-daemon] 已停止旧 daemon (pid=${pid}),下次调用时自动拉起新版本`);
    try { fs.unlinkSync(pidFile); } catch {}
    try { fs.unlinkSync(path.join(storageDir, ".daemon.token")); } catch {}
    try { fs.unlinkSync(path.join(storageDir, ".daemon.sock")); } catch {}
  } catch {
    // pid 文件不存在或进程已退出
  }
}

const args = process.argv.slice(2);
let builtCurrentPlatform = false;
const cur = currentTarget();

if (args.length === 0) {
  build(cur);
  builtCurrentPlatform = true;
} else if (args.includes("--all")) {
  for (const key of Object.keys(TARGETS)) build(key);
  builtCurrentPlatform = true;
} else if (args.includes("--mac")) {
  build("mac-arm64");
  build("mac-x64");
  if (cur.startsWith("mac-")) builtCurrentPlatform = true;
} else if (args.includes("--win")) {
  build("win-x64");
  if (cur.startsWith("win-")) builtCurrentPlatform = true;
} else if (args.includes("--linux")) {
  build("linux-x64");
  build("linux-arm64");
  if (cur.startsWith("linux-")) builtCurrentPlatform = true;
} else {
  for (const arg of args) {
    const key = arg.replace(/^--/, "");
    if (TARGETS[key]) {
      build(key);
      if (key === cur) builtCurrentPlatform = true;
    } else {
      console.error(`Unknown target: ${arg}`);
      process.exit(1);
    }
  }
}

if (builtCurrentPlatform) killRunningDaemon();
