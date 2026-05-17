// 通用分析阶段结果缓存。
//
// 设计:
// - 独立目录 <cacheDir>: 跟 projects/ / models/ 同级, 默认 userData/cache/, 可在
//   设置里改到外部盘。
// - 元数据进 SQLite (<cacheDir>/index.db), payload 进 JSON 文件
//   (<cacheDir>/blobs/<scope>/<sha[0:2]>/<sha[2:]>.json), 这样大 payload 不撑爆 db,
//   也方便直接 cat 调试。
// - Scope 按阶段名隔离 ('transcript' / 'prefilter' / 'shot-merger' / ...), key 内
//   含 model + 参数 + prompt VERSION, 换模型或改 prompt 不会命中错结果。
// - LRU: set 后若总大小 > maxBytes, 按 last_used_at asc 删到 90% 容量。throttle
//   到最多 5s 检查一次, 避免 prefilter 那种逐帧高频 set 把磁盘 I/O 打满。
// - 整个模块 singleton: prefilter / shot-merger 等都 require 同一个实例,
//   configure() 由 main.cjs 在启动时调一次。

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

let _state = null; // { dir, maxBytes, db }
let _lastEvictCheck = 0;
const EVICT_CHECK_INTERVAL_MS = 5_000;

function stableStringify(value) {
  if (value === null || value === undefined) return JSON.stringify(value ?? null);
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(value[k])).join(",") + "}";
}

function makeKey(input) {
  const text = typeof input === "string" ? input : stableStringify(input);
  return crypto.createHash("sha256").update(text, "utf8").digest("hex").slice(0, 32);
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

function safeScope(scope) {
  return String(scope || "default").replace(/[^a-zA-Z0-9_-]/g, "_");
}

function blobPathFor(scope, key) {
  return path.join(_state.dir, "blobs", safeScope(scope), key.slice(0, 2), key.slice(2) + ".json");
}

function ensureDb() {
  if (!_state) throw new Error("cache-store: configure 还没调用");
  if (_state.db) return _state.db;
  fs.mkdirSync(_state.dir, { recursive: true });
  const db = new DatabaseSync(path.join(_state.dir, "index.db"));
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS cache_entries (
      scope         TEXT NOT NULL,
      key           TEXT NOT NULL,
      blob_rel      TEXT NOT NULL,
      size_bytes    INTEGER NOT NULL,
      created_at    INTEGER NOT NULL,
      last_used_at  INTEGER NOT NULL,
      hit_count     INTEGER NOT NULL DEFAULT 0,
      meta_json     TEXT,
      PRIMARY KEY (scope, key)
    );
    CREATE INDEX IF NOT EXISTS idx_last_used ON cache_entries(last_used_at);
    CREATE INDEX IF NOT EXISTS idx_scope ON cache_entries(scope);
  `);
  _state.db = db;
  return db;
}

function closeDb() {
  if (_state?.db) {
    try { _state.db.close(); } catch { /* ignore */ }
    _state.db = null;
  }
}

function configure({ dir, maxBytes }) {
  const normalizedDir = path.resolve(dir);
  if (_state && _state.dir !== normalizedDir) closeDb();
  if (!_state) _state = { dir: normalizedDir, maxBytes: maxBytes ?? 0, db: null };
  else {
    _state.dir = normalizedDir;
    _state.maxBytes = maxBytes ?? _state.maxBytes;
  }
  ensureDb();
  return { dir: _state.dir, maxBytes: _state.maxBytes };
}

function getCacheDir() { return _state?.dir || null; }
function getMaxBytes() { return _state?.maxBytes ?? 0; }
function isConfigured() { return !!_state; }

async function get(scope, key) {
  if (!_state) return null;
  const db = ensureDb();
  const row = db.prepare(
    "SELECT blob_rel, meta_json FROM cache_entries WHERE scope = ? AND key = ?",
  ).get(scope, key);
  if (!row) return null;
  const abs = path.isAbsolute(row.blob_rel) ? row.blob_rel : path.join(_state.dir, row.blob_rel);
  try {
    const text = await fsp.readFile(abs, "utf8");
    const payload = JSON.parse(text);
    db.prepare(
      "UPDATE cache_entries SET last_used_at = ?, hit_count = hit_count + 1 WHERE scope = ? AND key = ?",
    ).run(Date.now(), scope, key);
    return {
      payload,
      meta: row.meta_json ? safeParseJson(row.meta_json) : null,
    };
  } catch {
    // blob 丢了 (用户手动删了文件) → 同步把 index 行也清掉, 让下次 set 重建
    db.prepare("DELETE FROM cache_entries WHERE scope = ? AND key = ?").run(scope, key);
    return null;
  }
}

function safeParseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

async function set(scope, key, payload, opts = {}) {
  if (!_state) return;
  const db = ensureDb();
  const blob = blobPathFor(scope, key);
  await fsp.mkdir(path.dirname(blob), { recursive: true });
  const text = JSON.stringify(payload);
  await fsp.writeFile(blob, text, "utf8");
  const size = Buffer.byteLength(text, "utf8");
  const rel = path.relative(_state.dir, blob);
  const ts = Date.now();
  const metaJson = opts.meta ? JSON.stringify(opts.meta) : null;
  db.prepare(`
    INSERT INTO cache_entries (scope, key, blob_rel, size_bytes, created_at, last_used_at, hit_count, meta_json)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?)
    ON CONFLICT(scope, key) DO UPDATE SET
      blob_rel = excluded.blob_rel,
      size_bytes = excluded.size_bytes,
      last_used_at = excluded.last_used_at,
      meta_json = excluded.meta_json
  `).run(scope, key, rel, size, ts, ts, metaJson);
  maybeEvict();
}

function maybeEvict() {
  if (!_state || _state.maxBytes <= 0) return;
  const now = Date.now();
  if (now - _lastEvictCheck < EVICT_CHECK_INTERVAL_MS) return;
  _lastEvictCheck = now;
  evictToSize(_state.maxBytes).catch(() => { /* ignore */ });
}

function stats() {
  if (!_state) return { totalEntries: 0, totalBytes: 0, maxBytes: 0, cacheDir: null, byScope: {} };
  const db = ensureDb();
  const total = db.prepare(
    "SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS bytes FROM cache_entries",
  ).get();
  const byScopeRows = db.prepare(
    "SELECT scope, COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS bytes, MAX(last_used_at) AS lastUsed FROM cache_entries GROUP BY scope ORDER BY bytes DESC",
  ).all();
  const byScope = {};
  for (const r of byScopeRows) {
    byScope[r.scope] = {
      count: Number(r.n),
      bytes: Number(r.bytes),
      lastUsedAt: Number(r.lastUsed) || 0,
    };
  }
  return {
    totalEntries: Number(total.n),
    totalBytes: Number(total.bytes),
    maxBytes: _state.maxBytes,
    cacheDir: _state.dir,
    byScope,
  };
}

function unmarshalEntry(row) {
  return {
    scope: row.scope,
    key: row.key,
    sizeBytes: Number(row.size_bytes),
    createdAt: Number(row.created_at),
    lastUsedAt: Number(row.last_used_at),
    hitCount: Number(row.hit_count),
    meta: row.meta_json ? safeParseJson(row.meta_json) : null,
  };
}

function list({ scope, limit = 200, offset = 0 } = {}) {
  if (!_state) return [];
  const db = ensureDb();
  if (scope) {
    return db.prepare(
      "SELECT scope, key, size_bytes, created_at, last_used_at, hit_count, meta_json FROM cache_entries WHERE scope = ? ORDER BY last_used_at DESC LIMIT ? OFFSET ?",
    ).all(scope, limit, offset).map(unmarshalEntry);
  }
  return db.prepare(
    "SELECT scope, key, size_bytes, created_at, last_used_at, hit_count, meta_json FROM cache_entries ORDER BY last_used_at DESC LIMIT ? OFFSET ?",
  ).all(limit, offset).map(unmarshalEntry);
}

async function clear({ scope } = {}) {
  if (!_state) return { freedBytes: 0, freedEntries: 0 };
  const db = ensureDb();
  const rows = scope
    ? db.prepare("SELECT scope, key, blob_rel, size_bytes FROM cache_entries WHERE scope = ?").all(scope)
    : db.prepare("SELECT scope, key, blob_rel, size_bytes FROM cache_entries").all();
  let freed = 0;
  for (const r of rows) {
    const abs = path.isAbsolute(r.blob_rel) ? r.blob_rel : path.join(_state.dir, r.blob_rel);
    await fsp.rm(abs, { force: true }).catch(() => { /* ignore */ });
    freed += Number(r.size_bytes) || 0;
  }
  if (scope) {
    db.prepare("DELETE FROM cache_entries WHERE scope = ?").run(scope);
    await fsp.rm(
      path.join(_state.dir, "blobs", safeScope(scope)),
      { recursive: true, force: true },
    ).catch(() => { /* ignore */ });
  } else {
    db.prepare("DELETE FROM cache_entries").run();
    await fsp.rm(
      path.join(_state.dir, "blobs"),
      { recursive: true, force: true },
    ).catch(() => { /* ignore */ });
  }
  return { freedBytes: freed, freedEntries: rows.length };
}

async function evictToSize(targetMaxBytes) {
  if (!_state || targetMaxBytes <= 0) return { evicted: 0, freedBytes: 0 };
  const db = ensureDb();
  const totalRow = db.prepare("SELECT COALESCE(SUM(size_bytes), 0) AS bytes FROM cache_entries").get();
  let total = Number(totalRow.bytes);
  if (total <= targetMaxBytes) return { evicted: 0, freedBytes: 0 };
  const goal = Math.floor(targetMaxBytes * 0.9);
  const victims = db.prepare(
    "SELECT scope, key, blob_rel, size_bytes FROM cache_entries ORDER BY last_used_at ASC",
  ).all();
  let evicted = 0;
  let freedBytes = 0;
  for (const v of victims) {
    if (total <= goal) break;
    const abs = path.isAbsolute(v.blob_rel) ? v.blob_rel : path.join(_state.dir, v.blob_rel);
    await fsp.rm(abs, { force: true }).catch(() => { /* ignore */ });
    db.prepare("DELETE FROM cache_entries WHERE scope = ? AND key = ?").run(v.scope, v.key);
    total -= Number(v.size_bytes) || 0;
    freedBytes += Number(v.size_bytes) || 0;
    evicted += 1;
  }
  return { evicted, freedBytes };
}

async function copyDir(src, dst) {
  await fsp.mkdir(dst, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) await copyDir(s, d);
    else if (e.isFile()) await fsp.copyFile(s, d);
  }
}

// 改 cacheDir: 把整个目录搬到新位置 (同盘 rename, 跨盘 copy + 删源)。
// 调用方应在 saveConfig 写回 cacheDir 之前/之后协调好顺序。
async function migrate(targetDir) {
  if (!_state) throw new Error("cache-store: 未初始化");
  const newDir = path.resolve(targetDir);
  if (newDir === _state.dir) return { ok: true, mode: "noop" };
  const oldDir = _state.dir;
  const maxBytes = _state.maxBytes;
  closeDb();
  await fsp.mkdir(path.dirname(newDir), { recursive: true });
  let mode = "rename";
  try {
    // 目标存在且非空 → rename 会失败; 否则尝试整体 rename。
    const targetExists = await fsp.stat(newDir).then(() => true).catch(() => false);
    if (targetExists) {
      // 已存在: 拷贝合并 (覆盖同名), 然后删源
      await copyDir(oldDir, newDir);
      await fsp.rm(oldDir, { recursive: true, force: true });
      mode = "merge";
    } else {
      await fsp.rename(oldDir, newDir);
    }
  } catch (err) {
    if (err?.code === "EXDEV") {
      // 跨文件系统
      await copyDir(oldDir, newDir);
      await fsp.rm(oldDir, { recursive: true, force: true });
      mode = "copy";
    } else {
      // 源不存在 (从未写过 cache) → 直接建空目录
      await fsp.mkdir(newDir, { recursive: true });
      mode = "fresh";
    }
  }
  _state = { dir: newDir, maxBytes, db: null };
  ensureDb();
  return { ok: true, mode };
}

module.exports = {
  configure,
  isConfigured,
  getCacheDir,
  getMaxBytes,
  makeKey,
  sha256File,
  get,
  set,
  stats,
  list,
  clear,
  evictToSize,
  migrate,
};
