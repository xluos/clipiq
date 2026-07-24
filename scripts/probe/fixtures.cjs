// 探测用 fixture: 合成 shot-merger / prefilter / chunk-pass 的 representative input
//
// 设计原则: 输入长度可控 + 内容真实感够 (用现成 keyframe 文件 + 真实风格的 caption/subtitle)
// 不依赖 electron 任何 module, 直接可独立 require

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const KEYFRAME_DIR = path.join(
  os.homedir(),
  "Library/Application Support/clipiq/projects/proj-url-1778642640979/artifacts",
);

function listKeyframes() {
  if (!fs.existsSync(KEYFRAME_DIR)) {
    throw new Error(`fixture keyframe 目录不存在: ${KEYFRAME_DIR}`);
  }
  return fs
    .readdirSync(KEYFRAME_DIR)
    .filter((f) => /^keyframe-\d+\.jpg$/.test(f))
    .sort()
    .map((f) => path.join(KEYFRAME_DIR, f));
}

function imageFileToDataUrl(filePath) {
  const buf = fs.readFileSync(filePath);
  return `data:image/jpeg;base64,${buf.toString("base64")}`;
}

// ---------- shot-merger fixture ----------
// 真实风格: 每个 shot 时长 2-6s, 1-3 帧, 字幕长度 0/短/中/长 均匀, caption 24-60 字
const SUBTITLE_POOL = [
  "",
  "走在山间的小路上",
  "今天我们要去看一个非常特别的地方",
  "你看这里的风景真的太美了,空气也很清新,完全是一种远离城市喧嚣的感觉",
  "镜头切到餐桌",
  "其实这家店开了有十多年了,每天来打卡的人都排着长队",
  "",
  "继续往前走",
  "前面就是悬崖的边缘,大家小心一点,千万不要太靠近",
  "我们在这里休息一下,顺便补充点能量",
];

const CAPTION_POOL = [
  "山间小路两侧绿树成荫 远景",
  "餐桌上摆满各色点心和咖啡 俯拍",
  "女生背包走向远方 侧面跟拍",
  "海边礁石上海浪拍打 近景慢动作",
  "城市夜景灯火璀璨 高空俯拍",
  "厨师在灶台前翻炒 特写镜头",
  "情侣在长椅上谈笑 中景",
  "孩子蹲在地上看蚂蚁 低角度",
  "雨水打在窗户玻璃上 微距特写",
  "演讲者站在讲台上手势激昂 中景",
  "猫咪伸懒腰打哈欠 近景",
  "傍晚的天空云霞流动 延时",
  "古城墙脚下行人来往 大远景",
  "市集摊位上摆满各种水果 平视",
  "桌上摊开的笔记本电脑屏幕亮着 俯拍特写",
];

function makeShotMergerFixture(batchSize) {
  const shots = [];
  for (let i = 0; i < batchSize; i++) {
    const startSec = i * 4.2;
    const endSec = startSec + 2 + (i % 4);
    const frameCount = 1 + (i % 3);
    const frames = [];
    for (let j = 0; j < frameCount; j++) {
      const midSec = startSec + ((j + 1) / (frameCount + 1)) * (endSec - startSec);
      frames.push({
        midSec,
        caption: CAPTION_POOL[(i * 3 + j) % CAPTION_POOL.length],
        salience: 5 + (j % 4),
        signature: CAPTION_POOL[(i * 3 + j) % CAPTION_POOL.length].split(" ")[0],
        subject: "未识别",
      });
    }
    shots.push({
      startSec,
      endSec,
      subtitleText: SUBTITLE_POOL[i % SUBTITLE_POOL.length],
      frames,
    });
  }
  return shots;
}

function formatShotForPrompt(shot, indexInBatch) {
  const lines = [];
  lines.push(`SHOT ${indexInBatch} [${shot.startSec.toFixed(1)}s - ${shot.endSec.toFixed(1)}s]`);
  lines.push(shot.subtitleText && shot.subtitleText.trim() ? `字幕: ${shot.subtitleText.trim()}` : "字幕: (无)");
  if (Array.isArray(shot.frames) && shot.frames.length > 0) {
    lines.push("画面 (按时间序):");
    shot.frames.forEach((f, i) => {
      const cap = f.caption?.trim() || `${f.subject || "未识别"} · ${f.signature || ""}`.trim();
      const sal = typeof f.salience === "number" ? ` salience=${f.salience}` : "";
      lines.push(`  [F${i}] @${f.midSec.toFixed(1)}s${sal}: ${cap}`);
    });
  } else {
    lines.push("画面: (该镜头无抽帧)");
  }
  return lines.join("\n");
}

function buildShotMergerPrompt(shots) {
  const system =
    "你是视频拉片助理。我会给你一段视频里的若干个镜头, 每个镜头包含: 时间范围 / 字幕 / 镜头内若干帧的画面描述。" +
    "你的任务是为每个镜头生成一段更高层次的'镜头内容描述', 并挑出代表帧。\n\n" +
    "规则:\n" +
    "- shotDescription: 30-80 汉字一段话, 综合画面 + 字幕信息, 说出'镜头里在做什么 / 在讲什么 / 情绪或氛围'。\n" +
    "- shotDescription 不要罗列帧, 要写出一个整体观察。\n" +
    "- representativeFrameIndex: 从该镜头的 F0/F1/... 中挑出 1-3 个最能代表镜头的帧 index (按信息量, 不超过镜头实有帧数)。\n" +
    "- 直接输出严格 JSON, 不要思考过程, 不要 markdown 围栏。";

  const userBlocks = shots.map((shot, i) => formatShotForPrompt(shot, i));
  const user =
    "请为下列 " + shots.length + " 个镜头各自生成描述和代表帧。注意 shotIndex 必须跟下面列出的顺序对应 (0, 1, 2, ...)。\n\n" +
    userBlocks.join("\n\n") +
    "\n\n请输出 JSON: { \"shots\": [{ \"shotIndex\": 0, \"shotDescription\": \"...\", \"representativeFrameIndex\": [0] }, ...] }";

  return { system, user };
}

const SHOT_MERGER_SCHEMA = {
  type: "object",
  properties: {
    shots: {
      type: "array",
      items: {
        type: "object",
        properties: {
          shotIndex: { type: "integer", minimum: 0 },
          shotDescription: { type: "string", maxLength: 240 },
          representativeFrameIndex: { type: "array", items: { type: "integer", minimum: 0 }, maxItems: 3 },
        },
        required: ["shotIndex", "shotDescription", "representativeFrameIndex"],
        additionalProperties: false,
      },
    },
  },
  required: ["shots"],
  additionalProperties: false,
};

// ---------- prefilter fixture ----------
const PREFILTER_SCHEMA = {
  type: "object",
  properties: {
    sceneType: { type: "string", enum: ["interior", "exterior", "closeup", "establishing", "transition", "graphic", "other"] },
    subject: { type: "string", maxLength: 24 },
    hasText: { type: "string", enum: ["none", "chinese", "english", "mixed"] },
    salience: { type: "integer", minimum: 0, maximum: 10 },
    isEmpty: { type: "boolean" },
    signature: { type: "string", maxLength: 24 },
    caption: { type: "string", maxLength: 90 },
  },
  required: ["sceneType", "subject", "hasText", "salience", "isEmpty", "signature", "caption"],
  additionalProperties: false,
};

const PREFILTER_SYSTEM_PROMPT =
  "你是视频画面的打标器,直接输出严格 JSON。字段定义:\n" +
  "- sceneType: 镜头类型枚举\n" +
  "- subject: 画面里看到的主体,≤8 汉字\n" +
  "- hasText: 是否有可读文字(标题卡/字幕/招牌)\n" +
  "- salience: 信息量打分 0-10\n" +
  "- isEmpty: 仅当画面是纯黑屏/纯白屏时填 true\n" +
  "- signature: 3-5 个汉字精炼概括(用主体+地点)\n" +
  "- caption: 一句话描述这张画面(≤30 汉字)\n" +
  "不要思考过程,直接输出 JSON。";

const PREFILTER_USER_TEXT = "看这张视频帧,按上面规则输出 JSON。";

function buildPrefilterPrompt(imageDataUrl) {
  return {
    system: PREFILTER_SYSTEM_PROMPT,
    userContent: [
      { type: "image_url", image_url: { url: imageDataUrl } },
      { type: "text", text: PREFILTER_USER_TEXT },
    ],
  };
}

// ---------- chunk-pass fixture ----------
// 模拟一个真实 chunk: N 张帧 + transcript 段 + shot 上下文
function buildChunkPassPrompt(numFrames, numShots, numTranscriptSegs) {
  const startSec = 12.0;
  const endSec = startSec + numFrames * 3.5;
  const globalSummary =
    "本片讲述一名年轻博主前往云南山区记录当地手工艺人传承的故事。镜头跟随主角从城市出发, 穿越蜿蜒山路, 抵达一个保留传统造纸技艺的小村落。前半段以风光和路途为主, 中段进入手工艺人作坊, 通过近距离观察捞纸 / 晾纸 / 装裱的完整工艺, 展现传统的精巧与耐心。后半段穿插村民访谈和主角自身感悟, 收尾回到城市夜景, 形成时空对照。";

  const shotsBlock = [];
  shotsBlock.push("# 本片段镜头 (主 evidence; 已综合画面+字幕)");
  for (let i = 0; i < numShots; i++) {
    const s = startSec + i * (endSec - startSec) / numShots;
    const e = s + (endSec - startSec) / numShots;
    shotsBlock.push(`S${i + 1} [${s.toFixed(1)}-${e.toFixed(1)}s] 帧数=${Math.ceil(numFrames / numShots)}`);
    shotsBlock.push(`  画面: ${CAPTION_POOL[i % CAPTION_POOL.length]}, ${CAPTION_POOL[(i + 3) % CAPTION_POOL.length]}`);
    shotsBlock.push(`  字幕: ${SUBTITLE_POOL[(i + 2) % SUBTITLE_POOL.length] || "(无)"}`);
  }

  const framesBlock = ["# 本片段关键帧 (与下方图片顺序一一对应)"];
  for (let i = 0; i < numFrames; i++) {
    const t = startSec + i * (endSec - startSec) / numFrames;
    framesBlock.push(
      `#${i + 1}  t=${t.toFixed(1)}s  范围 ${(t - 0.5).toFixed(1)}-${(t + 0.5).toFixed(1)}s\n  画面: ${CAPTION_POOL[(i + 5) % CAPTION_POOL.length]}`,
    );
  }

  const transcriptBlock = ["# 本片段字幕 (带时间戳, 共 " + numTranscriptSegs + " 段)"];
  for (let i = 0; i < numTranscriptSegs; i++) {
    const s = startSec + i * (endSec - startSec) / numTranscriptSegs;
    const e = s + (endSec - startSec) / numTranscriptSegs * 0.8;
    const text = SUBTITLE_POOL[(i + 1) % SUBTITLE_POOL.length] || "(场景声/无人声)";
    transcriptBlock.push(`[${s.toFixed(1)}-${e.toFixed(1)}] ${text}`);
  }

  const userText = [
    `请分析视频的第 2/5 片段, 时间区间 [${startSec.toFixed(1)}, ${endSec.toFixed(1)}]s。`,
    "综合关注叙事结构、剪辑节奏、情绪曲线和画面信息。覆盖主要剪辑节点。",
    "",
    "# 整体上下文 (帮助你理解本片段在全片中的位置)",
    `视频《探访云南古法造纸村》总时长 320s (lengthBucket=medium), 画幅 1920x1080 (横屏)。`,
    "类型: 纪实 / vlog (置信度 0.78)",
    "",
    "全局摘要:",
    globalSummary,
    "",
    shotsBlock.join("\n"),
    "",
    framesBlock.join("\n"),
    "",
    transcriptBlock.join("\n"),
    "",
    "# 输出格式 (必须严格遵守)",
    "只返回 JSON (不要 markdown 围栏), 结构:",
    `{ "nodes":[ { "id":"chunk-2-node-1", "startSec":0, "endSec":3, "title":"...", "nodeTypes":["shot_change"], "shotDescription":"...", "shotType":"近景", "cameraMovement":"固定", "visualElements":[], "audioElements":[], "editIntent":"...", "emotionLabel":"...", "emotionIntensity":7, "narrativeFunction":"Hook|Setup|Development|Turn|Climax|Ending|Other", "confidence":0.9, "isHighlight":true } ] }`,
    "",
    "硬性要求:",
    `- nodes 时间戳 startSec/endSec 必须严格落在本片段 [${startSec.toFixed(1)}, ${endSec.toFixed(1)}]s 内, 不要跨段。`,
    "- nodes 按时间升序。",
    "- 不要返回 methodologyTags 字段 (后续步骤做)。",
    "- 不要返回 report 字段 (后续步骤做)。",
  ].join("\n");

  const systemText =
    "你是一名视频拉片分析师, 当前正在处理整段视频的某一片段。基于本片段的镜头描述 / 关键帧 / 字幕产出本片段的节点列表。" +
    "**只产 nodes, 不要做方法论打标 (后续步骤会单独做)**。所有回答必须是合法 JSON, 不要 markdown 围栏, 不要解释。";

  return { systemText, userText };
}

module.exports = {
  listKeyframes,
  imageFileToDataUrl,
  makeShotMergerFixture,
  buildShotMergerPrompt,
  SHOT_MERGER_SCHEMA,
  buildPrefilterPrompt,
  PREFILTER_SCHEMA,
  buildChunkPassPrompt,
};
