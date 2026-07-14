/**
 * 飞书多维表格（Bitable / 虚拟化 canvas grid）整页截图。
 *
 * 与普通滚动容器不同：内容画在 canvas 上、由 wheel 事件驱动虚拟滚动、列头冻结。
 * 见 src/background/injected/canvasGrid.ts 的注入辅助函数。
 *
 * 流程：
 *  1. prepareCanvasGrid：定位 canvas、冻结、滚回顶部、量列头高度
 *  2. 首帧整块截 canvas（含列头）
 *  3. 逐帧 scrollCanvasGridTo(下一偏移) → 截图 → 裁掉列头后拼到画布
 *  4. 偏移不再推进（触底）即结束，restoreCanvasGrid 还原
 */
import {
  errorResponse,
  locateFrameOffsetInPage,
  makeFullPageCapturingProgress,
  resolveFrameTarget,
  safeCaptureVisibleTab,
  sleep,
  type FullPageRouting
} from "~src/background/handlers/fullPageShared"
import {
  prepareCanvasGrid,
  restoreCanvasGrid,
  scrollCanvasGridStepDown,
  type CanvasGridMetrics
} from "~src/background/injected/canvasGrid"
import { downloadImageBlob } from "~src/background/utils/download"
import {
  assertFullPageTaskNotCancelled,
  shouldStopFullPageCapture,
  updateFullPageTaskProgress
} from "~src/background/utils/fullPageTask"
import {
  dataUrlToBitmap,
  stitchToBlob,
  type CaptureSlice
} from "~src/background/utils/imaging"
import { getCapturableActiveTab } from "~src/background/utils/tabHelper"
import type {
  CaptureFullPageRequest,
  CaptureResponse
} from "~src/shared/messages"
import { getSettings } from "~src/shared/settings"

/** 检测某页（或其子 frame）是否存在可滚动 canvas 表格（供路由/回退判断） */
export async function detectCanvasGrid(
  tabId: number,
  selector?: string,
  frameUrl?: string
): Promise<CanvasGridMetrics | null> {
  try {
    const target = await resolveFrameTarget(tabId, frameUrl)
    const [{ result }] = await chrome.scripting.executeScript({
      target,
      func: prepareCanvasGrid,
      args: [selector ?? ""]
    })
    return result && result.found ? result : null
  } catch {
    return null
  }
}

export async function handleCaptureFullPageCanvasGrid(
  request: CaptureFullPageRequest,
  routing?: FullPageRouting,
  prepared?: CanvasGridMetrics
): Promise<CaptureResponse> {
  const tabRes = await getCapturableActiveTab()
  if (!tabRes.ok) return { ok: false, error: tabRes.error }
  const tab = tabRes.tab
  const tabId = tab.id!
  // 用户手动选中的 canvas selector（若有）：优先精确定位该 canvas
  const selector = routing?.siteRuleOverride?.selector || ""
  // canvas 可能在跨域 iframe 内（如 POPo 内嵌网易灵犀表格）。若手动规则记录了
  // frameUrl，注入目标定位到该 frame，并测出 iframe 在主 frame 中的偏移，
  // 用于把「frame 局部 canvas 矩形」换算成整窗裁切坐标。
  const frameUrl = routing?.siteRuleOverride?.frameUrl
  const injectTarget = await resolveFrameTarget(tabId, frameUrl)
  const isSubFrame =
    !!frameUrl &&
    !!injectTarget.frameIds &&
    injectTarget.frameIds.length > 0 &&
    injectTarget.frameIds[0] !== 0
  let frameOffsetX = 0
  let frameOffsetY = 0
  if (isSubFrame && frameUrl) {
    try {
      const [{ result: off }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: locateFrameOffsetInPage,
        args: [frameUrl]
      })
      if (off && typeof off === "object") {
        frameOffsetX = off.x ?? 0
        frameOffsetY = off.y ?? 0
      }
    } catch {
      /* 取不到偏移则按 0 处理 */
    }
  }

  const settings = await getSettings()
  const taskId = request.payload?.taskId
  const format = request.payload?.format ?? settings.imageFormat
  const quality = request.payload?.quality ?? settings.imageQuality
  const fullPageRules = settings.fullPageRules
  const maxFullPageHeightPx = Math.max(
    0,
    Math.floor(fullPageRules.maxFullPageHeightPx ?? 0)
  )

  try {
    // 1) 准备（若路由已探测过则复用，避免二次滚回顶部）
    let metrics = prepared ?? null
    if (!metrics) {
      const [{ result }] = await chrome.scripting.executeScript({
        target: injectTarget,
        func: prepareCanvasGrid,
        args: [selector]
      })
      metrics = result ?? null
    }
    assertFullPageTaskNotCancelled(taskId)
    if (!metrics || !metrics.found) {
      return { ok: false, error: "未找到可滚动的 canvas 表格" }
    }

    const dpr = metrics.devicePixelRatio || 1
    const viewportH = metrics.canvasH
    const headerH = Math.max(0, Math.min(metrics.headerH, viewportH - 20))
    // 步长：视口高度减去冻结列头，再留一点重叠补偿
    const overlap = Math.round(
      Math.max(
        0,
        Math.min(0.2, fullPageRules.fullPageOverlapRatio ?? 0.05)
      ) * viewportH
    )
    const step = Math.max(40, viewportH - headerH - overlap)

    updateFullPageTaskProgress(taskId, {
      phase: "capturing",
      current: 1,
      total: Math.max(1, viewportH),
      message: "正在滚动并截图"
    })

    const slices: CaptureSlice[] = []
    // 把 frame 局部坐标换算成整窗裁切坐标
    const crop = {
      x: Math.max(0, Math.round(frameOffsetX + metrics.canvasX)),
      y: Math.max(0, Math.round(frameOffsetY + metrics.canvasY)),
      w: metrics.canvasW
    }

    // 2) 首帧（含列头）：prepare 已滚到顶部，偏移为 0
    let offset = 0
    const firstUrl = await safeCaptureVisibleTab(tab.windowId, { format: "png" })
    assertFullPageTaskNotCancelled(taskId)
    if (!firstUrl) throw new Error("截图失败：返回数据为空")
    slices.push({
      bitmap: await dataUrlToBitmap(firstUrl),
      scrollY: 0,
      destX: 0,
      sourceX: crop.x,
      sourceY: crop.y,
      sourceWidth: crop.w,
      sourceHeight: viewportH
    })

    // 3) 逐帧：单调向下步进，裁掉列头后拼接
    let prevOffset = offset
    let stall = 0
    const MAX_FRAMES = 400
    let contentBottom = viewportH

    for (let i = 0; i < MAX_FRAMES; i++) {
      if (shouldStopFullPageCapture(taskId)) break

      // 单调向下步进一屏（内部单次短滚动，快速返回，便于响应强制停止）
      const [{ result: stepRes }] = await chrome.scripting.executeScript({
        target: injectTarget,
        func: scrollCanvasGridStepDown,
        args: [selector]
      })
      offset =
        stepRes && typeof stepRes.offset === "number" ? stepRes.offset : offset
      const atBottom = !!(stepRes && stepRes.atBottom)
      await sleep(140)

      if (shouldStopFullPageCapture(taskId)) break

      // 触底：偏移无法再推进
      if (offset <= prevOffset + 2) {
        if (atBottom || ++stall >= 2) break
      } else {
        stall = 0
      }

      const url = await safeCaptureVisibleTab(tab.windowId, { format: "png" })
      if (!url) break
      const bitmap = await dataUrlToBitmap(url)
      // 从 headerH 向下裁切，避免冻结列头逐帧重复
      slices.push({
        bitmap,
        scrollY: offset + headerH,
        destX: crop.x,
        sourceX: crop.x,
        sourceY: crop.y + headerH,
        sourceWidth: crop.w,
        sourceHeight: viewportH - headerH
      })
      contentBottom = offset + viewportH

      updateFullPageTaskProgress(
        taskId,
        makeFullPageCapturingProgress(
          offset,
          maxFullPageHeightPx > 0
            ? Math.min(maxFullPageHeightPx, contentBottom + step)
            : contentBottom + step
        )
      )

      if (maxFullPageHeightPx > 0 && offset + viewportH >= maxFullPageHeightPx) {
        break
      }
      if (atBottom) break

      prevOffset = offset
    }

    // 4) 还原
    try {
      await chrome.scripting.executeScript({
        target: injectTarget,
        func: restoreCanvasGrid
      })
    } catch {
      /* 忽略 */
    }

    if (slices.length === 0) {
      assertFullPageTaskNotCancelled(taskId)
      throw new Error("未截取到任何内容")
    }

    updateFullPageTaskProgress(taskId, {
      phase: "stitching",
      current: 1,
      total: 1,
      message: "正在拼接"
    })

    const canvasHeight =
      maxFullPageHeightPx > 0
        ? Math.min(maxFullPageHeightPx, contentBottom)
        : contentBottom
    const blob = await stitchToBlob({
      slices,
      viewportWidth: crop.w,
      totalHeight: canvasHeight,
      devicePixelRatio: dpr,
      format,
      quality,
      backgroundColor: "#ffffff"
    })

    slices.forEach((s) => s.bitmap.close())

    const downloadId = await downloadImageBlob({
      blob,
      tabTitle: tab.title,
      ext: format
    })
    return { ok: true, downloadId }
  } catch (err) {
    try {
      await chrome.scripting.executeScript({
        target: injectTarget,
        func: restoreCanvasGrid
      })
    } catch {
      /* 忽略 */
    }
    return errorResponse(err)
  }
}
