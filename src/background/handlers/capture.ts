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
import { showCountdown } from "~src/background/injected/countdown"
import {
  detectAndHidePseudoSticky,
  flattenOversizedModals,
  freezeFlattenedModals,
  freezeScrollModals,
  hideExtensionFloats,
  hideFixedElements,
  hideFixedElementsExcludeFrame,
  hideFrameChrome,
  kickScrollListeners,
  measureContentTopReservedSpace,
  measureScrollMetrics,
  measureTopHeaderBottom,
  preparePage,
  rehideFixedElements,
  restoreFixedElements,
  restoreFlattenedModals,
  restorePage,
  scrollToY,
  unfreezeFlattenedModals,
  unfreezeScrollModals,
  waitForDynamicContent,
  type PageMetrics,
  type PreparePageSnapshot
} from "~src/background/injected/fullPage"
import {
  abortScrollRegionPicker,
  pickScrollRegion
} from "~src/background/injected/scrollRegionPicker"
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
  ClearScrollRegionRequest,
  CloseRelayWindowRequest,
  DownloadDesktopImageRequest,
  HideRelayWindowRequest,
  SelectScrollRegionRequest
} from "~src/shared/messages"
import { MessageType } from "~src/shared/messages"
import { getSettings, setSettings } from "~src/shared/settings"

/* ============================================================
 * 1. 可视区域
 * ============================================================ */
export async function handleCaptureVisible(
  request: CaptureVisibleRequest
): Promise<CaptureResponse> {
  const settings = await getSettings()
  const format = request.payload?.format ?? settings.imageFormat
  const quality = request.payload?.quality ?? settings.imageQuality

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
  request: CaptureFullPageRequest,
  routing?: FullPageRouting
): Promise<CaptureResponse> {
  // 读取用户的整页判别规则；以参数形式传入注入函数，便于即时生效
  const settings = await getSettings()
  const format = request.payload?.format ?? settings.imageFormat
  const quality = request.payload?.quality ?? settings.imageQuality

  /* 获取标签页询问是否允许截图 */
  const tabRes = await getCapturableActiveTab()
  if (!tabRes.ok) return { ok: false, error: tabRes.error }
  const tab = tabRes.tab
  const tabId = tab.id!

  const fullPageRules = settings.fullPageRules
  // 长截图相邻两帧之间的等待时长（毫秒，用户可调，默认 1500）
  const frameDelayMs = Math.max(
    0,
    Math.round(settings.fullPageFrameDelayMs ?? 1500)
  )
  // 路由器可临时覆盖站点滚动区（如自动探测到主体 iframe）；否则按 hostname 读取
  const siteRule =
    routing?.siteRuleOverride !== undefined
      ? routing.siteRuleOverride
      : settings.siteScrollRegions[hostnameFromUrl(tab.url) ?? ""] ?? null

  // 多 frame：用户在某个 iframe 内 picker 选过则 target 该 frame，否则注入主 frame
  const scrollerTarget = await resolveFrameTarget(tabId, siteRule?.frameUrl)
  // 同时拿 iframe 在主 frame viewport 中的偏移（slice sourceX/Y 用）
  let frameOffsetX = 0
  let frameOffsetY = 0
  if (
    siteRule?.frameUrl &&
    scrollerTarget.frameIds &&
    scrollerTarget.frameIds.length > 0
  ) {
    try {
      const [{ result: offset }] = await chrome.scripting.executeScript({
        target: { tabId }, // 必须在主 frame 取偏移
        func: locateFrameOffsetInPage,
        args: [siteRule.frameUrl]
      })
      if (offset && typeof offset === "object") {
        frameOffsetX = offset.x ?? 0
        frameOffsetY = offset.y ?? 0
        console.log("[fullPage] frame offset", offset)
      }
    } catch (err) {
      // 失败按 0 处理，等价于主 frame
      console.warn("[fullPage] locateFrameOffsetInPage failed", err)
    }
  }

  let snapshot: PreparePageSnapshot | null = null
  let hidingApplied = false
  let flattenApplied = false
  let scrollModalFrozen = false

  try {
    // 1) 准备：锁定滚动条 + 拿页面度量（注入到 scroller 所在 frame）
    const [{ result: prepResult }] = await chrome.scripting.executeScript({
      target: scrollerTarget,
      func: preparePage,
      args: [fullPageRules, siteRule]
    })
    if (!prepResult) return { ok: false, error: "页面准备失败" }
    const metrics: PageMetrics = prepResult
    snapshot = prepResult.snapshot

    // captureHeight 校正：preparePage 在 iframe 内算出的高度可能超过 iframe 在
    // 主 frame viewport 中的实际可见高度（例：iframe.clientHeight = 638 但 iframe
    // 在 tab viewport 中只能露 636）。captureVisibleTab 拍的是 tab viewport，
    // slice 源高度若大于"iframe 在 tab 内可见高度"，会被 bitmap 边界 clamp，
    // 导致每帧实际绘出尺寸 < stepHeight → 长图衔接处出现白条 / 文字截断。
    //
    // 解法：从主 frame 读 tab viewport 高度，把 captureHeight 与 stepHeight 一起
    // 夹紧到 (tabViewportHeight - frameOffsetY - captureY)。
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
            console.log("[fullPage] clamp captureHeight", {
              from: metrics.captureHeight,
              to: maxH
            })
            metrics.captureHeight = maxH
            metrics.viewportHeight = maxH
          }
          if (metrics.captureWidth > maxW) {
            metrics.captureWidth = maxW
            metrics.viewportWidth = maxW
          }
        }
      } catch {
        /* 校正失败保持原值，可能仍有衔接缝隙 */
      }
    }

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
    // stepHeight 取 viewport × (1 - overlap)，让相邻帧重叠以补全 scroller 底部
    // padding / box-shadow / mask 不渲染的那段内容（典型如富文本编辑器）。
    // overlap 比例由用户在设置页可调（fullPageOverlapRatio，默认 0.05）。
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
    /**
     * 真实可达的页面总高度。
     * preparePage 报告的 totalHeight 可能因 margin/transform 等偏大，
     * 用「最后一屏的实际 scrollY + viewportHeight」夹紧后再交给拼接器，
     * 避免长图末尾出现空白条。
     */
    let effectiveHeight = Math.max(totalHeight, stepHeight)
    // 长截图首帧保留 fixed/sticky（顶栏 / banner），但会带来两类遮挡：
    //   1) 顶栏「下面」的正文（典型如标题）在首帧被顶栏盖住；
    //   2) 底栏 / 浮动按钮 / 伪 sticky 盖住首帧底部正文。
    // 统一解法：画布顶部保留 contentOffsetY（= 顶栏下沿 headerBottom）高的
    // 顶栏带（取自第0帧 [0, headerBottom]），其余全部正文整体下移
    // contentOffsetY 由「已隐藏」的干净帧从内容真正顶部开始铺满覆盖。
    // 这样顶栏出现一次，正文（含原本被遮的标题）完整无遮挡接在其下。
    let contentOffsetY = 0

    // 2) 首帧：不隐藏任何 fixed/sticky，让弹窗 / iframe / 顶部 banner
    //    原样进入第一张图。从第二屏才开始隐藏，避免它们重复出现。
    //
    // 顺序很重要：flatten + freeze 必须在 scrollToY(0) 之前执行。
    // 原因：很多 SPA dropdown（典型如有道字典「全部产品」iframe）会监听 scroll
    // 事件，scroll 一发生立刻 display:none 自身。如果先 scrollToY(0) 再 flatten，
    // 摊平时弹窗已被收回，getBoundingClientRect 返回 0×0，flatten 直接漏判。
    // 摊平后弹窗 position 已变 absolute、坐标用文档系书写，scrollToY(0) 不影响其
    // 视觉位置；MutationObserver 同步回滚 display:none 的写入，scroll 事件触发
    // 的关闭也被即时还原。

    // 2.1) 把含 iframe 且超出首屏的 fixed/sticky 弹窗摊平为 absolute，
    //      使其底部能延伸到文档下方区域，从而被后续滚动帧完整拍下。
    //      maxBottom 是摊平后弹窗最低的文档坐标，用来扩展 totalHeight。
    try {
      const [{ result: flattenResult }] = await chrome.scripting.executeScript({
        target: scrollerTarget,
        func: flattenOversizedModals,
        args: [fullPageRules]
      })
      console.log("[fullPage] flatten result:", flattenResult, {
        originalTotalHeight: totalHeight,
        viewportHeight: stepHeight
      })
      if (flattenResult && flattenResult.count > 0) {
        flattenApplied = true
        // 摊平后弹窗下沿可能超过原文档高度，扩展 totalHeight 防止被裁
        if (flattenResult.maxBottom > totalHeight) {
          totalHeight = flattenResult.maxBottom
          effectiveHeight = Math.max(effectiveHeight, totalHeight)
        }
        // 立即冻结：装 MutationObserver + 吞噬鼠标/焦点事件，
        // 阻止页面 JS 在截图过程中把弹窗收回。
        try {
          await chrome.scripting.executeScript({
            target: scrollerTarget,
            func: freezeFlattenedModals
          })
        } catch {
          /* 冻结失败仅表现为弹窗可能消失，不致命 */
        }
        // 给一帧时间让浏览器完成布局；
        // 摊平时若把 iframe 弹窗移到 body 末尾会触发 iframe reload，需要更长
        // 等待时间让其重新加载完成，否则首帧拍到的是空白 iframe
        await sleep(800)
      }
    } catch {
      /* 摊平失败不致命，按原流程继续 */
    }

    //    flatten + freeze 完成后再滚回顶部（用户可能未在 scrollY=0 触发截图）。
    //    此时即使 scroll 事件触发页面 JS 把弹窗 display:none，MutationObserver
    //    会同步回滚。

    // 2.2) 冻结可见的 fixed/sticky 弹窗，防止 scrollToY(0) 触发的 scroll 事件
    //      把弹窗提前关闭（典型：有道翻译 VIP 购买弹窗监听 scroll → display:none）。
    //      unfreezeScrollModals 在第一帧拍完后立即调用，让弹窗恢复正常关闭行为，
    //      后续帧不再保留。
    try {
      const [{ result: sfCount }] = await chrome.scripting.executeScript({
        target: scrollerTarget,
        func: freezeScrollModals
      })
      if (sfCount && sfCount > 0) scrollModalFrozen = true
    } catch {
      /* 冻结失败不致命，弹窗可能在第一帧中消失，但不影响后续截图流程 */
    }

    const [{ result: firstScrollYRaw }] = await chrome.scripting.executeScript({
      target: scrollerTarget,
      func: scrollToY,
      args: [0]
    })
    let firstScrollY = firstScrollYRaw ?? 0
    await sleep(120)
    // scroll-behavior:smooth 的 scroller 上 scrollToY 立即返回值可能未到位。
    // sleep 后用 measureScrollMetrics 拿稳定 scrollTop，避免首帧位置错位。
    try {
      const [{ result: stableMetrics }] = await chrome.scripting.executeScript({
        target: scrollerTarget,
        func: measureScrollMetrics
      })
      if (stableMetrics && typeof stableMetrics.scrollTop === "number") {
        firstScrollY = stableMetrics.scrollTop
      }
    } catch {
      /* 忽略 */
    }

    const firstDataUrl = await safeCaptureVisibleTab(tab.windowId, {
      format: "png"
    })
    if (!firstDataUrl) throw new Error("截图失败：返回数据为空")
    const firstBitmap = await dataUrlToBitmap(firstDataUrl)
    slices.push(makeSlice(firstBitmap, firstScrollY))
    await dumpDebugFrame(firstDataUrl, 0, firstScrollY, {
      stepHeight,
      totalHeight,
      scrollerIsElement: metrics.scrollerIsElement,
      captureX: metrics.captureX,
      captureY: metrics.captureY,
      captureWidth: metrics.captureWidth,
      captureHeight: metrics.captureHeight,
      frameOffsetX,
      frameOffsetY,
      bitmapW: firstBitmap.width,
      bitmapH: firstBitmap.height
    })
    await dumpDebugSlice(
      firstBitmap,
      0,
      slices[slices.length - 1],
      metrics.devicePixelRatio
    )

    // 首屏即覆盖整页（短页面，无需后续滚动拼接）
    if (firstScrollY + stepHeight >= totalHeight) {
      effectiveHeight = Math.max(firstScrollY + stepHeight, totalHeight)
      // 短页面也要解冻，避免 observer 一直驻留
      if (scrollModalFrozen) {
        try {
          await chrome.scripting.executeScript({
            target: scrollerTarget,
            func: unfreezeScrollModals
          })
        } catch {
          /* 忽略 */
        }
      }
    } else {
      // 2.3) 第一帧已拍完，立即解冻弹窗：断开 MutationObserver，让弹窗恢复
      //      正常关闭行为（页面 JS 的 scroll-close 逻辑在此后可以生效）。
      //      必须在 hideFixedElements 之前调用，否则 observer 会与 hideFixedElements
      //      的 display:none 操作产生干扰。
      if (scrollModalFrozen) {
        try {
          await chrome.scripting.executeScript({
            target: scrollerTarget,
            func: unfreezeScrollModals
          })
        } catch {
          /* 忽略 */
        }
        // 给页面 JS 80ms 处理弹窗的自然关闭（scroll-close handler 此时可以执行）
        await sleep(80)
      }

      // scroller 在子 frame 时主 frame 的顶栏 / 侧栏不会被 scrollerTarget
      // 注入的 hideFixedElements 扫到，每帧都会重复出现。这里用一个独立路径
      // 同时对主 frame 跑一份隐藏，但保留承载 scroller 的 iframe 链。
      const scrollerIsSubFrame =
        !!siteRule?.frameUrl &&
        !!scrollerTarget.frameIds &&
        scrollerTarget.frameIds.length > 0 &&
        scrollerTarget.frameIds[0] !== 0

      // 3) 一次性隐藏 fixed/sticky + 用户自定义隐藏元素
      //    KoalaSnap 风格：用 display:none 让父容器回流，确保子元素也不可见。
      await chrome.scripting.executeScript({
        target: scrollerTarget,
        func: hideFixedElements,
        args: [fullPageRules, routing?.hideStructuralChrome ?? false]
      })
      await chrome.scripting.executeScript({
        target: scrollerTarget,
        func: hideExtensionFloats,
        args: [fullPageRules]
      })
      if (scrollerIsSubFrame && siteRule?.frameUrl) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId },
            func: hideFixedElementsExcludeFrame,
            args: [fullPageRules, siteRule.frameUrl]
          })
        } catch {
          console.log("Main frame failed to hide!")
        }
      }
      hidingApplied = true
      await sleep(120)

      // 3.5) 探测并隐藏 JS 模拟的伪 sticky（如 Confluence 顶栏，computed position
      //      不是 fixed/sticky 但靠 scroll 事件 + transform 跟随视口）。
      //      通过短距滚动探测漂移识别，再 display:none 加入恢复列表。
      await chrome.scripting.executeScript({
        target: scrollerTarget,
        func: detectAndHidePseudoSticky,
        args: [fullPageRules]
      })
      await sleep(120)

      // 3.6) 量取「顶部锚定头部」下沿 headerBottom（画布顶部要保留的顶栏带高度），
      //      以及正文顶部已预留的空白 P。正文整体下移量 = headerBottom - P：
      //      - 无预留（P≈0，标题被顶栏直接盖住）：下移满 headerBottom，标题露出；
      //      - 已预留满（P≈headerBottom，站点自带 padding-top）：下移 0，不叠加空白。
      //      并让第1帧滚到 P，跳过预留空白、从正文真实顶部开始拍。
      let headerBottom = 0
      try {
        const [{ result: hb }] = await chrome.scripting.executeScript({
          target: scrollerTarget,
          func: measureTopHeaderBottom
        })
        if (typeof hb === "number" && hb > 0) headerBottom = hb
      } catch {
        /* 测不到按无顶栏处理（contentOffsetY=0，干净帧整屏覆盖第0帧） */
      }
      const HEADER_MIN = 4
      let reservedTop = 0
      // 「弹窗主导」判定：headerBottom 显著大于普通顶栏（典型顶栏 60–150px）
      // 则视为带遮罩弹窗。此时若仍按「保留顶栏带 + 正文从真实顶部铺满」逻辑，
      // 干净帧会从页面 scrollY=reservedTop 起拍——把"位于第一帧弹窗下方但属于
      // 页面流式内容（如顶部 banner / hero）"重复贴到弹窗下方，造成 banner 在
      // 第二帧又出现。改为：让首个干净帧直接从 page[headerBottom] 起拍，
      // 接在弹窗下沿之后，不再追加 contentOffsetY 偏移。代价：弹窗背后被遮挡
      // 的页面内容会丢失，可接受。
      const modalDominated = headerBottom > Math.min(stepHeight * 0.35, 300)
      let firstCleanScroll = firstScrollY
      if (modalDominated) {
        contentOffsetY = 0
        firstCleanScroll = firstScrollY + headerBottom
      } else if (headerBottom > HEADER_MIN) {
        try {
          const [{ result: p }] = await chrome.scripting.executeScript({
            target: scrollerTarget,
            func: measureContentTopReservedSpace
          })
          if (typeof p === "number" && p > 0) {
            // 夹到 [0, headerBottom]：防止 P 过测导致跳过正文 / 下移量为负
            reservedTop = Math.min(headerBottom, p)
          }
        } catch {
          /* 测不到按无预留处理（下移满 headerBottom） */
        }
        contentOffsetY = Math.max(0, headerBottom - reservedTop)
        firstCleanScroll = firstScrollY + reservedTop
      } else {
        contentOffsetY = 0
      }

      // 3.7) 隐藏完成后重测内容高度（新坐标系），作为后续帧滚动 / 终止判定基准。
      //      sticky 等占位元素 display:none 后内容上移、文档变矮，旧的 totalHeight
      //      不再适用；用新高度才能正确判定到底，并算准画布高度。
      try {
        const [{ result: afterMetrics }] = await chrome.scripting.executeScript(
          {
            target: scrollerTarget,
            func: measureScrollMetrics
          }
        )
        if (afterMetrics && typeof afterMetrics.scrollHeight === "number") {
          totalHeight = afterMetrics.scrollHeight
        }
      } catch {
        /* 测不到沿用旧 totalHeight */
      }
      // 画布高度 = 顶栏带 + 正文（新坐标系）总高
      effectiveHeight = Math.max(
        effectiveHeight,
        totalHeight + contentOffsetY,
        stepHeight + contentOffsetY
      )

      // 4) 滚动 + 多次截图
      // 第1帧滚到正文真实顶部 firstCleanScroll（干净状态）拍出被顶栏遮住的标题；
      // 其后每帧 slice.scrollY = 实测 scrollY + contentOffsetY，整体下移给顶栏让位。
      let targetY = firstCleanScroll
      // 上一轮已经拍过的 scrollY（首帧），用于检测「无法再滚」
      // 第1帧目标是内容顶部（scrollY=0），与首帧 firstScrollY 相同，
      // 用 -1 哨兵避免首轮被误判为「无法再滚」而提前退出。
      let prevScrollY = -1
      // 连续无法推进的次数：动态加载 / 虚拟列表页面经常出现
      // "看似到底但内容还在异步加载"的瞬态。单次未推进就退出会丢后续内容，
      // 改为连续 N 次 scrollY 不变 + scrollHeight 不变才退出。
      let stallCount = 0
      const MAX_STALL = 4
      // 动态内容稳定等待上限。
      const DYNAMIC_WAIT_MS = 1500
      let frameIndex = 0

      while (true) {
        // 滚到目标位置（可能因为页面底部不足而被夹到 maxScrollY）
        const [{ result: actualY }] = await chrome.scripting.executeScript({
          target: scrollerTarget,
          func: scrollToY,
          args: [targetY]
        })
        // scrollToY 立即返回的 scrollTop 在 scroll-behavior:smooth 的容器上
        // 处于动画初期（远小于目标）。后面用 measureScrollMetrics 重新拿稳定值。
        let scrollY = actualY ?? targetY

        // 帧间等待：每滚到新一帧后等待用户设定的时长，给页面留出渲染/懒加载/动画稳定的时间
        if (frameDelayMs > 0) await sleep(frameDelayMs)

        // 4.1) 等待动态内容稳定：scrollHeight + 视口内 <img> 完成度
        let measuredHeight = totalHeight
        try {
          const [{ result: waitResult }] = await chrome.scripting.executeScript(
            {
              target: scrollerTarget,
              func: waitForDynamicContent,
              args: [DYNAMIC_WAIT_MS]
            }
          )
          if (waitResult && typeof waitResult.scrollHeight === "number") {
            measuredHeight = waitResult.scrollHeight
          }
        } catch {
          await sleep(120)
        }

        // 4.2) 重新读 scrollHeight + 真实 scrollTop：
        //   - 动态加载页 totalHeight 会持续增长
        //   - scroller 命中 CSS scroll-behavior:smooth 时，scrollToY 返回的
        //     scrollTop 是动画初期值；等待稳定后这里才是真实落点。
        //     若不更新 slice.scrollY，会把帧画到错误位置 → 长图前两帧错位。
        try {
          const [{ result: metricsNow }] = await chrome.scripting.executeScript(
            {
              target: scrollerTarget,
              func: measureScrollMetrics
            }
          )
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
          // totalHeight 是新坐标系正文高度，画布还要加上顶栏带 contentOffsetY
          effectiveHeight = Math.max(
            effectiveHeight,
            totalHeight + contentOffsetY
          )
        }

        // 补隐藏 SPA 滚动回调里重新挂载的顶栏/侧栏
        try {
          await chrome.scripting.executeScript({
            target: scrollerTarget,
            func: rehideFixedElements,
            args: [fullPageRules, routing?.hideStructuralChrome ?? false]
          })
          if (scrollerIsSubFrame && siteRule?.frameUrl) {
            await chrome.scripting.executeScript({
              target: { tabId },
              func: hideFixedElementsExcludeFrame,
              args: [fullPageRules, siteRule.frameUrl]
            })
          }
        } catch {
          /* 不致命 */
        }

        // 逐帧检测并隐藏「跟随视口」的吸顶元素（顶栏 / 频道导航 / 侧栏等）。
        // 不再依赖截图前一次性探测——很多导航是滚过阈值后才由 JS 变吸顶（如今日头条
        // 频道导航），那时才能被发现。用循环每帧之间的真实滚动位移做参照逐帧比较，
        // 元素一旦吸顶，下一帧即被命中、display:none（持久），从而消除逐帧重复。
        try {
          await chrome.scripting.executeScript({
            target: scrollerTarget,
            func: hideFrameChrome,
            args: [fullPageRules]
          })
          await chrome.scripting.executeScript({
            target: scrollerTarget,
            func: hideExtensionFloats,
            args: [fullPageRules]
          })
        } catch {
          /* 不致命 */
        }

        // 最终落点：必须在 captureVisibleTab 紧前一刻重读 scrollTop。
        // 中间 rehideFixedElements / 懒加载触发的 reflow 可能让 scroller
        // 自身 scrollTop 漂移（如 sticky 元素回弹、虚拟列表项变更），
        // 早期记录的 scrollY 会和 capture 内容偏离 → 长图错位。
        try {
          const [{ result: finalMetrics }] =
            await chrome.scripting.executeScript({
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
        // 干净帧整体下移 contentOffsetY，给画布顶部的顶栏带让位，
        // 同时让原本被顶栏遮住的内容（标题等）从顶栏正下方完整露出。
        slices.push(makeSlice(bitmap, scrollY + contentOffsetY))

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

          // stall 时主动派发滚动 / wheel 事件，戳醒只监听 wheel 的懒加载逻辑
          // （某些站如知乎 / 网易系是这么实现 infinite scroll 的）
          try {
            await chrome.scripting.executeScript({
              target: scrollerTarget,
              func: kickScrollListeners,
              args: [stepHeight]
            })
          } catch {
            /* 忽略 */
          }
          // 给页面一点时间继续加载
          await sleep(600)

          if (stallCount >= MAX_STALL) {
            effectiveHeight = Math.max(
              scrollY + stepHeight + contentOffsetY,
              totalHeight + contentOffsetY,
              effectiveHeight
            )
            break
          }
          targetY = scrollY + stepHeight
          continue
        } else {
          stallCount = 0
        }

        // 终止条件 0：达到图片高度上限（无限滚动页面保护）。
        // 此处 slice 已 push，保留本帧后封顶，避免信息流 / 评论流截不完。
        if (
          maxFullPageHeightPx > 0 &&
          scrollY + stepHeight + contentOffsetY >= maxFullPageHeightPx
        ) {
          effectiveHeight = Math.min(
            maxFullPageHeightPx,
            Math.max(
              scrollY + stepHeight + contentOffsetY,
              totalHeight + contentOffsetY,
              effectiveHeight
            )
          )
          break
        }

        // 终止条件 2：当前可视区已到达页面底部
        if (scrollY + stepHeight >= totalHeight) {
          effectiveHeight = Math.max(
            scrollY + stepHeight + contentOffsetY,
            totalHeight + contentOffsetY,
            effectiveHeight
          )
          break
        }

        prevScrollY = scrollY
        // 下一目标：步进一屏；不再用陈旧 totalHeight 强制夹住
        // （totalHeight 在动态页会持续增长，夹下来会让 targetY 倒退）
        targetY = scrollY + stepHeight
      }
    }

    // 5) 截完恢复 fixed/sticky 元素
    if (hidingApplied) {
      try {
        await chrome.scripting.executeScript({
          target: scrollerTarget,
          func: restoreFixedElements
        })
        // 主 frame 上的 hideFixedElementsExcludeFrame 也复用同一 STORE，
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

    // 5.1) 恢复被摊平的 iframe 弹窗（先卸载冻结守护，再回填 inline style）
    if (flattenApplied) {
      try {
        await chrome.scripting.executeScript({
          target: scrollerTarget,
          func: unfreezeFlattenedModals
        })
      } catch {
        /* tab 可能关闭，下面 finally 还会兜底 */
      }
      try {
        await chrome.scripting.executeScript({
          target: scrollerTarget,
          func: restoreFlattenedModals
        })
        flattenApplied = false
      } catch {
        /* tab 可能关闭，下面 finally 还会兜底 */
      }
    }

    // 6) 拼接
    // 最终封顶：即便循环因其它条件退出，也不让画布超过用户设置的高度上限。
    if (maxFullPageHeightPx > 0) {
      effectiveHeight = Math.min(effectiveHeight, maxFullPageHeightPx)
    }
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
    // 6) 无论成功失败，恢复页面（restorePage 已包含 restoreFixedElements 兜底）
    // 兜底：确保 scrollModal observer 已断开（正常路径应在第一帧后已断开）
    if (scrollModalFrozen) {
      try {
        await chrome.scripting.executeScript({
          target: scrollerTarget,
          func: unfreezeScrollModals
        })
      } catch {
        /* 忽略 */
      }
    }
    if (flattenApplied) {
      try {
        await chrome.scripting.executeScript({
          target: scrollerTarget,
          func: unfreezeFlattenedModals
        })
      } catch {
        /* 忽略 */
      }
      try {
        await chrome.scripting.executeScript({
          target: scrollerTarget,
          func: restoreFlattenedModals
        })
      } catch {
        /* 忽略 */
      }
    }
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
      // 子 frame 模式下主 frame 也调过 hideFixedElementsExcludeFrame，
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

/* ============================================================
 * 2.5 手动滚动区域选择
 *
 * 多 frame 流程：
 *   - 枚举 tab 内所有 frame（chrome.webNavigation.getAllFrames）
 *   - 给每个 frame 单独注入 picker（不用 allFrames，因为单个 Promise 会等
 *     所有 frame 都返回才 resolve；用户只点一个 frame 的话其它永远不返回）
 *   - 每个注入返回独立的 Promise，Promise.race 拿到第一个非 null 结果
 *   - 胜出后向其它 frame 注入 abortScrollRegionPicker 拆遮罩
 * ============================================================ */
export async function handleSelectScrollRegion(
  _request: SelectScrollRegionRequest
): Promise<CaptureResponse> {
  try {
    const tabRes = await getCapturableActiveTab()
    if (!tabRes.ok) return { ok: false, error: tabRes.error }
    const tab = tabRes.tab
    const tabId = tab.id!
    const hostname = hostnameFromUrl(tab.url)
    if (!hostname) return { ok: false, error: "当前页面不支持站点规则" }

    // 拿到所有 frame；单 frame 页面退化成原来的单注入路径
    let frames: chrome.webNavigation.GetAllFrameResultDetails[] = []
    try {
      frames = (await chrome.webNavigation.getAllFrames({ tabId })) ?? []
    } catch {
      frames = []
    }
    // 过滤掉非可注入的 schema（about:blank 偶尔出现，extension 注入会失败）
    const candidateFrames = frames.filter(
      (f) => f.url && /^https?:|^file:/.test(f.url)
    )

    // 没有任何子 frame，走老路（直接注入主 frame）
    if (candidateFrames.length <= 1) {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: pickScrollRegion
      })
      if (!result) return { ok: false, cancelled: true, error: "已取消" }
      const settings = await getSettings()
      await setSettings({
        siteScrollRegions: {
          ...settings.siteScrollRegions,
          [hostname]: {
            ...result,
            hostname,
            createdAt: Date.now()
          }
        }
      })
      return { ok: true }
    }

    // 多 frame：每个 frame 各注入一份 picker，拿独立 Promise 后 race。
    // 胜出方携带 frameUrl，败者返回 null（被 abort 或自然取消）。
    type FrameAttempt = {
      frameId: number
      promise: Promise<
        ReturnType<typeof pickScrollRegion> extends Promise<infer R> ? R : never
      >
    }
    const attempts: FrameAttempt[] = candidateFrames.map((f) => ({
      frameId: f.frameId,
      promise: chrome.scripting
        .executeScript({
          target: { tabId, frameIds: [f.frameId] },
          func: pickScrollRegion
        })
        .then(
          (arr) =>
            (arr?.[0]?.result ?? null) as Awaited<
              ReturnType<typeof pickScrollRegion>
            >
        )
        .catch(() => null as Awaited<ReturnType<typeof pickScrollRegion>>)
    }))

    // 用 Promise.race 拿第一个 truthy 结果。null 视为该 frame 被取消，
    // 仅当所有 frame 都 resolve 为 null 才算用户整体取消。
    const winnerPromise = new Promise<{
      result: Awaited<ReturnType<typeof pickScrollRegion>>
      frameId: number
    } | null>((resolve) => {
      let pending = attempts.length
      attempts.forEach(({ frameId, promise }) => {
        promise.then((result) => {
          if (result) {
            resolve({ result, frameId })
          } else {
            pending--
            if (pending === 0) resolve(null)
          }
        })
      })
    })

    const winner = await winnerPromise

    // 不论胜负，向所有未胜出 frame 注入 abort 清场（胜者的 picker 已经 resolve
    // 并自行清理，不必再 abort；但顺手 abort 也无副作用，幂等）。
    await Promise.all(
      candidateFrames
        .filter((f) => !winner || f.frameId !== winner.frameId)
        .map((f) =>
          chrome.scripting
            .executeScript({
              target: { tabId, frameIds: [f.frameId] },
              func: abortScrollRegionPicker
            })
            .catch(() => undefined)
        )
    )

    if (!winner) return { ok: false, cancelled: true, error: "已取消" }

    // winnerPromise 仅在 result 真值时 resolve，这里非空
    const picked = winner.result!

    const settings = await getSettings()
    await setSettings({
      siteScrollRegions: {
        ...settings.siteScrollRegions,
        [hostname]: {
          ...picked,
          hostname,
          createdAt: Date.now()
        }
      }
    })

    return { ok: true }
  } catch (err) {
    return errorResponse(err)
  }
}

export async function handleClearScrollRegion(
  _request: ClearScrollRegionRequest
): Promise<CaptureResponse> {
  try {
    const tabRes = await getCapturableActiveTab()
    if (!tabRes.ok) return { ok: false, error: tabRes.error }
    const hostname = hostnameFromUrl(tabRes.tab.url)
    if (!hostname) return { ok: false, error: "当前页面不支持站点规则" }

    const settings = await getSettings()
    const next = { ...settings.siteScrollRegions }
    delete next[hostname]
    await setSettings({ siteScrollRegions: next })

    return { ok: true }
  } catch (err) {
    return errorResponse(err)
  }
}

/* ============================================================
 * 3. 选区
 * ============================================================ */
export async function handleCaptureSelection(
  request: CaptureSelectionRequest
): Promise<CaptureResponse> {
  const settings = await getSettings()
  const format = request.payload?.format ?? settings.imageFormat
  const quality = request.payload?.quality ?? settings.imageQuality

  try {
    const tabRes = await getCapturableActiveTab()
    if (!tabRes.ok) return { ok: false, error: tabRes.error }
    const tab = tabRes.tab
    const tabId = tab.id!

    // 1) 注入遮罩并等待用户拖拽（注意：popup 此时已关闭，由 background 等待）
    const [{ result: selection }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: pickSelection,
      args: [{ keepFrameAfterPick: false }]
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
    // 中转窗口尺寸 = Chrome getDisplayMedia 系统弹窗的可用尺寸（弹窗以窗口
    // 客户区为画布，过窄会导致多屏选择器右侧屏幕缩略图被裁掉）。
    const W = 960
    const H = 640
    // getDisplayMedia 系统弹窗左边界与调用窗口左边界对齐。
    // 中转窗口居中于浏览器窗口，系统弹窗从此向右展开不溢出。
    let left: number | undefined
    let top: number | undefined
    try {
      const cur = await chrome.windows.getCurrent()
      if (
        typeof cur.left === "number" &&
        typeof cur.top === "number" &&
        typeof cur.width === "number" &&
        typeof cur.height === "number"
      ) {
        left = Math.max(cur.left, Math.round(cur.left + (cur.width - W) / 2))
        top = Math.round(cur.top + (cur.height - H) / 2)
      }
    } catch {
      /* 取不到就让浏览器自决定 */
    }
    await chrome.windows.create({
      url,
      type: "popup",
      width: W,
      height: H,
      ...(left != null && top != null ? { left, top } : {}),
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
