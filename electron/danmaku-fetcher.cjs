// B 站弹幕拉取 + protobuf 解析
//
// 输入: bilibili URL (含 BV / b23.tv 短链)
// 输出: { platform, bvid, cid, durationSec, title, totalCount, segmentCount, messages: [{tSec, text, ...}] }
//
// 接口链路:
//   1) URL → BV ID (短链先 GET location)
//   2) bvid → cid + duration:  GET https://api.bilibili.com/x/web-interface/view?bvid=...
//   3) 分段拉弹幕 protobuf: GET https://api.bilibili.com/x/v2/dm/web/seg.so?type=1&oid={cid}&segment_index={n}
//      segment_index 从 1 起, 每段 6 分钟; 末尾响应空就停。
//
// protobuf schema (DmSegMobileReply { repeated DanmakuElem elems = 1; }) 字段固定多年, 这里手写 varint 解析,
// 不引入 protobufjs 依赖。仅消费 progress(ms) / mode / color / midHash / content / weight。

const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");

const VIEW_API = "https://api.bilibili.com/x/web-interface/view";
const DANMAKU_API = "https://api.bilibili.com/x/v2/dm/web/seg.so";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const SEGMENT_SEC = 360;        // 每段 6 分钟
const SEGMENT_DELAY_MS = 400;   // 节流
const MAX_SEGMENTS = 60;        // 上限 6 小时, 防御 cid 错误时无限拉
const CACHE_TTL_MS = 12 * 3600 * 1000;

// ---- BV 提取 / 短链解析 -----------------------------------------------------

function extractBvid(url) {
  if (!url) return null;
  const m = String(url).match(/BV[1-9A-HJ-NP-Za-km-z]{10}/);
  return m ? m[0] : null;
}

async function resolveShortUrl(url) {
  if (!/b23\.tv/i.test(String(url))) return url;
  try {
    const res = await fetch(url, { redirect: "manual", headers: { "User-Agent": UA } });
    const loc = res.headers.get("location");
    if (loc) return loc;
  } catch {
    // 网络/解析失败让上层兜底
  }
  return url;
}

async function fetchBvid(url) {
  const direct = extractBvid(url);
  if (direct) return direct;
  const resolved = await resolveShortUrl(url);
  return extractBvid(resolved);
}

// ---- view API: bvid → cid + duration ---------------------------------------

async function fetchVideoInfo(bvid, abortSignal) {
  const url = `${VIEW_API}?bvid=${encodeURIComponent(bvid)}`;
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: abortSignal });
  if (!res.ok) throw new Error(`view API HTTP ${res.status}`);
  const json = await res.json();
  if (json.code !== 0) throw new Error(`view API code=${json.code}: ${json.message || ""}`);
  const data = json.data || {};
  const cid = data.cid || (Array.isArray(data.pages) && data.pages[0]?.cid);
  if (!cid) throw new Error("view API 未返回 cid");
  return {
    cid: String(cid),
    duration: Number(data.duration) || 0,
    title: data.title || "",
  };
}

// ---- protobuf varint decoder -----------------------------------------------
// Wire format reference: https://protobuf.dev/programming-guides/encoding/

function readVarint(buf, pos) {
  let value = 0n;
  let shift = 0n;
  let read = 0;
  while (pos + read < buf.length) {
    const b = buf[pos + read];
    read++;
    value |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value, pos: pos + read };
    shift += 7n;
    if (shift > 70n) throw new Error("varint overflow");
  }
  throw new Error("varint truncated");
}

function readKey(buf, pos) {
  const v = readVarint(buf, pos);
  return {
    wire: Number(v.value & 7n),
    field: Number(v.value >> 3n),
    pos: v.pos,
  };
}

function skipField(buf, pos, wire) {
  switch (wire) {
    case 0: return readVarint(buf, pos).pos;
    case 1: return pos + 8;
    case 5: return pos + 4;
    case 2: {
      const len = readVarint(buf, pos);
      return len.pos + Number(len.value);
    }
    default: throw new Error(`unknown wire type ${wire}`);
  }
}

function decodeElem(buf, start, end) {
  const out = { progress: 0, mode: 0, color: 0, midHash: "", content: "", weight: 0 };
  let p = start;
  while (p < end) {
    const k = readKey(buf, p);
    p = k.pos;
    if (k.wire === 0) {
      const v = readVarint(buf, p);
      p = v.pos;
      const num = Number(v.value);
      switch (k.field) {
        case 2: out.progress = num; break;
        case 3: out.mode = num; break;
        case 5: out.color = num; break;
        case 9: out.weight = num; break;
        // 其他 varint 字段(id/fontsize/ctime/pool/attr) 忽略
      }
    } else if (k.wire === 2) {
      const len = readVarint(buf, p);
      p = len.pos;
      const blen = Number(len.value);
      const slice = buf.slice(p, p + blen);
      p += blen;
      switch (k.field) {
        case 6: out.midHash = slice.toString("utf8"); break;
        case 7: out.content = slice.toString("utf8"); break;
        // 10 action / 12 idStr 不要
      }
    } else {
      p = skipField(buf, p, k.wire);
    }
  }
  return out;
}

function decodeSegment(buf) {
  const elems = [];
  let p = 0;
  while (p < buf.length) {
    const k = readKey(buf, p);
    p = k.pos;
    if (k.wire === 2 && k.field === 1) {
      const len = readVarint(buf, p);
      p = len.pos;
      const blen = Number(len.value);
      elems.push(decodeElem(buf, p, p + blen));
      p += blen;
    } else {
      p = skipField(buf, p, k.wire);
    }
  }
  return elems;
}

// ---- 单 segment 拉取 --------------------------------------------------------

async function fetchSegment(cid, segmentIndex, abortSignal) {
  const url = `${DANMAKU_API}?type=1&oid=${encodeURIComponent(cid)}&segment_index=${segmentIndex}`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA },
    signal: abortSignal,
  });
  if (res.status === 304 || res.status === 404) return { elems: [], empty: true };
  if (!res.ok) throw new Error(`segment ${segmentIndex} HTTP ${res.status}`);
  const arrayBuf = await res.arrayBuffer();
  const buf = Buffer.from(arrayBuf);
  if (buf.length === 0) return { elems: [], empty: true };
  try {
    const elems = decodeSegment(buf);
    return { elems, empty: elems.length === 0 };
  } catch (err) {
    throw new Error(`segment ${segmentIndex} protobuf parse failed: ${err.message}`);
  }
}

// ---- 全片拉取 (无缓存) ------------------------------------------------------

async function fetchAllDanmaku({ url, onProgress, abortSignal }) {
  const bvid = await fetchBvid(url);
  if (!bvid) throw new Error("URL 不像 B 站视频链接, 无法提取 BV ID");
  const { cid, duration, title } = await fetchVideoInfo(bvid, abortSignal);

  const expectedSegments = Math.max(1, Math.ceil(duration / SEGMENT_SEC));
  const capSegments = Math.min(expectedSegments + 1, MAX_SEGMENTS);

  const messages = [];
  let lastSegment = 0;
  for (let i = 1; i <= capSegments; i++) {
    const t0 = Date.now();
    const { elems, empty } = await fetchSegment(cid, i, abortSignal);
    lastSegment = i;
    for (const e of elems) {
      if (!e.content) continue;
      messages.push({
        tSec: Math.max(0, e.progress / 1000),
        text: e.content,
        mode: e.mode || 1,
        color: e.color || 0xffffff,
        midHash: e.midHash || "",
        weight: e.weight || 0,
      });
    }
    if (typeof onProgress === "function") {
      onProgress({
        segment: i,
        total: capSegments,
        count: messages.length,
        elapsedMs: Date.now() - t0,
      });
    }
    if (empty && i >= expectedSegments) break;
    if (i < capSegments) await new Promise((r) => setTimeout(r, SEGMENT_DELAY_MS));
  }

  messages.sort((a, b) => a.tSec - b.tSec);
  return {
    platform: "bilibili",
    bvid,
    cid,
    durationSec: duration,
    title,
    totalCount: messages.length,
    segmentCount: lastSegment,
    messages,
  };
}

// ---- 缓存层 -----------------------------------------------------------------

function getDanmakuCachePath(userDataDir) {
  return path.join(userDataDir, "danmaku-cache.json");
}

async function readDanmakuCache(userDataDir) {
  try {
    const raw = await fs.readFile(getDanmakuCachePath(userDataDir), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writeDanmakuCache(userDataDir, cache) {
  try {
    await fs.writeFile(getDanmakuCachePath(userDataDir), JSON.stringify(cache, null, 2), "utf8");
  } catch (err) {
    // 缓存写失败不影响主流程
    console.warn("[danmaku-cache] write failed:", err?.message || err);
  }
}

async function fetchDanmakuWithCache({ url, userDataDir, onProgress, abortSignal }) {
  const bvid = await fetchBvid(url);
  if (!bvid) throw new Error("URL 不像 B 站视频链接, 无法提取 BV ID");

  let cacheStore = {};
  if (userDataDir) {
    cacheStore = await readDanmakuCache(userDataDir);
    const hit = cacheStore[bvid];
    if (hit && Date.now() - new Date(hit.fetchedAt).getTime() < CACHE_TTL_MS) {
      if (typeof onProgress === "function") {
        onProgress({
          segment: hit.segmentCount,
          total: hit.segmentCount,
          count: hit.totalCount,
          fromCache: true,
        });
      }
      return { ...hit, fromCache: true };
    }
  }

  const result = await fetchAllDanmaku({ url, onProgress, abortSignal });
  const payload = { ...result, fetchedAt: new Date().toISOString() };

  if (userDataDir) {
    cacheStore[bvid] = payload;
    await writeDanmakuCache(userDataDir, cacheStore);
  }
  return { ...payload, fromCache: false };
}

module.exports = {
  extractBvid,
  fetchBvid,
  resolveShortUrl,
  fetchVideoInfo,
  fetchSegment,
  decodeSegment,
  decodeElem,
  fetchAllDanmaku,
  fetchDanmakuWithCache,
};
