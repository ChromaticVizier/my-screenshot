/**
 * 整页截图：在页面上下文中执行的辅助函数
 *
 * 这些函数会被 chrome.scripting.executeScript 序列化注入到页面执行，
 * 因此：
 *  - 不能依赖外部 import（必须自包含）
 *  - 参数与返回值必须可结构化克隆（不能传函数、DOM）
 *
 * 工作方式：background 通过多次调用以下函数完成长截图流程：
 *   1. preparePage()         → 锁定滚动条 + 收集页面尺寸（首帧保留顶/侧栏）
 *   2. scrollTo({ y })       → 滚到指定位置（重复多次）
 *   3. recordAnchors()       → 首帧滚到 y=0 时调用：记录候选元素当前的"文档绝对 top"
 *   4. hideStickyForFrame()  → 后续帧滚动后调用：对比绝对 top，跟着视口走的元素就隐藏
 *   5. restoreStickyForFrame() → 截图完成后立即恢复
 *   6. restorePage(snapshot) → 流程结束恢复滚动条与滚动位置
 *
 * 检测原理：
 *   非 sticky 元素的"文档绝对 top"（rect.top + scrollY）滚动时不变；
 *   sticky/fixed/JS 伪 sticky 元素会"跟着视口走"，绝对 top 随 scrollY 同步增长。
 *   后续帧测量同一元素绝对 top 与首帧记录值之差，> 阈值即视为"贴着视口"，隐藏。
 *   这能同时覆盖：真 fixed、真 sticky、JS+transform 模拟的伪 sticky。
 *
 *   候选元素只选"可能贴边"的：position 不是 static / sticky / fixed 的小元素也纳入，
 *   范围足够宽以兜底；首帧绝对 top 由 dataset 暂存以跨次调用读取。
 */

/** 由 preparePage 返回，传给 restorePage 用于还原 */
export interface PreparePageSnapshot {
  /** 原 documentElement.style.overflow */
  htmlOverflow: string
  /** 原 body.style.overflow */
  bodyOverflow: string
  /** 原 scrollY */
  originalScrollY: number
}

export interface PageMetrics {
  totalHeight: number
  viewportWidth: number
  viewportHeight: number
  devicePixelRatio: number
}

/* ========== 注入函数：必须自包含 ========== */

/**
 * 准备页面：只收集度量、锁定 overflow，不隐藏任何元素。
 * 首帧需要保留顶/侧栏正常显示。
 */
export function preparePage(): PageMetrics & {
  snapshot: PreparePageSnapshot
} {
  const html = document.documentElement
  const body = document.body

  const snapshot: PreparePageSnapshot = {
    htmlOverflow: html.style.overflow,
    bodyOverflow: body.style.overflow,
    originalScrollY: window.scrollY
  }

  // 计算总高度（取多种属性的最大值，处理特殊布局）
  const totalHeight = Math.max(
    document.body.scrollHeight,
    document.documentElement.scrollHeight,
    document.body.offsetHeight,
    document.documentElement.offsetHeight,
    document.documentElement.clientHeight
  )

  return {
    totalHeight,
    viewportWidth: html.clientWidth,
    viewportHeight: html.clientHeight,
    devicePixelRatio: window.devicePixelRatio || 1,
    snapshot
  }
}

/** 滚动到指定 Y 位置（同步：滚动后立即返回当前实际 scrollY） */
export function scrollToY(y: number): number {
  window.scrollTo({ top: y, left: 0, behavior: "instant" as ScrollBehavior })
  return window.scrollY
}

/**
 * 首帧调用：记录所有可见元素当前的"文档绝对 top/left"到 dataset。
 *
 * 后续帧用这两个值比对：若元素在视口里位置没怎么变（绝对位置随 scrollY 同步移动），
 * 说明它是"跟着视口走"的 sticky / fixed / JS 伪 sticky，需要隐藏。
 *
 * 只记录"可能贴边"的元素（rect 在视口里或紧邻视口），减少 dataset 噪音。
 */
export function recordAnchors(): number {
  const ANCHOR_TOP = "__myScreenshotAnchorTop"
  const ANCHOR_LEFT = "__myScreenshotAnchorLeft"
  const scrollX = window.scrollX
  const scrollY = window.scrollY
  const vw = document.documentElement.clientWidth
  const vh = document.documentElement.clientHeight

  const all = document.querySelectorAll<HTMLElement>("body *")
  let count = 0

  all.forEach((el) => {
    let cs: CSSStyleDeclaration
    try {
      cs = getComputedStyle(el)
    } catch {
      return
    }
    if (cs.visibility === "hidden" || cs.display === "none") return

    const rect = el.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return

    // 跳过明显与"贴边"无关的元素：完全不在视口内的
    if (
      rect.bottom < 0 ||
      rect.top > vh ||
      rect.right < 0 ||
      rect.left > vw
    ) {
      return
    }

    ;(el.dataset as Record<string, string>)[ANCHOR_TOP] = String(
      rect.top + scrollY
    )
    ;(el.dataset as Record<string, string>)[ANCHOR_LEFT] = String(
      rect.left + scrollX
    )
    count++
  })

  return count
}

/**
 * 截图前隐藏所有"跟着视口走的小型贴边元素"。
 *
 * 判别两个维度：
 *
 *  A) 行为：当前帧"文档绝对 top/left"（rect.top + scrollY）与首帧记录值显著不同
 *     → 元素跟着视口走（真 fixed/sticky 或 JS 伪 sticky 都会命中）
 *
 *  B) 形态：必须是"小型贴边装饰"，不能是占据视口的内容容器
 *     - 横向栏：宽 >= 视口宽 50%，高 <= 视口高 30%
 *     - 纵向栏：高 >= 视口高 50%，宽 <= 视口宽 30%
 *     - 小角标 / 浮窗：宽 <= 视口宽 40% 且 高 <= 视口高 40%
 *     - 任何占据视口大部分（同时 宽 > 50% 且 高 > 50%）的元素一律保留
 *       （SPA 主内容容器、卡片大块、模态层底框等）
 *
 * 两条都满足才隐藏。
 *
 * 返回 hiddenCount 仅用于诊断。
 */
export function hideStickyForFrame(): number {
  const MARK = "__myScreenshotHidden"
  const ANCHOR_TOP = "__myScreenshotAnchorTop"
  const ANCHOR_LEFT = "__myScreenshotAnchorLeft"
  const scrollX = window.scrollX
  const scrollY = window.scrollY
  const vw = document.documentElement.clientWidth
  const vh = document.documentElement.clientHeight

  const all = document.querySelectorAll<HTMLElement>("body *")
  let count = 0

  all.forEach((el) => {
    const ds = el.dataset as Record<string, string | undefined>
    if (MARK in ds) return
    if (!(ANCHOR_TOP in ds) || !(ANCHOR_LEFT in ds)) return

    let cs: CSSStyleDeclaration
    try {
      cs = getComputedStyle(el)
    } catch {
      return
    }
    if (cs.visibility === "hidden" || cs.display === "none") return

    const rect = el.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return

    // ---- A 行为：是否跟着视口走 ----
    const anchorTop = Number(ds[ANCHOR_TOP])
    const anchorLeft = Number(ds[ANCHOR_LEFT])
    if (!isFinite(anchorTop) || !isFinite(anchorLeft)) return

    const dyFollow = rect.top + scrollY - anchorTop
    const dxFollow = rect.left + scrollX - anchorLeft
    const followsViewport =
      Math.abs(dyFollow) > 3 || Math.abs(dxFollow) > 3
    if (!followsViewport) return

    // ---- B 形态：必须是"小型贴边"，绝不能是内容容器 ----
    // 同时占视口大部分的元素 = 内容容器，保留
    const isLargeContent = rect.width > vw * 0.5 && rect.height > vh * 0.5
    if (isLargeContent) return

    const isHorizontalBar =
      rect.width >= vw * 0.5 && rect.height <= vh * 0.3
    const isVerticalBar =
      rect.height >= vh * 0.5 && rect.width <= vw * 0.3
    const isSmallFloater =
      rect.width <= vw * 0.4 && rect.height <= vh * 0.4

    if (!(isHorizontalBar || isVerticalBar || isSmallFloater)) return

    ;(el.dataset as Record<string, string>)[MARK] = el.style.visibility || ""
    el.style.visibility = "hidden"
    count++
  })

  return count
}

/** 与 hideStickyForFrame 配对：截完帧后恢复 visibility。 */
export function restoreStickyForFrame(): void {
  const MARK = "__myScreenshotHidden"
  document.querySelectorAll<HTMLElement>("body *").forEach((el) => {
    const ds = el.dataset as Record<string, string | undefined>
    if (MARK in ds) {
      el.style.visibility = ds[MARK] ?? ""
      delete ds[MARK]
    }
  })
}

/** 恢复页面原状（滚动条 + 滚动位置）。同时兜底清理隐藏标记与首帧锚点。 */
export function restorePage(snapshot: PreparePageSnapshot): void {
  const MARK = "__myScreenshotHidden"
  const ANCHOR_TOP = "__myScreenshotAnchorTop"
  const ANCHOR_LEFT = "__myScreenshotAnchorLeft"
  document.querySelectorAll<HTMLElement>("body *").forEach((el) => {
    const ds = el.dataset as Record<string, string | undefined>
    if (MARK in ds) {
      el.style.visibility = ds[MARK] ?? ""
      delete ds[MARK]
    }
    if (ANCHOR_TOP in ds) delete ds[ANCHOR_TOP]
    if (ANCHOR_LEFT in ds) delete ds[ANCHOR_LEFT]
  })

  document.documentElement.style.overflow = snapshot.htmlOverflow
  document.body.style.overflow = snapshot.bodyOverflow
  window.scrollTo({
    top: snapshot.originalScrollY,
    left: 0,
    behavior: "instant" as ScrollBehavior
  })
}
