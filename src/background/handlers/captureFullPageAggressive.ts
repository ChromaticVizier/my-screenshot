/**
 * 隔离模式（"isolate" 专家）的整页（滚动拼接）截图。
 *
 * 由 MoE 路由器（fullPageRouter）在判定页面为「SPA 单主滚动容器」时选用；
 * 用户也可在设置里把 fullPageMode 设为 "isolate" 强制走本流程。
 * 标准流程见 capture.ts 的 handleCaptureFullPage（首帧保留 + 逐帧补偿）。
 *
 * 两条分支：
 *
 * A) 保留首帧（主 frame 内部滚动容器，典型 SPA：网易邮箱 / Confluence）：
 *    1. preparePage() 找主滚动容器（原始位置）
 *    2. 首帧整窗截图 —— 顶栏 / 侧栏等固定元素原样保留，只出现这一次
 *    3. 隐藏覆盖在 scroller 上的 fixed / 伪 sticky（不调 isolateScroller，避免兄弟
 *       元素 display:none 引起 scroller 回流、与首帧接缝处布局跳变）
 *    4. 后续帧裁切 scroller「原始矩形」——chrome 在裁切区之外，自动不再出现；
 *       并用 contentOffsetY / destX 把后续帧排到首帧 chrome 之下、与首帧里的
 *       scroller 内容同宽同位，接缝无缝。
 *
 * B) 隔离（子 frame / iframe 专家，或 window 滚动）：
 *    preparePage → isolateScroller 把容器外元素 display:none → 重测裁切区 →
 *    统一滚动截图。子 frame 主 frame 用 hideOutsideFrameChain 只保留 iframe 链。
 *
 * 截完统一 restoreFixedElements / restorePage 还原。
 */
import {
  dumpDebugFrame,
  dumpDebugSlice,
  errorResponse,
  hostnameFromUrl,
  locateFrameOffsetInPage,
  resolveFrameTarget,
  safeCaptureVisibleTab,
  sleep,
  type FullPageRouting
} from "~src/background/handlers/fullPageShared"
import {
  isolateScroller,
  measureScrollerRect
} from "~src/background/injected/fullPageAggressive"
import {
  detectAndHidePseudoSticky,
  hideFixedElements,
  hideFrameChrome,
  hideOutsideFrameChain,
  kickScrollListeners,
  measureContentInsets,
  measurePageBackground,
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
  // 路由器可临时覆盖站点滚动区（如自动探测到主体 iframe）；否则按 hostname 读取
  const siteRule =
    routing?.siteRuleOverride !== undefined
      ? routing.siteRuleOverride
      : settings.siteScrollRegions[hostnameFromUrl(tab.url) ?? ""] ?? null

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

    // 「保留首帧」模式下：后续帧需整体下移 contentOffsetY（给首帧顶栏/侧栏让位），
    // 并把裁切出的 scroller 画到画布上 scroller 原本的横向位置 framesDestX，
    // 与首帧整窗里的 scroller 内容对齐。非保留模式（子 frame / window）下二者为 0，
    // makeSlice 行为与原先完全一致。
    let contentOffsetY = 0
    let framesDestX = 0
    // spa-like 专家：激进隐藏结构性 chrome（顶栏 + 大侧边栏）。供首帧保留分支与
    // 循环内的 rehideFixedElements 共用，保证重新挂载的侧栏也持续隐藏。
    const aggressiveChrome = routing?.hideStructuralChrome ?? false
    // 后续帧从源图裁切的矩形（CSS 像素，相对视口）。null = 整窗不裁。
    // scroller 模式 = scroller 矩形；window+侧栏模式 = 正文列；由各分支设定。
    let frameCrop: { x: number; y: number; w: number; h: number } | null = null

    const makeSlice = (
      bitmap: ImageBitmap,
      scrollTop: number
    ): CaptureSlice => {
      const base: CaptureSlice = {
        bitmap,
        scrollY: scrollTop + contentOffsetY,
        destX: framesDestX
      }
      if (!frameCrop) return base
      return {
        ...base,
        // 把 iframe 在主 frame viewport 中的偏移叠加到裁切原点。
        // 主 frame 时 frameOffset=0，等价于原行为。
        sourceX: frameCrop.x + frameOffsetX,
        sourceY: frameCrop.y + frameOffsetY,
        sourceWidth: frameCrop.w,
        sourceHeight: frameCrop.h
      }
    }

    const slices: CaptureSlice[] = []

    // 网页背景色：用作长图画布底色，使后续帧未绘制的侧栏槽留白与网页背景一致。
    let pageBackground = "#ffffff"
    try {
      const [{ result: bg }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: measurePageBackground
      })
      if (typeof bg === "string" && bg) pageBackground = bg
    } catch {
      /* 取不到沿用白色 */
    }

    // scroller 在子 iframe 内：主 frame 上的顶栏 / 侧栏需在主 frame 单独隔离
    // （只保留承载 scroller 的 iframe 链）。
    const scrollerIsSubFrame =
      !!siteRule?.frameUrl &&
      !!scrollerTarget.frameIds &&
      scrollerTarget.frameIds.length > 0 &&
      scrollerTarget.frameIds[0] !== 0

    // 是否走「保留首帧」分支：主 frame（非子 iframe）一律保留首帧。
    // 含两种子情形：内部滚动容器（网易邮箱 / Confluence / gitlab）与 window 滚动
    //（带固定顶栏 / 侧栏的页面）。子 frame（iframe 专家）仍走原隔离流程。
    const preserveFirstFrame = !scrollerIsSubFrame

    // 后续帧循环的起始 scrollTop（保留首帧时从首帧已展示内容之后接着拍）
    let firstTargetY = 0
    // 保留首帧模式下首帧整窗高度（CSS 像素），用于保证画布不裁掉首帧
    let preserveFirstFrameH = 0

    /* ===== 阶段 1：滚回顶部（用户可能未在 scrollY=0 触发截图）===== */
    await chrome.scripting.executeScript({
      target: scrollerTarget,
      func: scrollToY,
      args: [0]
    })
    await sleep(120)

    if (preserveFirstFrame) {
      /* ===== 阶段 2A：保留首帧（顶栏 / 侧栏等固定元素只在第一帧出现）=====
       * 关键取舍：不调 isolateScroller（它 display:none 兄弟会让 scroller 回流、
       * 宽度变化，导致首帧与后续帧接缝处布局跳变）。改为：
       *  - 首帧整窗截图，原样保留 chrome；
       *  - 后续帧裁切 scroller 的「原始」矩形——chrome 在裁切区之外，自动不出现；
       *  - 仅隐藏覆盖在 scroller 上的 fixed / 伪 sticky（避免内部吸顶元素逐帧重复）。
       * 这样 scroller 不回流，首帧里的 scroller 内容与后续帧同宽同位，接缝无缝。
       */
      // 整窗尺寸（画布宽度用整窗宽，首帧整窗、后续帧定位到 scroller 左侧）
      let vw = metrics.captureWidth
      let vh = metrics.captureHeight
      try {
        const [{ result: vp }] = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => ({
            w: document.documentElement.clientWidth,
            h: document.documentElement.clientHeight
          })
        })
        if (vp && typeof vp === "object") {
          vw = vp.w ?? vw
          vh = vp.h ?? vh
        }
      } catch {
        /* 取不到整窗尺寸则退化为 scroller 尺寸 */
      }

      // 首帧：不隐藏任何元素，整窗截图，chrome（顶栏 / 侧栏）原样进图
      const firstDataUrl = await safeCaptureVisibleTab(tab.windowId, {
        format: "png"
      })
      if (!firstDataUrl) throw new Error("截图失败：返回数据为空")
      const firstBitmap = await dataUrlToBitmap(firstDataUrl)
      slices.push({
        bitmap: firstBitmap,
        scrollY: 0,
        destX: 0,
        sourceX: 0,
        sourceY: 0,
        sourceWidth: vw,
        sourceHeight: vh
      })
      await dumpDebugFrame(firstDataUrl, 0, 0, {
        preserveFirstFrame: true,
        vw,
        vh,
        captureX: metrics.captureX,
        captureY: metrics.captureY,
        captureWidth: metrics.captureWidth,
        captureHeight: metrics.captureHeight
      })

      // 画布宽度用整窗宽度，容纳首帧整窗 + 左侧侧栏带
      metrics.viewportWidth = vw
      // 记录首帧整窗高度，拼接时保证画布至少容纳首帧
      preserveFirstFrameH = vh

      // 量取左右侧栏 inset → 正文列 [insetLeft, insetRight]。
      // 必须在隐藏 chrome 之前测（aggressiveChrome 会把侧栏 display:none，测不到）。
      let insetLeft = 0
      let insetRight = vw
      try {
        const [{ result: ins }] = await chrome.scripting.executeScript({
          target: scrollerTarget,
          func: measureContentInsets
        })
        if (ins && typeof ins === "object") {
          insetLeft = Math.max(0, Math.min(Math.round(ins.left ?? 0), vw))
          insetRight = Math.max(
            insetLeft + 1,
            Math.min(Math.round(ins.right ?? vw), vw)
          )
        }
      } catch {
        /* 测不到则视为无侧栏 */
      }

      // 隐藏 chrome（顶栏 / 侧栏 / 伪 sticky）。spa-like 传 hideStructuralChrome=true，
      // 激进隐藏全高侧栏（window 模式靠它去掉固定侧栏；scroller 模式侧栏在裁切区外，
      // 隐藏与否都不进图，激进与否均安全）。
      await chrome.scripting.executeScript({
        target: scrollerTarget,
        func: hideFixedElements,
        args: [fullPageRules, aggressiveChrome]
      })
      await chrome.scripting.executeScript({
        target: scrollerTarget,
        func: detectAndHidePseudoSticky,
        args: [fullPageRules]
      })
      hidingApplied = true
      await sleep(150)

      const seamOverlapRatio = Math.min(
        0.5,
        Math.max(0, fullPageRules.fullPageOverlapRatio ?? 0.05)
      )
      if (metrics.scrollerIsElement) {
        // 子情形①：内部滚动容器。后续帧裁切 scroller「原始矩形」——顶栏 / 侧栏多在
        // 裁切区之外，自动不出现。防御：若 scroller 矩形把左侧栏也圈进来了
        // （captureX 落在侧栏区内），把裁切左边界推到侧栏右沿，避免覆盖首帧侧栏。
        const cropLeft = Math.max(Math.round(metrics.captureX), insetLeft)
        const cropRight = Math.min(
          Math.round(metrics.captureX + metrics.captureWidth),
          insetRight
        )
        contentOffsetY = Math.max(0, Math.round(metrics.captureY))
        framesDestX = cropLeft
        frameCrop = {
          x: cropLeft,
          y: metrics.captureY,
          w: Math.max(1, cropRight - cropLeft),
          h: metrics.captureHeight
        }
        // 首帧已展示 scroller 顶部 captureHeight 高内容；后续帧从其后接着拍，减重叠避缝隙
        const seamOverlap = Math.round(metrics.captureHeight * seamOverlapRatio)
        firstTargetY = Math.max(
          0,
          Math.round(metrics.captureHeight) - seamOverlap
        )
      } else {
        // 子情形②：window 滚动（带固定顶栏 / 侧栏，典型旧版 GitLab）。
        // 「首帧完全保留」最稳策略：首帧 = 第一屏整窗（含全部 chrome），后续帧从
        // 第二屏（scrollY=视口高）开始整窗截图（chrome 已隐藏），整体排到首帧之下
        // （contentOffsetY=0 → canvas y = scrollY ≥ 视口高）。首帧 [0, vh] 整块永不被
        // 后续帧覆盖，顶栏 / 侧栏只在首帧出现；正文从第二屏起干净拼接。
        contentOffsetY = 0
        framesDestX = 0
        frameCrop = null
        firstTargetY = vh
        // 隐藏后内容高度可能变化，重测作为终止 / 画布基准
        try {
          const [{ result: m }] = await chrome.scripting.executeScript({
            target: scrollerTarget,
            func: measureScrollMetrics
          })
          if (m && typeof m.scrollHeight === "number") {
            metrics.totalHeight = m.scrollHeight
          }
        } catch {
          /* 测不到沿用旧值 */
        }
      }
    } else {
      /* ===== 阶段 2B：隔离主滚动容器，隐藏其它所有元素（原流程）===== */
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

      // 后续帧裁切到（重测后的）scroller 矩形；window 模式整窗不裁。
      frameCrop = metrics.scrollerIsElement
        ? {
            x: metrics.captureX,
            y: metrics.captureY,
            w: metrics.captureWidth,
            h: metrics.captureHeight
          }
        : null
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
    // 图片高度上限（CSS 像素，0=不限）：无限滚动页面的硬性终止条件
    const maxFullPageHeightPx = Math.max(
      0,
      Math.floor(fullPageRules.maxFullPageHeightPx ?? 0)
    )
    let totalHeight = metrics.totalHeight
    let effectiveHeight = Math.max(totalHeight, stepHeight)

    // 保留首帧模式下，若 scroller 内容已在首帧整窗里展示完（不可再滚），
    // 则只需首帧这一张，跳过后续滚动循环。
    const singleFrame =
      preserveFirstFrame && totalHeight <= metrics.captureHeight + 4

    // 后续帧从 firstTargetY 开始（保留首帧时 = 首帧已展示内容之后；否则 0）
    let targetY = firstTargetY
    // 上一轮已截过的 scrollY，用于检测「无法再滚」。
    // 首帧目标 scrollY=0，用 -1 哨兵避免首轮被误判为「无法推进」而提前退出。
    let prevScrollY = -1
    // 连续无法推进次数：动态加载 / 虚拟列表常出现「看似到底但仍在异步加载」瞬态，
    // 连续 N 次 scrollY + scrollHeight 都不变才退出。
    let stallCount = 0
    const MAX_STALL = 4
    const DYNAMIC_WAIT_MS = 1500
    let frameIndex = 0

    while (!singleFrame) {
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
          args: [fullPageRules, aggressiveChrome]
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

      // 3.3b) 逐帧检测并隐藏「跟随视口」的吸顶元素（顶栏 / 频道导航 / 侧栏）。
      //       用循环每帧之间的真实滚动位移做参照逐帧比较，解决「滚过阈值后才由 JS
      //       变吸顶」的导航（如今日头条频道导航）——它截图开始时还在流中、探测不到，
      //       吸顶后的下一帧即被命中并 display:none（持久）。window 子情形下后续帧整窗
      //       拼接，吸顶导航会逐帧重复，靠此消除；scroller 子情形下导航本在裁切区外，无害。
      try {
        await chrome.scripting.executeScript({
          target: scrollerTarget,
          func: hideFrameChrome,
          args: [fullPageRules]
        })
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

      // 终止条件 0：达到图片高度上限（无限滚动页面保护）。本帧已 push，保留后封顶。
      if (
        maxFullPageHeightPx > 0 &&
        scrollY + stepHeight >= maxFullPageHeightPx
      ) {
        effectiveHeight = Math.min(
          maxFullPageHeightPx,
          Math.max(scrollY + stepHeight, totalHeight, effectiveHeight)
        )
        break
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
    // 最终封顶：即便循环因其它条件退出也不让画布超过用户设置的高度上限。
    if (maxFullPageHeightPx > 0) {
      effectiveHeight = Math.min(effectiveHeight, maxFullPageHeightPx)
    }
    // 保留首帧模式下后续帧整体下移了 contentOffsetY（顶栏带高度），画布相应加高；
    // 并保证画布至少容纳首帧整窗高度（短页面只有首帧时不被裁底）。
    const canvasHeight = Math.max(
      effectiveHeight + contentOffsetY,
      preserveFirstFrameH
    )
    const blob = await stitchToBlob({
      slices,
      viewportWidth: metrics.viewportWidth,
      totalHeight: canvasHeight,
      devicePixelRatio: metrics.devicePixelRatio,
      format,
      quality,
      backgroundColor: pageBackground
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
