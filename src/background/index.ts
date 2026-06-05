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
  handleClearScrollRegion,
  handleCloseRelayWindow,
  handleDownloadDesktopImage,
  handleHideRelayWindow,
  handleSelectScrollRegion
} from "~src/background/handlers/capture"
import { handleCaptureFullPageCdp } from "~src/background/handlers/captureCdp"
import {
  handleRecorderFinish,
  handleRecordStartCurrentTab,
  handleRecordStartRegionTab,
  handleRecordStop
} from "~src/background/handlers/record"
import {
  clearPendingImage,
  getPendingImage
} from "~src/background/utils/pendingImage"
import { MessageType, type ExtensionRequest } from "~src/shared/messages"
import { getSettings } from "~src/shared/settings"

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
          // 设置中开启 CDP 模式时走 captureCdp，否则走原有滚动拼接路径
          const settings = await getSettings()
          if (settings.useCdpForFullPage) {
            sendResponse(await handleCaptureFullPageCdp(request))
          } else {
            sendResponse(await handleCaptureFullPage(request))
          }
          break
        }
        case MessageType.SELECT_SCROLL_REGION: {
          sendResponse(await handleSelectScrollRegion(request))
          break
        }
        case MessageType.CLEAR_SCROLL_REGION: {
          sendResponse(await handleClearScrollRegion(request))
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
        case MessageType.GET_PENDING_IMAGE: {
          const img = getPendingImage()
          if (img) {
            sendResponse({ ok: true, dataUrl: img.dataUrl, filename: img.filename })
          } else {
            sendResponse({ ok: false, error: "没有待编辑的图片" })
          }
          break
        }
        case MessageType.EDITOR_DOWNLOAD: {
          try {
            const { dataUrl, filename } = request.payload
            await chrome.downloads.download({
              url: dataUrl,
              filename,
              saveAs: false
            })
            clearPendingImage()
            sendResponse({ ok: true })
          } catch (err) {
            sendResponse({
              ok: false,
              error: err instanceof Error ? err.message : String(err)
            })
          }
          break
        }
        case MessageType.RECORD_START_CURRENT_TAB: {
          sendResponse(await handleRecordStartCurrentTab(request))
          break
        }
        case MessageType.RECORD_START_REGION_TAB: {
          sendResponse(await handleRecordStartRegionTab(request))
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
        case MessageType.RECORDER_STOP:
        case MessageType.RECORDER_PAUSE:
        case MessageType.RECORDER_RESUME: {
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
