/**
 * 「网页内嵌自定义滚动文档 / 表格」专家（embedded-doc）。
 *
 * 适配：网易灵犀（SpreadJS）等在 iframe 内、用 canvas 渲染、靠键盘/wheel 自定义滚动的
 * 表格 / 文档——没有原生可滚动元素，设 scrollTop 无效，旧流程「无法滚动」。
 *
 * 流程：
 *   1. 定位承载文档的 frame（路由器从主 frame 探测到的主体 iframe 传入 frameUrl）。
 *   2. 注入 detectEmbeddedScrollDoc：若不是自定义滚动文档 → 回退到隔离/iframe 专家。
 *   3. 首帧：整窗截图（保留 POPO / office 顶部 + 侧边工具栏，只此一帧）。
 *   4. 后续帧：聚焦网格按 PageDown 逐页滚动；用竖直滚动条 thumb 位置换算网格内容
 *      偏移 scrollPos，裁切「网格区」拼到长图对应位置；thumb 到底即停。
 *
 * 滚动进度换算（见 embeddedDoc.ts）：
 *   scrollPos = (thumbTop - trackTop) * gridHeight / thumbHeight
 */
import { handleCaptureFullPageAggressive } from "~src/background/handlers/captureFullPageAggressive"
import {
  errorResponse,
  locateFrameOffsetInPage,
  resolveFrameTarget,
  safeCaptureVisibleTab,
  sleep,
  type FullPageRouting
} from "~src/background/handlers/fullPageShared"
import {
  detectEmbeddedScrollDoc,
  embeddedScrollState,
  embeddedScrollStepDown,
  embeddedScrollToTop,
  type EmbeddedScrollProbe
} from "~src/background/injected/embeddedDoc"
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

export async function handleCaptureFullPageEmbeddedDoc(
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
  const maxHeight = Math.max(
    0,
    Math.floor(settings.fullPageRules.maxFullPageHeightPx ?? 0)
  )
  const taskId = request.payload?.taskId
  // 长截图相邻两帧之间的等待时长（毫秒，用户可调，默认 1500）；canvas 表格滚动后需要
  // 时间重绘，至少留 200ms。
  const frameDelayMs = Math.max(
    200,
    Math.round(settings.fullPageFrameDelayMs ?? 1500)
  )

  // 重新探测「当前」主体 iframe 的 src：手动选区里存的 frameUrl 可能带旧 timestamp，
  // 与现在的 iframe URL 不一致 → resolveFrameTarget 匹配失败；用实时最大 iframe src 兜底。
  let frameUrl = routing?.siteRuleOverride?.frameUrl ?? ""
  try {
    const [{ result: src }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        let best = ""
        let bestArea = 0
        document.querySelectorAll("iframe").forEach((f) => {
          const r = f.getBoundingClientRect()
          if (r.width <= 0 || r.height <= 0) return
          const area = r.width * r.height
          if (area > bestArea && /^https?:/i.test(f.src || "")) {
            bestArea = area
            best = f.src
          }
        })
        return best
      }
    })
    if (typeof src === "string" && /^https?:/i.test(src)) frameUrl = src
  } catch {
    /* 用 routing 里的 frameUrl */
  }
  if (!frameUrl) {
    // 没有目标 iframe → 交回隔离专家
    return handleCaptureFullPageAggressive(request, routing)
  }

  // 定位承载文档的 frame + 它在主 frame 视口中的偏移
  const frameTarget = await resolveFrameTarget(tabId, frameUrl)
  const isSubFrame =
    !!frameTarget.frameIds &&
    frameTarget.frameIds.length > 0 &&
    frameTarget.frameIds[0] !== 0
  let frameOffsetX = 0
  let frameOffsetY = 0
  if (isSubFrame) {
    try {
      const [{ result: offset }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: locateFrameOffsetInPage,
        args: [frameUrl]
      })
      if (offset && typeof offset === "object") {
        frameOffsetX = offset.x ?? 0
        frameOffsetY = offset.y ?? 0
      }
    } catch {
      /* 失败按 0 处理 */
    }
  }

  // 探测：是否自定义滚动文档
  let probe: EmbeddedScrollProbe | null = null
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: frameTarget,
      func: detectEmbeddedScrollDoc
    })
    probe = (result as EmbeddedScrollProbe | undefined) ?? null
  } catch (err) {
    console.warn("[embeddedDoc] detect failed", err)
    probe = null
  }
  console.log("[embeddedDoc] target", {
    frameUrl: frameUrl.slice(0, 60),
    isSubFrame,
    frameIds: frameTarget.frameIds,
    frameOffsetX,
    frameOffsetY,
    probe
  })
  if (!probe || !probe.isCustomScroll) {
    // 不是自定义滚动文档 → 回退隔离/iframe 专家
    console.log("[embeddedDoc] not a custom-scroll doc → fallback aggressive")
    return handleCaptureFullPageAggressive(request, routing)
  }
  const gridProbe = probe

  try {
    // 主 frame 视口尺寸 + dpr
    let vw = 1536
    let vh = 674
    let dpr = 1
    try {
      const [{ result: vp }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => ({
          w: document.documentElement.clientWidth,
          h: document.documentElement.clientHeight,
          dpr: window.devicePixelRatio || 1,
          bg:
            getComputedStyle(document.body).backgroundColor ||
            getComputedStyle(document.documentElement).backgroundColor ||
            "#ffffff"
        })
      })
      if (vp && typeof vp === "object") {
        vw = vp.w ?? vw
        vh = vp.h ?? vh
        dpr = vp.dpr ?? dpr
      }
    } catch {
      /* 用默认 */
    }
    let pageBackground = "#ffffff"
    try {
      const [{ result: bg }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () =>
          getComputedStyle(document.body).backgroundColor ||
          getComputedStyle(document.documentElement).backgroundColor ||
          "#ffffff"
      })
      if (typeof bg === "string" && bg) pageBackground = bg
    } catch {
      /* 默认白 */
    }

    // 网格区在「整个标签页视口」中的矩形（frame 偏移 + frame 内 canvas 位置）
    const gridLeftTab = frameOffsetX + gridProbe.gridLeft
    const gridTopTab = frameOffsetY + gridProbe.gridTop
    const gridWidth = gridProbe.gridWidth
    const estimatedTotal = Math.max(
      vh,
      Math.round(
        gridProbe.gridHeight * (gridProbe.trackHeight / gridProbe.thumbHeight)
      )
    )
    updateFullPageTaskProgress(taskId, {
      phase: "capturing",
      current: 0,
      total:
        maxHeight > 0 ? Math.min(estimatedTotal, maxHeight) : estimatedTotal,
      message: "正在滚动并截图"
    })
    // 网格在视口里实际可见高度（被视口底裁掉的部分不算）
    const gridVisibleH = Math.max(
      1,
      Math.min(gridProbe.gridHeight, vh - gridTopTab)
    )

    const slices: CaptureSlice[] = []

    // 先滚到顶
    await chrome.scripting.executeScript({
      target: frameTarget,
      func: embeddedScrollToTop
    })
    await sleep(200)

    // 首帧：整窗（保留工具栏，仅此一帧）
    const firstDataUrl = await safeCaptureVisibleTab(tab.windowId, {
      format: "png"
    })
    if (!firstDataUrl) throw new Error("截图失败：返回数据为空")
    slices.push({
      bitmap: await dataUrlToBitmap(firstDataUrl),
      scrollY: 0,
      destX: 0,
      sourceX: 0,
      sourceY: 0,
      sourceWidth: vw,
      sourceHeight: vh
    })

    // 滚动条换算：scrollPos = (thumbTop - trackTop) * gridHeight / thumbHeight
    const posOf = (s: {
      thumbTop: number
      thumbHeight: number
      trackTop: number
    }) =>
      s.thumbHeight > 0
        ? ((s.thumbTop - s.trackTop) * gridProbe.gridHeight) / s.thumbHeight
        : 0

    let effectiveHeight = vh
    let contentOffsetY = 0
    let prevThumbTop = gridProbe.thumbTop
    const MAX_FRAMES = 80
    let gridFrameIndex = 0

    for (let i = 0; i < MAX_FRAMES; i++) {
      // PageDown 推进一页（先派发，再等滚动 / 重绘稳定，最后读滚动条状态——
      // 不能派发后立刻读，否则 thumb 还没动 → 误判「没推进」直接退出）
      await chrome.scripting.executeScript({
        target: frameTarget,
        func: embeddedScrollStepDown
      })
      await sleep(frameDelayMs)
      const [{ result: state }] = await chrome.scripting.executeScript({
        target: frameTarget,
        func: embeddedScrollState
      })
      if (!state || state.thumbHeight <= 0) break
      console.log("[embeddedDoc] step", i, {
        thumbTop: state.thumbTop,
        prevThumbTop,
        atBottom:
          state.thumbTop + state.thumbHeight >=
          state.trackTop + state.trackHeight - 2
      })

      // 没有推进（到底 / 无法再滚）→ 停
      if (state.thumbTop <= prevThumbTop + 0.5) break
      prevThumbTop = state.thumbTop

      const scrollPos = posOf(state)
      updateFullPageTaskProgress(taskId, {
        phase: "capturing",
        current: Math.min(
          estimatedTotal,
          Math.max(1, scrollPos + gridVisibleH)
        ),
        total:
          maxHeight > 0 ? Math.min(estimatedTotal, maxHeight) : estimatedTotal,
        message: "正在滚动并截图"
      })
      if (gridFrameIndex === 0) {
        // 第一张网格帧排到首帧之下（canvas y = vh）
        contentOffsetY = Math.max(0, Math.round(vh - scrollPos))
      }
      const canvasY = Math.round(scrollPos + contentOffsetY)

      const dataUrl = await safeCaptureVisibleTab(tab.windowId, {
        format: "png"
      })
      if (!dataUrl) break
      slices.push({
        bitmap: await dataUrlToBitmap(dataUrl),
        scrollY: canvasY,
        destX: gridLeftTab,
        sourceX: gridLeftTab,
        sourceY: gridTopTab,
        sourceWidth: gridWidth,
        sourceHeight: gridVisibleH
      })
      effectiveHeight = Math.max(effectiveHeight, canvasY + gridVisibleH)
      gridFrameIndex++

      // 高度上限封顶
      if (maxHeight > 0 && effectiveHeight >= maxHeight) break

      // thumb 到底 → 停
      if (
        state.thumbTop + state.thumbHeight >=
        state.trackTop + state.trackHeight - 2
      ) {
        break
      }
    }

    if (maxHeight > 0) effectiveHeight = Math.min(effectiveHeight, maxHeight)

    updateFullPageTaskProgress(taskId, {
      phase: "stitching",
      current: 1,
      total: 1,
      message: "正在拼接"
    })
    const blob = await stitchToBlob({
      slices,
      viewportWidth: vw,
      totalHeight: effectiveHeight,
      devicePixelRatio: dpr,
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
  }
}
