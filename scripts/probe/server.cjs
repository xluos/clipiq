// 临时 spawn llama-server 给探测脚本用, 不动用户当前的 sidecar
//
// 用法:
//   const { spawnLlamaServer } = require("./server.cjs");
//   const srv = await spawnLlamaServer({ modelKey, ctxSize, port?, withMmproj? });
//   ...
//   await srv.kill();

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");

const USER_DATA = path.join(os.homedir(), "Library/Application Support/clipiq");
const BIN_PATH = path.join(USER_DATA, "bin/llama-cpp-b9128/llama-server");
const MODELS_DIR = path.join(USER_DATA, "models/llama");

// 已下载模型清单 (跟 manifest 对齐, 但 fixture 自己维护)
const MODELS = {
  qwen3_5_0_8b_q4km: {
    modelFile: "Qwen3.5-0.8B-Q4_K_M.gguf",
    mmprojFile: "mmproj-F16.gguf",
    defaultCtx: 8192,
    label: "0.8B",
  },
  qwen3_5_4b_q4km: {
    modelFile: "Qwen3.5-4B-Q4_K_M.gguf",
    mmprojFile: "mmproj-F16.gguf",
    defaultCtx: 16384,
    label: "4B",
  },
  qwen3_5_9b_q4km: {
    modelFile: "Qwen3.5-9B-Q4_K_M.gguf",
    mmprojFile: "mmproj-F16.gguf",
    defaultCtx: 32768,
    label: "9B",
  },
};

function modelGgufPath(modelKey) {
  const m = MODELS[modelKey];
  if (!m) throw new Error(`未知 modelKey: ${modelKey}`);
  return {
    model: path.join(MODELS_DIR, modelKey, m.modelFile),
    mmproj: path.join(MODELS_DIR, modelKey, m.mmprojFile),
    label: m.label,
    defaultCtx: m.defaultCtx,
  };
}

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function pingHealth(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) {
        const j = await res.json().catch(() => ({}));
        if (j.status === "ok") return true;
      }
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function spawnLlamaServer({ modelKey, ctxSize, port, withMmproj = true, readyTimeoutMs = 90_000, log = console.log }) {
  if (!fs.existsSync(BIN_PATH)) throw new Error(`llama-server 不存在: ${BIN_PATH}`);
  const { model, mmproj, label, defaultCtx } = modelGgufPath(modelKey);
  if (!fs.existsSync(model)) throw new Error(`model gguf 不存在: ${model}`);
  if (withMmproj && !fs.existsSync(mmproj)) throw new Error(`mmproj gguf 不存在: ${mmproj}`);

  const actualPort = port || (await findFreePort());
  const actualCtx = ctxSize || defaultCtx;
  const args = [
    "--host", "127.0.0.1",
    "--port", String(actualPort),
    "--model", model,
    "--ctx-size", String(actualCtx),
    "--n-gpu-layers", "999",
    "--no-warmup",
  ];
  if (withMmproj) args.push("--mmproj", mmproj);

  log(`[server] spawn ${label} ctx=${actualCtx} port=${actualPort} mmproj=${withMmproj ? "y" : "n"}`);
  const t0 = Date.now();
  const proc = spawn(BIN_PATH, args, { stdio: ["ignore", "pipe", "pipe"], detached: false });
  let stderrTail = "";
  proc.stderr.on("data", (d) => {
    stderrTail = (stderrTail + d.toString()).slice(-4000);
  });
  proc.stdout.on("data", () => { /* drain */ });

  const ready = await pingHealth(actualPort, readyTimeoutMs);
  if (!ready) {
    proc.kill("SIGKILL");
    throw new Error(`server 在 ${readyTimeoutMs}ms 内未就绪, stderr tail:\n${stderrTail}`);
  }
  const loadMs = Date.now() - t0;
  log(`[server] ${label} ready in ${(loadMs / 1000).toFixed(1)}s`);

  return {
    port: actualPort,
    baseUrl: `http://127.0.0.1:${actualPort}/v1`,
    label,
    modelKey,
    ctxSize: actualCtx,
    loadMs,
    kill: async () => {
      try {
        proc.kill("SIGTERM");
        await new Promise((r) => setTimeout(r, 1500));
        if (!proc.killed) proc.kill("SIGKILL");
      } catch { /* ignore */ }
      log(`[server] killed ${label}`);
    },
  };
}

// 已经在跑的 server (比如用户的 60537), 直接 wrap, kill 是 noop
function wrapExistingServer({ port, modelKey, label = "(reuse)" }) {
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    label,
    modelKey,
    ctxSize: null, // 未知, 从 /props 拿
    loadMs: 0,
    kill: async () => { /* don't kill user's server */ },
  };
}

module.exports = { spawnLlamaServer, wrapExistingServer, MODELS, modelGgufPath };
