/**
 * popup 与 background / content script 之间的消息协议
 * 集中定义类型与常量，保证两端类型一致
 */

/** 消息类型枚举 */
export const MessageType = {
  CAPTURE_VISIBLE: "capture/visible",
  CAPTURE_FULL_PAGE: "capture/fullPage",
  CAPTURE_FULL_PAGE_CANCEL: "capture/fullPageCancel",
  CAPTURE_FULL_PAGE_PROGRESS_GET: "capture/fullPageProgress/get",
  CAPTURE_FULL_PAGE_PROGRESS: "capture/fullPageProgress",
  CAPTURE_SELECTION: "capture/selection",
  CAPTURE_DELAYED: "capture/delayed",
  CAPTURE_DESKTOP: "capture/desktop",
  /** 选择并记忆当前站点的滚动区域 */
  SELECT_SCROLL_REGION: "scrollRegion/select",
  /** 清除当前站点记忆的滚动区域 */
  CLEAR_SCROLL_REGION: "scrollRegion/clear",
  /** 中转窗口拿到屏幕截图 dataUrl 后，请求 background 下载 */
  DOWNLOAD_DESKTOP_IMAGE: "download/desktopImage",
  /** 中转窗口请求 background 把自己移到屏幕外（不能用 minimize，会冻结 JS） */
  HIDE_RELAY_WINDOW: "window/hideRelay",
  /** 中转窗口请求 background 销毁自己 */
  CLOSE_RELAY_WINDOW: "window/closeRelay",

  /** 编辑器 tab 请求待裁剪的图片数据 */
  GET_PENDING_IMAGE: "editor/getPendingImage",
  /** 编辑器 tab 裁剪完成，请求下载 */
  EDITOR_DOWNLOAD: "editor/download",
  /** 编辑器 tab 放弃本次截图，请求清理待编辑图片 */
  EDITOR_DISCARD: "editor/discard",

  /* ====== 录屏 ====== */
  /** popup → background：开始录制当前标签页（整页） */
  RECORD_START_CURRENT_TAB: "record/startCurrentTab",
  /** popup → background：开始区域录制当前标签页 */
  RECORD_START_REGION_TAB: "record/startRegionTab",
  /** popup / 控制栏 → background：停止当前录制 */
  RECORD_STOP: "record/stop",
  /** background → 控制栏 / 中转窗口：触发停止 */
  RECORDER_STOP: "recorder/stop",
  /** 控制栏 → 中转窗口（经 background 转发）：暂停 */
  RECORDER_PAUSE: "recorder/pause",
  /** 控制栏 → 中转窗口（经 background 转发）：继续 */
  RECORDER_RESUME: "recorder/resume",
  /** 中转窗口 → background：MediaRecorder 真正开始录制，回传精确起点
   *  （bootstrap 时设的 startedAt 包含创建窗口+加载popup+getUserMedia等准备时间，
   *  控制栏计时与实际视频时长会差约 1 秒；以此消息为准重置起点） */
  RECORDER_STARTED: "recorder/started",
  /** 中转窗口 → background：录制完成（已自行下载） */
  RECORDER_FINISH: "recorder/finish",

  /* ====== 麦克风授权 ====== */
  /** 授权窗口 → background：麦克风授权结果（getUserMedia 成功/失败） */
  MIC_PERMISSION_RESULT: "mic/permissionResult"
} as const

export type MessageType = (typeof MessageType)[keyof typeof MessageType]

/** 通用图片格式选项 */
export interface ImageOptions {
  format?: "png" | "jpeg"
  /** jpeg 质量 0-100 */
  quality?: number
}

/** 选区矩形（CSS 像素，相对视口左上角） */
export interface SelectionRect {
  x: number
  y: number
  width: number
  height: number
}

/* ---------- 可视区域 ---------- */
export interface CaptureVisibleRequest {
  type: typeof MessageType.CAPTURE_VISIBLE
  payload?: ImageOptions
}

/* ---------- 整页 ---------- */
export interface CaptureFullPageRequest {
  type: typeof MessageType.CAPTURE_FULL_PAGE
  payload?: ImageOptions & {
    taskId?: string
  }
}

export interface CaptureFullPageCancelRequest {
  type: typeof MessageType.CAPTURE_FULL_PAGE_CANCEL
}

export interface CaptureFullPageProgressGetRequest {
  type: typeof MessageType.CAPTURE_FULL_PAGE_PROGRESS_GET
}

export type CaptureFullPageProgressPhase =
  | "capturing"
  | "stitching"
  | "done"
  | "cancelled"
  | "error"

export interface CaptureFullPageProgressState {
  taskId: string
  phase: CaptureFullPageProgressPhase
  current: number
  total: number
  message?: string
  error?: string
}

export interface CaptureFullPageProgressRequest {
  type: typeof MessageType.CAPTURE_FULL_PAGE_PROGRESS
  payload: CaptureFullPageProgressState
}

/* ---------- 滚动区域选择 ---------- */
export interface SelectScrollRegionRequest {
  type: typeof MessageType.SELECT_SCROLL_REGION
}

export interface ClearScrollRegionRequest {
  type: typeof MessageType.CLEAR_SCROLL_REGION
}

/* ---------- 选区 ---------- */
export interface CaptureSelectionRequest {
  type: typeof MessageType.CAPTURE_SELECTION
  payload?: ImageOptions
}

/* ---------- 延迟可视区域 ---------- */
export interface CaptureDelayedRequest {
  type: typeof MessageType.CAPTURE_DELAYED
  payload?: ImageOptions & {
    /** 倒计时秒数，省略则读取用户设置 */
    seconds?: number
  }
}

/* ---------- 整个屏幕或应用窗口 ---------- */
export interface CaptureDesktopRequest {
  type: typeof MessageType.CAPTURE_DESKTOP
  payload?: ImageOptions
}

/* ---------- 中转窗口 → background：下载屏幕截图 dataUrl ---------- */
export interface DownloadDesktopImageRequest {
  type: typeof MessageType.DOWNLOAD_DESKTOP_IMAGE
  payload: {
    dataUrl: string
    format: "png" | "jpeg"
  }
}

/* ---------- 中转窗口 → background：把自己移到屏幕外 ---------- */
export interface HideRelayWindowRequest {
  type: typeof MessageType.HIDE_RELAY_WINDOW
}

/* ---------- 中转窗口 → background：销毁自己 ---------- */
export interface CloseRelayWindowRequest {
  type: typeof MessageType.CLOSE_RELAY_WINDOW
}

/* ---------- 编辑器 tab → background：获取待裁剪图片 ---------- */
export interface GetPendingImageRequest {
  type: typeof MessageType.GET_PENDING_IMAGE
}

export interface GetPendingImageResponse {
  ok: boolean
  dataUrl?: string
  filename?: string
  error?: string
}

/* ---------- 编辑器 tab → background：裁剪后下载 ---------- */
export interface EditorDownloadRequest {
  type: typeof MessageType.EDITOR_DOWNLOAD
  payload: {
    dataUrl: string
    filename: string
  }
}

/* ---------- 编辑器 tab → background：放弃本次截图 ---------- */
export interface EditorDiscardRequest {
  type: typeof MessageType.EDITOR_DISCARD
}

/* ---------- 录屏：popup → background ---------- */
export interface RecordStartCurrentTabRequest {
  type: typeof MessageType.RECORD_START_CURRENT_TAB
  payload: {
    /** popup 已申请好的 tab streamId */
    streamId: string
    /** 同时也是 streamId 的 consumerTabId，用于注入脚本到该 tab */
    tabId: number
  }
}

export interface RecordStartRegionTabRequest {
  type: typeof MessageType.RECORD_START_REGION_TAB
  payload: {
    streamId: string
    tabId: number
  }
}

export interface RecordStopRequest {
  type: typeof MessageType.RECORD_STOP
}

/* ---------- 录屏：background → recorder 窗口 / 控制栏 ---------- */
export interface RecorderStopRequest {
  type: typeof MessageType.RECORDER_STOP
}

export interface RecorderPauseRequest {
  type: typeof MessageType.RECORDER_PAUSE
}

export interface RecorderResumeRequest {
  type: typeof MessageType.RECORDER_RESUME
}

/* ---------- 录屏：中转窗口 → background ---------- */
export interface RecorderStartedRequest {
  type: typeof MessageType.RECORDER_STARTED
  payload: {
    /** MediaRecorder.start() 调用瞬间的 Date.now() */
    startedAt: number
  }
}

export interface RecorderFinishRequest {
  type: typeof MessageType.RECORDER_FINISH
  payload: {
    /** 是否被用户主动取消 */
    cancelled?: boolean
    /** 出错信息 */
    error?: string
  }
}

/* ---------- 麦克风授权：授权窗口 → background ---------- */
export interface MicPermissionResultRequest {
  type: typeof MessageType.MIC_PERMISSION_RESULT
  payload: {
    /** 是否获得麦克风授权 */
    granted: boolean
    /** 失败原因（未授权/无设备等） */
    error?: string
  }
}

/** 通用响应 */
export interface CaptureResponse {
  ok: boolean
  /** 成功时返回下载 ID */
  downloadId?: number
  /** 失败原因 */
  error?: string
  /** 用户主动取消（如选区按 Esc），UI 应静默处理 */
  cancelled?: boolean
}

/** 联合请求类型，便于 background 路由分发 */
export type ExtensionRequest =
  | CaptureVisibleRequest
  | CaptureFullPageRequest
  | CaptureFullPageCancelRequest
  | CaptureFullPageProgressGetRequest
  | CaptureFullPageProgressRequest
  | SelectScrollRegionRequest
  | ClearScrollRegionRequest
  | CaptureSelectionRequest
  | CaptureDelayedRequest
  | CaptureDesktopRequest
  | DownloadDesktopImageRequest
  | HideRelayWindowRequest
  | CloseRelayWindowRequest
  | GetPendingImageRequest
  | EditorDownloadRequest
  | EditorDiscardRequest
  | RecordStartCurrentTabRequest
  | RecordStartRegionTabRequest
  | RecordStopRequest
  | RecorderStopRequest
  | RecorderPauseRequest
  | RecorderResumeRequest
  | RecorderStartedRequest
  | RecorderFinishRequest
  | MicPermissionResultRequest
