/**
 * 截图相关的 background 处理逻辑
 *
 * 选型说明：
 * - 使用 chrome.tabs.captureVisibleTab：浏览器扩展原生 API，无需用户在
 *   屏幕共享选择器中确认，体验最佳；产出真实渲染结果，质量等同 WebRTC。
 * - 使用 chrome.downloads.download：以 dataUrl 直接触发下载，无需先转 Blob
 *   或 createObjectURL，service worker 中也可用（避免对 URL.createObjectURL
 *   在不同 Chrome 版本中的兼容差异）。
 */
import { buildScreenshotFilename } from "~src/shared/filename"
import type {
  CaptureVisibleRequest,
  CaptureVisibleResponse
} from "~src/shared/messages"

/**
 * 处理「可视区域截图」请求
 */
export async function handleCaptureVisible(
  request: CaptureVisibleRequest
): Promise<CaptureVisibleResponse> {
  const format = request.payload?.format ?? "png"
  const quality = request.payload?.quality

  try {
    // 1. 获取当前活动标签页（用于拿 windowId 和文件名）
    const [activeTab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true
    })

    if (!activeTab) {
      return { ok: false, error: "未找到活动标签页" }
    }

    // 部分页面（chrome://、Chrome Web Store 等）不允许截图，提前提示
    const url = activeTab.url ?? ""
    if (
      url.startsWith("chrome://") ||
      url.startsWith("edge://") ||
      url.startsWith("chrome-extension://") ||
      url.startsWith("https://chrome.google.com/webstore")
    ) {
      return {
        ok: false,
        error: "当前页面不允许截图（浏览器内部页面或商店页）"
      }
    }

    // 2. 截取可视区域
    const dataUrl = await chrome.tabs.captureVisibleTab(activeTab.windowId, {
      format,
      ...(format === "jpeg" && quality != null ? { quality } : {})
    })

    if (!dataUrl) {
      return { ok: false, error: "截图失败：返回数据为空" }
    }

    // 3. 触发下载
    const filename = buildScreenshotFilename({
      tabTitle: activeTab.title,
      ext: format
    })

    const downloadId = await chrome.downloads.download({
      url: dataUrl,
      filename,
      saveAs: false
    })

    return { ok: true, downloadId }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}
