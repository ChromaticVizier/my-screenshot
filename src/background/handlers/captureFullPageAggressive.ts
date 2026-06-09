/**
 * 激进隐藏模式的整页（滚动拼接）截图。
 *
 * 由 settings.aggressiveHideMode 开关控制；关闭时走 capture.ts 的
 * handleCaptureFullPage（保留首帧 + 逐帧补偿的旧流程）。
 *
 * 业务流程：
 *   1. preparePage()      → 锁定滚动条 + 找主滚动容器（保留手动选择 / iframe 选择）
 *   2. 滚回顶部后「隔离」主滚动容器：把容器外所有元素 display:none
 *      （isolateScroller + hideFixedElements + detectAndHidePseudoSticky；
 *       子 frame 模式主 frame 用 hideOutsideFrameChain 只保留 iframe 链）
 *   3. 隔离后重测裁切区域 → 统一滚动截图、裁切、拼接、下载（与旧流程一致）
 *
 * 隔离后页面只剩 scroller 子树，无顶栏 / 侧栏 / 弹窗逐帧重复，因此首帧与后续帧
 * 完全一致处理，省掉旧流程里 flatten / 首帧保留 / contentOffsetY 补偿等逻辑。
 */
import {
  dumpDebugFrame,
  dumpDebugSlice,
  errorResponse,
  hostnameFromUrl,
  locateFrameOffsetInPage,
  resolveFrameTarget,
  safeCaptureVisibleTab,
  sleep
} from "~src/background/handlers/fullPageShared"
import {
  isolateScroller,
  measureScrollerRect
} from "~src/background/injected/fullPageAggressive"
import {
  detectAndHidePseudoSticky,
  hideFixedElements,
  hideOutsideFrameChain,
  kickScrollListeners,
  measureScrollMetrics,
  preparePage,
  rehideFixedElements,
  restoreFixedElements,
  restorePage,
  scrollToY,
  waitForDynamicContent,
  type PageMetrics,
  type PreparePageSnapshot
} from "~src/background/injected/fullPage"
import { downloadImageBlob } from "~src/background/utils/download"
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

export async function handleCaptureFullPageAggressive(
  request: CaptureFullPageRequest
): Promise<CaptureResponse> {
  const format = request.payload?.format ?? "png"
  const quality = request.payload?.quality

  const tabRes = await getCapturableActiveTab()
  if (!tabRes.ok) return { ok: false, error: tabRes.error }
  const tab = tabRes.tab
  const tabId = tab.id!

  const settings = await getSettings()
  const fullPageRules = settings.fullPageRules
  const siteRule =
    settings.siteScrollRegions[hostnameFromUrl(tab.url) ?? ""] ?? null

  // 多 frame：用户在某个 iframe 内 picker 选过则 target 该 frame，否则注入主 frame
  const scrollerTarget = await resolveFrameTarget(tabId, siteRule?.frameUrl)
  // iframe 在主 frame viewport 中的偏移（slice sourceX/Y 用）
  let frameOffsetX = 0
  let frameOffsetY = 0
  if (
    siteRule?.frameUrl &&
    scrollerTarget.frameIds &&
    scrollerTarget.frameIds.length > 0
  ) {
    try {
      const [{ result: offset }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: locateFrameOffsetInPage,
        args: [siteRule.frameUrl]
      })
      if (offset && typeof offset === "object") {
        frameOffsetX = offset.x ?? 0
        frameOffsetY = offset.y ?? 0
      }
    } catch (err) {
      console.warn("[fullPage][aggressive] locateFrameOffsetInPage failed", err)
    }
  }

  let snapshot: PreparePageSnapshot | null = null
  let hidingApplied = false

  try {
    // 1) 准备：锁定滚动条 + 找主滚动容器（保留手动选择 / iframe 选择逻辑）
    const [{ result: prepResult }] = await chrome.scripting.executeScript({
      target: scrollerTarget,
      func: preparePage,
      args: [fullPageRules, siteRule]
    })
    if (!prepResult) return { ok: false, error: "页面准备失败" }
    const metrics: PageMetrics = prepResult
    snapshot = prepResult.snapshot

    const makeSlice = (bitmap: ImageBitmap, scrollY: number): CaptureSlice => ({
      bitmap,
      scrollY,
      ...(metrics.scrollerIsElement
        ? {
            // 把 iframe 在主 frame viewport 中的偏移叠加到 captureX/Y。
            // 主 frame scroller 时 frameOffset=0，等价于原行为。
            sourceX: metrics.captureX + frameOffsetX,
            sourceY: metrics.captureY + frameOffsetY,
            sourceWidth: metrics.captureWidth,
            sourceHeight: metrics.captureHeight
          }
        : {})
    })

    const slices: CaptureSlice[] = []

    // scroller 在子 iframe 内：主 frame 上的顶栏 / 侧栏需在主 frame 单独隔离
    // （只保留承载 scroller 的 iframe 链）。
    const scrollerIsSubFrame =
      !!siteRule?.frameUrl &&
      !!scrollerTarget.frameIds &&
      scrollerTarget.frameIds.length > 0 &&
      scrollerTarget.frameIds[0] !== 0

    /* ===== 阶段 1：滚回顶部（用户可能未在 scrollY=0 触发截图）===== */
    await chrome.scripting.executeScript({
      target: scrollerTarget,
      func: scrollToY,
      args: [0]
    })
    await sleep(120)

    /* ===== 阶段 2：隔离主滚动容器，隐藏其它所有元素 ===== */
    // 2.1) scroller 所在 frame：链隔离（隐藏 scroller 祖先链外的兄弟）
    //      + 隐藏容器内部的 fixed/sticky 与 JS 伪 sticky（避免内部吸顶元素逐帧重复）。
    await chrome.scripting.executeScript({
      target: scrollerTarget,
      func: isolateScroller,
      args: [fullPageRules]
    })
    await chrome.scripting.executeScript({
      target: scrollerTarget,
      func: hideFixedElements,
      args: [fullPageRules]
    })
    await chrome.scripting.executeScript({
      target: scrollerTarget,
      func: detectAndHidePseudoSticky,
      args: [fullPageRules]
    })
    // 2.2) 子 frame 模式：主 frame 上只保留承载 scroller 的 iframe 链
    if (scrollerIsSubFrame && siteRule?.frameUrl) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: hideOutsideFrameChain,
          args: [siteRule.frameUrl]
        })
      } catch {
        console.log("Main frame failed to isolate frame chain!")
      }
    }
    hidingApplied = true
    await sleep(150)

    // 2.3) 主 frame 隔离后承载 scroller 的 iframe 可能回流移位，重算其偏移
    if (scrollerIsSubFrame && siteRule?.frameUrl) {
      try {
        const [{ result: offset }] = await chrome.scripting.executeScript({
          target: { tabId },
          func: locateFrameOffsetInPage,
          args: [siteRule.frameUrl]
        })
        if (offset && typeof offset === "object") {
          frameOffsetX = offset.x ?? frameOffsetX
          frameOffsetY = offset.y ?? frameOffsetY
        }
      } catch {
        /* 保持隔离前的旧偏移 */
      }
    }

    // 2.4) 隔离会移除 scroller 的兄弟元素，scroller 在视口中的位置 / 尺寸已变，
    //      重测裁切区域与总高度，覆盖 preparePage 的旧值。
    try {
      const [{ result: m }] = await chrome.scripting.executeScript({
        target: scrollerTarget,
        func: measureScrollerRect
      })
      if (m) {
        metrics.captureX = m.captureX
        metrics.captureY = m.captureY
        metrics.captureWidth = m.captureWidth
        metrics.captureHeight = m.captureHeight
        metrics.viewportWidth = m.captureWidth
        metrics.viewportHeight = m.captureHeight
        metrics.totalHeight = m.totalHeight
      }
    } catch {
      /* 重测失败沿用 preparePage 旧值，可能仍有衔接缝隙 */
    }

    // 2.5) captureHeight 再夹紧到 iframe 在主 frame viewport 中的实际可见高度，
    //      避免 slice 源高度超过 bitmap 边界被 clamp → 长图衔接处白条。
    if (metrics.scrollerIsElement && (frameOffsetY > 0 || frameOffsetX > 0)) {
      try {
        const [{ result: vp }] = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => ({
            w: document.documentElement.clientWidth,
            h: document.documentElement.clientHeight
          })
        })
        if (vp && typeof vp === "object") {
          const maxH = Math.max(
            1,
            (vp.h ?? metrics.captureHeight) - frameOffsetY - metrics.captureY
          )
          const maxW = Math.max(
            1,
            (vp.w ?? metrics.captureWidth) - frameOffsetX - metrics.captureX
          )
          if (metrics.captureHeight > maxH) {
            metrics.captureHeight = maxH
            metrics.viewportHeight = maxH
          }
          if (metrics.captureWidth > maxW) {
            metrics.captureWidth = maxW
            metrics.viewportWidth = maxW
          }
        }
      } catch {
        /* 校正失败保持原值 */
      }
    }

    /* ===== 阶段 3：滚动 + 多次截图（首帧不再特殊处理，所有帧统一）===== */
    // stepHeight 取 viewport × (1 - overlap)，让相邻帧重叠以补全 scroller 底部
    // padding / box-shadow / mask 不渲染的那段内容。overlap 比例用户可调。
    const overlapRatio = Math.min(
      0.5,
      Math.max(0, fullPageRules.fullPageOverlapRatio ?? 0.05)
    )
    const stepHeight = Math.max(
      1,
      Math.floor(metrics.viewportHeight * (1 - overlapRatio))
    )
    let totalHeight = metrics.totalHeight
    let effectiveHeight = Math.max(totalHeight, stepHeight)

    let targetY = 0
    // 上一轮已截过的 scrollY，用于检测「无法再滚」。
    // 首帧目标 scrollY=0，用 -1 哨兵避免首轮被误判为「无法推进」而提前退出。
    let prevScrollY = -1
    // 连续无法推进次数：动态加载 / 虚拟列表常出现「看似到底但仍在异步加载」瞬态，
    // 连续 N 次 scrollY + scrollHeight 都不变才退出。
    let stallCount = 0
    const MAX_STALL = 4
    const DYNAMIC_WAIT_MS = 1500
    let frameIndex = 0

    while (true) {
      // 滚到目标位置（可能因页面底部不足被夹到 maxScrollY）
      const [{ result: actualY }] = await chrome.scripting.executeScript({
        target: scrollerTarget,
        func: scrollToY,
        args: [targetY]
      })
      let scrollY = actualY ?? targetY

      // 3.1) 等待动态内容稳定：scrollHeight + 视口内 <img> 完成度
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

      // 3.2) 重新读 scrollHeight + 真实 scrollTop：动态页 totalHeight 会持续增长；
      //      scroll-behavior:smooth 容器上 scrollToY 立即返回值是动画初期值。
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
      }

      // 3.3) 补隐藏滚动期间 SPA 重新挂载的 fixed/sticky；子 frame 主 frame 再隔离一次
      try {
        await chrome.scripting.executeScript({
          target: scrollerTarget,
          func: rehideFixedElements,
          args: [fullPageRules]
        })
        if (scrollerIsSubFrame && siteRule?.frameUrl) {
          await chrome.scripting.executeScript({
            target: { tabId },
            func: hideOutsideFrameChain,
            args: [siteRule.frameUrl]
          })
        }
      } catch {
        /* 不致命 */
      }

      // 3.4) capture 紧前一刻重读 scrollTop：中间 rehide / 懒加载 reflow 可能让
      //      scroller scrollTop 漂移，早期记录值会与 capture 内容偏离 → 长图错位。
      try {
        const [{ result: finalMetrics }] = await chrome.scripting.executeScript({
          target: scrollerTarget,
          func: measureScrollMetrics
        })
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
      slices.push(makeSlice(bitmap, scrollY))

      frameIndex++
      await dumpDebugFrame(dataUrl, frameIndex, scrollY, {
        targetY,
        totalHeight,
        stallCount,
        measuredHeight,
        bitmapW: bitmap.width,
        bitmapH: bitmap.height,
        sliceCount: slices.length
      })
      await dumpDebugSlice(
        bitmap,
        frameIndex,
        slices[slices.length - 1],
        metrics.devicePixelRatio
      )

      // 终止条件 1：连续 MAX_STALL 轮无法再滚 → 真到底
      if (scrollY === prevScrollY) {
        stallCount++
        // stall 时主动派发 scroll / wheel 事件，戳醒只监听 wheel 的懒加载逻辑
        try {
          await chrome.scripting.executeScript({
            target: scrollerTarget,
            func: kickScrollListeners,
            args: [stepHeight]
          })
        } catch {
          /* 忽略 */
        }
        await sleep(600)
        if (stallCount >= MAX_STALL) {
          effectiveHeight = Math.max(
            scrollY + stepHeight,
            totalHeight,
            effectiveHeight
          )
          break
        }
        targetY = scrollY + stepHeight
        continue
      } else {
        stallCount = 0
      }

      // 终止条件 2：当前可视区已到达页面底部
      if (scrollY + stepHeight >= totalHeight) {
        effectiveHeight = Math.max(
          scrollY + stepHeight,
          totalHeight,
          effectiveHeight
        )
        break
      }

      prevScrollY = scrollY
      // 下一目标：步进一屏（不用陈旧 totalHeight 强制夹住，动态页会持续增长）
      targetY = scrollY + stepHeight
    }

    // 4) 截完恢复 fixed/sticky 元素（含隔离隐藏的元素，复用同一 STORE）
    if (hidingApplied) {
      try {
        await chrome.scripting.executeScript({
          target: scrollerTarget,
          func: restoreFixedElements
        })
        // 子 frame 模式主 frame 上的 hideOutsideFrameChain 也复用同一 STORE，
        // 必须独立再调一次 restore（注入函数靠 window.STORE，跨 frame 不共享）。
        if (
          scrollerTarget.frameIds &&
          scrollerTarget.frameIds.length > 0 &&
          scrollerTarget.frameIds[0] !== 0
        ) {
          try {
            await chrome.scripting.executeScript({
              target: { tabId },
              func: restoreFixedElements
            })
          } catch {
            /* 主 frame 恢复失败兜底由 finally 处理 */
          }
        }
        hidingApplied = false
      } catch {
        /* tab 可能关闭，下面 finally 还会兜底 */
      }
    }

    // 5) 拼接
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
    // 无论成功失败，恢复页面（restorePage 已包含 restoreFixedElements 兜底）
    if (snapshot || hidingApplied) {
      try {
        await chrome.scripting.executeScript({
          target: scrollerTarget,
          func: restorePage,
          args: [
            snapshot ?? {
              htmlOverflow: "",
              bodyOverflow: "",
              originalScrollY: 0,
              scrollerIsElement: false,
              originalScrollerScrollTop: 0,
              scrollerViewportTop: 0,
              scrollerViewportLeft: 0,
              scrollerViewportWidth: 0,
              scrollerViewportHeight: 0
            }
          ]
        })
      } catch {
        /* 标签可能已关闭，忽略 */
      }
      // 子 frame 模式下主 frame 也调过 hideOutsideFrameChain，
      // 必须在主 frame 单独恢复（restoreFixedElements 是幂等的，多调无害）。
      if (
        scrollerTarget.frameIds &&
        scrollerTarget.frameIds.length > 0 &&
        scrollerTarget.frameIds[0] !== 0
      ) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId },
            func: restoreFixedElements
          })
        } catch {
          /* 忽略 */
        }
      }
    }
  }
}
