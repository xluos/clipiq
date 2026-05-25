// ai-model-daemon IPC 客户端。
// 通过 Unix socket 与 daemon 通信,管理模型下载生命周期。
// daemon 未运行时自动拉起。

const http = require("node:http");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const os = require("node:os");

function daemonStorageDir() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "AIModels");
  }
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "AIModels");
  }
  return path.join(os.homedir(), ".local", "share", "AIModels");
}

function socketPath() {
  return path.join(daemonStorageDir(), ".daemon.sock");
}

function pidPath() {
  return path.join(daemonStorageDir(), ".daemon.pid");
}

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      socketPath: socketPath(),
      path: urlPath,
      method,
      headers: { "Content-Type": "application/json" },
    };
    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk.toString(); });
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function isDaemonRunning() {
  try {
    const res = await request("GET", "/status");
    return res.status === 200 && res.data?.ready === true;
  } catch {
    return false;
  }
}

async function findDaemonBinary() {
  const envPath = process.env.AI_MODEL_DAEMON_PATH;
  if (envPath && fsSync.existsSync(envPath)) return envPath;

  const candidates = [
    path.join(os.homedir(), ".local", "bin", "ai-model-daemon"),
    path.join(os.homedir(), "go", "bin", "ai-model-daemon"),
    "/usr/local/bin/ai-model-daemon",
  ];
  for (const c of candidates) {
    if (fsSync.existsSync(c)) return c;
  }

  return new Promise((resolve) => {
    const which = process.platform === "win32" ? "where" : "which";
    const child = spawn(which, ["ai-model-daemon"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (c) => { out += c.toString(); });
    child.on("close", () => {
      const first = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
      resolve(first || null);
    });
    child.on("error", () => resolve(null));
  });
}

let daemonProcess = null;

async function ensureDaemon() {
  if (await isDaemonRunning()) return;

  const binary = await findDaemonBinary();
  if (!binary) {
    throw new Error(
      "ai-model-daemon 未找到。请构建并安装: cd ../ai-model-daemon && go build -o ~/.local/bin/ai-model-daemon .",
    );
  }

  await fs.mkdir(daemonStorageDir(), { recursive: true });

  const sock = socketPath();
  try { await fs.unlink(sock); } catch { /* ignore */ }

  const child = spawn(binary, ["serve"], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  await new Promise((resolve, reject) => {
    let stdout = "";
    const onData = (chunk) => {
      stdout += chunk.toString();
      try {
        const ready = JSON.parse(stdout.trim());
        if (ready.socket || ready.pid) {
          child.stdout.removeListener("data", onData);
          resolve(ready);
        }
      } catch { /* not complete yet */ }
    };
    child.stdout.on("data", onData);
    child.on("error", reject);
    const timer = setTimeout(() => reject(new Error("daemon 启动超时 (10s)")), 10_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      reject(new Error(`daemon 退出 code=${code}`));
    });
  });

  child.unref();
  daemonProcess = child;
  // eslint-disable-next-line no-console
  console.log(`[daemon-client] daemon started pid=${child.pid}`);
}

async function getStatus() {
  await ensureDaemon();
  const res = await request("GET", "/status");
  return res.data;
}

async function listModels(appFilter) {
  await ensureDaemon();
  const urlPath = appFilter ? `/models?app=${encodeURIComponent(appFilter)}` : "/models";
  const res = await request("GET", urlPath);
  return res.data;
}

async function getModelStatus(modelId) {
  await ensureDaemon();
  const res = await request("GET", `/models/${encodeURIComponent(modelId)}`);
  if (res.status === 404) return null;
  return res.data;
}

async function getModelPaths(modelId) {
  await ensureDaemon();
  const res = await request("GET", `/models/${encodeURIComponent(modelId)}/path`);
  if (res.status === 404) return null;
  return res.data?.paths || null;
}

async function deleteModel(modelId) {
  await ensureDaemon();
  const res = await request("DELETE", `/models/${encodeURIComponent(modelId)}`);
  return res.data;
}

async function setMirrorPreference(mirror) {
  await ensureDaemon();
  const res = await request("POST", "/config", { preferMirror: mirror });
  return res.data;
}

// SSE 下载,解析 event stream 回调 onProgress / onSkip / onDone。
// 返回 Promise<{ok, error?}>
function downloadModel(modelId, onProgress) {
  return new Promise(async (resolve, reject) => {
    try {
      await ensureDaemon();
    } catch (err) {
      return reject(err);
    }

    const opts = {
      socketPath: socketPath(),
      path: `/models/${encodeURIComponent(modelId)}/download`,
      method: "POST",
      headers: { "Accept": "text/event-stream" },
    };

    const req = http.request(opts, (res) => {
      // 非 SSE 响应: 可能是 already_ready / conflict / 404
      const contentType = res.headers["content-type"] || "";
      if (!contentType.includes("text/event-stream")) {
        let data = "";
        res.on("data", (chunk) => { data += chunk.toString(); });
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            if (json.status === "already_ready") return resolve({ ok: true, alreadyReady: true });
            if (json.error) return reject(new Error(json.error));
            resolve({ ok: true, data: json });
          } catch {
            reject(new Error(`daemon 响应异常: ${data.slice(0, 200)}`));
          }
        });
        return;
      }

      let buf = "";
      res.on("data", (chunk) => {
        buf += chunk.toString();
        const blocks = buf.split("\n\n");
        buf = blocks.pop();
        for (const block of blocks) {
          if (!block.trim()) continue;
          const eventMatch = block.match(/^event:\s*(.+)$/m);
          const dataMatch = block.match(/^data:\s*(.+)$/m);
          if (!eventMatch || !dataMatch) continue;
          const eventType = eventMatch[1].trim();
          let payload;
          try { payload = JSON.parse(dataMatch[1]); } catch { continue; }

          if (eventType === "progress" && onProgress) {
            onProgress(payload);
          } else if (eventType === "done") {
            if (payload.ok) {
              resolve({ ok: true });
            } else {
              reject(new Error(payload.error || "下载失败"));
            }
          }
          // skip events are informational, ignored
        }
      });
      res.on("end", () => {
        // 流结束但没收到 done event → 可能连接断了
        resolve({ ok: true });
      });
    });

    req.on("error", reject);
    req.end();
  });
}

module.exports = {
  ensureDaemon,
  isDaemonRunning,
  getStatus,
  listModels,
  getModelStatus,
  getModelPaths,
  downloadModel,
  deleteModel,
  setMirrorPreference,
  socketPath,
  daemonStorageDir,
};
