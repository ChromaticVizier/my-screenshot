import {
  dumpDebugFrame,
  dumpDebugSlice,
  errorResponse,
  estimateFullPageProgressTotal,
  hostnameFromUrl,
  makeFullPageCapturingProgress,
  resolveFrameTarget,
  safeCaptureVisibleTab,
  sleep,
  updateFullPageProgressTotalEstimate,
  type FullPageRouting
} from "~src/background/handlers/fullPageShared"
import {
  hideFixedElements,
  measurePageBackground,
  measureScrollMetrics,
  preparePage,
  restorePage,
  scrollToY,
  waitForDynamicContent,
  type PageMetrics,
  type PreparePageSnapshot
} from "~src/background/injected/fullPage"
import { downloadImageBlob } from "~src/background/utils/download"
import { updateFullPageTaskProgress } from "~src/background/utils/fullPageTask"
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

function findChatComposerRoot(): {
  found: boolean
  top: number
  left: number
  width: number
  height: number
} {
  const vw = document.documentElement.clientWidth || window.innerWidth || 1
  const vh = document.documentElement.clientHeight || window.innerHeight || 1
  const controls = Array.from(
    document.querySelectorAll<HTMLElement>(
      'textarea,input,[contenteditable="true"],[role="textbox"]'
    )
  )
  for (const control of controls) {
    let r: DOMRect
    try {
      r = control.getBoundingClientRect()
    } catch {
      continue
    }
    if (r.width < 120 || r.height < 20) continue
    if (r.top < vh * 0.45 || r.bottom < vh * 0.65) continue
    let root: HTMLElement = control
    let cur: HTMLElement | null = control
    while (
      cur?.parentElement &&
      cur.parentElement !== document.documentElement
    ) {
      const parent = cur.parentElement
      let pr: DOMRect
      try {
        pr = parent.getBoundingClientRect()
      } catch {
        break
      }
      if (pr.width < r.width || pr.height < r.height) break
      if (pr.height > vh * 0.35 || pr.width > vw * 0.95) break
      if (pr.bottom < vh * 0.6) break
      root = parent
      cur = parent
    }
    const rr = root.getBoundingClientRect()
    return {
      found: true,
      top: Math.max(0, rr.top),
      left: Math.max(0, rr.left),
      width: rr.width,
      height: rr.height
    }
  }
  return { found: false, top: 0, left: 0, width: 0, height: 0 }
}

export async function handleCaptureFullPageChat(
  request: CaptureFullPageRequest,
  routing?: FullPageRouting
): Promise<CaptureResponse> {
  const tabRes = await getCapturableActiveTab()
  if (!tabRes.ok) return { ok: false, error: tabRes.error }
  const tab = tabRes.tab
  const tabId = tab.id!

  const settings = await getSettings()
  const format = request.payload?.format ?? settings.imageFormat
  const quality = request.payload?.quality ?? settings.imageQuality
  const fullPageRules = settings.fullPageRules
  const frameDelayMs = Math.max(
    0,
    Math.round(settings.fullPageFrameDelayMs ?? 1500)
  )
  const taskId = request.payload?.taskId
  const siteRule =
    routing?.siteRuleOverride !== undefined
      ? routing.siteRuleOverride
      : settings.siteScrollRegions[hostnameFromUrl(tab.url) ?? ""] ?? null
  const scrollerTarget = await resolveFrameTarget(tabId, siteRule?.frameUrl)

  let snapshot: PreparePageSnapshot | null = null

  try {
    const [{ result: prepResult }] = await chrome.scripting.executeScript({
      target: scrollerTarget,
      func: preparePage,
      args: [fullPageRules, siteRule]
    })
    if (!prepResult) return { ok: false, error: "页面准备失败" }

    const metrics: PageMetrics = prepResult
    snapshot = prepResult.snapshot

    let pageBackground = "#ffffff"
    try {
      const [{ result: bg }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: measurePageBackground
      })
      if (typeof bg === "string" && bg) pageBackground = bg
    } catch {
      /* 忽略 */
    }

    await chrome.scripting.executeScript({
      target: scrollerTarget,
      func: scrollToY,
      args: [0]
    })
    await sleep(120)

    const [{ result: composer }] = await chrome.scripting.executeScript({
      target: scrollerTarget,
      func: findChatComposerRoot
    })
    const composerHeight = composer?.found ? Math.ceil(composer.height) : 0
    const composerTop = composer?.found
      ? Math.max(0, Math.round(composer.top))
      : 0
    const firstSourceHeight = Math.max(
      1,
      metrics.captureHeight - composerHeight
    )
    const overlapRatio = Math.min(
      0.5,
      Math.max(0, fullPageRules.fullPageOverlapRatio ?? 0.05)
    )
    const stepHeight = Math.max(
      1,
      Math.floor(firstSourceHeight * (1 - overlapRatio))
    )
    const maxFullPageHeightPx = Math.max(
      0,
      Math.floor(fullPageRules.maxFullPageHeightPx ?? 0)
    )

    await chrome.scripting.executeScript({
      target: scrollerTarget,
      func: hideFixedElements,
      args: [fullPageRules]
    })

    const progressEstimate = await estimateFullPageProgressTotal(
      scrollerTarget,
      metrics.totalHeight,
      maxFullPageHeightPx,
      metrics.captureHeight
    )
    let progressTotal = progressEstimate.total
    let totalHeight = metrics.totalHeight
    const isInfiniteScroll = progressEstimate.infinite
    let effectiveHeight = Math.max(totalHeight, firstSourceHeight)
    updateFullPageTaskProgress(
      taskId,
      makeFullPageCapturingProgress(0, progressTotal)
    )
    const slices: CaptureSlice[] = []

    const firstDataUrl = await safeCaptureVisibleTab(tab.windowId, {
      format: "png"
    })
    if (!firstDataUrl) throw new Error("截图失败：返回数据为空")
    const firstBitmap = await dataUrlToBitmap(firstDataUrl)
    slices.push({
      bitmap: firstBitmap,
      scrollY: 0,
      sourceX: metrics.captureX,
      sourceY: metrics.captureY,
      sourceWidth: metrics.captureWidth,
      sourceHeight: firstSourceHeight,
      destX: metrics.captureX
    })
    await dumpDebugFrame(firstDataUrl, 0, 0, {
      chatExpert: true,
      composerHeight,
      firstSourceHeight
    })
    await dumpDebugSlice(
      firstBitmap,
      0,
      slices[slices.length - 1],
      metrics.devicePixelRatio
    )

    let targetY = stepHeight
    let prevScrollY = 0
    let stallCount = 0
    const MAX_STALL = 4
    const DYNAMIC_WAIT_MS = 1500
    let frameIndex = 0
    let lastScrollY = 0
    let lastBitmap: ImageBitmap | null = null
    let lastSlice: CaptureSlice | null = null

    while (true) {
      updateFullPageTaskProgress(
        taskId,
        makeFullPageCapturingProgress(targetY, progressTotal)
      )
      const [{ result: actualY }] = await chrome.scripting.executeScript({
        target: scrollerTarget,
        func: scrollToY,
        args: [targetY]
      })
      let scrollY = actualY ?? targetY
      if (frameDelayMs > 0) await sleep(frameDelayMs)

      let measuredHeight = totalHeight
      try {
        const [{ result: waitResult }] = await chrome.scripting.executeScript({
          target: scrollerTarget,
          func: waitForDynamicContent,
          args: [DYNAMIC_WAIT_MS]
        })
        if (waitResult && typeof waitResult.scrollHeight === "number") {
          measuredHeight = waitResult.scrollHeight
        }
      } catch {
        await sleep(120)
      }

      try {
        const [{ result: metricsNow }] = await chrome.scripting.executeScript({
          target: scrollerTarget,
          func: measureScrollMetrics
        })
        if (metricsNow) {
          if (metricsNow.scrollHeight > measuredHeight) {
            measuredHeight = metricsNow.scrollHeight
          }
          if (typeof metricsNow.scrollTop === "number") {
            scrollY = metricsNow.scrollTop
          }
        }
      } catch {
        /* 忽略 */
      }

      if (measuredHeight > totalHeight) {
        totalHeight = measuredHeight
        effectiveHeight = Math.max(effectiveHeight, totalHeight)
        progressTotal = updateFullPageProgressTotalEstimate(
          progressTotal,
          measuredHeight,
          maxFullPageHeightPx
        )
        updateFullPageTaskProgress(
          taskId,
          makeFullPageCapturingProgress(scrollY, progressTotal)
        )
      }

      try {
        const [{ result: finalMetrics }] = await chrome.scripting.executeScript(
          {
            target: scrollerTarget,
            func: measureScrollMetrics
          }
        )
        if (finalMetrics && typeof finalMetrics.scrollTop === "number") {
          scrollY = finalMetrics.scrollTop
        }
      } catch {
        /* 忽略 */
      }

      const dataUrl = await safeCaptureVisibleTab(tab.windowId, {
        format: "png"
      })
      if (!dataUrl) throw new Error("截图失败：返回数据为空")
      const bitmap = await dataUrlToBitmap(dataUrl)
      const slice: CaptureSlice = {
        bitmap,
        scrollY,
        sourceX: metrics.captureX,
        sourceY: metrics.captureY,
        sourceWidth: metrics.captureWidth,
        sourceHeight: firstSourceHeight,
        destX: metrics.captureX
      }

      if (lastBitmap) {
        slices.push(lastSlice!)
      }
      lastBitmap = bitmap
      lastSlice = slice
      lastScrollY = scrollY

      frameIndex++
      await dumpDebugFrame(dataUrl, frameIndex, scrollY, {
        chatExpert: true,
        targetY,
        totalHeight,
        measuredHeight,
        stallCount
      })
      await dumpDebugSlice(bitmap, frameIndex, slice, metrics.devicePixelRatio)

      if (scrollY === prevScrollY) {
        stallCount++
        if (stallCount >= MAX_STALL) {
          effectiveHeight = Math.max(
            scrollY + metrics.captureHeight,
            totalHeight,
            effectiveHeight
          )
          break
        }
        targetY = scrollY + stepHeight
        continue
      }
      stallCount = 0

      if (
        maxFullPageHeightPx > 0 &&
        scrollY + metrics.captureHeight >= maxFullPageHeightPx
      ) {
        effectiveHeight = Math.min(
          maxFullPageHeightPx,
          Math.max(
            scrollY + metrics.captureHeight,
            totalHeight,
            effectiveHeight
          )
        )
        break
      }

      if (
        !isInfiniteScroll &&
        scrollY + metrics.captureHeight >= totalHeight
      ) {
        effectiveHeight = Math.max(
          scrollY + metrics.captureHeight,
          totalHeight,
          effectiveHeight
        )
        break
      }

      prevScrollY = scrollY
      targetY = scrollY + stepHeight
    }

    try {
      await chrome.scripting.executeScript({
        target: scrollerTarget,
        func: restorePage,
        args: [snapshot]
      })
      snapshot = null
    } catch {
      /* finally 兜底 */
    }

    if (lastBitmap && lastSlice) {
      const lastDataUrl = await safeCaptureVisibleTab(tab.windowId, {
        format: "png"
      })
      lastBitmap.close()
      const visibleComposerBitmap = await dataUrlToBitmap(lastDataUrl!)
      slices.push({
        bitmap: visibleComposerBitmap,
        scrollY: lastScrollY,
        sourceX: metrics.captureX,
        sourceY: metrics.captureY,
        sourceWidth: metrics.captureWidth,
        sourceHeight: metrics.captureHeight,
        destX: metrics.captureX
      })
    }

    const canvasHeight = Math.max(
      effectiveHeight,
      lastScrollY + metrics.captureHeight
    )
    updateFullPageTaskProgress(taskId, {
      phase: "stitching",
      current: 1,
      total: 1,
      message: "正在拼接"
    })
    const blob = await stitchToBlob({
      slices,
      viewportWidth: metrics.viewportWidth,
      totalHeight: canvasHeight,
      devicePixelRatio: metrics.devicePixelRatio,
      format,
      quality,
      backgroundColor: pageBackground
    })

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
    if (snapshot) {
      try {
        await chrome.scripting.executeScript({
          target: scrollerTarget,
          func: restorePage,
          args: [snapshot]
        })
      } catch {
        /* 忽略 */
      }
    }
  }
}
