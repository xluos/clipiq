#!/usr/bin/env node
// 本地 llama-server 探测脚本: 3 模型 × 3 stage × 多个 max_tokens 档
//
// 用法:
//   node scripts/probe-llama.cjs                         # 默认全跑
//   node scripts/probe-llama.cjs --models 0.8b           # 只跑 0.8B (快速 smoke)
//   node scripts/probe-llama.cjs --stages shot-merger    # 只跑 shot-merger
//   node scripts/probe-llama.cjs --reuse-port 60537      # 0.8B 复用用户当前 server
//
// 输出: scripts/probe/reports/probe-{timestamp}.{json,md}

const fs = require("node:fs");
const path = require("node:path");
const {
  listKeyframes, imageFileToDataUrl,
  makeShotMergerFixture, buildShotMergerPrompt, SHOT_MERGER_SCHEMA,
  buildPrefilterPrompt, PREFILTER_SCHEMA,
  buildChunkPassPrompt,
} = require("./probe/fixtures.cjs");
const { spawnLlamaServer, wrapExistingServer, MODELS } = require("./probe/server.cjs");
const { runCase } = require("./probe/runner.cjs");

const ALL_MODEL_KEYS = ["qwen3_5_0_8b_q4km", "qwen3_5_4b_q4km", "qwen3_5_9b_q4km"];
const LABEL_TO_KEY = { "0.8b": "qwen3_5_0_8b_q4km", "4b": "qwen3_5_4b_q4km", "9b": "qwen3_5_9b_q4km" };

const ALL_STAGES = ["shot-merger", "prefilter", "chunk-pass"];

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { models: null, stages: null, reusePort: null, replicates: 2 };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--models") out.models = args[++i].split(",").map((s) => s.trim().toLowerCase());
    else if (a === "--stages") out.stages = args[++i].split(",").map((s) => s.trim());
    else if (a === "--reuse-port") out.reusePort = Number(args[++i]);
    else if (a === "--replicates") out.replicates = Number(args[++i]);
  }
  return out;
}

function resolveModels(modelArgs) {
  if (!modelArgs) return ALL_MODEL_KEYS;
  const keys = [];
  for (const m of modelArgs) {
    if (LABEL_TO_KEY[m]) keys.push(LABEL_TO_KEY[m]);
    else if (ALL_MODEL_KEYS.includes(m)) keys.push(m);
    else throw new Error(`unknown model: ${m} (allowed: 0.8b/4b/9b 或 ${ALL_MODEL_KEYS.join("/")})`);
  }
  return keys;
}

function fmt(n, d = 1) { return n == null ? "-" : (typeof n === "number" ? n.toFixed(d) : String(n)); }

// ---------- 各 stage 的探测计划 ----------
// 每个 stage 用一个数组定义 cases, 每 case 给 prompt + maxTokens
function buildShotMergerCases() {
  // batch=3 / 6 / 12 三个挡位, 每挡几个 maxTokens
  // 单 shot 输出约 60-100 token (含 JSON wrap), 推算预算:
  //   batch=3:  expected ≈ 250 tok, budget 试 200 / 500 / 1000 / 2000
  //   batch=6:  expected ≈ 500 tok, budget 试 400 / 800 / 1500 / 3000
  //   batch=12: expected ≈ 1000 tok, budget 试 800 / 1500 / 3000 / 6000
  const plans = [
    { batch: 3, maxTokens: [200, 500, 1000, 2000] },
    { batch: 6, maxTokens: [400, 800, 1500, 3000] },
    { batch: 12, maxTokens: [800, 1500, 3000, 6000] },
  ];
  const cases = [];
  for (const p of plans) {
    const shots = makeShotMergerFixture(p.batch);
    const prompt = buildShotMergerPrompt(shots);
    for (const mt of p.maxTokens) {
      cases.push({
        label: `batch=${p.batch} maxTok=${mt}`,
        batch: p.batch,
        maxTokens: mt,
        prompt: { system: prompt.system, user: prompt.user },
        responseFormat: { type: "json_schema", json_schema: { name: "shot_merger", strict: true, schema: SHOT_MERGER_SCHEMA } },
      });
    }
  }
  return cases;
}

function buildPrefilterCases() {
  // prefilter 单帧调用, 主代码写死 max_tokens=280. 这里探: 140 / 280 / 560
  // 看 thinking 关掉后是不是 280 已经够 + 更大 budget 是否影响延迟
  const keyframes = listKeyframes();
  if (keyframes.length === 0) throw new Error("没有 keyframe 做 prefilter fixture");
  // 取 2 张差异较大的图 (开头 + 中间)
  const sample = [keyframes[0], keyframes[Math.floor(keyframes.length / 2)]];
  const cases = [];
  for (const imgPath of sample) {
    const dataUrl = imageFileToDataUrl(imgPath);
    const prompt = buildPrefilterPrompt(dataUrl);
    for (const mt of [140, 280, 560]) {
      cases.push({
        label: `${path.basename(imgPath)} maxTok=${mt}`,
        maxTokens: mt,
        prompt: { system: prompt.system, userContent: prompt.userContent },
        responseFormat: { type: "json_schema", json_schema: { name: "prefilter_tag", strict: true, schema: PREFILTER_SCHEMA } },
      });
    }
  }
  return cases;
}

function buildChunkPassCases() {
  // 主分析 chunk-pass: vision + text. 模拟 numFrames=4/8/12 的 chunk
  // 单 chunk 输出 nodes 数依赖 shots 数, ~3-12 个 node × 200-400 token/node
  // budget: 1500 / 3000 / 6000 / 12000
  const keyframes = listKeyframes();
  const plans = [
    { numFrames: 4, numShots: 4, numTranscriptSegs: 3, maxTokens: [1500, 3000, 6000] },
    { numFrames: 8, numShots: 6, numTranscriptSegs: 5, maxTokens: [3000, 6000, 12000] },
  ];
  const cases = [];
  for (const p of plans) {
    const imgs = keyframes.slice(0, p.numFrames).map(imageFileToDataUrl);
    const { systemText, userText } = buildChunkPassPrompt(p.numFrames, p.numShots, p.numTranscriptSegs);
    for (const mt of p.maxTokens) {
      cases.push({
        label: `frames=${p.numFrames} shots=${p.numShots} maxTok=${mt}`,
        maxTokens: mt,
        prompt: { systemText, userText, imageDataUrls: imgs },
        // chunk-pass 不强 schema, 自由 JSON 输出 (跟主代码一致)
        responseFormat: null,
      });
    }
  }
  return cases;
}

const STAGE_BUILDERS = {
  "shot-merger": buildShotMergerCases,
  "prefilter": buildPrefilterCases,
  "chunk-pass": buildChunkPassCases,
};

async function probeOneStage({ srv, stage, replicates }) {
  const cases = STAGE_BUILDERS[stage]();
  console.log(`\n  [${stage}] 共 ${cases.length} cases × ${replicates} reps`);
  const results = [];
  for (const c of cases) {
    process.stdout.write(`    · ${c.label} ... `);
    const t0 = Date.now();
    try {
      const r = await runCase({
        baseUrl: srv.baseUrl,
        model: srv.modelKey,
        label: c.label,
        prompt: c.prompt,
        maxTokens: c.maxTokens,
        responseFormat: c.responseFormat,
        replicates,
      });
      const flag = r.allJsonValid ? "✓" : (r.anyTruncated ? "✗truncated" : "✗invalid");
      console.log(`${flag} median=${(r.median.totalMs / 1000).toFixed(1)}s tps=${r.median.tokensPerSec || "?"} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      results.push({ stage, ...r });
    } catch (err) {
      console.log(`✗ error: ${err.message?.slice(0, 200)}`);
      results.push({ stage, label: c.label, maxTokens: c.maxTokens, error: err.message });
    }
  }
  return results;
}

function renderMarkdown(allResults, runMeta) {
  const lines = [];
  lines.push(`# 本地 LLM 探测报告`);
  lines.push("");
  lines.push(`生成时间: ${runMeta.startedAt}`);
  lines.push(`总耗时: ${(runMeta.totalMs / 1000).toFixed(1)}s`);
  lines.push(`Replicates 每 case: ${runMeta.replicates}`);
  lines.push("");

  for (const block of allResults) {
    lines.push(`## ${block.serverLabel} (${block.modelKey}, ctx=${block.ctxSize || "?"})`);
    lines.push("");
    lines.push(`Server 加载耗时: ${block.serverLoadMs == null ? "(reuse)" : (block.serverLoadMs / 1000).toFixed(1) + "s"}`);
    lines.push("");

    // group by stage
    const byStage = new Map();
    for (const r of block.results) {
      if (!byStage.has(r.stage)) byStage.set(r.stage, []);
      byStage.get(r.stage).push(r);
    }

    for (const [stage, rows] of byStage) {
      lines.push(`### Stage: ${stage}`);
      lines.push("");
      lines.push("| case | maxTok | total(s) | first(ms) | gen(ms) | promptTok | completionTok | TPS | JSON | finish |");
      lines.push("|------|--------|----------|-----------|---------|-----------|---------------|-----|------|--------|");
      for (const r of rows) {
        if (r.error) {
          lines.push(`| ${r.label} | ${r.maxTokens} | error | - | - | - | - | - | - | ${r.error.slice(0, 50)} |`);
          continue;
        }
        const m = r.median;
        const jsonStatus = r.allJsonValid ? "✓" : "✗";
        lines.push(`| ${r.label.replace(/\|/g, "\\|")} | ${m.maxTokens || r.maxTokens} | ${(m.totalMs / 1000).toFixed(2)} | ${fmt(m.firstTokenMs, 0)} | ${fmt(m.generationMs, 0)} | ${fmt(m.promptTokens, 0)} | ${fmt(m.completionTokens, 0)} | ${m.tokensPerSec || "-"} | ${jsonStatus} | ${m.finishReason || "-"} |`);
      }
      lines.push("");
    }
  }

  lines.push(`---`);
  lines.push(`## 合理 max_tokens 推荐`);
  lines.push(``);
  lines.push("推荐策略: 取**最小**满足 JSON valid + finish≠length 的 maxTokens 档,再加 ~30% 缓冲。每个 stage 的 completionTokens (中位) 已能体现真实需要。");
  lines.push("");
  for (const block of allResults) {
    lines.push(`### ${block.serverLabel}`);
    const byStage = new Map();
    for (const r of block.results) {
      if (r.error) continue;
      if (!byStage.has(r.stage)) byStage.set(r.stage, []);
      byStage.get(r.stage).push(r);
    }
    for (const [stage, rows] of byStage) {
      // 找每个 case 配置组下: 第一个 jsonValid + 不 truncated 的 maxTokens
      // chunk-pass / shot-merger 按 batch/frames group; prefilter 按 image
      const groups = new Map();
      for (const r of rows) {
        const key = r.label.replace(/maxTok=\d+/, "").trim();
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
      }
      for (const [groupKey, gRows] of groups) {
        const sorted = gRows.sort((a, b) => (a.median?.maxTokens || a.maxTokens) - (b.median?.maxTokens || b.maxTokens));
        const ok = sorted.find((r) => r.allJsonValid && !r.anyTruncated);
        const completionMedian = ok?.median?.completionTokens;
        if (ok) {
          const recommend = Math.ceil((completionMedian || ok.maxTokens) * 1.3 / 100) * 100;
          lines.push(`- **${stage}** ${groupKey}: 实际 completion ≈ ${completionMedian} tok, 推荐 max_tokens **${recommend}** (首个达标档 ${ok.maxTokens})`);
        } else {
          lines.push(`- **${stage}** ${groupKey}: 全档都失败 / 截断, 需要更大 budget 或更强模型`);
        }
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

async function main() {
  const opts = parseArgs();
  const stages = opts.stages || ALL_STAGES;
  const modelKeys = resolveModels(opts.models);
  console.log(`[probe] models = ${modelKeys.join(", ")}`);
  console.log(`[probe] stages = ${stages.join(", ")}`);
  console.log(`[probe] replicates = ${opts.replicates}`);

  const tStart = Date.now();
  const allResults = [];

  for (const modelKey of modelKeys) {
    let srv;
    const isReuse = opts.reusePort && modelKey === "qwen3_5_0_8b_q4km";
    if (isReuse) {
      srv = wrapExistingServer({ port: opts.reusePort, modelKey, label: `${MODELS[modelKey].label} (reuse:${opts.reusePort})` });
      // 拉一下 /props 确定 ctx
      try {
        const props = await fetch(`http://127.0.0.1:${opts.reusePort}/props`).then((r) => r.json());
        srv.ctxSize = props?.default_generation_settings?.n_ctx || null;
      } catch { /* ignore */ }
    } else {
      try {
        srv = await spawnLlamaServer({ modelKey });
      } catch (err) {
        console.error(`[probe] ${modelKey} 启动失败: ${err.message}`);
        allResults.push({
          serverLabel: MODELS[modelKey].label,
          modelKey, ctxSize: null, serverLoadMs: null,
          results: [{ error: `server 启动失败: ${err.message}` }],
        });
        continue;
      }
    }

    const blockResults = [];
    for (const stage of stages) {
      try {
        const rs = await probeOneStage({ srv, stage, replicates: opts.replicates });
        blockResults.push(...rs);
      } catch (err) {
        console.error(`  [${stage}] error: ${err.message}`);
        blockResults.push({ stage, error: err.message });
      }
    }
    allResults.push({
      serverLabel: srv.label,
      modelKey: srv.modelKey,
      ctxSize: srv.ctxSize,
      serverLoadMs: isReuse ? null : srv.loadMs,
      results: blockResults,
    });

    await srv.kill();
  }

  const runMeta = {
    startedAt: new Date(tStart).toISOString(),
    totalMs: Date.now() - tStart,
    replicates: opts.replicates,
  };

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const reportsDir = path.join(__dirname, "probe/reports");
  fs.mkdirSync(reportsDir, { recursive: true });
  const jsonPath = path.join(reportsDir, `probe-${ts}.json`);
  const mdPath = path.join(reportsDir, `probe-${ts}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify({ meta: runMeta, results: allResults }, null, 2));
  fs.writeFileSync(mdPath, renderMarkdown(allResults, runMeta));
  console.log(`\n[probe] 完成. 总耗时 ${(runMeta.totalMs / 1000).toFixed(1)}s`);
  console.log(`[probe] JSON: ${jsonPath}`);
  console.log(`[probe] Markdown: ${mdPath}`);
}

main().catch((err) => {
  console.error("[probe] fatal:", err);
  process.exit(1);
});
