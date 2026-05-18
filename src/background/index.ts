/**
 * Service Worker 入口
 * 负责接收 popup / content script 的消息并路由到对应处理器
 */
import { handleCaptureVisible } from "~src/background/handlers/capture"
import { MessageType, type ExtensionRequest } from "~src/shared/messages"

chrome.runtime.onMessage.addListener(
  (request: ExtensionRequest, _sender, sendResponse) => {
    // 异步处理：必须 return true 保持消息通道开启
    ;(async () => {
      switch (request.type) {
        case MessageType.CAPTURE_VISIBLE: {
          const res = await handleCaptureVisible(request)
          sendResponse(res)
          break
        }
        default: {
          sendResponse({
            ok: false,
            error: `未知消息类型: ${(request as { type?: string }).type}`
          })
        }
      }
    })()
    return true
  }
)

// 让 TS 把此文件当模块处理
export {}
