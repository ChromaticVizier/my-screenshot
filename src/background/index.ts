/**
 * Service Worker 入口
 * 负责接收 popup / content script 的消息并路由到对应处理器
 */
import {
  handleCaptureDelayed,
  handleCaptureDesktop,
  handleCaptureSelection,
  handleCaptureVisible,
  handleClearScrollRegion,
  handleCloseRelayWindow,
  handleDownloadDesktopImage,
  handleHideRelayWindow,
  handleSelectScrollRegion
} from "~src/background/handlers/capture"
import { handleCaptureFullPageRouted } from "~src/background/handlers/fullPageRouter"
import {
  handleRecorderFinish,
  handleRecorderStarted,
  handleRecordMicrophonePermissionWindow,
  handleRecordStartCurrentTab,
  handleRecordStartDesktop,
  handleRecordStartRegionTab,
  handleRecordStop
} from "~src/background/handlers/record"
import {
  cancelFullPageTask,
  finishFullPageTask,
  getFullPageTask,
  isFullPageCaptureCancelled,
  setFullPageTaskTab,
  startFullPageTask
} from "~src/background/utils/fullPageTask"
import {
  clearPendingImage,
  getPendingImage
} from "~src/background/utils/pendingImage"
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
          const taskId = startFullPageTask(request.payload?.taskId)
          request.payload = { ...(request.payload ?? {}), taskId }
          const tabId = sender.tab?.id
          setFullPageTaskTab(taskId, tabId)
          try {
            const res = await handleCaptureFullPageRouted(request, tabId)
            finishFullPageTask(taskId, res)
            sendResponse(res)
          } catch (err) {
            const res = isFullPageCaptureCancelled(err)
              ? { ok: false, cancelled: true, error: "长截图已停止" }
              : {
                  ok: false,
                  error: err instanceof Error ? err.message : String(err)
                }
            finishFullPageTask(taskId, res)
            sendResponse(res)
          }
          break
        }
        case MessageType.CAPTURE_FULL_PAGE_CANCEL: {
          sendResponse({ ok: cancelFullPageTask(), cancelled: true })
          break
        }
        case MessageType.CAPTURE_FULL_PAGE_PROGRESS_GET: {
          sendResponse({ ok: true, progress: getFullPageTask() })
          break
        }
        case MessageType.CAPTURE_FULL_PAGE_PROGRESS: {
          sendResponse({ ok: true })
          break
        }
        case MessageType.SELECT_SCROLL_REGION: {
          sendResponse(await handleSelectScrollRegion(request, sender.tab?.id))
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
            sendResponse({
              ok: true,
              dataUrl: img.dataUrl,
              filename: img.filename
            })
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
              saveAs: true
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
        case MessageType.EDITOR_DISCARD: {
          clearPendingImage()
          sendResponse({ ok: true })
          break
        }
        case MessageType.RECORD_START_DESKTOP: {
          sendResponse(await handleRecordStartDesktop(request))
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
        case MessageType.RECORD_MICROPHONE_PERMISSION_WINDOW: {
          sendResponse(await handleRecordMicrophonePermissionWindow("microphone"))
          break
        }
        case MessageType.RECORD_CAMERA_PERMISSION_WINDOW: {
          sendResponse(await handleRecordMicrophonePermissionWindow("camera"))
          break
        }
        case MessageType.RECORDER_FINISH: {
          sendResponse(await handleRecorderFinish(request, sender))
          break
        }
        case MessageType.RECORDER_STARTED: {
          sendResponse(await handleRecorderStarted(request))
          break
        }
        case MessageType.RECORDER_STOP:
        case MessageType.RECORDER_PAUSE:
        case MessageType.RECORDER_RESUME:
        case MessageType.RECORD_MICROPHONE_REQUEST:
        case MessageType.RECORDER_MICROPHONE_STATUS: {
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
