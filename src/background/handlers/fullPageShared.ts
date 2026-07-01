/**
 * 长截图（滚动拼接）两套实现的公共工具。
 *
 * 旧流程（capture.ts handleCaptureFullPage）与激进隐藏流程
 * （captureFullPageAggressive.ts）都依赖这些工具：
 *  - captureVisibleTab 限频包装（共享同一限频时间戳，避免两套实现各自计时撞 quota）
 *  - 调试帧 / slice dump
 *  - frameUrl → InjectionTarget 解析、iframe 在主 frame 中的偏移定位
 *
 * 提取到此独立模块，既能在两套实现间复用，也为 capture.ts / 激进流程减负。
 */
import type { CaptureSlice } from "~src/background/utils/imaging"
import type { CaptureResponse } from "~src/shared/messages"
import type { SiteScrollRegionRule } from "~src/shared/settings"

/**
 * 路由上下文：fullPageRouter 选定专家后传给具体 handler 的可选参数。
 *
 * 默认（不传）时 handler 按原有逻辑工作（按 hostname 读取 siteScrollRegions）。
 * 路由器需要让某次截图临时使用特定滚动区 / iframe 时（如自动探测到主体 iframe），
 * 通过 siteRuleOverride 传入一条合成规则。
 */
export interface FullPageRouting {
  /**
   * 覆盖默认按 hostname 读取的站点滚动区规则。
   *  - undefined：不覆盖，handler 仍按 hostname 自行读取
   *  - null：显式声明"本次无站点规则"（即便存储里有也忽略）
   *  - 对象：使用该合成规则（典型：路由到 iframe 专家时传入 { frameUrl } ）
   */
  siteRuleOverride?: SiteScrollRegionRule | null
  /**
   * 激进隐藏结构性 chrome（顶栏 + 大侧边栏）：spa-like 专家专用。
   * 开启后标准流程的隐藏步骤不再豁免「全高窄侧栏 / 内容型大块 fixed」，
   * 把固定顶栏 + 侧边栏一并隐藏，使其只在首帧出现。默认 false（标准专家保留侧栏）。
   */
  hideStructuralChrome?: boolean
}

/** captureVisibleTab 限频间隔（ms），Chrome 限制约 2 次/秒，留一点裕量 */
export const CAPTURE_INTERVAL = 600

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * 调试开关：每滚动一帧就下载一张原始帧（带 scrollY 文件名）+ 在 console
 * 打印 slice 元数据。打开后会在「下载」目录看到一串 `_dbg_frameXX.png`，
 * 帮助定位拼接错位 / 内容覆盖问题。生产时关掉。
 */
export const DEBUG_DUMP_FRAMES = false

export async function dumpDebugFrame(
  dataUrl: string,
  index: number,
  scrollY: number,
  meta: Record<string, unknown>
): Promise<void> {
  if (!DEBUG_DUMP_FRAMES) return
  try {
    console.log(`[fullPage][dbg] frame ${index}`, { scrollY, ...meta })
    const filename = `_dbg_frame${String(index).padStart(2, "0")}_y${Math.round(
      scrollY
    )}.png`
    await chrome.downloads.download({
      url: dataUrl,
      filename,
      saveAs: false,
      conflictAction: "uniquify"
    })
  } catch (err) {
    console.warn("[fullPage][dbg] dump failed", err)
  }
}

/**
 * 调试：把 slice 实际切片后的样子单独下载下来。
 * 直接用 OffscreenCanvas 模拟 stitchToBlob 里的裁切逻辑，便于对比"原始整屏 png"
 * 和"最终拼接长图"之间在哪一步出问题。
 */
export async function dumpDebugSlice(
  bitmap: ImageBitmap,
  index: number,
  slice: CaptureSlice,
  dpr: number
): Promise<void> {
  if (!DEBUG_DUMP_FRAMES) return
  try {
    const sx = Math.max(0, Math.round((slice.sourceX ?? 0) * dpr))
    const sy = Math.max(0, Math.round((slice.sourceY ?? 0) * dpr))
    const sw = Math.min(
      bitmap.width - sx,
      Math.round((slice.sourceWidth ?? bitmap.width / dpr) * dpr)
    )
    const sh = Math.min(
      bitmap.height - sy,
      Math.round((slice.sourceHeight ?? bitmap.height / dpr) * dpr)
    )
    console.log(`[fullPage][dbg] slice ${index} crop`, {
      sx,
      sy,
      sw,
      sh,
      bitmapW: bitmap.width,
      bitmapH: bitmap.height,
      sliceScrollY: slice.scrollY,
      sourceX: slice.sourceX,
      sourceY: slice.sourceY,
      sourceWidth: slice.sourceWidth,
      sourceHeight: slice.sourceHeight
    })
    if (sw <= 0 || sh <= 0) return
    const canvas = new OffscreenCanvas(sw, sh)
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh)
    const blob = await canvas.convertToBlob({ type: "image/png" })
    const reader = new FileReader()
    const url = await new Promise<string>((resolve, reject) => {
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(blob)
    })
    await chrome.downloads.download({
      url,
      filename: `_dbg_slice${String(index).padStart(2, "0")}_y${Math.round(slice.scrollY)}.png`,
      saveAs: false,
      conflictAction: "uniquify"
    })
  } catch (err) {
    console.warn("[fullPage][dbg] slice dump failed", err)
  }
}

export function hostnameFromUrl(url?: string): string | null {
  if (!url) return null
  try {
    return new URL(url).hostname
  } catch {
    return null
  }
}

/**
 * URL 宽松匹配。
 * 用于把 SiteScrollRegionRule.frameUrl（用户选取时记下的 location.href）
 * 与 chrome.webNavigation.getAllFrames 返回的当前 frame.url 对齐。
 *
 * 同时也用于在 DOM 树里递归查找 iframe 元素（src vs contentDocument.location.href
 * 加载后可能略有差异，hash/query 也常变）。
 *
 * 策略：完全相等优先，否则 origin + 第一段 path 一致即视为同一 frame。
 */
function looseMatchUrl(a: string, b: string): boolean {
  if (a === b) return true
  try {
    const ua = new URL(a)
    const ub = new URL(b)
    if (ua.origin !== ub.origin) return false
    return ua.pathname.split("/")[1] === ub.pathname.split("/")[1]
  } catch {
    return false
  }
}

/**
 * 把 SiteScrollRegionRule.frameUrl 解析到具体的 InjectionTarget。
 *
 * 用户可能在 iframe 内（如内嵌 SaaS 文档/编辑器）picker 选取了滚动区，
 * 此时 frameUrl 记录该 iframe 的 location.href。截图流程的所有注入都要 target
 * 到对应 frame，否则会在主 frame 找不到 selector / scroller。
 *
 * 匹配策略：完全相等优先 → 同 origin 模糊匹配 → 回退主 frame。
 */
export async function resolveFrameTarget(
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
  const partial = frames.find((f) => looseMatchUrl(f.url, frameUrl))
  if (partial) return { tabId, frameIds: [partial.frameId] }
  return { tabId }
}

/**
 * 注入到主 frame，递归 same-origin 文档树定位指定 frameUrl 的 iframe，
 * 返回它在主 frame viewport 中的左上角 (x,y)。
 *
 * iframe 内的 preparePage 报告的 captureX/Y 是 iframe 局部坐标
 * （以 iframe viewport 左上为原点）；captureVisibleTab 拍的是整个 tab viewport，
 * 所以从全屏 png 切片时要把 iframe 在 tab viewport 中的偏移加上去。
 *
 * 跨域中间层 iframe 阻断递归：拿到中间层的偏移作为近似值（误差 = target 在
 * 中间层内的局部位置）。仍是 best-effort，多数 SaaS 嵌套 iframe 是同源。
 *
 * 兜底：精确/模糊匹配都没命中（典型场景：iframe src 带每次刷新都变的 timestamp
 * query 但 path 第一段也变），退而取主 frame 中"最大可见 iframe"。popo 文档
 * 等富文本嵌入页一般主 iframe 占视口 ≥ 50%，远比侧边的小 iframe 大，区分度高。
 */
export function locateFrameOffsetInPage(
  frameUrl: string
): { x: number; y: number; matchedBy: "exact" | "loose" | "largest" | "none" } {
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

  // 1) 同源递归精确/模糊查找
  const visit = (
    doc: Document,
    offsetX: number,
    offsetY: number
  ): { x: number; y: number; matchedBy: "exact" | "loose" } | null => {
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
      const localX = offsetX + r.left
      const localY = offsetY + r.top

      let nestedDoc: Document | null = null
      try {
        nestedDoc = f.contentDocument
      } catch {
        nestedDoc = null
      }
      if (f.src === frameUrl) return { x: localX, y: localY, matchedBy: "exact" }
      if (nestedDoc?.location?.href === frameUrl) {
        return { x: localX, y: localY, matchedBy: "exact" }
      }
      if (matches(f.src, frameUrl) || matches(nestedDoc?.location?.href ?? "", frameUrl)) {
        return { x: localX, y: localY, matchedBy: "loose" }
      }

      if (nestedDoc) {
        const found = visit(nestedDoc, localX, localY)
        if (found) return found
      }
    }
    return null
  }

  try {
    const found = visit(document, 0, 0)
    if (found) return found
  } catch {
    /* 继续走兜底 */
  }

  // 2) 兜底：取「最大可见 iframe」。
  //    popo 文档 iframe.src 带每次都变的 timestamp，path 第一段（"app"）
  //    虽然稳定，但若将来 path 也变会同样失效。最大 iframe 兜底覆盖了
  //    "页面只有一个主 iframe + 几个小 iframe（统计/分享）" 这类典型布局。
  let best: { el: HTMLIFrameElement; area: number } | null = null
  document.querySelectorAll<HTMLIFrameElement>("iframe").forEach((f) => {
    let r: DOMRect
    try {
      r = f.getBoundingClientRect()
    } catch {
      return
    }
    if (r.width <= 0 || r.height <= 0) return
    const cs = getComputedStyle(f)
    if (cs.display === "none" || cs.visibility === "hidden") return
    const area = r.width * r.height
    const cur = best as { el: HTMLIFrameElement; area: number } | null
    if (!cur || area > cur.area) best = { el: f, area }
  })
  const winner = best as { el: HTMLIFrameElement; area: number } | null
  if (winner) {
    const r = winner.el.getBoundingClientRect()
    return { x: r.left, y: r.top, matchedBy: "largest" }
  }
  return { x: 0, y: 0, matchedBy: "none" }
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

export async function safeCaptureVisibleTab(
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

export function errorResponse(err: unknown): CaptureResponse {
  return {
    ok: false,
    error: err instanceof Error ? err.message : String(err)
  }
}
