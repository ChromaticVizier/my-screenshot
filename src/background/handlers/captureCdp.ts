/**
 * 通过 Chrome DevTools Protocol（CDP）一次拍下整页长截图。
 *
 * 与现有"滚动 + 拼接"方案完全独立，互不干扰。开关由
 * settings.useCdpForFullPage 控制，默认关闭。
 *
 * 流程：
 *   1. chrome.debugger.attach 接入目标 tab
 *   2. Page.getLayoutMetrics 拿到完整内容尺寸（cssContentSize）
 *   3. Page.captureScreenshot 配 captureBeyondViewport: true
 *      把整个文档一次绘制到 png（PNG/JPEG 由调用方决定）
 *   4. detach
 *
 * 使用 CDP 时，浏览器顶部会出现 "XXX 正在调试此浏览器" 的提示条。
 * 这是 Chrome 安全要求，无法隐藏。功能完成后立即 detach 即可消失。
 */
import { downloadImageBlob } from "~src/background/utils/download"
import { getCapturableActiveTab } from "~src/background/utils/tabHelper"
import type {
  CaptureFullPageRequest,
  CaptureResponse
} from "~src/shared/messages"

interface LayoutMetricsResult {
  cssContentSize?: { width: number; height: number }
  contentSize?: { width: number; height: number }
}

interface CaptureScreenshotResult {
  data: string
}

export async function handleCaptureFullPageCdp(
  request: CaptureFullPageRequest
): Promise<CaptureResponse> {
  const format = request.payload?.format ?? "png"
  const quality = request.payload?.quality

  const tabRes = await getCapturableActiveTab()
  if (!tabRes.ok) return { ok: false, error: tabRes.error }
  const tab = tabRes.tab
  const tabId = tab.id!

  const target: chrome.debugger.Debuggee = { tabId }
  let attached = false
  try {
    await chrome.debugger.attach(target, "1.3")
    attached = true

    const metrics = (await chrome.debugger.sendCommand(
      target,
      "Page.getLayoutMetrics"
    )) as LayoutMetricsResult
    const size = metrics.cssContentSize ?? metrics.contentSize
    if (!size || size.width <= 0 || size.height <= 0) {
      throw new Error("CDP 拿不到页面尺寸")
    }

    const cdpFormat = format === "jpeg" ? "jpeg" : "png"
    const params: Record<string, unknown> = {
      format: cdpFormat,
      captureBeyondViewport: true,
      fromSurface: true,
      clip: {
        x: 0,
        y: 0,
        width: Math.ceil(size.width),
        height: Math.ceil(size.height),
        scale: 1
      }
    }
    if (cdpFormat === "jpeg" && quality != null) {
      params.quality = Math.max(0, Math.min(100, Math.round(quality)))
    }

    const shot = (await chrome.debugger.sendCommand(
      target,
      "Page.captureScreenshot",
      params
    )) as CaptureScreenshotResult
    if (!shot?.data) throw new Error("CDP 截图返回为空")

    // 提前 detach：让 "正在调试" 提示条尽快消失
    try {
      await chrome.debugger.detach(target)
    } catch {
      /* 忽略 */
    }
    attached = false

    const dataUrl = `data:image/${cdpFormat};base64,${shot.data}`
    const blob = await (await fetch(dataUrl)).blob()
    const downloadId = await downloadImageBlob({
      blob,
      tabTitle: tab.title,
      ext: format
    })
    return { ok: true, downloadId }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }
  } finally {
    if (attached) {
      try {
        await chrome.debugger.detach(target)
      } catch {
        /* 忽略 */
      }
    }
  }
}
