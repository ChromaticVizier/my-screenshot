/**
 * 录屏相关的类型 / 选项 / 会话状态
 *
 * - RecordOptions：用户在录屏面板上设置的偏好（持久到 storage.local）
 * - RecordSessionState：当前是否在录制（持久到 storage.local，跨 popup 重开）
 */

export type RecordResolution = "720p" | "1080p" | "4k"
export type RecordFileFormat = "webm" | "mp4"

/** 分辨率档位 → 最大像素尺寸（保留源宽高比，仅作为上限）
 *  Chrome tabCapture 使用 mandatory.maxWidth/maxHeight 约束，
 *  实际输出 = min(源物理像素, 这里给的上限)，比例由源决定 */
export const RESOLUTION_MAX_PIXELS: Record<
  RecordResolution,
  { width: number; height: number }
> = {
  "720p": { width: 1280, height: 720 },
  "1080p": { width: 1920, height: 1080 },
  "4k": { width: 3840, height: 2160 }
}

export interface RecordOptions {
  /** 录制清晰度 */
  resolution: RecordResolution
  /** 输出文件格式 */
  format: RecordFileFormat
  /** 是否录入麦克风 */
  microphone: boolean
  /** 是否录入系统声音 */
  systemAudio: boolean
}

export const DEFAULT_RECORD_OPTIONS: RecordOptions = {
  resolution: "720p",
  format: "webm",
  microphone: false,
  systemAudio: false
}

/** 会话状态（临时） */
export interface RecordSession {
  /** 是否处于录制中 */
  recording: boolean
  /** 录制开始的时间戳（ms） */
  startedAt?: number
  /** 录制窗口的 windowId，用于停止时定位 */
  recorderWindowId?: number
}

export const EMPTY_SESSION: RecordSession = {
  recording: false
}

const OPTIONS_KEY = "recordOptions"
const SESSION_KEY = "recordSession"

/* ---------- options ---------- */
export async function getRecordOptions(): Promise<RecordOptions> {
  const raw = await chrome.storage.local.get(OPTIONS_KEY)
  const stored = (raw[OPTIONS_KEY] as Partial<RecordOptions> | undefined) ?? {}
  return { ...DEFAULT_RECORD_OPTIONS, ...stored }
}

export async function setRecordOptions(
  patch: Partial<RecordOptions>
): Promise<void> {
  const current = await getRecordOptions()
  const next = { ...current, ...patch }
  await chrome.storage.local.set({ [OPTIONS_KEY]: next })
}

/* ---------- session ---------- */
export async function getRecordSession(): Promise<RecordSession> {
  const raw = await chrome.storage.local.get(SESSION_KEY)
  const stored = (raw[SESSION_KEY] as RecordSession | undefined) ?? EMPTY_SESSION
  return { ...EMPTY_SESSION, ...stored }
}

export async function setRecordSession(
  patch: Partial<RecordSession>
): Promise<void> {
  const current = await getRecordSession()
  const next = { ...current, ...patch }
  await chrome.storage.local.set({ [SESSION_KEY]: next })
}

export async function clearRecordSession(): Promise<void> {
  await chrome.storage.local.set({ [SESSION_KEY]: EMPTY_SESSION })
}

/** 订阅会话变化（用于 popup 在 recorder 窗口里录制时实时更新按钮） */
export function onRecordSessionChanged(
  cb: (session: RecordSession) => void
): () => void {
  const listener = (
    changes: { [key: string]: chrome.storage.StorageChange },
    areaName: string
  ) => {
    if (areaName !== "local" || !changes[SESSION_KEY]) return
    cb({
      ...EMPTY_SESSION,
      ...((changes[SESSION_KEY].newValue as RecordSession) ?? {})
    })
  }
  chrome.storage.onChanged.addListener(listener)
  return () => chrome.storage.onChanged.removeListener(listener)
}
