/**
 * 截图相关的 popup 端调用层
 * 封装 chrome.runtime.sendMessage，向 UI 暴露 Promise 化的接口
 */
import {
  MessageType,
  type CaptureVisibleRequest,
  type CaptureVisibleResponse
} from "~src/shared/messages"

/** 截取当前标签页可视区域并触发下载 */
export function captureVisibleArea(
  payload?: CaptureVisibleRequest["payload"]
): Promise<CaptureVisibleResponse> {
  const request: CaptureVisibleRequest = {
    type: MessageType.CAPTURE_VISIBLE,
    payload
  }
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(request, (res: CaptureVisibleResponse) => {
      const lastError = chrome.runtime.lastError
      if (lastError) {
        resolve({ ok: false, error: lastError.message ?? "消息通道异常" })
        return
      }
      resolve(res)
    })
  })
}
