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
 *   3. hideStickyForFrame()  → 后续帧滚动后调用：隐藏所有粘在视口边缘的元素
 *   4. restoreStickyForFrame() → 截图完成后立即恢复，避免页面长时间观感异常
 *   5. restorePage(snapshot) → 流程结束恢复滚动条与滚动位置
 *
 * 隐藏策略（对齐 awesome-screenshot）：
 *   - 首帧不隐藏，让顶栏 / 侧栏 / 角标正常出现
 *   - 后续每滚到新位置都重新扫描：
 *     a) computed position 为 fixed / sticky 的元素
 *     b) 形似"伪 sticky"的元素：体积接近视口宽 / 高，且贴在视口某条边
 *        （覆盖部分 SPA 用 JS + transform 模拟的 sticky 顶栏 / 侧栏）
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
 * 截图前隐藏所有"粘在视口边缘"的元素。
 *
 * 核心思路：只隐藏"条状贴边元素"（顶/底/侧栏），保留作为内容容器的大块。
 *
 * 命中条件（必须同时满足）：
 *  1) 紧贴视口某条边（top<=1 / bottom>=vh-1 / left<=1 / right>=vw-1）
 *  2) 形态是"条"：
 *     - 横向栏：宽度 >= 视口宽 60%，且高度 <= 视口高 40%
 *     - 纵向栏：高度 >= 视口高 60%，且宽度 <= 视口宽 40%
 *  3) 自身不是内部可滚动容器
 *     （scrollHeight > clientHeight 或 scrollWidth > clientWidth 的元素是 SPA
 *      内容滚动容器，例如 Confluence 的 main panel；隐藏它会把全部内容抹掉）
 *
 * 命中后区分 fixed/sticky 与其它定位：
 *  - 对真 fixed/sticky 总是隐藏（典型的顶/侧栏、悬浮按钮）
 *  - 对其它定位（absolute/relative/static）只在"条形 + 贴边"满足时隐藏
 *    （覆盖 SPA 用 JS+transform 模拟的伪 sticky）
 *
 * 返回 hiddenCount 仅用于诊断；恢复不依赖返回值，统一扫描 dataset 标记。
 */
export function hideStickyForFrame(): number {
  const MARK = "__myScreenshotHidden"
  const vw = document.documentElement.clientWidth
  const vh = document.documentElement.clientHeight

  const all = document.querySelectorAll<HTMLElement>("body *")
  let count = 0

  all.forEach((el) => {
    // 已隐藏跳过
    if (MARK in (el.dataset as Record<string, string | undefined>)) return

    let cs: CSSStyleDeclaration
    try {
      cs = getComputedStyle(el)
    } catch {
      return
    }

    // 不可见 / 不占空间的不处理
    if (cs.visibility === "hidden" || cs.display === "none") return

    const rect = el.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return

    // 内部可滚动容器：是承载内容的滚动区，绝不能隐藏
    const isInternalScroller =
      (el.scrollHeight > el.clientHeight + 1 &&
        (cs.overflowY === "auto" || cs.overflowY === "scroll")) ||
      (el.scrollWidth > el.clientWidth + 1 &&
        (cs.overflowX === "auto" || cs.overflowX === "scroll"))
    if (isInternalScroller) return

    // 形态检测：必须是"条状贴边"
    const stickTop = rect.top <= 1
    const stickBottom = rect.bottom >= vh - 1
    const stickLeft = rect.left <= 1
    const stickRight = rect.right >= vw - 1

    const isHorizontalBar =
      (stickTop || stickBottom) &&
      rect.width >= vw * 0.6 &&
      rect.height <= vh * 0.4

    const isVerticalBar =
      (stickLeft || stickRight) &&
      rect.height >= vh * 0.6 &&
      rect.width <= vw * 0.4

    // 角标 / 浮窗：尺寸小且贴角，对 fixed/sticky 也认为是悬浮元素
    const isSmallFloater =
      (stickTop || stickBottom || stickLeft || stickRight) &&
      rect.width <= vw * 0.4 &&
      rect.height <= vh * 0.4

    const isFixedish = cs.position === "fixed" || cs.position === "sticky"

    let shouldHide = false
    if (isHorizontalBar || isVerticalBar) {
      shouldHide = true
    } else if (isFixedish && isSmallFloater) {
      // 真 fixed/sticky 的小型悬浮元素（回到顶部按钮、聊天小窗等）
      shouldHide = true
    }

    if (shouldHide) {
      ;(el.dataset as Record<string, string>)[MARK] = el.style.visibility || ""
      el.style.visibility = "hidden"
      count++
    }
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

/** 恢复页面原状（滚动条 + 滚动位置）。同时兜底清理可能残留的隐藏标记。 */
export function restorePage(snapshot: PreparePageSnapshot): void {
  const MARK = "__myScreenshotHidden"
  document.querySelectorAll<HTMLElement>("body *").forEach((el) => {
    const ds = el.dataset as Record<string, string | undefined>
    if (MARK in ds) {
      el.style.visibility = ds[MARK] ?? ""
      delete ds[MARK]
    }
  })

  document.documentElement.style.overflow = snapshot.htmlOverflow
  document.body.style.overflow = snapshot.bodyOverflow
  window.scrollTo({
    top: snapshot.originalScrollY,
    left: 0,
    behavior: "instant" as ScrollBehavior
  })
}
