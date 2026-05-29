// 通用后台任务调度器(main 进程)。
//
// 设计目标:把"正在跑/注册过"的后台工作统一成 task,按 kind 配置并发(有的串行排队、
// 有的并行),脱离前端页面状态。以后加新的后台能力 = registerKind 注册一个 runner,
// 不碰调度器本身。
//
// 本模块是纯逻辑 + 依赖注入(now / genId / persist / emit),不 import electron,
// 便于单测。真正的落库、IPC 广播、与 analyzeProject 的桥接都在 main.cjs 里注入。
//
// 状态机:queued → running → (succeeded | failed | cancelled);重启时 running → interrupted。
// 进度只更新内存 + emit,不落库(重启只需恢复 queued/running 这种"待办"语义,进度无需持久)。

export type TaskStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface Task {
  id: string;
  kind: string;
  status: TaskStatus;
  title: string;
  /** kind 专属参数,JSON 落库。如 { videoId, pipelineId, slotOverrides } */
  payload: Record<string, unknown>;
  /** 关联的领域实体 id(analysisId / videoId / accountId / modelKey),用于 UI 跳转 + 进度关联 */
  refId: string | null;
  /** 幂等键:同 key 的 queued/running 任务只保留一个,防重复入队 */
  dedupeKey: string | null;
  progress: number;
  stage: string;
  message: string;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface TaskProgress {
  progress?: number;
  stage?: string;
  message?: string;
}

/** 可被 SIGTERM 杀掉的子进程(ffmpeg / yt-dlp 等) */
export interface KillableChild {
  kill: (signal?: string) => void;
}

export interface RunnerContext {
  task: Task;
  /** runner 应监听它,被 cancel 时抛错退出 */
  signal: AbortSignal;
  /** runner 上报进度;任务非 running 时静默丢弃 */
  onProgress: (p: TaskProgress) => void;
  /** 登记衍生子进程,cancel 时统一 SIGTERM */
  registerChild: (child: KillableChild) => void;
}

export interface KindDef {
  /** 1 = 串行(其余排队);N = 至多 N 并行;Infinity = 不限 */
  concurrency: number;
  run: (task: Task, ctx: RunnerContext) => Promise<unknown>;
  /** 由 payload 派生展示标题 */
  title?: (payload: Record<string, unknown>) => string;
  /** 由 payload 派生幂等键;返回空表示不去重 */
  dedupeKey?: (payload: Record<string, unknown>) => string | null | undefined;
}

export type SchedulerEvent =
  | { type: "task"; task: Task } // 新增 / 状态变 / 进度
  | { type: "removed"; id: string };

export interface SchedulerDeps {
  now: () => number;
  genId: () => string;
  /** upsert 单条 task 到持久层(仅状态迁移时调用,进度不落库) */
  persist: (task: Task) => void;
  removePersisted: (id: string) => void;
  /** 通知 renderer(main 里桥接成 broadcastToWindows) */
  emit: (event: SchedulerEvent) => void;
  /** 可选:每个 kind 跑完一条后的钩子(测试 / 埋点用) */
  onSettled?: (task: Task) => void;
}

export interface EnqueueOptions {
  title?: string;
  refId?: string | null;
  dedupeKey?: string | null;
}

const ACTIVE: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["queued", "running"]);

interface Settler {
  promise: Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

export class TaskScheduler {
  private kinds = new Map<string, KindDef>();
  private tasks = new Map<string, Task>();
  private controllers = new Map<string, AbortController>();
  private children = new Map<string, Set<KillableChild>>();
  // 完成待:让 IPC handler 能 await 某个 task 跑完拿到 runner 返回值(analysis:start 用)
  private settlers = new Map<string, Settler>();
  private results = new Map<string, unknown>();

  constructor(private deps: SchedulerDeps) {}

  /**
   * 返回一个在该 task 进入终态时 settle 的 promise:succeeded → resolve(runner 返回值),
   * failed → reject(error),cancelled/interrupted → reject。已是终态则立即 settle。
   * 用于把"队列化 + await 完成"接回原本同步 await analyzeProject 的 IPC 语义。
   */
  whenSettled(id: string): Promise<unknown> {
    const task = this.tasks.get(id);
    if (!task) return Promise.reject(new Error(`task ${id} not found`));
    if (task.status === "succeeded") return Promise.resolve(this.results.get(id));
    if (task.status === "failed") return Promise.reject(new Error(task.error || "任务失败"));
    if (task.status === "cancelled") return Promise.reject(new Error("任务已取消"));
    if (task.status === "interrupted") return Promise.reject(new Error("任务被中断"));
    let s = this.settlers.get(id);
    if (!s) {
      let resolve!: (v: unknown) => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise<unknown>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      s = { promise, resolve, reject };
      this.settlers.set(id, s);
    }
    return s.promise;
  }

  registerKind(kind: string, def: KindDef): void {
    this.kinds.set(kind, { concurrency: 1, ...def });
  }

  hasKind(kind: string): boolean {
    return this.kinds.has(kind);
  }

  /** 启动时用持久化的 task 行重建内存状态:running → interrupted,queued 保留并重新调度 */
  hydrate(rows: Task[]): void {
    for (const row of rows) {
      const task: Task = { ...row };
      if (task.status === "running") {
        task.status = "interrupted";
        task.finishedAt = this.deps.now();
        this.deps.persist(task);
      }
      this.tasks.set(task.id, task);
    }
    this.schedule();
  }

  enqueue(kind: string, payload: Record<string, unknown>, opts: EnqueueOptions = {}): Task {
    const def = this.kinds.get(kind);
    if (!def) throw new Error(`task-queue: unknown kind "${kind}"`);

    const dedupeKey = opts.dedupeKey ?? def.dedupeKey?.(payload) ?? null;
    if (dedupeKey) {
      for (const t of this.tasks.values()) {
        if (t.dedupeKey === dedupeKey && ACTIVE.has(t.status)) return t;
      }
    }

    const task: Task = {
      id: this.deps.genId(),
      kind,
      status: "queued",
      title: opts.title ?? def.title?.(payload) ?? kind,
      payload,
      refId: opts.refId ?? null,
      dedupeKey,
      progress: 0,
      stage: "排队中",
      message: "",
      error: null,
      createdAt: this.deps.now(),
      startedAt: null,
      finishedAt: null,
    };
    this.tasks.set(task.id, task);
    this.deps.persist(task);
    this.deps.emit({ type: "task", task });
    this.schedule();
    return task;
  }

  cancel(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;
    if (task.status === "queued") {
      task.status = "cancelled";
      task.finishedAt = this.deps.now();
      this.deps.persist(task);
      this.deps.emit({ type: "task", task });
      this.rejectSettler(id, "任务已取消");
      this.schedule();
      return true;
    }
    if (task.status === "running") {
      // abort + 杀子进程;runner 监听 signal 抛错后走 finish("cancelled")
      this.controllers.get(id)?.abort();
      for (const child of this.children.get(id) ?? []) {
        try {
          child.kill("SIGTERM");
        } catch {
          /* already dead */
        }
      }
      return true;
    }
    return false;
  }

  /** 从队列彻底移除(running 先 cancel)。终态/排队中的任务可直接删。 */
  remove(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;
    if (task.status === "running") this.cancel(id);
    this.tasks.delete(id);
    this.controllers.delete(id);
    this.children.delete(id);
    this.results.delete(id);
    this.deps.removePersisted(id);
    this.deps.emit({ type: "removed", id });
    this.rejectSettler(id, "任务已移除");
    return true;
  }

  private rejectSettler(id: string, reason: string): void {
    const s = this.settlers.get(id);
    if (s) {
      this.settlers.delete(id);
      s.reject(new Error(reason));
    }
  }

  list(): Task[] {
    return [...this.tasks.values()];
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  private runningCount(kind: string): number {
    let n = 0;
    for (const t of this.tasks.values()) {
      if (t.kind === kind && t.status === "running") n++;
    }
    return n;
  }

  private schedule(): void {
    for (const [kind, def] of this.kinds) {
      let running = this.runningCount(kind);
      if (running >= def.concurrency) continue;
      const queued = [...this.tasks.values()]
        .filter((t) => t.kind === kind && t.status === "queued")
        .sort((a, b) => a.createdAt - b.createdAt);
      for (const task of queued) {
        if (running >= def.concurrency) break;
        this.start(task, def);
        running++;
      }
    }
  }

  private start(task: Task, def: KindDef): void {
    task.status = "running";
    task.startedAt = this.deps.now();
    task.stage = "运行中";
    this.deps.persist(task);
    this.deps.emit({ type: "task", task });

    const ac = new AbortController();
    this.controllers.set(task.id, ac);
    const childSet = new Set<KillableChild>();
    this.children.set(task.id, childSet);

    const ctx: RunnerContext = {
      task,
      signal: ac.signal,
      onProgress: (p) => {
        // 任务已不在跑(被 cancel / removed)就丢弃迟到的进度
        if (this.tasks.get(task.id)?.status !== "running") return;
        if (p.progress != null) task.progress = p.progress;
        if (p.stage != null) task.stage = p.stage;
        if (p.message != null) task.message = p.message;
        this.deps.emit({ type: "task", task }); // 进度只 emit,不落库
      },
      registerChild: (c) => childSet.add(c),
    };

    // 同步调用 run,让 onProgress / registerChild 在本轮内即生效;
    // 同步抛错也当失败处理。返回的 promise 决定终态。
    let result: Promise<unknown>;
    try {
      result = Promise.resolve(def.run(task, ctx));
    } catch (err) {
      this.finish(task, "failed", err instanceof Error ? err.message : String(err));
      return;
    }
    result.then(
      (value) => {
        this.results.set(task.id, value);
        this.finish(task, "succeeded");
      },
      (err: unknown) => {
        if (ac.signal.aborted) this.finish(task, "cancelled");
        else this.finish(task, "failed", err instanceof Error ? err.message : String(err));
      },
    );
  }

  private finish(task: Task, status: TaskStatus, error?: string): void {
    // 可能在 run 期间被 remove() 掉了,这时不要复活
    if (!this.tasks.has(task.id)) {
      this.controllers.delete(task.id);
      this.children.delete(task.id);
      return;
    }
    task.status = status;
    task.finishedAt = this.deps.now();
    if (status === "succeeded") task.progress = 100;
    if (error) task.error = error;
    this.controllers.delete(task.id);
    this.children.delete(task.id);
    this.deps.persist(task);
    this.deps.emit({ type: "task", task });
    // settle whenSettled() 的等待方
    const s = this.settlers.get(task.id);
    if (s) {
      this.settlers.delete(task.id);
      if (status === "succeeded") s.resolve(this.results.get(task.id));
      else if (status === "cancelled") s.reject(new Error("任务已取消"));
      else s.reject(new Error(error || "任务失败"));
    }
    this.deps.onSettled?.(task);
    this.schedule();
  }
}

export function createTaskScheduler(deps: SchedulerDeps): TaskScheduler {
  return new TaskScheduler(deps);
}
