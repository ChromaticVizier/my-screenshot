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
  hideOtherIframesInPage,
  listFramesInPage,
  pickFrame,
  restoreOtherIframesInPage,
  type FramePickerOption
} from "~src/background/injected/framePicker"
import { pickScrollRegion } from "~src/background/injected/scrollRegionPicker"
import {
  detectAndHidePseudoSticky,
  flattenOversizedModals,
  freezeFlattenedModals,
  hideFixedElements,
  preparePage,
  rehideFixedElements,
  restoreFixedElements,
  restoreFlattenedModals,
  restorePage,
  scrollToY,
  unfreezeFlattenedModals,
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
  ClearScrollRegionRequest,
  CloseRelayWindowRequest,
  DownloadDesktopImageRequest,
  HideRelayWindowRequest,
  SelectScrollRegionRequest
} from "~src/shared/messages"
import { MessageType } from "~src/shared/messages"
import { getSettings, setSettings } from "~src/shared/settings"

/** captureVisibleTab 限频间隔（ms），Chrome 限制约 2 次/秒，留一点裕量 */
const CAPTURE_INTERVAL = 600

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function hostnameFromUrl(url?: string): string | null {
  if (!url) return null
  try {
    return new URL(url).hostname
  } catch {
    return null
  }
}

/**
 * 解析 SiteScrollRegionRule.frameUrl 到具体的 chrome.scripting.InjectionTarget。
 *
 * 用户可能在 iframe(常见的内嵌 SaaS 文档/编辑器)里 picker 选取了滚动区,
 * 此时 frameUrl 记录该 iframe 的 location.href。截图流程的所有注入都要 target
 * 到对应 frame,否则会在主 frame 找不到 selector / scroller。
 *
 * 匹配策略:
 *  1. 完全相等的 frame.url 优先(URL 含 query/hash 也作严格比较)
 *  2. 退化到同 origin 的 frame(用户切换标签或刷新后 query 可能略变)
 *  3. 最后回退主 frame,保持向后兼容
 */
async function resolveFrameTarget(
  tabId: number,
  frameUrl?: string
): Promise<chrome.scripting.InjectionTarget> {
  if (!frameUrl) return { tabId }
  let frames: chrome.webNavigation.GetAllFrameResultDetails[] | null = null
  try {
    frames = await chrome.webNavigation.getAllFrames({ tabId })
  } catch {
    return { tabId }
  }
  if (!frames || frames.length === 0) return { tabId }
  const exact = frames.find((f) => f.url === frameUrl)
  if (exact) return { tabId, frameIds: [exact.frameId] }
  try {
    const target = new URL(frameUrl)
    const partial = frames.find((f) => {
      try {
        return new URL(f.url).origin === target.origin
      } catch {
        return false
      }
    })
    if (partial) return { tabId, frameIds: [partial.frameId] }
  } catch {
    // ignore
  }
  return { tabId }
}

/**
 * 在主 frame 算出指定 iframe 在 tab viewport 中的左上角坐标。
 *
 * iframe 内的 preparePage 返回的 captureX/Y 是 iframe 局部坐标(以 iframe
 * viewport 左上为原点);captureVisibleTab 拍的是整个 tab viewport,
 * 所以从全屏 png 切片时,要把 iframe 在 tab viewport 中的偏移加上去。
 *
 * 嵌套 iframe 场景:contentDocument.location.href 在 same-origin 子 frame 中
 * 可读,递归累加每层 iframe 的 rect.left/top 即得到目标 frame 的累计偏移。
 *
 * 跨域中间层会切断递归,target frame 在跨域层内时只能拿到中间层的偏移作为
 * 近似值(误差 = target 在中间层内的局部位置)。
 *
 * 主 frame 也找不到匹配 frame 则返回 (0, 0),视同主 frame。
 */
function locateFrameOffsetInPage(frameUrl: string): { x: number; y: number } {
  const matches = (a: string, b: string) => {
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

  const visit = (
    doc: Document,
    offsetX: number,
    offsetY: number
  ): { x: number; y: number } | null => {
    let iframes: HTMLIFrameElement[]
    try {
      iframes = Array.from(doc.querySelectorAll<HTMLIFrameElement>("iframe"))
    } catch {
      return null
    }
    for (const f of iframes) {
      let r: DOMRect
      try {
        r = f.getBoundingClientRect()
      } catch {
        continue
      }
      const localOffsetX = offsetX + r.left
      const localOffsetY = offsetY + r.top

      // 优先比 contentDocument.location.href,同时回落 src
      let nestedDoc: Document | null = null
      try {
        nestedDoc = f.contentDocument
      } catch {
        nestedDoc = null
      }
      const candidateUrls: string[] = []
      if (nestedDoc?.location?.href) candidateUrls.push(nestedDoc.location.href)
      if (f.src) candidateUrls.push(f.src)
      if (candidateUrls.some((u) => matches(u, frameUrl))) {
        return { x: localOffsetX, y: localOffsetY }
      }

      // 递归进入 same-origin 子 frame
      if (nestedDoc) {
        const found = visit(nestedDoc, localOffsetX, localOffsetY)
        if (found) return found
      }
    }
    return null
  }

  try {
    const found = visit(document, 0, 0)
    return found ?? { x: 0, y: 0 }
  } catch {
    return { x: 0, y: 0 }
  }
}

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

  // 读取用户的整页判别规则；以参数形式传入注入函数，便于即时生效
  const settings = await getSettings()
  const fullPageRules = settings.fullPageRules
  const siteRule =
    settings.siteScrollRegions[hostnameFromUrl(tab.url) ?? ""] ?? null

  // 解析滚动区目标 frame:用户在 iframe 内 picker 选过则 target 该 frame,
  // 否则注入主 frame(向后兼容)。
  const scrollerTarget = await resolveFrameTarget(tabId, siteRule?.frameUrl)
  // 同时拿 iframe 在主 frame viewport 里的偏移(用于切片 sourceX/Y 修正)
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
      }
    } catch {
      // 失败按 0 处理,等价于主 frame
    }
  }

  let snapshot: PreparePageSnapshot | null = null
  let hidingApplied = false
  let flattenApplied = false
  let otherIframesHidden = false

  try {
    // 0) 当 scroller 在子 frame 内时,先在主 frame 把所有"非滚动 frame"的 iframe
    //    隐藏 (display:none)。否则首屏图里会闯入流程图 / 视频 / 其它 iframe 内容,
    //    遮挡正文。主 frame scroller(siteRule.frameUrl 为空)的场景行为不变。
    if (siteRule?.frameUrl) {
      try {
        const [{ result: hideRes }] = await chrome.scripting.executeScript({
          target: { tabId },
          func: hideOtherIframesInPage,
          args: [siteRule.frameUrl]
        })
        console.log("[fullPage] hideOtherIframesInPage:", {
          keepFrameUrl: siteRule.frameUrl,
          ...hideRes
        })
        if (hideRes && hideRes.hiddenCount > 0 && hideRes.keepCount > 0) {
          // 仅当 keep 命中至少一个 iframe(目标 frame)+ 至少隐了一个时才标记
          // 已应用,避免 "全部 iframe 都被隐了" 这种异常情况下还试图恢复
          otherIframesHidden = true
          // 给一帧时间让浏览器完成 layout(display:none 触发回流)
          await sleep(120)
        } else if (hideRes && hideRes.keepCount === 0) {
          // 没找到目标 frame —— 不要乱隐藏,立即恢复(防御已 hide 的元素)
          console.warn(
            "[fullPage] hideOtherIframesInPage: 未匹配到 keep frame, 跳过隐藏"
          )
          if (hideRes.hiddenCount > 0) {
            try {
              await chrome.scripting.executeScript({
                target: { tabId },
                func: restoreOtherIframesInPage
              })
            } catch {
              /* 忽略 */
            }
          }
        }
      } catch (e) {
        // 失败仅意味着首帧仍含其它 iframe,不致命
        console.warn("[fullPage] hideOtherIframesInPage failed:", e)
      }
    }

    // 1) 准备：锁定滚动条 + 拿页面度量
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
            // 把 iframe 在主 frame viewport 中的偏移叠加到 captureX/Y 上,
            // 对主 frame 截图等价(offset=0)。
            sourceX: metrics.captureX + frameOffsetX,
            sourceY: metrics.captureY + frameOffsetY,
            sourceWidth: metrics.captureWidth,
            sourceHeight: metrics.captureHeight
          }
        : {})
    })

    const slices: CaptureSlice[] = []
    const stepHeight = metrics.viewportHeight
    let totalHeight = metrics.totalHeight
    /**
     * 真实可达的页面总高度。
     * preparePage 报告的 totalHeight 可能因 margin/transform 等偏大，
     * 用「最后一屏的实际 scrollY + viewportHeight」夹紧后再交给拼接器，
     * 避免长图末尾出现空白条。
     */
    let effectiveHeight = Math.max(totalHeight, stepHeight)

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
    const [{ result: firstScrollYRaw }] = await chrome.scripting.executeScript({
      target: scrollerTarget,
      func: scrollToY,
      args: [0]
    })
    const firstScrollY = firstScrollYRaw ?? 0
    await sleep(120)

    const firstDataUrl = await safeCaptureVisibleTab(tab.windowId, {
      format: "png"
    })
    if (!firstDataUrl) throw new Error("截图失败：返回数据为空")
    const firstBitmap = await dataUrlToBitmap(firstDataUrl)
    slices.push(makeSlice(firstBitmap, firstScrollY))

    // 首屏即覆盖整页（短页面，无需后续滚动拼接）
    if (firstScrollY + stepHeight >= totalHeight) {
      effectiveHeight = Math.max(firstScrollY + stepHeight, totalHeight)
    } else {
      // 3) 一次性隐藏 fixed/sticky + 用户自定义隐藏元素
      //    KoalaSnap 风格：用 display:none 让父容器回流，确保子元素也不可见。
      await chrome.scripting.executeScript({
        target: scrollerTarget,
        func: hideFixedElements,
        args: [fullPageRules]
      })
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

      // 4) 滚动 + 多次截图（从第二屏开始）
      let targetY = firstScrollY + stepHeight
      // 上一轮已经拍过的 scrollY（首帧），用于检测「无法再滚」
      let prevScrollY = firstScrollY

      while (true) {
        // 滚到目标位置（可能因为页面底部不足而被夹到 maxScrollY）
        const [{ result: actualY }] = await chrome.scripting.executeScript({
          target: scrollerTarget,
          func: scrollToY,
          args: [targetY]
        })
        const scrollY = actualY ?? targetY

        // 滚动后留一帧时间让浏览器完成 layout/paint
        await sleep(120)

        // 补隐藏 SPA（React/Vue）滚动回调里重新挂载的顶栏/侧栏 DOM。
        // 旧节点已被 MARK，函数内部幂等跳过；仅对新增 fixed/sticky 节点生效。
        try {
          await chrome.scripting.executeScript({
            target: scrollerTarget,
            func: rehideFixedElements,
            args: [fullPageRules]
          })
        } catch {
          /* 隐藏失败不致命，继续截图 */
        }

        const dataUrl = await safeCaptureVisibleTab(tab.windowId, {
          format: "png" // 中间帧统一用 png 无损，最后再按目标格式编码
        })
        if (!dataUrl) throw new Error("截图失败：返回数据为空")

        const bitmap = await dataUrlToBitmap(dataUrl)
        slices.push(makeSlice(bitmap, scrollY))

        // 终止条件 1：页面无法再滚（实际 scrollY 与上一轮相同）
        // 这同时覆盖了：短页面无法滚动、totalHeight 高估、动态加载未触发等情况
        if (scrollY === prevScrollY) {
          // 兜底：仍取已扩展的 totalHeight / effectiveHeight 较大值。
          // 摊平弹窗时已通过 spacer 撑高文档，正常会先命中条件 2；
          // 此处用 max 确保即使 spacer 失效，弹窗 maxBottom 也不会被回退覆盖。
          effectiveHeight = Math.max(
            scrollY + stepHeight,
            totalHeight,
            effectiveHeight
          )
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
    }

    // 5) 截完恢复 fixed/sticky 元素
    if (hidingApplied) {
      try {
        await chrome.scripting.executeScript({
          target: scrollerTarget,
          func: restoreFixedElements
        })
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

    // 5.2) 恢复被隐藏的其它 iframe(注入主 frame)
    if (otherIframesHidden) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: restoreOtherIframesInPage
        })
        otherIframesHidden = false
      } catch {
        /* tab 可能关闭，下面 finally 还会兜底 */
      }
    }

    // 6) 拼接
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
          args: [snapshot ?? {
            htmlOverflow: "",
            bodyOverflow: "",
            originalScrollY: 0,
            scrollerIsElement: false,
            originalScrollerScrollTop: 0,
            scrollerViewportTop: 0,
            scrollerViewportLeft: 0,
            scrollerViewportWidth: 0,
            scrollerViewportHeight: 0
          }]
        })
      } catch {
        /* 标签可能已关闭，忽略 */
      }
    }
    // 兜底恢复其它 iframe
    if (otherIframesHidden) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: restoreOtherIframesInPage
        })
      } catch {
        /* 忽略 */
      }
    }
  }
}

/* ============================================================
 * 2.5 手动滚动区域选择
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

    // 先决定要在哪个 frame 内 picker。流程:
    //  1) 主 frame 注入 listFramesInPage,枚举页面里所有可见的 iframe + rect + src
    //  2) 同步拿 chrome.webNavigation.getAllFrames 的 frameId 列表
    //  3) 按 url 匹配 frameId 与 iframe rect,组装 FramePickerOption[]
    //  4) 如果存在 iframe,主 frame 弹 frame 选择面板让用户决定;
    //     否则直接在主 frame 内 pickScrollRegion
    //  5) 决定后只在选中的 frame 内注入 pickScrollRegion
    let pickerTarget: chrome.scripting.InjectionTarget = { tabId }

    // (1) 主 frame 枚举 iframe (递归 same-origin)
    let iframeInfos: Array<{
      url: string
      title: string
      rect: { left: number; top: number; width: number; height: number }
    }> = []
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: listFramesInPage
      })
      iframeInfos = result ?? []
    } catch (e) {
      console.warn("[selectScrollRegion] listFramesInPage failed:", e)
      iframeInfos = []
    }

    // (2) 拿 webNavigation 全量 frame 树
    let frames: chrome.webNavigation.GetAllFrameResultDetails[] = []
    try {
      frames = (await chrome.webNavigation.getAllFrames({ tabId })) ?? []
    } catch (e) {
      console.warn("[selectScrollRegion] getAllFrames failed:", e)
      frames = []
    }

    // (3) 仅当存在多个 frame 时才弹选择面板;只有主 frame 一个则直接 picker
    if (frames.length > 1) {
      // 主 frame 一律对应 frameId=0(WebExtensions 约定:parentFrameId=-1)
      const mainFrame = frames.find((f) => f.parentFrameId === -1)
      const options: FramePickerOption[] = []
      if (mainFrame) {
        options.push({
          frameId: mainFrame.frameId,
          url: mainFrame.url,
          isMain: true,
          // 主 frame 选项展示整个 viewport 范围(下面单独注入函数补真实尺寸)
          rect: { left: 0, top: 0, width: 0, height: 0 },
          label: "主页面"
        })
      }
      // 把所有非主 frame 都列出来。优先用 iframeInfos 提供的 rect(若 url 能匹配上),
      // 匹配不上的仍列出,但没有 rect 预览。
      //
      // url 匹配采取 origin + 部分 path 的宽松匹配:
      //  - iframe src 在加载后可能与 contentDocument.location.href 一致也可能不一致
      //  - listFramesInPage 已优先取 contentDocument.location.href
      //  - 但跨域中间层 iframe 仍只有 src,与 webNavigation 的 url 可能含/不含 query
      const matchInfo = (frameUrl: string) => {
        // 完全相等
        let m = iframeInfos.find((info) => info.url === frameUrl)
        if (m) return m
        // origin + 第一段 path 匹配
        try {
          const t = new URL(frameUrl)
          m = iframeInfos.find((info) => {
            try {
              const u = new URL(info.url)
              return (
                u.origin === t.origin &&
                u.pathname.split("/")[1] === t.pathname.split("/")[1]
              )
            } catch {
              return false
            }
          })
          if (m) return m
        } catch {
          // ignore
        }
        return null
      }

      frames
        .filter((f) => f.parentFrameId !== -1)
        .forEach((f) => {
          const info = matchInfo(f.url)
          let label: string
          if (info?.title) {
            label = info.title
          } else {
            try {
              const u = new URL(f.url)
              label = u.hostname + u.pathname.slice(0, 30)
            } catch {
              label = f.url.slice(0, 50)
            }
          }
          options.push({
            frameId: f.frameId,
            url: f.url,
            isMain: false,
            rect: info?.rect ?? { left: 0, top: 0, width: 0, height: 0 },
            label
          })
        })

      if (options.length >= 2) {
        // 主 frame 选项需要补真实 viewport rect — 注入函数自行算
        const mainOpt = options.find((o) => o.isMain)
        if (mainOpt) {
          try {
            const [{ result: vp }] = await chrome.scripting.executeScript({
              target: { tabId },
              func: () => ({
                w: document.documentElement.clientWidth,
                h: document.documentElement.clientHeight
              })
            })
            if (vp) {
              mainOpt.rect = { left: 0, top: 0, width: vp.w, height: vp.h }
            }
          } catch {
            // 失败也无妨,rect 留 0,只影响 hover 预览
          }
        }
        // 在主 frame 弹 frame 选择面板
        const [{ result: chosenFrameId }] = await chrome.scripting.executeScript({
          target: { tabId },
          func: pickFrame,
          args: [options]
        })
        if (chosenFrameId == null) {
          return { ok: false, cancelled: true, error: "已取消" }
        }
        if (chosenFrameId === 0) {
          pickerTarget = { tabId }
        } else {
          pickerTarget = { tabId, frameIds: [chosenFrameId] }
        }
      }
      // options.length < 2 则退化到主 frame 直接 picker(理论上 frames.length>1
      // 时不会走到这里,因为主 frame 至少 1 项,但作为兜底保留)
    }

    // (5) 在选定 frame 内注入 pickScrollRegion
    const results = await chrome.scripting.executeScript({
      target: pickerTarget,
      func: pickScrollRegion
    })
    const picked = results.map((r) => r.result).find((r) => r != null)

    if (!picked) return { ok: false, cancelled: true, error: "已取消" }

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
