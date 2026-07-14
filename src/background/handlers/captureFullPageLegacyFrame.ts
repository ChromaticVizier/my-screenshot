import {
  dumpDebugFrame,
  dumpDebugSlice,
  errorResponse,
  safeCaptureVisibleTab,
  sleep
} from "~src/background/handlers/fullPageShared"
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

import type { FullPageRouting } from "./fullPageShared"

export async function handleCaptureFullPageLegacyFrame(
  request: CaptureFullPageRequest,
  routing?: FullPageRouting
): Promise<CaptureResponse> {
  const tabRes = await getCapturableActiveTab()
  if (!tabRes.ok) return { ok: false, error: tabRes.error }
  const tab = tabRes.tab
  const tabId = tab.id!
  const settings = await getSettings()
  const taskId = request.payload?.taskId
  const format = request.payload?.format ?? settings.imageFormat
  const quality = request.payload?.quality ?? settings.imageQuality
  const overlapRatio = Math.min(
    0.5,
    Math.max(0, settings.fullPageRules.fullPageOverlapRatio ?? 0.05)
  )
  const frameUrl = routing?.siteRuleOverride?.frameUrl
  if (!frameUrl) return { ok: false, error: "未找到可滚动 frame" }

  const target = await resolveLegacyFrameTarget(tabId, frameUrl)
  const [{ result: metrics }] = await chrome.scripting.executeScript({
    target,
    func: prepareLegacyFrameCapture
  })
  assertFullPageTaskNotCancelled(taskId)
  if (!metrics) return { ok: false, error: "frame 页面准备失败" }

  let frameOffsetX = 0
  let frameOffsetY = 0
  try {
    const [{ result: offset }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: locateLegacyFrameOffsetInPage,
      args: [frameUrl]
    })
    if (offset) {
      frameOffsetX = offset.x ?? 0
      frameOffsetY = offset.y ?? 0
    }
  } catch {
    /* ignore */
  }

  const stepHeight = Math.max(
    1,
    Math.floor(metrics.captureHeight * (1 - overlapRatio))
  )
  let totalHeight = Math.max(metrics.totalHeight, metrics.captureHeight)
  updateFullPageTaskProgress(taskId, {
    phase: "capturing",
    current: 1,
    total: totalHeight,
    message: "正在滚动 frame 并截图"
  })

  const slices: CaptureSlice[] = []
  let chromeCollapsed = false
  try {
    await chrome.scripting.executeScript({
      target,
      func: legacyFrameScrollTo,
      args: [0]
    })
    await sleep(120)
    const firstDataUrl = await safeCaptureVisibleTab(tab.windowId, {
      format: "png"
    })
    assertFullPageTaskNotCancelled(taskId)
    const firstBitmap = await dataUrlToBitmap(firstDataUrl)
    slices.push(
      makeSlice(firstBitmap, 0, metrics, frameOffsetX, frameOffsetY, true)
    )
    await dumpDebugFrame(firstDataUrl, 0, 0, { legacyFrame: true, totalHeight })
    await dumpDebugSlice(firstBitmap, 0, slices[0], metrics.devicePixelRatio)

    await chrome.scripting.executeScript({
      target: { tabId },
      func: collapseLegacyFrameChrome,
      args: [frameUrl]
    })
    chromeCollapsed = true
    await sleep(80)

    let targetY = stepHeight
    let prevY = -1
    let frameIndex = 0
    while (targetY < totalHeight) {
      if (shouldStopFullPageCapture(taskId)) break
      updateFullPageTaskProgress(taskId, {
        phase: "capturing",
        current: Math.min(totalHeight, Math.max(1, targetY)),
        total: Math.max(1, totalHeight),
        message: "正在滚动 frame 并截图"
      })
      const [{ result: state }] = await chrome.scripting.executeScript({
        target,
        func: legacyFrameScrollTo,
        args: [targetY]
      })
      const scrollY = state?.scrollTop ?? targetY
      if (
        typeof state?.scrollHeight === "number" &&
        state.scrollHeight > totalHeight
      ) {
        totalHeight = state.scrollHeight
      }
      if (scrollY === prevY) break
      await sleep(
        Math.max(0, Math.round(settings.fullPageFrameDelayMs ?? 1000))
      )
      const dataUrl = await safeCaptureVisibleTab(tab.windowId, {
        format: "png"
      })
      const bitmap = await dataUrlToBitmap(dataUrl)
      slices.push(
        makeSlice(bitmap, scrollY, metrics, frameOffsetX, frameOffsetY, false)
      )
      frameIndex++
      await dumpDebugFrame(dataUrl, frameIndex, scrollY, {
        legacyFrame: true,
        totalHeight
      })
      await dumpDebugSlice(
        bitmap,
        frameIndex,
        slices[slices.length - 1],
        metrics.devicePixelRatio
      )
      if (scrollY + stepHeight >= totalHeight) break
      prevY = scrollY
      targetY = scrollY + stepHeight
    }

    updateFullPageTaskProgress(taskId, {
      phase: "stitching",
      current: 1,
      total: 1,
      message: "正在拼接"
    })
    const blob = await stitchToBlob({
      slices,
      viewportWidth: metrics.viewportWidth,
      totalHeight,
      devicePixelRatio: metrics.devicePixelRatio,
      format,
      quality
    })
    slices.forEach((s) => s.bitmap.close())
    const downloadId = await downloadImageBlob({
      blob,
      tabTitle: tab.title,
      ext: format
    })
    if (chromeCollapsed) {
      await chrome.scripting
        .executeScript({
          target: { tabId },
          func: restoreLegacyFrameChrome
        })
        .catch(() => undefined)
      chromeCollapsed = false
    }
    return { ok: true, downloadId }
  } catch (err) {
    slices.forEach((s) => s.bitmap.close())
    if (chromeCollapsed) {
      await chrome.scripting
        .executeScript({
          target: { tabId },
          func: restoreLegacyFrameChrome
        })
        .catch(() => undefined)
    }
    return errorResponse(err)
  }
}

function collapseLegacyFrameChrome(keepFrameUrl: string): void {
  const ATTR = "data-my-ss-legacy-frame-original"
  const matches = (a: string, b: string): boolean => {
    if (!a || !b) return false
    if (a === b) return true
    try {
      const ua = new URL(a)
      const ub = new URL(b)
      return (
        ua.origin === ub.origin &&
        ua.pathname.split("/")[1] === ub.pathname.split("/")[1]
      )
    } catch {
      return false
    }
  }
  document.querySelectorAll<HTMLFrameElement>("frame").forEach((f) => {
    let href = ""
    try {
      href = f.contentDocument?.location?.href ?? ""
    } catch {
      href = ""
    }
    if (matches(f.src, keepFrameUrl) || matches(href, keepFrameUrl)) return
    if (!f.hasAttribute(ATTR)) {
      f.setAttribute(
        ATTR,
        JSON.stringify({
          noResize: f.getAttribute("noresize"),
          scrolling: f.getAttribute("scrolling"),
          style: f.getAttribute("style")
        })
      )
    }
    f.setAttribute("scrolling", "no")
    f.style.setProperty("visibility", "hidden", "important")
  })
}

function restoreLegacyFrameChrome(): void {
  const ATTR = "data-my-ss-legacy-frame-original"
  document.querySelectorAll<HTMLFrameElement>(`frame[${ATTR}]`).forEach((f) => {
    try {
      const raw = f.getAttribute(ATTR)
      const state = raw ? JSON.parse(raw) : {}
      if (state.scrolling == null) f.removeAttribute("scrolling")
      else f.setAttribute("scrolling", state.scrolling)
      if (state.noResize == null) f.removeAttribute("noresize")
      else f.setAttribute("noresize", state.noResize)
      if (state.style == null) f.removeAttribute("style")
      else f.setAttribute("style", state.style)
      f.removeAttribute(ATTR)
    } catch {
      f.removeAttribute(ATTR)
    }
  })
}

function makeSlice(
  bitmap: ImageBitmap,
  scrollY: number,
  metrics: LegacyFrameMetrics,
  frameOffsetX: number,
  frameOffsetY: number,
  includeChromeFrame: boolean
): CaptureSlice {
  return {
    bitmap,
    scrollY: includeChromeFrame ? 0 : scrollY + frameOffsetY,
    sourceX: includeChromeFrame ? 0 : frameOffsetX,
    sourceY: includeChromeFrame ? 0 : frameOffsetY,
    sourceWidth: includeChromeFrame
      ? metrics.viewportWidth
      : metrics.captureWidth,
    sourceHeight: includeChromeFrame
      ? Math.min(metrics.viewportHeight, frameOffsetY + metrics.captureHeight)
      : metrics.captureHeight,
    destX: 0
  }
}

function locateLegacyFrameOffsetInPage(frameUrl: string): {
  x: number
  y: number
  matchedBy: "exact" | "loose" | "largest" | "none"
} {
  const matches = (a: string, b: string): boolean => {
    if (!a || !b) return false
    if (a === b) return true
    try {
      const ua = new URL(a)
      const ub = new URL(b)
      return (
        ua.origin === ub.origin &&
        ua.pathname.split("/")[1] === ub.pathname.split("/")[1]
      )
    } catch {
      return false
    }
  }

  const frames = Array.from(
    document.querySelectorAll<HTMLFrameElement>("frame")
  )
  for (const f of frames) {
    const r = f.getBoundingClientRect()
    let href = ""
    try {
      href = f.contentDocument?.location?.href ?? ""
    } catch {
      href = ""
    }
    if (f.src === frameUrl || href === frameUrl) {
      return { x: r.left, y: r.top, matchedBy: "exact" }
    }
    if (matches(f.src, frameUrl) || matches(href, frameUrl)) {
      return { x: r.left, y: r.top, matchedBy: "loose" }
    }
  }

  let best: { frame: HTMLFrameElement; area: number } | null = null
  frames.forEach((f) => {
    const r = f.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return
    let docH = 0
    try {
      const doc = f.contentDocument
      docH = doc
        ? Math.max(
            doc.documentElement.scrollHeight,
            doc.body?.scrollHeight ?? 0
          )
        : 0
    } catch {
      docH = 0
    }
    const scrollBonus = docH > r.height + 8 ? 10 : 1
    const area = r.width * r.height * scrollBonus
    if (!best || area > best.area) best = { frame: f, area }
  })
  if (best) {
    const r = best.frame.getBoundingClientRect()
    return { x: r.left, y: r.top, matchedBy: "largest" }
  }
  return { x: 0, y: 0, matchedBy: "none" }
}

async function resolveLegacyFrameTarget(
  tabId: number,
  frameUrl: string
): Promise<chrome.scripting.InjectionTarget> {
  const frames = (await chrome.webNavigation.getAllFrames({ tabId })) ?? []
  const exact = frames.find((f) => f.url === frameUrl)
  if (exact) return { tabId, frameIds: [exact.frameId] }
  const loose = frames.find((f) => {
    try {
      const a = new URL(f.url)
      const b = new URL(frameUrl)
      return (
        a.origin === b.origin &&
        a.pathname.split("/")[1] === b.pathname.split("/")[1]
      )
    } catch {
      return false
    }
  })
  if (loose) return { tabId, frameIds: [loose.frameId] }
  return { tabId }
}

interface LegacyFrameMetrics {
  viewportWidth: number
  viewportHeight: number
  captureWidth: number
  captureHeight: number
  totalHeight: number
  devicePixelRatio: number
}

function prepareLegacyFrameCapture(): LegacyFrameMetrics {
  const html = document.documentElement
  const body = document.body
  const target = body || html
  html.style.setProperty("scroll-behavior", "auto", "important")
  body?.style.setProperty("scroll-behavior", "auto", "important")
  const viewportWidth = Math.max(
    1,
    Math.round(window.top?.innerWidth || window.innerWidth || 1)
  )
  const viewportHeight = Math.max(
    1,
    Math.round(window.top?.innerHeight || window.innerHeight || 1)
  )
  const captureWidth = Math.max(
    1,
    Math.round(html.clientWidth || window.innerWidth || 1)
  )
  const captureHeight = Math.max(
    1,
    Math.round(window.innerHeight || html.clientHeight || 1)
  )
  const totalHeight = Math.max(
    captureHeight,
    Math.round(
      Math.max(
        html.scrollHeight,
        body?.scrollHeight ?? 0,
        html.offsetHeight,
        body?.offsetHeight ?? 0,
        target.scrollHeight
      )
    )
  )
  return {
    viewportWidth,
    viewportHeight,
    captureWidth,
    captureHeight,
    totalHeight,
    devicePixelRatio: window.devicePixelRatio || 1
  }
}

function legacyFrameScrollTo(y: number): {
  scrollTop: number
  scrollHeight: number
} {
  const html = document.documentElement
  const body = document.body
  window.scrollTo(0, y)
  if (body) body.scrollTop = y
  html.scrollTop = y
  const scrollTop = Math.max(
    window.scrollY || 0,
    body?.scrollTop ?? 0,
    html.scrollTop || 0
  )
  return {
    scrollTop,
    scrollHeight: Math.max(
      html.scrollHeight,
      body?.scrollHeight ?? 0,
      html.offsetHeight,
      body?.offsetHeight ?? 0
    )
  }
}
