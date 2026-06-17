import { describe, it, expect, beforeEach } from "vitest";
import { TaskScheduler, type Task, type SchedulerEvent } from "../electron/task-queue";

// 一个手动可控的 runner:返回 promise + resolve/reject 句柄,断言并发/排队时序用。
function deferred() {
  let resolve!: (v?: unknown) => void;
  let reject!: (e?: unknown) => void;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeScheduler(opts: { onSettled?: (t: Task) => void } = {}) {
  let counter = 0;
  let clock = 1000;
  const persisted = new Map<string, Task>();
  const events: SchedulerEvent[] = [];
  const sched = new TaskScheduler({
    now: () => clock++,
    genId: () => `t${++counter}`,
    persist: (t) => persisted.set(t.id, { ...t }),
    removePersisted: (id) => persisted.delete(id),
    emit: (e) => events.push(e),
    onSettled: opts.onSettled,
  });
  return { sched, persisted, events, tick: () => clock++ };
}

describe("TaskScheduler: 按 kind 并发", () => {
  it("串行 kind(concurrency=1):同时塞 3 个,只跑 1 个,其余排队", () => {
    const { sched } = makeScheduler();
    const defs = [deferred(), deferred(), deferred()];
    let i = 0;
    sched.registerKind("serial", { concurrency: 1, run: () => defs[i++].promise });

    sched.enqueue("serial", { n: 1 });
    sched.enqueue("serial", { n: 2 });
    sched.enqueue("serial", { n: 3 });

    const running = sched.list().filter((t) => t.status === "running");
    const queued = sched.list().filter((t) => t.status === "queued");
    expect(running).toHaveLength(1);
    expect(queued).toHaveLength(2);
  });

  it("跑完一个后自动顶上下一个", async () => {
    const { sched } = makeScheduler();
    const defs = [deferred(), deferred(), deferred()];
    let i = 0;
    sched.registerKind("serial", { concurrency: 1, run: () => defs[i++].promise });

    sched.enqueue("serial", {});
    sched.enqueue("serial", {});
    defs[0].resolve();
    await defs[0].promise;
    await Promise.resolve(); // 让 .then 链跑完

    expect(sched.list().filter((t) => t.status === "running")).toHaveLength(1);
    expect(sched.list().filter((t) => t.status === "succeeded")).toHaveLength(1);
  });

  it("并行 kind(concurrency=2):3 个里同时跑 2 个", () => {
    const { sched } = makeScheduler();
    sched.registerKind("par", { concurrency: 2, run: () => deferred().promise });
    sched.enqueue("par", {});
    sched.enqueue("par", {});
    sched.enqueue("par", {});
    expect(sched.list().filter((t) => t.status === "running")).toHaveLength(2);
    expect(sched.list().filter((t) => t.status === "queued")).toHaveLength(1);
  });

  it("不限并发(Infinity):全部立即跑", () => {
    const { sched } = makeScheduler();
    sched.registerKind("dl", { concurrency: Infinity, run: () => deferred().promise });
    sched.enqueue("dl", {});
    sched.enqueue("dl", {});
    sched.enqueue("dl", {});
    expect(sched.list().filter((t) => t.status === "running")).toHaveLength(3);
  });

  it("不同 kind 各算各的并发,互不挤占", () => {
    const { sched } = makeScheduler();
    sched.registerKind("a", { concurrency: 1, run: () => deferred().promise });
    sched.registerKind("b", { concurrency: 1, run: () => deferred().promise });
    sched.enqueue("a", {});
    sched.enqueue("b", {});
    expect(sched.list().filter((t) => t.status === "running")).toHaveLength(2);
  });
});

describe("TaskScheduler: dedupe", () => {
  it("同 dedupeKey 的 queued/running 任务不重复入队,返回已存在的", () => {
    const { sched } = makeScheduler();
    sched.registerKind("serial", {
      concurrency: 1,
      run: () => deferred().promise,
      dedupeKey: (p) => `v:${p.videoId}`,
    });
    const a = sched.enqueue("serial", { videoId: "x" });
    const b = sched.enqueue("serial", { videoId: "x" });
    expect(b.id).toBe(a.id);
    expect(sched.list()).toHaveLength(1);
  });

  it("终态后同 key 可再次入队(不再算重复)", async () => {
    const { sched } = makeScheduler();
    const d = deferred();
    let used = false;
    sched.registerKind("serial", {
      concurrency: 1,
      run: () => (used ? deferred().promise : ((used = true), d.promise)),
      dedupeKey: (p) => `v:${p.videoId}`,
    });
    const a = sched.enqueue("serial", { videoId: "x" });
    d.resolve();
    await d.promise;
    await Promise.resolve();
    const b = sched.enqueue("serial", { videoId: "x" });
    expect(b.id).not.toBe(a.id);
  });
});

describe("TaskScheduler: cancel / remove", () => {
  it("取消排队中的任务 → cancelled,下一个顶上", () => {
    const { sched } = makeScheduler();
    sched.registerKind("serial", { concurrency: 1, run: () => deferred().promise });
    sched.enqueue("serial", {}); // 跑
    const q = sched.enqueue("serial", {}); // 排队
    expect(sched.cancel(q.id)).toBe(true);
    expect(sched.get(q.id)?.status).toBe("cancelled");
  });

  it("取消运行中的任务 → runner 经 signal 抛错 → cancelled", async () => {
    const { sched } = makeScheduler();
    sched.registerKind("serial", {
      concurrency: 1,
      run: (_t, ctx) =>
        new Promise((_res, rej) => {
          ctx.signal.addEventListener("abort", () => rej(new Error("aborted")));
        }),
    });
    const a = sched.enqueue("serial", {});
    sched.cancel(a.id);
    await new Promise((r) => setTimeout(r, 0));
    expect(sched.get(a.id)?.status).toBe("cancelled");
  });

  it("cancel 运行中会 SIGTERM 已登记的子进程", () => {
    const { sched } = makeScheduler();
    let killed = false;
    sched.registerKind("serial", {
      concurrency: 1,
      run: (_t, ctx) => {
        ctx.registerChild({ kill: () => (killed = true) });
        return deferred().promise;
      },
    });
    const a = sched.enqueue("serial", {});
    sched.cancel(a.id);
    expect(killed).toBe(true);
  });

  it("remove 把任务从列表和持久层都删掉,并发 removed 事件", () => {
    const { sched, persisted, events } = makeScheduler();
    sched.registerKind("serial", { concurrency: 1, run: () => deferred().promise });
    const a = sched.enqueue("serial", {});
    expect(persisted.has(a.id)).toBe(true);
    sched.remove(a.id);
    expect(sched.get(a.id)).toBeUndefined();
    expect(persisted.has(a.id)).toBe(false);
    expect(events.some((e) => e.type === "removed" && e.id === a.id)).toBe(true);
  });

  it("running 任务被 remove 后,即便 runner 之后 resolve 也不会复活", async () => {
    const { sched } = makeScheduler();
    const d = deferred();
    sched.registerKind("serial", { concurrency: 1, run: () => d.promise });
    const a = sched.enqueue("serial", {});
    sched.remove(a.id);
    d.resolve();
    await d.promise;
    await Promise.resolve();
    expect(sched.get(a.id)).toBeUndefined();
  });
});

describe("TaskScheduler: 进度", () => {
  it("onProgress 更新内存 + emit,但不落库", () => {
    const { sched, persisted, events } = makeScheduler();
    sched.registerKind("serial", {
      concurrency: 1,
      run: (_t, ctx) => {
        ctx.onProgress({ progress: 42, stage: "分析中", message: "hi" });
        return deferred().promise;
      },
    });
    const a = sched.enqueue("serial", {});
    expect(sched.get(a.id)?.progress).toBe(42);
    expect(sched.get(a.id)?.stage).toBe("分析中");
    // 持久层里仍是 running 那一版(progress 不随 tick 落库)
    expect(persisted.get(a.id)?.progress).toBe(0);
    expect(events.some((e) => e.type === "task" && e.task.progress === 42)).toBe(true);
  });
});

describe("TaskScheduler: 终态展示", () => {
  it("成功时 stage 收口为完成,不保留运行中", async () => {
    const { sched } = makeScheduler();
    const d = deferred();
    sched.registerKind("serial", {
      concurrency: 1,
      run: (_t, ctx) => {
        ctx.onProgress({ progress: 80, stage: "运行中", message: "处理中" });
        return d.promise;
      },
    });
    const a = sched.enqueue("serial", {});
    d.resolve("ok");
    await d.promise;
    await Promise.resolve();
    expect(sched.get(a.id)?.status).toBe("succeeded");
    expect(sched.get(a.id)?.progress).toBe(100);
    expect(sched.get(a.id)?.stage).toBe("完成");
    expect(sched.get(a.id)?.message).toBe("");
  });

  it("失败时 stage/message/error 收口为失败信息", async () => {
    const { sched } = makeScheduler();
    const d = deferred();
    sched.registerKind("serial", { concurrency: 1, run: () => d.promise });
    const a = sched.enqueue("serial", {});
    d.reject(new Error("模型挂了"));
    await expect(d.promise).rejects.toThrow("模型挂了");
    await Promise.resolve();
    expect(sched.get(a.id)?.status).toBe("failed");
    expect(sched.get(a.id)?.stage).toBe("失败");
    expect(sched.get(a.id)?.message).toBe("模型挂了");
    expect(sched.get(a.id)?.error).toBe("模型挂了");
  });

  it("排队取消时 stage 收口为已取消", () => {
    const { sched } = makeScheduler();
    sched.registerKind("serial", { concurrency: 1, run: () => deferred().promise });
    sched.enqueue("serial", {});
    const q = sched.enqueue("serial", {});
    sched.cancel(q.id);
    expect(sched.get(q.id)?.status).toBe("cancelled");
    expect(sched.get(q.id)?.stage).toBe("已取消");
  });
});

describe("TaskScheduler: whenSettled(接回 await 完成的 IPC 语义)", () => {
  it("成功 → resolve runner 返回值", async () => {
    const { sched } = makeScheduler();
    const d = deferred();
    sched.registerKind("serial", { concurrency: 1, run: () => d.promise });
    const a = sched.enqueue("serial", {});
    const settled = sched.whenSettled(a.id);
    d.resolve({ id: "analysis-1", result: { nodes: [1] } });
    await expect(settled).resolves.toEqual({ id: "analysis-1", result: { nodes: [1] } });
  });

  it("失败 → reject 带 error message", async () => {
    const { sched } = makeScheduler();
    const d = deferred();
    sched.registerKind("serial", { concurrency: 1, run: () => d.promise });
    const a = sched.enqueue("serial", {});
    const settled = sched.whenSettled(a.id);
    d.reject(new Error("模型挂了"));
    await expect(settled).rejects.toThrow("模型挂了");
  });

  it("排队中的任务被取消 → whenSettled reject", async () => {
    const { sched } = makeScheduler();
    sched.registerKind("serial", { concurrency: 1, run: () => deferred().promise });
    sched.enqueue("serial", {}); // 占用
    const q = sched.enqueue("serial", {}); // 排队
    const settled = sched.whenSettled(q.id);
    sched.cancel(q.id);
    await expect(settled).rejects.toThrow("已取消");
  });

  it("多个 whenSettled 共享同一 settle(dedupe 命中时多方 await)", async () => {
    const { sched } = makeScheduler();
    const d = deferred();
    sched.registerKind("serial", { concurrency: 1, run: () => d.promise, dedupeKey: (p) => `v:${p.v}` });
    const a = sched.enqueue("serial", { v: 1 });
    const b = sched.enqueue("serial", { v: 1 }); // dedupe → 同一 task
    expect(b.id).toBe(a.id);
    const p1 = sched.whenSettled(a.id);
    const p2 = sched.whenSettled(b.id);
    d.resolve("ok");
    await expect(Promise.all([p1, p2])).resolves.toEqual(["ok", "ok"]);
  });
});

describe("TaskScheduler: 重启恢复(hydrate)", () => {
  let rows: Task[];
  beforeEach(() => {
    rows = [
      mkRow("r1", "serial", "running"),
      mkRow("r2", "serial", "queued"),
      mkRow("r3", "serial", "succeeded"),
    ];
  });

  it("running → interrupted;queued 重新调度起跑;终态保持不动", () => {
    const { sched } = makeScheduler();
    sched.registerKind("serial", { concurrency: 1, run: () => deferred().promise });
    sched.hydrate(rows);
    expect(sched.get("r1")?.status).toBe("interrupted");
    expect(sched.get("r1")?.stage).toBe("已中断");
    expect(sched.get("r2")?.status).toBe("running"); // 被重新调度起跑
    expect(sched.get("r3")?.status).toBe("succeeded");
  });
});

function mkRow(id: string, kind: string, status: Task["status"]): Task {
  return {
    id,
    kind,
    status,
    title: id,
    payload: {},
    refId: null,
    dedupeKey: null,
    progress: status === "succeeded" ? 100 : 0,
    stage: "",
    message: "",
    error: null,
    createdAt: 1,
    startedAt: status === "queued" ? null : 2,
    finishedAt: status === "succeeded" ? 3 : null,
  };
}
