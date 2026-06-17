const { app, BrowserWindow, session } = require("electron");
const { spawn } = require("node:child_process");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const log = require("./logger.cjs");

const DEFAULT_SEED_USER_URL =
  "https://www.douyin.com/user/" +
  "MS4wLjABAAAAEpmH344CkCw2M58T33Q8TuFpdvJsOyaZcbWxAMc6H03wOVFf1Ow4mPP94TDUS4Us";
const COOKIE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const SESSION_PARTITION = "persist:clipiq-douyin-spider";

function appRoot() {
  return app?.getAppPath?.() || path.resolve(__dirname, "..");
}

function candidateSpiderPaths() {
  const env = process.env.DOUYIN_SPIDER_PATH ? [process.env.DOUYIN_SPIDER_PATH] : [];
  const root = appRoot();
  return [
    ...env,
    path.join(root, "vendor", "DouYin_Spider"),
    path.join(root, "..", "douyin-tool-eval", "vendor", "DouYin_Spider"),
    path.join(root, "..", "douyin-crawler-service", "vendor", "DouYin_Spider"),
  ];
}

function resolveSpiderPath() {
  for (const p of candidateSpiderPaths()) {
    if (p && fsSync.existsSync(p)) return path.resolve(p);
  }
  throw new Error(
    "找不到 DouYin_Spider。请设置 DOUYIN_SPIDER_PATH 指向 DouYin_Spider 目录。",
  );
}

function candidatePythonCommands(spiderPath) {
  const exe = process.platform === "win32" ? "python.exe" : "python";
  const env = process.env.DOUYIN_SPIDER_PYTHON ? [process.env.DOUYIN_SPIDER_PYTHON] : [];
  return [
    ...env,
    path.join(spiderPath, ".venv", process.platform === "win32" ? "Scripts" : "bin", exe),
    path.join(appRoot(), "..", "douyin-crawler-service", ".venv", process.platform === "win32" ? "Scripts" : "bin", exe),
    process.platform === "win32" ? "python" : "python3",
    "python",
  ];
}

function resolvePythonCommand(spiderPath) {
  for (const cmd of candidatePythonCommands(spiderPath)) {
    if (!cmd) continue;
    if (cmd.includes(path.sep) && !fsSync.existsSync(cmd)) continue;
    return cmd;
  }
  return process.platform === "win32" ? "python" : "python3";
}

function cookieCachePath() {
  const userData = app?.getPath ? app.getPath("userData") : path.join(os.tmpdir(), "clipiq");
  return path.join(userData, "douyin-spider-cookie.json");
}

async function readCachedCookie() {
  try {
    const data = JSON.parse(await fs.readFile(cookieCachePath(), "utf8"));
    if (!data?.cookie || !data.createdAt) return null;
    if (Date.now() - Number(data.createdAt) > COOKIE_MAX_AGE_MS) return null;
    if (!String(data.cookie).includes("s_v_web_id=")) return null;
    return data.cookie;
  } catch {
    return null;
  }
}

async function writeCachedCookie(cookie) {
  try {
    await fs.mkdir(path.dirname(cookieCachePath()), { recursive: true });
    await fs.writeFile(
      cookieCachePath(),
      JSON.stringify({ cookie, createdAt: Date.now() }, null, 2),
      { mode: 0o600 },
    );
  } catch (err) {
    log.warn("douyin-spider", "写 cookie 缓存失败:", err?.message || err);
  }
}

async function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} 超时 (${Math.round(timeoutMs / 1000)}s)`)), timeoutMs);
    }),
  ]);
}

async function generateCookieViaElectron({ seedUrl = DEFAULT_SEED_USER_URL, timeoutMs = 45_000 } = {}) {
  const ses = session.fromPartition(SESSION_PARTITION);
  let webid = null;
  const filter = { urls: ["*://www.douyin.com/aweme/v1/web/user/profile/other/*"] };
  const onBeforeRequest = (details, callback) => {
    try {
      const u = new URL(details.url);
      const next = u.searchParams.get("webid");
      if (next) webid = next;
    } catch {
      /* ignore malformed URL */
    }
    callback({});
  };

  ses.webRequest.onBeforeRequest(filter, onBeforeRequest);
  const win = new BrowserWindow({
    show: false,
    width: 1365,
    height: 900,
    webPreferences: {
      partition: SESSION_PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  try {
    const domReady = new Promise((resolve, reject) => {
      win.webContents.once("dom-ready", resolve);
      win.webContents.once("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (isMainFrame) reject(new Error(`抖音页面加载失败 ${errorCode}: ${errorDescription || validatedURL}`));
      });
    });
    win.loadURL(seedUrl).catch((err) => {
      log.warn("douyin-spider", "loadURL failed:", err?.message || err);
    });
    await withTimeout(domReady, timeoutMs, "抖音页面加载");
    const started = Date.now();
    while (!webid && Date.now() - started < Math.min(timeoutMs, 12_000)) {
      await delay(500);
    }
    const cookies = [
      ...(await ses.cookies.get({ url: "https://www.douyin.com" })),
      ...(await ses.cookies.get({ url: "https://douyin.com" })),
    ];
    const dict = new Map();
    for (const c of cookies) {
      if (c?.name && c.value != null) dict.set(c.name, c.value);
    }
    if (webid && !dict.has("s_v_web_id")) dict.set("s_v_web_id", webid);
    if (!dict.has("s_v_web_id")) {
      throw new Error("Electron 生成抖音 cookie 失败: 缺少 s_v_web_id");
    }
    const cookie = [...dict.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
    await writeCachedCookie(cookie);
    return cookie;
  } finally {
    try { ses.webRequest.onBeforeRequest(filter, null); } catch { /* noop */ }
    try { win.destroy(); } catch { /* noop */ }
  }
}

async function getCookie({ seedUrl } = {}) {
  const cached = await readCachedCookie();
  if (cached) return cached;
  return await generateCookieViaElectron({ seedUrl });
}

function runRunner(payload, { timeoutMs = 90_000 } = {}) {
  const spiderPath = resolveSpiderPath();
  const python = resolvePythonCommand(spiderPath);
  const runnerPath = path.join(__dirname, "douyin_spider_runner.py");
  return new Promise((resolve, reject) => {
    const child = spawn(python, [runnerPath], {
      cwd: spiderPath,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, DOUYIN_SPIDER_PATH: spiderPath },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* noop */ }
      reject(new Error(`DouYin_Spider sidecar 超时 (${Math.round(timeoutMs / 1000)}s)`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const trimmed = stdout.trim();
      let parsed = null;
      if (trimmed) {
        try {
          parsed = JSON.parse(trimmed.split(/\n/).at(-1));
        } catch (err) {
          return reject(new Error(`DouYin_Spider 返回非 JSON: ${trimmed.slice(0, 300)}`));
        }
      }
      if (code !== 0 || parsed?.ok === false) {
        const msg = parsed?.error || stderr.trim().slice(-600) || `exit code=${code}`;
        return reject(new Error(msg));
      }
      resolve(parsed);
    });
    child.stdin.end(JSON.stringify({ ...payload, spider_path: spiderPath }));
  });
}

function normalizeSpiderVideo(video) {
  const id = String(video?.aweme_id || "");
  const durationMs = Number(video?.duration_ms) || 0;
  const createTs = Number(video?.create_time) || 0;
  return {
    id,
    title: video?.desc || "(未命名视频)",
    durationSec: Math.round(durationMs / 1000),
    uploadDate: createTs
      ? new Date(createTs * 1000).toISOString().slice(0, 10).replace(/-/g, "")
      : null,
    viewCount: Number(video?.play_count) || 0,
    likeCount: Number(video?.digg_count) || 0,
    commentCount: Number(video?.comment_count) || 0,
    shareCount: Number(video?.share_count) || 0,
    collectCount: Number(video?.collect_count) || 0,
    externalUrl: video?.aweme_url || (id ? `https://www.douyin.com/video/${id}` : ""),
    thumbnailUrl: video?.cover_url ? String(video.cover_url).replace(/^http:\/\//, "https://") : null,
    playUrl: Array.isArray(video?.video_urls) ? video.video_urls[0] || null : null,
    noteImageUrls: Array.isArray(video?.note_image_urls) ? video.note_image_urls : [],
  };
}

function normalizeSpiderUser(user) {
  const followerCount = Number(user?.follower_count) || 0;
  return {
    nickname: user?.nickname || null,
    avatarUrl: user?.avatar ? String(user.avatar).replace(/^http:\/\//, "https://") : null,
    signature: user?.signature || null,
    followerCount,
    followingCount: Number(user?.following_count) || 0,
    awemeCount: Number(user?.aweme_count) || 0,
    uid: user?.uid || user?.short_id || null,
    secUid: user?.sec_uid || null,
  };
}

async function crawlUser({ userUrl, limit = 20, seedUrl, maxCommentsPerVideo = 0, includeReplies = false }) {
  const cookie = await getCookie({ seedUrl: seedUrl || userUrl || DEFAULT_SEED_USER_URL });
  const result = await runRunner({
    op: "crawl_user",
    cookie,
    user_url: userUrl,
    limit,
    max_comments_per_video: maxCommentsPerVideo,
    include_replies: includeReplies,
    sleep_seconds: 0.8,
  }, { timeoutMs: Math.max(90_000, limit * 8_000) });
  const profile = normalizeSpiderUser(result.user || {});
  const videos = (Array.isArray(result.videos) ? result.videos : [])
    .map(normalizeSpiderVideo)
    .filter((v) => v.id);
  return { profile, videos, raw: result };
}

async function crawlAweme({ input, seedUrl, maxCommentsPerVideo = 30, includeReplies = false }) {
  const cookie = await getCookie({ seedUrl: seedUrl || DEFAULT_SEED_USER_URL });
  const result = await runRunner({
    op: "crawl_aweme",
    cookie,
    aweme_id: input,
    max_comments_per_video: maxCommentsPerVideo,
    include_replies: includeReplies,
    sleep_seconds: 0.8,
  }, { timeoutMs: 90_000 });
  return {
    user: normalizeSpiderUser(result.user || {}),
    video: normalizeSpiderVideo(result.video || {}),
    comments: Array.isArray(result.comments) ? result.comments : [],
    raw: result,
  };
}

function getStatus() {
  try {
    const spiderPath = resolveSpiderPath();
    return {
      available: true,
      spiderPath,
      python: resolvePythonCommand(spiderPath),
      cookieCachePath: cookieCachePath(),
    };
  } catch (err) {
    return { available: false, error: err?.message || String(err) };
  }
}

module.exports = {
  crawlUser,
  crawlAweme,
  generateCookieViaElectron,
  getCookie,
  getStatus,
  normalizeSpiderVideo,
  normalizeSpiderUser,
};
