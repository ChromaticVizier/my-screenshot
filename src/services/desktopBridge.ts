/**
 * 中转窗口与 background 之间的通信桥
 */
import {
  MessageType,
  type CaptureResponse,
  type CloseRelayWindowRequest,
  type DownloadDesktopImageRequest,
  type HideRelayWindowRequest
} from "~src/shared/messages"

interface DownloadDesktopArgs {
  dataUrl: string
  format: "png" | "jpeg"
}

export function downloadDesktopImage(
  args: DownloadDesktopArgs
): Promise<CaptureResponse> {
  const req: DownloadDesktopImageRequest = {
    type: MessageType.DOWNLOAD_DESKTOP_IMAGE,
    payload: args
  }
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(req, (res: CaptureResponse) => {
      const lastError = chrome.runtime.lastError
      if (lastError) {
        resolve({ ok: false, error: lastError.message ?? "消息通道异常" })
        return
      }
      resolve(res)
    })
  })
}

/** 请求 background 把当前中转窗口移到屏幕外（保留 JS 运行能力） */
export function hideRelayWindow(): Promise<void> {
  const req: HideRelayWindowRequest = { type: MessageType.HIDE_RELAY_WINDOW }
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(req, () => {
      // 不论成功失败都 resolve，避免阻塞主流程
      void chrome.runtime.lastError
      resolve()
    })
  })
}

/** 请求 background 销毁当前中转窗口 */
export function closeRelayWindow(): Promise<void> {
  const req: CloseRelayWindowRequest = { type: MessageType.CLOSE_RELAY_WINDOW }
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(req, () => {
      void chrome.runtime.lastError
      resolve()
    })
  })
}
