/**
 * popup 与 background 之间的消息协议
 * 集中定义类型与常量，保证两端类型一致
 */

/** 消息类型枚举 */
export const MessageType = {
  CAPTURE_VISIBLE: "capture/visible"
} as const

export type MessageType = (typeof MessageType)[keyof typeof MessageType]

/** 请求/响应类型映射 */
export interface CaptureVisibleRequest {
  type: typeof MessageType.CAPTURE_VISIBLE
  payload?: {
    /** 图片格式，默认 png */
    format?: "png" | "jpeg"
    /** jpeg 质量 0-100 */
    quality?: number
  }
}

export interface CaptureVisibleResponse {
  ok: boolean
  /** 成功时返回下载 ID */
  downloadId?: number
  /** 失败原因 */
  error?: string
}

/** 联合请求类型，便于 background 路由分发 */
export type ExtensionRequest = CaptureVisibleRequest

/** 通用响应包装 */
export type ExtensionResponse<T = unknown> = {
  ok: true
  data?: T
} | {
  ok: false
  error: string
}
