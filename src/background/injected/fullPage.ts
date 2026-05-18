/**
 * 整页截图：在页面上下文中执行的辅助函数
 *
 * 这些函数会被 chrome.scripting.executeScript 序列化注入到页面执行，
 * 因此：
 *  - 不能依赖外部 import（必须自包含）
 *  - 参数与返回值必须可结构化克隆（不能传函数、DOM）
 *
 * 工作方式：background 通过多次调用以下函数完成长截图流程：
 *   1. preparePage()         → 锁定滚动条 + 收集页面尺寸 + 隐藏 fixed/sticky
 *   2. scrollTo({ y })       → 滚到指定位置（重复多次）
 *   3. restorePage(snapshot) → 恢复 fixed/sticky 与滚动位置
 */

/** 由 preparePage 返回，传给 restorePage 用于还原 */
export interface PreparePageSnapshot {
  /** 原 documentElement.style.overflow */
  htmlOverflow: string
  /** 原 body.style.overflow */
  bodyOverflow: string
  /** 原 scrollY */
  originalScrollY: number
  /** 受影响元素与原 visibility 的列表（按 dataset key 关联） */
  hiddenCount: number
}

export interface PageMetrics {
  totalHeight: number
  viewportWidth: number
  viewportHeight: number
  devicePixelRatio: number
}

/* ========== 注入函数：必须自包含 ========== */

/**
 * 准备页面：
 * - 收集页面度量信息
 * - 隐藏所有 position: fixed / sticky 元素，防止滚动残影
 * - 禁用 html/body 的滚动条交互（避免抖动）
 */
export function preparePage(): PageMetrics & {
  snapshot: PreparePageSnapshot
} {
  const html = document.documentElement
  const body = document.body

  const snapshot: PreparePageSnapshot = {
    htmlOverflow: html.style.overflow,
    bodyOverflow: body.style.overflow,
    originalScrollY: window.scrollY,
    hiddenCount: 0
  }

  // 收集 fixed / sticky 元素并隐藏
  const all = document.querySelectorAll<HTMLElement>("body *")
  const MARK = "__myScreenshotHidden"
  all.forEach((el) => {
    const cs = getComputedStyle(el)
    if (cs.position === "fixed" || cs.position === "sticky") {
      // 保留原 visibility 到 dataset，便于恢复
      ;(el.dataset as Record<string, string>)[MARK] = el.style.visibility || ""
      el.style.visibility = "hidden"
      snapshot.hiddenCount++
    }
  })

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

/** 恢复页面原状 */
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
