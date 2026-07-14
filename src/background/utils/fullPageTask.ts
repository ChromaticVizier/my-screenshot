export type FullPageTaskPhase =
  | "capturing"
  | "stitching"
  | "done"
  | "cancelled"
  | "error"

export interface FullPageTaskProgress {
  taskId: string
  phase: FullPageTaskPhase
  current: number
  total: number
  message?: string
  error?: string
}

class FullPageCaptureCancelled extends Error {
  constructor() {
    super("长截图已停止")
    this.name = "FullPageCaptureCancelled"
  }
}

type TaskState = FullPageTaskProgress & {
  cancelled: boolean
  tabId?: number
}

let activeTask: TaskState | null = null

export function startFullPageTask(taskId?: string): string {
  if (
    activeTask &&
    activeTask.phase !== "done" &&
    activeTask.phase !== "cancelled" &&
    activeTask.phase !== "error"
  ) {
    activeTask.cancelled = true
  }
  const nextTaskId =
    taskId ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  activeTask = {
    taskId: nextTaskId,
    phase: "capturing",
    current: 0,
    total: 1,
    cancelled: false
  }
  broadcastFullPageProgress()
  return nextTaskId
}

export function getFullPageTask(): FullPageTaskProgress | null {
  if (!activeTask) return null
  const { taskId, phase, current, total, message, error } = activeTask
  return { taskId, phase, current, total, message, error }
}

export function setFullPageTaskTab(taskId: string, tabId?: number): void {
  if (!activeTask || activeTask.taskId !== taskId) return
  activeTask.tabId = tabId
}

export function cancelFullPageTask(): boolean {
  if (
    !activeTask ||
    activeTask.phase === "done" ||
    activeTask.phase === "cancelled" ||
    activeTask.phase === "error"
  ) {
    return false
  }
  activeTask.cancelled = true
  activeTask.phase = "capturing"
  activeTask.message = "正在停止并拼接已截取内容"
  broadcastFullPageProgress()
  return true
}

export function assertFullPageTaskNotCancelled(taskId?: string): void {
  if (!taskId || !activeTask || activeTask.taskId !== taskId) return
  if (activeTask.cancelled || activeTask.phase === "cancelled") {
    throw new FullPageCaptureCancelled()
  }
}

export function updateFullPageTaskProgress(
  taskId: string | undefined,
  patch: Partial<Omit<FullPageTaskProgress, "taskId">>
): void {
  if (!taskId || !activeTask || activeTask.taskId !== taskId) return
  activeTask = {
    ...activeTask,
    ...patch,
    current: Math.max(0, patch.current ?? activeTask.current),
    total: Math.max(1, patch.total ?? activeTask.total)
  }
  broadcastFullPageProgress()
}

export function finishFullPageTask(
  taskId: string | undefined,
  result: { ok: boolean; cancelled?: boolean; error?: string }
): void {
  if (!taskId || !activeTask || activeTask.taskId !== taskId) return
  if (result.cancelled) {
    activeTask.phase = "cancelled"
    activeTask.message = "已停止"
  } else if (result.ok) {
    activeTask.phase = "done"
    activeTask.message = activeTask.cancelled ? "已停止，已生成当前截图" : "已完成"
    activeTask.current = activeTask.total
  } else {
    activeTask.phase = "error"
    activeTask.error = result.error
    activeTask.message = result.error ?? "长截图失败"
  }
  broadcastFullPageProgress()
  setTimeout(
    () => {
      if (!activeTask || activeTask.taskId !== taskId) return
      activeTask = null
    },
    result.ok ? 800 : 1600
  )
}

export function isFullPageTaskStopRequested(taskId?: string): boolean {
  return !!taskId && !!activeTask && activeTask.taskId === taskId && activeTask.cancelled
}

export function shouldStopFullPageCapture(taskId?: string): boolean {
  return isFullPageTaskStopRequested(taskId)
}

export function isFullPageCaptureCancelled(err: unknown): boolean {
  return err instanceof FullPageCaptureCancelled
}

function broadcastFullPageProgress(): void {
  const progress = getFullPageTask()
  if (!progress) return
  chrome.runtime
    .sendMessage({ type: "capture/fullPageProgress", payload: progress })
    .catch(() => undefined)
}
