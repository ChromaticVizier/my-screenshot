/**
 * 截图相关的 background 处理逻辑
 *
 * 五种模式：
 *   - 可视区域：单次 captureVisibleTab → 下载
 *   - 整页：滚动 + 多次截图 + OffscreenCanvas 拼接
 *   - 选区：注入遮罩 → 单次截图 → OffscreenCanvas 裁剪
 *   - 延迟可视区域：注入倒计时浮窗 → 复用「可视区域」
 *   - 整个屏幕或应用窗口：注入函数到当前页 → 调 getDisplayMedia
 *     → 抓首帧 → 下载（唯一不依赖 captureVisibleTab 的模式）
 */
import { showCountdown } from "~src/background/injected/countdown"
import {
  preparePage,
  restorePage,
  scrollToY,
  type PageMetrics,
  type PreparePageSnapshot
} from "~src/background/injected/fullPage"
import { pickSelection } from "~src/background/injected/selection"
import { downloadImageBlob } from "~src/background/utils/download"
import {
  cropToBlob,
  dataUrlToBitmap,
  stitchToBlob,
  type CaptureSlice
} from "~src/background/utils/imaging"
import { getCapturableActiveTab } from "~src/background/utils/tabHelper"
import type {
  CaptureDelayedRequest,
  CaptureDesktopRequest,
  CaptureFullPageRequest,
  CaptureResponse,
  CaptureSelectionRequest,
  CaptureVisibleRequest,
  CloseRelayWindowRequest,
  DownloadDesktopImageRequest,
  HideRelayWindowRequest
} from "~src/shared/messages"
import { MessageType } from "~src/shared/messages"
import { getSettings } from "~src/shared/settings"

/** captureVisibleTab 限频间隔（ms），Chrome 限制约 2 次/秒，留一点裕量 */
const CAPTURE_INTERVAL = 600

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * captureVisibleTab 的限频包装
 *
 * 关键点：
 * - 用模块级变量 lastCaptureAt 记录"上次发起调用"的时间戳，
 *   下一次调用前补齐至少 CAPTURE_INTERVAL 毫秒；
 * - 即使因其它原因（如另一处调用）已超频，捕获 quota 错误后再退避一次重试，
 *   避免单次失败让整轮长截图前功尽弃。
 */
let lastCaptureAt = 0

async function safeCaptureVisibleTab(
  windowId: number,
  options: chrome.tabs.CaptureVisibleTabOptions
): Promise<string> {
  const wait = lastCaptureAt + CAPTURE_INTERVAL - Date.now()
  if (wait > 0) await sleep(wait)

  try {
    lastCaptureAt = Date.now()
    return await chrome.tabs.captureVisibleTab(windowId, options)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes("MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND")) {
      // 命中 quota：退避后重试一次
      await sleep(CAPTURE_INTERVAL)
      lastCaptureAt = Date.now()
      return await chrome.tabs.captureVisibleTab(windowId, options)
    }
    throw err
  }
}

/* ============================================================
 * 1. 可视区域
 * ============================================================ */
export async function handleCaptureVisible(
  request: CaptureVisibleRequest
): Promise<CaptureResponse> {
  const format = request.payload?.format ?? "png"
  const quality = request.payload?.quality

  try {
    const tabRes = await getCapturableActiveTab()
    if (!tabRes.ok) return { ok: false, error: tabRes.error }

    const dataUrl = await safeCaptureVisibleTab(tabRes.tab.windowId, {
      format,
      ...(format === "jpeg" && quality != null ? { quality } : {})
    })
    if (!dataUrl) return { ok: false, error: "截图失败：返回数据为空" }

    const blob = await (await fetch(dataUrl)).blob()
    const downloadId = await downloadImageBlob({
      blob,
      tabTitle: tabRes.tab.title,
      ext: format
    })
    return { ok: true, downloadId }
  } catch (err) {
    return errorResponse(err)
  }
}

/* ============================================================
 * 2. 整页（滚动拼接）
 * ============================================================ */
export async function handleCaptureFullPage(
  request: CaptureFullPageRequest
): Promise<CaptureResponse> {
  const format = request.payload?.format ?? "png"
  const quality = request.payload?.quality

  const tabRes = await getCapturableActiveTab()
  if (!tabRes.ok) return { ok: false, error: tabRes.error }
  const tab = tabRes.tab
  const tabId = tab.id!

  let snapshot: PreparePageSnapshot | null = null

  try {
    // 1) 准备：隐藏 fixed/sticky，拿页面度量
    const [{ result: prepResult }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: preparePage
    })
    if (!prepResult) return { ok: false, error: "页面准备失败" }
    const metrics: PageMetrics = prepResult
    snapshot = prepResult.snapshot

    // 2) 滚动 + 多次截图
    const slices: CaptureSlice[] = []
    const stepHeight = metrics.viewportHeight
    const totalHeight = metrics.totalHeight
    let targetY = 0
    let prevScrollY = -1
    /**
     * 真实可达的页面总高度。
     * preparePage 报告的 totalHeight 可能因 margin/transform 等偏大，
     * 用「最后一屏的实际 scrollY + viewportHeight」夹紧后再交给拼接器，
     * 避免长图末尾出现空白条。
     */
    let effectiveHeight = Math.max(totalHeight, stepHeight)

    while (true) {
      // 滚到目标位置（可能因为页面底部不足而被夹到 maxScrollY）
      const [{ result: actualY }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: scrollToY,
        args: [targetY]
      })
      const scrollY = actualY ?? targetY

      // 滚动后留一帧时间让浏览器完成 layout/paint
      await sleep(120)

      const dataUrl = await safeCaptureVisibleTab(tab.windowId, {
        format: "png" // 中间帧统一用 png 无损，最后再按目标格式编码
      })
      if (!dataUrl) throw new Error("截图失败：返回数据为空")

      const bitmap = await dataUrlToBitmap(dataUrl)
      slices.push({ bitmap, scrollY })

      // 终止条件 1：页面无法再滚（实际 scrollY 与上一轮相同）
      // 这同时覆盖了：短页面无法滚动、totalHeight 高估、动态加载未触发等情况
      if (scrollY === prevScrollY) {
        effectiveHeight = scrollY + stepHeight
        break
      }

      // 终止条件 2：当前可视区已到达页面底部
      if (scrollY + stepHeight >= totalHeight) {
        effectiveHeight = Math.max(scrollY + stepHeight, totalHeight)
        break
      }

      prevScrollY = scrollY
      // 下一目标位置：步进一屏，但若下一步会超出页面，则改为对齐底部
      const nextY = scrollY + stepHeight
      targetY = Math.min(nextY, totalHeight - stepHeight)
    }

    // 3) 拼接
    const blob = await stitchToBlob({
      slices,
      viewportWidth: metrics.viewportWidth,
      totalHeight: effectiveHeight,
      devicePixelRatio: metrics.devicePixelRatio,
      format,
      quality
    })

    // 释放 bitmap
    slices.forEach((s) => s.bitmap.close())

    const downloadId = await downloadImageBlob({
      blob,
      tabTitle: tab.title,
      ext: format
    })
    return { ok: true, downloadId }
  } catch (err) {
    return errorResponse(err)
  } finally {
    // 4) 无论成功失败，恢复页面
    if (snapshot) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: restorePage,
          args: [snapshot]
        })
      } catch {
        /* 标签可能已关闭，忽略 */
      }
    }
  }
}

/* ============================================================
 * 3. 选区
 * ============================================================ */
export async function handleCaptureSelection(
  request: CaptureSelectionRequest
): Promise<CaptureResponse> {
  const format = request.payload?.format ?? "png"
  const quality = request.payload?.quality

  try {
    const tabRes = await getCapturableActiveTab()
    if (!tabRes.ok) return { ok: false, error: tabRes.error }
    const tab = tabRes.tab
    const tabId = tab.id!

    // 1) 注入遮罩并等待用户拖拽（注意：popup 此时已关闭，由 background 等待）
    const [{ result: selection }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: pickSelection
    })

    if (!selection) {
      return { ok: false, cancelled: true, error: "已取消" }
    }

    // 给浏览器一帧时间移除遮罩，避免它出现在截图里
    await sleep(80)

    // 2) 整屏截图
    const dataUrl = await safeCaptureVisibleTab(tab.windowId, {
      format: "png"
    })
    if (!dataUrl) return { ok: false, error: "截图失败：返回数据为空" }

    // 3) 裁剪
    const bitmap = await dataUrlToBitmap(dataUrl)
    const blob = await cropToBlob({
      source: bitmap,
      rect: {
        x: selection.x,
        y: selection.y,
        width: selection.width,
        height: selection.height
      },
      devicePixelRatio: selection.devicePixelRatio,
      format,
      quality
    })
    bitmap.close()

    const downloadId = await downloadImageBlob({
      blob,
      tabTitle: tab.title,
      ext: format
    })
    return { ok: true, downloadId }
  } catch (err) {
    return errorResponse(err)
  }
}

/* ============================================================
 * 4. 延迟可视区域
 *
 * 复用「可视区域」逻辑：先注入倒计时浮窗，结束后委托给 handleCaptureVisible。
 * ============================================================ */
export async function handleCaptureDelayed(
  request: CaptureDelayedRequest
): Promise<CaptureResponse> {
  try {
    const tabRes = await getCapturableActiveTab()
    if (!tabRes.ok) return { ok: false, error: tabRes.error }
    const tabId = tabRes.tab.id!

    // 1) 解析倒计时秒数：请求中显式指定 > 用户设置 > 默认值
    let seconds = request.payload?.seconds
    if (seconds == null) {
      const settings = await getSettings()
      seconds = settings.delaySeconds
    }
    seconds = Math.max(1, Math.min(60, Math.round(seconds)))

    // 2) 注入倒计时浮窗，等待用户操作或自然结束
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: showCountdown,
      args: [seconds]
    })

    if (result === "cancel") {
      return { ok: false, cancelled: true, error: "已取消" }
    }

    // 浮窗在 finish 时已经从 DOM 移除，再等一帧让浏览器完成重绘
    await sleep(80)

    // 3) 复用「可视区域」逻辑
    return handleCaptureVisible({
      type: MessageType.CAPTURE_VISIBLE,
      payload: {
        format: request.payload?.format,
        quality: request.payload?.quality
      }
    })
  } catch (err) {
    return errorResponse(err)
  }
}

/* ============================================================
 * 5. 整个屏幕或应用窗口
 *
 * 思路（参考 Awesome Screenshot 实现）：
 *   getDisplayMedia 必须在「持有用户手势」+「拥有 DOM 上下文」的环境中调用，
 *   service worker / 注入脚本都不满足。因此本扩展的做法是：
 *
 *     popup 点击 → background 用 chrome.windows.create 打开一个尺寸很小的
 *     「中转扩展窗口」（加载 popup.html?action=desktopCapture）
 *      → 该窗口里的 React 组件检测到 query 参数后立即调 getDisplayMedia
 *      → 弹出系统级共享选择器（用户截图里的「选择要分享什么」）
 *      → 用户选择后抓首帧 → 通过 storage 把 dataUrl 交给 background
 *      → background 下载并关闭中转窗口
 *
 * 这里 background 只负责「打开窗口」，真正的截图逻辑在 popup 入口分支里。
 * ============================================================ */
export async function handleCaptureDesktop(
  _request: CaptureDesktopRequest
): Promise<CaptureResponse> {
  try {
    const url = chrome.runtime.getURL("popup.html") + "?action=desktopCapture"
    await chrome.windows.create({
      url,
      type: "popup",
      width: 480,
      height: 560,
      focused: true
    })
    // 中转窗口接管后续流程；这里直接返回 ok，popup 端只用于关闭自身。
    return { ok: true }
  } catch (err) {
    return errorResponse(err)
  }
}

/**
 * 中转窗口请求把自己「移到屏幕外」（避免被截入屏幕共享画面）。
 *
 * Windows 上 Chrome 会把负坐标的窗口夹回主屏幕边缘，所以不能用
 * (-32000, -32000)。这里用 chrome.system.display 拿到所有显示器
 * bounds 的并集，把窗口放到并集**正下方**（top = maxBottom + 50），
 * 这是一个 100% 屏外的位置。
 *
 * 为什么不用 minimized：
 *   Chrome 会冻结最小化窗口的 JS 主循环（包括 setTimeout、rAF），
 *   导致后续抓帧、下载、关闭流程全部卡死。
 */
export async function handleHideRelayWindow(
  _request: HideRelayWindowRequest,
  sender: chrome.runtime.MessageSender
): Promise<{ ok: true }> {
  const winId = sender?.tab?.windowId
  if (winId == null) return { ok: true }

  try {
    // 计算所有显示器 bounds 的并集，找一个真正屏外的位置
    let outsideTop = 5000
    let safeLeft = 0
    try {
      const displays = await chrome.system.display.getInfo()
      let maxBottom = 0
      let minLeft = Number.POSITIVE_INFINITY
      for (const d of displays) {
        const bottom = d.bounds.top + d.bounds.height
        if (bottom > maxBottom) maxBottom = bottom
        if (d.bounds.left < minLeft) minLeft = d.bounds.left
      }
      outsideTop = maxBottom + 50
      safeLeft = Number.isFinite(minLeft) ? minLeft : 0
    } catch {
      /* 拿不到显示器信息时用默认大正值 */
    }

    await chrome.windows.update(winId, {
      left: safeLeft,
      top: outsideTop,
      width: 200,
      height: 200,
      focused: true
    })
    // 在 background 等动画完成；中转窗口里的 setTimeout 不论是否被节流
    // 都不影响这里
    await new Promise<void>((r) => setTimeout(r, 350))
  } catch {
    /* 忽略 */
  }
  return { ok: true }
}

/** 中转窗口完成全部流程后请求销毁自己 */
export async function handleCloseRelayWindow(
  _request: CloseRelayWindowRequest,
  sender: chrome.runtime.MessageSender
): Promise<{ ok: true }> {
  const winId = sender?.tab?.windowId
  if (winId != null) {
    try {
      await chrome.windows.remove(winId)
    } catch {
      /* 忽略 */
    }
  }
  return { ok: true }
}

/**
 * 中转窗口完成屏幕共享截图后，把 dataUrl 发回 background 走下载链路。
 * 单独走一个消息，避免在窗口间传 Blob 造成结构化克隆问题。
 */
export async function handleDownloadDesktopImage(
  request: DownloadDesktopImageRequest
): Promise<CaptureResponse> {
  try {
    const { dataUrl, format } = request.payload
    const blob = await (await fetch(dataUrl)).blob()
    const downloadId = await downloadImageBlob({
      blob,
      tabTitle: "screen",
      ext: format
    })
    return { ok: true, downloadId }
  } catch (err) {
    return errorResponse(err)
  }
}

/* ============================================================ */

function errorResponse(err: unknown): CaptureResponse {
  return {
    ok: false,
    error: err instanceof Error ? err.message : String(err)
  }
}
