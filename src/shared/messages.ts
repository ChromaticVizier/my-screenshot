/**
 * popup 与 background / content script 之间的消息协议
 * 集中定义类型与常量，保证两端类型一致
 */

/** 消息类型枚举 */
export const MessageType = {
  CAPTURE_VISIBLE: "capture/visible",
  CAPTURE_FULL_PAGE: "capture/fullPage",
  CAPTURE_SELECTION: "capture/selection",
  CAPTURE_DELAYED: "capture/delayed"
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
  payload?: ImageOptions
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
  | CaptureSelectionRequest
  | CaptureDelayedRequest
