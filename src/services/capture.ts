/**
 * 截图相关的 popup 端调用层
 * 封装 chrome.runtime.sendMessage，向 UI 暴露 Promise 化的接口
 */
import {
  MessageType,
  type CaptureDelayedRequest,
  type CaptureDesktopRequest,
  type CaptureFullPageRequest,
  type CaptureResponse,
  type CaptureSelectionRequest,
  type CaptureVisibleRequest,
  type ClearScrollRegionRequest,
  type ExtensionRequest,
  type ImageOptions,
  type SelectScrollRegionRequest
} from "~src/shared/messages"

function send<T extends ExtensionRequest>(
  request: T
): Promise<CaptureResponse> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(request, (res: CaptureResponse) => {
      const lastError = chrome.runtime.lastError
      if (lastError) {
        resolve({ ok: false, error: lastError.message ?? "消息通道异常" })
        return
      }
      resolve(res)
    })
  })
}

/** 截取当前标签页可视区域并触发下载 */
export function captureVisibleArea(payload?: ImageOptions) {
  const req: CaptureVisibleRequest = {
    type: MessageType.CAPTURE_VISIBLE,
    payload
  }
  return send(req)
}

/** 截取整页（滚动拼接）并触发下载 */
export function captureFullPage(payload?: ImageOptions) {
  const req: CaptureFullPageRequest = {
    type: MessageType.CAPTURE_FULL_PAGE,
    payload
  }
  return send(req)
}

/** 手动选择并记忆当前站点的滚动区域 */
export function selectScrollRegion() {
  const req: SelectScrollRegionRequest = {
    type: MessageType.SELECT_SCROLL_REGION
  }
  return send(req)
}

/** 清除当前站点记忆的滚动区域 */
export function clearScrollRegion() {
  const req: ClearScrollRegionRequest = {
    type: MessageType.CLEAR_SCROLL_REGION
  }
  return send(req)
}

/** 截取选区并触发下载 */
export function captureSelection(payload?: ImageOptions) {
  const req: CaptureSelectionRequest = {
    type: MessageType.CAPTURE_SELECTION,
    payload
  }
  return send(req)
}

/** 延迟后截取可视区域并触发下载（页面右上角会显示倒计时） */
export function captureDelayed(
  payload?: CaptureDelayedRequest["payload"]
) {
  const req: CaptureDelayedRequest = {
    type: MessageType.CAPTURE_DELAYED,
    payload
  }
  return send(req)
}

/** 截取整个屏幕或应用窗口（弹出系统级共享选择器） */
export function captureDesktop(payload?: ImageOptions) {
  const req: CaptureDesktopRequest = {
    type: MessageType.CAPTURE_DESKTOP,
    payload
  }
  return send(req)
}
