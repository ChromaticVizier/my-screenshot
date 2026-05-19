/**
 * Service Worker 入口
 * 负责接收 popup / content script 的消息并路由到对应处理器
 */
import {
  handleCaptureDelayed,
  handleCaptureDesktop,
  handleCaptureFullPage,
  handleCaptureSelection,
  handleCaptureVisible,
  handleCloseRelayWindow,
  handleDownloadDesktopImage,
  handleHideRelayWindow
} from "~src/background/handlers/capture"
import {
  handleRecorderFinish,
  handleRecordStartCurrentTab,
  handleRecordStop
} from "~src/background/handlers/record"
import { MessageType, type ExtensionRequest } from "~src/shared/messages"

chrome.runtime.onMessage.addListener(
  (request: ExtensionRequest, sender, sendResponse) => {
    // 异步处理：必须 return true 保持消息通道开启
    ;(async () => {
      switch (request.type) {
        case MessageType.CAPTURE_VISIBLE: {
          sendResponse(await handleCaptureVisible(request))
          break
        }
        case MessageType.CAPTURE_FULL_PAGE: {
          sendResponse(await handleCaptureFullPage(request))
          break
        }
        case MessageType.CAPTURE_SELECTION: {
          sendResponse(await handleCaptureSelection(request))
          break
        }
        case MessageType.CAPTURE_DELAYED: {
          sendResponse(await handleCaptureDelayed(request))
          break
        }
        case MessageType.CAPTURE_DESKTOP: {
          sendResponse(await handleCaptureDesktop(request))
          break
        }
        case MessageType.DOWNLOAD_DESKTOP_IMAGE: {
          sendResponse(await handleDownloadDesktopImage(request))
          break
        }
        case MessageType.HIDE_RELAY_WINDOW: {
          sendResponse(await handleHideRelayWindow(request, sender))
          break
        }
        case MessageType.CLOSE_RELAY_WINDOW: {
          sendResponse(await handleCloseRelayWindow(request, sender))
          break
        }
        case MessageType.RECORD_START_CURRENT_TAB: {
          sendResponse(await handleRecordStartCurrentTab(request))
          break
        }
        case MessageType.RECORD_STOP: {
          sendResponse(await handleRecordStop(request))
          break
        }
        case MessageType.RECORDER_FINISH: {
          sendResponse(await handleRecorderFinish(request, sender))
          break
        }
        case MessageType.RECORDER_STOP: {
          // recorder 注入脚本才是这条消息的接收方，service worker 直接放行
          sendResponse({ ok: true })
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

export {}
