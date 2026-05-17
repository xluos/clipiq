// B 站弹幕词云生成
//
// 设计取舍:
//   - 不引入 nodejieba (native module, 跨平台打包复杂); 用 bigram + 反应词规则覆盖 80% 信号
//   - 反应词归一: "哈哈哈" / "2333" / "666" / "awsl" / "绝绝子" 等网络情绪表达 → 一个 token, 单独加权
//   - 普通 CJK 串走 2-gram + 3-gram 滑窗, 过停用词
//   - 弹幕本身短句多 + 高频反应词集中, 这个粒度已经能产出"有意义的词云"

const STOPWORDS = new Set([
  // 单字语气助词通过"≥2 字"长度过滤掉, 这里收 2-3 字高频空泛词
  "什么", "怎么", "为什么", "怎样", "如何",
  "可以", "这个", "那个", "这些", "那些",
  "我们", "你们", "他们", "自己", "大家",
  "感觉", "应该", "可能", "已经", "因为", "所以", "如果", "但是", "然后", "其实",
  "还是", "就是", "不是", "也是", "都是",
]);

// 反应词归一规则: 各种网络情绪表达 → 一个 token, 出现一次记 reactionBoost 权重
const REACTION_RULES = [
  { pattern: /哈哈+/, token: "哈哈哈" },
  { pattern: /[23]{2,}3/, token: "2333" },
  { pattern: /6{2,}/, token: "666" },
  { pattern: /awsl|绝绝子|蚌埠住了|无语住了/i, token: "awsl" },
  { pattern: /嘤嘤+|呜呜+/, token: "呜呜呜" },
  { pattern: /嘿嘿+|嘻嘻+/, token: "嘿嘿" },
  { pattern: /呵呵+/, token: "呵呵" },
  { pattern: /大佬|大神/, token: "大佬" },
  { pattern: /给力|牛批|nb|niubi/i, token: "牛批" },
  { pattern: /笑死|笑不活了|笑岔了/, token: "笑死" },
  { pattern: /好家伙/, token: "好家伙" },
  { pattern: /前方高能|高能预警/, token: "高能" },
  { pattern: /yyds|永远的神/i, token: "yyds" },
];

function detectReactions(text) {
  const hits = [];
  for (const rule of REACTION_RULES) {
    if (rule.pattern.test(text)) hits.push(rule.token);
  }
  return hits;
}

function extractTerms(text) {
  // 把标点/数字/英文/空白都换成空格, 留下 CJK 串
  const cleaned = String(text).replace(/[\s\p{P}\d\p{Script=Latin}]+/gu, " ").trim();
  if (!cleaned) return [];
  const cjkRegex = /[一-鿿]+/g;
  const segments = cleaned.match(cjkRegex) || [];
  const terms = [];
  for (const seg of segments) {
    if (seg.length < 2) continue;
    if (seg.length === 2) {
      if (!STOPWORDS.has(seg)) terms.push(seg);
      continue;
    }
    // ≥3 字: 2-gram + 3-gram 滑窗, 去停用词
    const grams = new Set();
    for (let i = 0; i < seg.length - 1; i++) {
      const bi = seg.slice(i, i + 2);
      if (!STOPWORDS.has(bi)) grams.add(bi);
    }
    for (let i = 0; i < seg.length - 2; i++) {
      const tri = seg.slice(i, i + 3);
      if (!STOPWORDS.has(tri)) grams.add(tri);
    }
    terms.push(...grams);
  }
  return terms;
}

function buildWordCloud(messages, { topK = 80, minCount = 2, reactionBoost = 3 } = {}) {
  const counts = new Map();
  for (const m of messages || []) {
    const txt = String(m.text || "").trim();
    if (!txt) continue;
    // 反应词
    for (const r of detectReactions(txt)) {
      counts.set(r, (counts.get(r) || 0) + reactionBoost);
    }
    // 常规词
    for (const t of extractTerms(txt)) {
      counts.set(t, (counts.get(t) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, c]) => c >= minCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([text, value]) => ({ text, value }));
}

// 节点级 mini 词云: 区间内频次, 单条弹幕也算
function buildNodeTopTerms(messages, nodes, { perNode = 6 } = {}) {
  const result = new Map();
  for (const node of nodes || []) {
    const ns = Number(node.startSec);
    const ne = Number(node.endSec);
    if (!Number.isFinite(ns) || !Number.isFinite(ne)) continue;
    const subset = (messages || []).filter((m) => {
      const t = Number(m.tSec);
      return Number.isFinite(t) && t >= ns && t < ne;
    });
    if (subset.length === 0) continue;
    const wc = buildWordCloud(subset, { topK: perNode, minCount: 1 });
    if (wc.length > 0) result.set(node.id, wc);
  }
  return result;
}

module.exports = {
  detectReactions,
  extractTerms,
  buildWordCloud,
  buildNodeTopTerms,
};
