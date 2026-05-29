// 通用后台任务队列的 renderer 镜像。
// 唯一数据源是 main 进程的 task-queue 调度器:启动拉一次全量(listQueueTasks),
// 之后增量订阅 taskqueue:update / taskqueue:removed。任务队列面板、视频行的
// "排队中" 状态都读这里 —— 跟页面挂载/卸载无关,切走页面不丢。
import { create } from "zustand";
import type { QueueTask } from "../electron-api";

interface TaskQueueState {
  tasksById: Record<string, QueueTask>;
  upsert: (task: QueueTask) => void;
  remove: (id: string) => void;
  replaceAll: (tasks: QueueTask[]) => void;
}

export const useTaskQueueStore = create<TaskQueueState>((set) => ({
  tasksById: {},
  upsert: (task) => set((s) => ({ tasksById: { ...s.tasksById, [task.id]: task } })),
  remove: (id) =>
    set((s) => {
      if (!(id in s.tasksById)) return s;
      const next = { ...s.tasksById };
      delete next[id];
      return { tasksById: next };
    }),
  replaceAll: (tasks) =>
    set(() => {
      const map: Record<string, QueueTask> = {};
      for (const t of tasks) map[t.id] = t;
      return { tasksById: map };
    }),
}));

// ── 选择器(组件用,避免每个调用点重复过滤逻辑)──

const ACTIVE = new Set<QueueTask["status"]>(["queued", "running"]);

/** 某 refId(通常是 videoId)是否有未结束的任务,可选限定 kind。给视频行显示"排队中/运行中"用。 */
export function selectTaskByRef(
  tasksById: Record<string, QueueTask>,
  refId: string,
  kind?: string,
): QueueTask | undefined {
  for (const t of Object.values(tasksById)) {
    if (t.refId === refId && ACTIVE.has(t.status) && (!kind || t.kind === kind)) return t;
  }
  return undefined;
}

export function isQueueTaskActive(status: QueueTask["status"]): boolean {
  return ACTIVE.has(status);
}
