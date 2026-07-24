// 本地 llama 调度管理器。
//
// 设计目标:对外屏蔽"单例 server / 模型切换 / inflight 跟踪 / 队列"概念,
// 业务方只需要 await manager.acquire(modelKey) 拿到一个可用的 slot 就行。
//
// 调度规则:
//  - 同 model 并发 → 共享同一 server,直接放行,inflight++
//  - 不同 model 排队 → 等当前 model 所有 inflight=0 → stop + start → 放行
//  - 未启动 server → 第一个请求触发 start
//  - signal.abort → 还在队列里就摘除并 reject;已经拿到 slot 业务自己中断
//
// 为什么不直接让业务方调 llama-runtime.start: start() 在 model 不一致时
// 会立刻 stop 当前 server, 不管别人还在用。manager 加了"等空闲"和"FIFO 队列"
// 这两个语义,业务方只要传 modelKey 进来就够。
//
// 用法:
//   const slot = await llamaManager.acquire("qwen3_5_9b_q4km", { signal });
//   try {
//     const res = await fetch(`${slot.baseUrl}/chat/completions`, {
//       headers: { authorization: `Bearer ${slot.apiKey}` },
//       body: JSON.stringify({ model: slot.model, ... }),
//     });
//   } finally {
//     slot.release();
//   }

const daemonClient = require("./daemon-client.cjs");
const log = require("./logger.cjs");

const state = {
  // queue 元素: { modelKey, resolve, reject, signal, onAbort, queuedAt }
  queue: [],
  // 当前持有 slot 的请求数 (acquire 成功未 release 的数量)
  inflight: 0,
  // worker loop 是否在跑;防重入
  processing: false,
  // 切换中的目标 model;切换期间新请求即使同 model 也要排队
  switchingTo: null,
};

// 真实的当前 model 始终从 runtime.getStatus() 读, 不在 manager 缓存,
// 这样 IPC (llama:start / llama:stop) 直接操作 runtime 也不会让 manager 失忆。
let _cachedRtStatus = null;
let _cachedRtTs = 0;

async function fetchRuntimeStatus() {
  const now = Date.now();
  if (_cachedRtStatus && now - _cachedRtTs < 500) return _cachedRtStatus;
  try {
    const rt = await daemonClient.getRuntimeStatus();
    _cachedRtStatus = rt;
    _cachedRtTs = now;
    return rt;
  } catch {
    return null;
  }
}

function getCurrentModel() {
  const rt = _cachedRtStatus;
  if (!rt) return null;
  return rt.llm?.state === "ready" ? (rt.llm.modelId || null) : null;
}

function getActiveModel() {
  return getCurrentModel();
}

function getQueueDepth() {
  return state.queue.length;
}

function getInflight() {
  return state.inflight;
}

function describeState() {
  return {
    currentModel: getCurrentModel(),
    inflight: state.inflight,
    queueDepth: state.queue.length,
    switchingTo: state.switchingTo,
    queuedModels: state.queue.map((t) => t.modelKey),
  };
}

function buildSlot(modelKey) {
  const rt = _cachedRtStatus;
  if (!rt || rt.llm?.state !== "ready" || !rt.llm?.port) {
    throw new Error(`llama-server 未就绪 (state=${rt?.llm?.state || "unknown"})`);
  }
  const contextSize = rt.llm.contextSize || 8192;
  let released = false;
  return {
    modelKey,
    model: modelKey,
    baseUrl: `http://127.0.0.1:${rt.llm.port}/v1`,
    apiKey: "local",
    contextSize,
    release() {
      if (released) return;
      released = true;
      state.inflight = Math.max(0, state.inflight - 1);
      schedule();
    },
  };
}

function schedule() {
  if (state.processing) return;
  state.processing = true;
  // 用 microtask 切到独立 stack, 避免 acquire→schedule 递归
  Promise.resolve()
    .then(processQueue)
    .catch((err) => {
      log.error("llama-manager", "processQueue 异常:", err);
    })
    .finally(() => {
      state.processing = false;
      // 处理过程中可能又有 release 进来, 再扫一遍
      if (state.queue.length > 0 && state.inflight === 0 && !state.switchingTo) {
        schedule();
      }
    });
}

async function processQueue() {
  while (state.queue.length > 0) {
    const head = state.queue[0];
    await fetchRuntimeStatus();
    const currentModel = getCurrentModel();
    const sameModel = currentModel === head.modelKey;

    if (sameModel && !state.switchingTo) {
      state.queue.shift();
      detachAbort(head);
      state.inflight += 1;
      try {
        head.resolve(buildSlot(head.modelKey));
      } catch (err) {
        state.inflight = Math.max(0, state.inflight - 1);
        state.queue.unshift(head);
      }
      continue;
    }

    if (state.inflight > 0) return;
    if (state.switchingTo) return;

    const targetModel = head.modelKey;
    state.switchingTo = targetModel;
    try {
      log.info("llama-manager",
        `切换 ${currentModel || "(空)"} → ${targetModel} (queue=${state.queue.length})`,
      );
      const result = await daemonClient.startLLM(targetModel);
      _cachedRtStatus = null;
      await fetchRuntimeStatus();
      log.info("llama-manager",
        `切换完成 model=${targetModel} port=${result.port} ctx=${result.contextSize}`,
      );
    } catch (err) {
      log.error("llama-manager", `切换 ${targetModel} 失败:`, err?.message || err);
      for (let i = state.queue.length - 1; i >= 0; i--) {
        if (state.queue[i].modelKey === targetModel) {
          const t = state.queue.splice(i, 1)[0];
          detachAbort(t);
          t.reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
    } finally {
      state.switchingTo = null;
    }
  }
}

function detachAbort(task) {
  if (task.signal && task.onAbort) {
    try {
      task.signal.removeEventListener("abort", task.onAbort);
    } catch {
      /* ignore */
    }
  }
}

/**
 * 申请一个本地推理 slot。同 model 并发会共享 server;不同 model 会排队等空闲后切换。
 *
 * @param {string} modelKey - manifest 里的 model key (例如 "qwen3_5_9b_q4km")
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal] - 队列等待期间响应 abort;已 resolve 后由调用方自己管理
 * @returns {Promise<{ modelKey, model, baseUrl, apiKey, contextSize, release }>}
 */
function acquire(modelKey, opts = {}) {
  const { signal } = opts;
  if (!modelKey || typeof modelKey !== "string") {
    return Promise.reject(new Error("acquire 需要 modelKey 字符串"));
  }
  // daemon 管理模型列表，不在本地校验 modelKey
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("acquire 被取消"));
      return;
    }
    const task = { modelKey, resolve, reject, signal, queuedAt: Date.now(), onAbort: null };
    if (signal) {
      task.onAbort = () => {
        const idx = state.queue.indexOf(task);
        if (idx >= 0) {
          state.queue.splice(idx, 1);
          reject(new Error("acquire 被取消"));
        }
        // 已经 resolve 出 slot 的话, 调用方自己负责中断 fetch + release
      };
      signal.addEventListener("abort", task.onAbort);
    }
    state.queue.push(task);
    schedule();
  });
}

/**
 * Convenience wrapper: 自动 acquire / release。
 * 业务里大多数地方应该用这个, 避免漏 release。
 */
async function withModel(modelKey, fn, opts = {}) {
  const slot = await acquire(modelKey, opts);
  try {
    return await fn(slot);
  } finally {
    slot.release();
  }
}

/** 应用退出前调一次, 主动释放 server。 */
async function shutdown() {
  // 拒掉队列里所有等待的 task
  for (const t of state.queue.splice(0)) {
    detachAbort(t);
    t.reject(new Error("llama-manager shutdown"));
  }
  state.switchingTo = null;
  try {
    await daemonClient.stopLLM();
  } catch (err) {
    log.warn("llama-manager", "shutdown stop 失败:", err?.message || err);
  }
}

module.exports = {
  acquire,
  withModel,
  getActiveModel,
  getQueueDepth,
  getInflight,
  describeState,
  shutdown,
};
