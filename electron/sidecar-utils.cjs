// Sidecar 生命周期工具: PID 文件 + 跨会话接管 + 孤儿清理。
//
// 背景: llama-server / whisper-server 是 electron 主进程 spawn 出来的子进程,
// 但当 electron 被 Ctrl+C / SIGKILL / concurrently -k / 终端关闭时, 不会触发
// app.before-quit, sidecar 接管 ppid=1 成为孤儿继续跑。下次 electron 启动
// 不知道有这些孤儿, 又 spawn 新的, 长此以往累积几十个。
//
// 修复思路:
// - spawn 后立即把 { pid, port, modelKey, parentPid, startedAt } 写到一个 JSON 文件;
// - stop 时清掉这个文件;
// - 下次启动 init() 时 reapOrAdopt: 读 PID 文件 → 检查 pid + port 是否都活 →
//   活就接管 (复用同一端口和模型, 省一次冷启动); 死就杀残留 + 清文件。

const fs = require("node:fs");
const path = require("node:path");
const log = require("./logger.cjs");

function pidAlive(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0); // signal 0 不发信号, 只检测存活
    return true;
  } catch (e) {
    // ESRCH = 不存在; EPERM = 存在但无权限 (依然算活)
    return e.code === "EPERM";
  }
}

function killPid(pid, signal = "SIGTERM") {
  if (!pidAlive(pid)) return false;
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

// 同步等待 pid 退出, 超时强杀。Sync 版本给 shutdownSync / exit hook 用。
function killPidSyncWait(pid, graceMs = 800) {
  if (!pidAlive(pid)) return;
  killPid(pid, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return;
    // 自旋等待 (sync). 短时间忙等 OK, 我们只在退出路径用。
    const target = Date.now() + 50;
    while (Date.now() < target) { /* spin */ }
  }
  if (pidAlive(pid)) killPid(pid, "SIGKILL");
}

async function killPidAsyncWait(pid, graceMs = 1500) {
  if (!pidAlive(pid)) return;
  killPid(pid, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (pidAlive(pid)) killPid(pid, "SIGKILL");
}

async function probePort(port, { timeoutMs = 800, pathSuffix = "/" } = {}) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}${pathSuffix}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return r.ok || r.status === 404; // 任何 HTTP 响应都算"端口活着"
  } catch {
    return false;
  }
}

function readPidFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const obj = JSON.parse(raw);
    if (obj && Number.isFinite(obj.pid) && Number.isFinite(obj.port)) return obj;
  } catch {
    // 文件不存在 / 损坏 → 当作不存在
  }
  return null;
}

function writePidFile(filePath, info) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify({ ...info, writtenAt: Date.now() }, null, 2),
    );
  } catch (e) {
    log.warn("sidecar-utils", "writePidFile failed:", e.message);
  }
}

function clearPidFile(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // already gone — ok
  }
}

/**
 * 检查 PID 文件指向的 sidecar 是否还能接管。返回:
 *   - { mode: "adopt", info }: pid+port 都活, 调用方可以接管 (设置 state.borrowedPid 等)
 *   - { mode: "kill", info }:  pid 活但端口已死, 调用方应 killPid 后清文件
 *   - { mode: "stale" }:        pid 已死, 调用方只需清文件
 *   - { mode: "none" }:         没有 PID 文件
 *
 * 不在这里直接做副作用 (杀/清), 调用方可能想多做几件事 (e.g. 校验 modelKey 是否匹配当前 schema)。
 */
async function inspectPidFile(filePath, probeOptions = {}) {
  const info = readPidFile(filePath);
  if (!info) return { mode: "none" };
  const alive = pidAlive(info.pid);
  if (!alive) return { mode: "stale", info };
  const portUp = await probePort(info.port, probeOptions);
  if (!portUp) return { mode: "kill", info };
  return { mode: "adopt", info };
}

module.exports = {
  pidAlive,
  killPid,
  killPidSyncWait,
  killPidAsyncWait,
  probePort,
  readPidFile,
  writePidFile,
  clearPidFile,
  inspectPidFile,
};
