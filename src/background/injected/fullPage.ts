/**
 * 整页截图：在页面上下文中执行的辅助函数（KoalaSnap 风格）
 *
 * 这些函数会被 chrome.scripting.executeScript 序列化注入到页面执行，
 * 因此：
 *  - 不能依赖外部 import（必须自包含；类型 import 不会被打包，安全）
 *  - 参数与返回值必须可结构化克隆（不能传函数、DOM）
 *
 * 工作方式：background 通过以下顺序完成长截图：
 *   1. preparePage()         → 锁定滚动条 + 收集页面尺寸
 *   2. hideFixedElements()   → 一次性把所有 position:fixed/sticky 元素 display:none
 *   3. 循环 scrollToY → rehideFixedElements（补隐藏 SPA 重挂载节点）→ captureVisibleTab
 *   4. restoreFixedElements() → 截完一次性恢复 display
 *   5. restorePage(snapshot) → 恢复滚动条与原 scrollY
 *
 * 设计取舍：
 *  - display:none 而非 visibility:hidden：会让父元素回流，确保子图标等被一起带走
 *    （否则 sticky 容器仍占空间，里面的小图标依然可见）
 *  - 一次性隐藏 + 一次性恢复：避免每帧重扫的开销和闪烁
 *  - 不再做"形态/角色/行为差异"启发；仅靠 computed position 命中
 *  - 用户自定义选择器最高优先级：
 *      customKeepSelectors → 从隐藏集合里移除（强制保留）
 *      customHideSelectors → 加入隐藏集合（强制隐藏）
 *  - 首帧弹窗保留：长截图首屏不调用 hideFixedElements，直接 captureVisibleTab，
 *    弹窗 / iframe / 顶部 banner 原样进入第一张图。从第二屏开始才隐藏，
 *    避免它们在每屏重复出现。该流程由 background/handlers/capture.ts 编排。
 */

import type { FullPageRuleSet } from "~src/shared/settings"

/** 由 preparePage 返回，传给 restorePage 用于还原 */
export interface PreparePageSnapshot {
  /** 原 documentElement.style.overflow */
  htmlOverflow: string
  /** 原 body.style.overflow */
  bodyOverflow: string
  /** 原 scrollY（window 滚动） */
  originalScrollY: number
  /** 主滚动容器是否落在某个内部元素上（如 SPA 里的 #app / 中栏内容区）。 */
  scrollerIsElement: boolean
  /** scrollerIsElement=true 时记录原 scrollTop，restore 时还原 */
  originalScrollerScrollTop: number
  /** 主滚动容器在浏览器视口中的 top；拼接时用于从每帧裁掉固定头部 */
  scrollerViewportTop: number
  /** 主滚动容器在浏览器视口中的 left；拼接时用于横向裁切 */
  scrollerViewportLeft: number
  /** 主滚动容器宽度 */
  scrollerViewportWidth: number
  /** 主滚动容器可视高度 */
  scrollerViewportHeight: number
}

export interface PageMetrics {
  totalHeight: number
  viewportWidth: number
  viewportHeight: number
  devicePixelRatio: number
  /** true 表示实际滚动发生在内部元素而不是 window */
  scrollerIsElement: boolean
  /** scroller 模式下用于从 captureVisibleTab 全屏图里裁切主体区域 */
  captureX: number
  captureY: number
  captureWidth: number
  captureHeight: number
}

/* ========== 注入函数：必须自包含 ========== */

/**
 * 准备页面：收集度量、锁定 overflow、检测主滚动容器，不隐藏任何元素。
 * 隐藏由 hideFixedElements 单独负责。
 *
 * 主滚动容器检测：很多 SPA 用 `<div id="app" style="height:100vh; overflow:auto">`
 * 做主滚动容器，document/body 反而 `height: 100vh; overflow: hidden|visible`，
 * window 完全不可滚。这种页面下 documentElement.scrollHeight ≈ viewportHeight，
 * 直接走 window.scrollTo 截图只会拍单帧。
 *
 * 检测启发：
 *   1) 先试 window.scrollTo(任意大值)，若 scrollY 不变 → window 不可滚
 *   2) 在 document.documentElement 子树上找：
 *      - computed overflow-y 是 auto/scroll
 *      - rect 接近全屏（占视口宽 ≥ 90% 高 ≥ 90%）
 *      - scrollHeight > clientHeight + 4
 *      命中候选里取面积最大的；若 window 可滚则跳过此步
 *   3) 给命中的元素打 dataset `data-my-screenshot-scroller="1"`，后续注入函数靠这个标记同步
 */
export function preparePage(rules?: FullPageRuleSet): PageMetrics & {
  snapshot: PreparePageSnapshot
} {
  const SCROLLER_ATTR = "data-my-screenshot-scroller"
  const html = document.documentElement
  const body = document.body

  // 清掉上一轮可能残留的标记
  document
    .querySelectorAll(`[${SCROLLER_ATTR}="1"]`)
    .forEach((el) => el.removeAttribute(SCROLLER_ATTR))

  const originalScrollY = window.scrollY

  // 1) 探测 window 是否真的能滚
  const probeY = originalScrollY + 1
  window.scrollTo({ top: probeY, left: 0, behavior: "instant" as ScrollBehavior })
  const reachedY = window.scrollY
  // 还原 scrollY，避免影响后续探测
  window.scrollTo({
    top: originalScrollY,
    left: 0,
    behavior: "instant" as ScrollBehavior
  })
  const windowScrollable = reachedY !== originalScrollY

  // 2) 找主滚动容器。
  // 不再只限「接近全屏」：三栏应用/知识库/IM 页面经常只有中间栏是主体可滚区。
  // 评分同时考虑：可滚动距离、视口面积、文本量、语义类名、居中程度。
  let scrollerEl: HTMLElement | null = null
  if (rules?.detectScrollContainer !== false) {
    const vw = html.clientWidth || window.innerWidth
    const vh = html.clientHeight || window.innerHeight
    const minRatio = rules?.scrollContainerMinRatio ?? 1.05
    const minOverflowPx = rules?.scrollContainerMinOverflowPx ?? 80
    const areaWeight = rules?.scrollContainerAreaWeight ?? 0.35
    const textWeight = rules?.scrollContainerTextWeight ?? 0.3
    const semanticWeight = rules?.scrollContainerSemanticWeight ?? 0.35
    let semanticRe: RegExp | null = null
    try {
      semanticRe = new RegExp(rules?.scrollContainerRegex || "", "i")
    } catch {
      semanticRe = null
    }

    const windowDocHeight = Math.max(
      body.scrollHeight,
      html.scrollHeight,
      body.offsetHeight,
      html.offsetHeight,
      html.clientHeight
    )
    const windowCanCover = windowScrollable && windowDocHeight > vh + minOverflowPx
    let bestScore = 0
    let bestEl: HTMLElement | null = null

    document.querySelectorAll<HTMLElement>("*").forEach((el) => {
      let cs: CSSStyleDeclaration
      try {
        cs = getComputedStyle(el)
      } catch {
        return
      }
      const oy = cs.overflowY
      if (oy !== "auto" && oy !== "scroll") return
      if (cs.display === "none" || cs.visibility === "hidden") return
      const scrollHeight = el.scrollHeight
      const clientHeight = el.clientHeight
      const overflowPx = scrollHeight - clientHeight
      if (clientHeight <= 0 || overflowPx < minOverflowPx) return
      if (scrollHeight / Math.max(1, clientHeight) < minRatio) return

      const rect = el.getBoundingClientRect()
      // 不在视口内或过小的滚动块不作为整页主体
      if (rect.width < vw * 0.15 || rect.height < vh * 0.25) return
      if (rect.bottom <= 0 || rect.top >= vh) return
      const visibleW = Math.max(0, Math.min(rect.right, vw) - Math.max(rect.left, 0))
      const visibleH = Math.max(0, Math.min(rect.bottom, vh) - Math.max(rect.top, 0))
      const visibleAreaRatio = Math.min(1, (visibleW * visibleH) / Math.max(1, vw * vh))
      if (visibleAreaRatio <= 0.03) return

      const idClass = `${el.id || ""} ${String(el.className || "")}`
      const semanticScore = semanticRe && semanticRe.test(idClass) ? 1 : 0
      const textLen = (el.innerText || "").trim().length
      const textScore = Math.min(1, textLen / 1200)
      const overflowScore = Math.min(1, overflowPx / Math.max(1, vh))
      const heightScore = Math.min(1, visibleH / Math.max(1, vh))
      const widthScore = Math.min(1, visibleW / Math.max(1, vw))
      const centerX = rect.left + rect.width / 2
      const centerScore = 1 - Math.min(1, Math.abs(centerX - vw / 2) / Math.max(1, vw / 2))
      const depthPenalty = (() => {
        let depth = 0
        let cur: HTMLElement | null = el
        while (cur && cur !== document.documentElement) {
          depth++
          cur = cur.parentElement
        }
        return Math.min(0.2, depth * 0.01)
      })()

      const areaScore = visibleAreaRatio * 0.55 + heightScore * 0.3 + widthScore * 0.15
      const score =
        overflowScore * 0.25 +
        areaScore * areaWeight +
        textScore * textWeight +
        semanticScore * semanticWeight +
        centerScore * 0.12 -
        depthPenalty

      if (score > bestScore) {
        bestScore = score
        bestEl = el
      }
    })

    // 仅当 window 不可滚，或内部容器明显比 window 更像主体时才切换。
    // 避免普通页面里某个侧栏列表误夺主滚动权。
    if (bestEl && (!windowCanCover || bestScore >= 0.55)) {
      scrollerEl = bestEl
      scrollerEl.setAttribute(SCROLLER_ATTR, "1")
    }
  }

  const scrollerRect = scrollerEl?.getBoundingClientRect()
  const snapshot: PreparePageSnapshot = {
    htmlOverflow: html.style.overflow,
    bodyOverflow: body.style.overflow,
    originalScrollY,
    scrollerIsElement: !!scrollerEl,
    originalScrollerScrollTop: scrollerEl ? scrollerEl.scrollTop : 0,
    scrollerViewportTop: scrollerRect ? Math.max(0, scrollerRect.top) : 0,
    scrollerViewportLeft: scrollerRect ? Math.max(0, scrollerRect.left) : 0,
    scrollerViewportWidth: scrollerRect
      ? Math.min(scrollerRect.width, html.clientWidth - Math.max(0, scrollerRect.left))
      : html.clientWidth,
    scrollerViewportHeight: scrollerRect
      ? Math.min(scrollerRect.height, html.clientHeight - Math.max(0, scrollerRect.top))
      : html.clientHeight
  }

  // 计算总高度：内部容器模式下用容器 scrollHeight；否则用文档高度
  const totalHeight = scrollerEl
    ? Math.max(scrollerEl.scrollHeight, scrollerEl.clientHeight)
    : Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight,
        document.body.offsetHeight,
        document.documentElement.offsetHeight,
        document.documentElement.clientHeight
      )

  // captureVisibleTab 捕获的是浏览器可视窗口；内部容器模式下从全屏图中裁切主体区域。
  const captureX = snapshot.scrollerViewportLeft
  const captureY = snapshot.scrollerViewportTop
  const captureWidth = snapshot.scrollerViewportWidth
  const captureHeight = snapshot.scrollerViewportHeight

  return {
    totalHeight,
    viewportWidth: captureWidth,
    viewportHeight: captureHeight,
    devicePixelRatio: window.devicePixelRatio || 1,
    scrollerIsElement: !!scrollerEl,
    captureX,
    captureY,
    captureWidth,
    captureHeight,
    snapshot
  }
}

/**
 * 滚动到指定 Y 位置（同步：滚动后立即返回当前实际 scrollY）。
 * 若 preparePage 检测到主滚动容器在某个内部元素上，则用 element.scrollTo 替代
 * window.scrollTo，并返回 element.scrollTop。
 */
export function scrollToY(y: number): number {
  const SCROLLER_ATTR = "data-my-screenshot-scroller"
  const scroller = document.querySelector<HTMLElement>(
    `[${SCROLLER_ATTR}="1"]`
  )
  if (scroller) {
    scroller.scrollTo({
      top: y,
      left: 0,
      behavior: "instant" as ScrollBehavior
    })
    return scroller.scrollTop
  }
  window.scrollTo({ top: y, left: 0, behavior: "instant" as ScrollBehavior })
  return window.scrollY
}

/**
 * 一次性隐藏所有 fixed/sticky 元素 + customHideSelectors 命中元素。
 *
 * customKeepSelectors 命中的元素（及其祖先）不在隐藏范围内。
 *
 * 原始 display 值挂在 window 上，restoreFixedElements 时按列表恢复。
 * 用 dataset MARK 防重复隐藏。
 *
 * 注意：调用时机由 background/handlers/capture.ts 控制——首屏拍完才调用，
 * 让弹窗 / iframe / 顶部 banner 完整进入第一张图。
 */
export function hideFixedElements(rules: FullPageRuleSet): number {
  if (!rules || rules.enabled === false) return 0

  const MARK = "__myScreenshotHidden"
  const STORE = "__myScreenshotHiddenList"

  // 把 keepSet 算出来：命中 customKeepSelectors 的元素及祖先全部进入豁免名单
  const keepSet = new Set<HTMLElement>()
  ;(rules.customKeepSelectors || []).forEach((sel) => {
    if (!sel) return
    try {
      document.querySelectorAll<HTMLElement>(sel).forEach((el) => {
        let cur: HTMLElement | null = el
        while (cur && cur !== document.documentElement) {
          keepSet.add(cur)
          cur = cur.parentElement
        }
      })
    } catch {
      // 选择器非法，忽略
    }
  })

  // 遍历范围：document.documentElement 下所有元素 + 进入 open shadowRoot
  const walk = (root: ParentNode): HTMLElement[] => {
    const out: HTMLElement[] = []
    const visit = (node: ParentNode) => {
      node.querySelectorAll<HTMLElement>("*").forEach((el) => {
        out.push(el)
        if (el.shadowRoot) visit(el.shadowRoot)
      })
    }
    visit(root)
    return out
  }

  const list: { el: HTMLElement; originalDisplay: string }[] = []
  const hide = (el: HTMLElement) => {
    if (keepSet.has(el)) return
    const ds = el.dataset as Record<string, string | undefined>
    if (MARK in ds) return
    ;(el.dataset as Record<string, string>)[MARK] = "1"
    list.push({ el, originalDisplay: el.style.display })
    el.style.display = "none"
  }

  // 1) 用户强制隐藏（最高优先级）
  ;(rules.customHideSelectors || []).forEach((sel) => {
    if (!sel) return
    try {
      document.querySelectorAll<HTMLElement>(sel).forEach(hide)
    } catch {
      // 忽略非法
    }
  })

  // 2) 所有 fixed/sticky 元素
  walk(document.documentElement).forEach((el) => {
    let cs: CSSStyleDeclaration
    try {
      cs = getComputedStyle(el)
    } catch {
      return
    }
    // 主滚动容器本身不能隐藏，否则内部滚动截图会直接白屏/只剩背景。
    if (el.getAttribute("data-my-screenshot-scroller") === "1") return
    if (cs.position === "fixed" || cs.position === "sticky") {
      hide(el)
    }
  })

  // 挂到 window 上方便 restoreFixedElements 取回；类型用 unknown 兼容
  ;(window as unknown as Record<string, unknown>)[STORE] = list
  return list.length
}

/**
 * 每帧重扫：补隐藏滚动期间新出现的 fixed/sticky 元素。
 *
 * 解决 SPA（React/Vue）顶栏重复问题：
 *   有些 SPA 在 scroll 事件回调里重新挂载/替换顶栏 DOM 节点（新节点没有 MARK
 *   也没有 inline display:none），导致首帧后的截图里顶栏再次出现。
 *
 * 与 hideFixedElements 行为一致，但：
 *  - 复用同一份 STORE，新隐藏的元素会被一并 restoreFixedElements 恢复
 *  - 借助 MARK 跳过已隐藏元素，纯增量、无副作用、不触发滚动
 *  - 每次截图循环前调用一次，保持顶部/侧栏在每一帧都不可见
 */
export function rehideFixedElements(rules: FullPageRuleSet): number {
  if (!rules || rules.enabled === false) return 0

  const MARK = "__myScreenshotHidden"
  const STORE = "__myScreenshotHiddenList"

  const keepSet = new Set<HTMLElement>()
  ;(rules.customKeepSelectors || []).forEach((sel) => {
    if (!sel) return
    try {
      document.querySelectorAll<HTMLElement>(sel).forEach((el) => {
        let cur: HTMLElement | null = el
        while (cur && cur !== document.documentElement) {
          keepSet.add(cur)
          cur = cur.parentElement
        }
      })
    } catch {
      // 忽略
    }
  })

  const store = (window as unknown as Record<string, unknown>)[STORE]
  const list = Array.isArray(store)
    ? (store as { el: HTMLElement; originalDisplay: string }[])
    : []

  const newlyHidden: HTMLElement[] = []
  const hide = (el: HTMLElement) => {
    if (keepSet.has(el)) return
    const ds = el.dataset as Record<string, string | undefined>
    if (MARK in ds) return // 已经被隐藏过，跳过
    ;(el.dataset as Record<string, string>)[MARK] = "1"
    list.push({ el, originalDisplay: el.style.display })
    el.style.display = "none"
    newlyHidden.push(el)
  }

  // 1) 用户强制隐藏（命中即隐藏，覆盖新增节点）
  ;(rules.customHideSelectors || []).forEach((sel) => {
    if (!sel) return
    try {
      document.querySelectorAll<HTMLElement>(sel).forEach(hide)
    } catch {
      // 忽略
    }
  })

  // 2) 当前所有 fixed/sticky 元素（含 open shadowRoot 子树）
  const visit = (root: ParentNode) => {
    root.querySelectorAll<HTMLElement>("*").forEach((el) => {
      let cs: CSSStyleDeclaration
      try {
        cs = getComputedStyle(el)
      } catch {
        return
      }
      // 主滚动容器本身不能隐藏，否则内部滚动截图会直接白屏/只剩背景。
      if (el.getAttribute("data-my-screenshot-scroller") === "1") return
      if (cs.position === "fixed" || cs.position === "sticky") {
        hide(el)
      }
      if (el.shadowRoot) visit(el.shadowRoot)
    })
  }
  visit(document.documentElement)

  ;(window as unknown as Record<string, unknown>)[STORE] = list
  return newlyHidden.length
}

/** 与 hideFixedElements 配对：截完恢复 display。 */
export function restoreFixedElements(): void {
  const MARK = "__myScreenshotHidden"
  const STORE = "__myScreenshotHiddenList"
  const store = (window as unknown as Record<string, unknown>)[STORE]
  const list = Array.isArray(store)
    ? (store as { el: HTMLElement; originalDisplay: string }[])
    : []
  list.forEach(({ el, originalDisplay }) => {
    el.style.display = originalDisplay
    const ds = el.dataset as Record<string, string | undefined>
    delete ds[MARK]
  })
  delete (window as unknown as Record<string, unknown>)[STORE]
}

/**
 * 探测并隐藏"JS 模拟的伪 sticky"元素。
 *
 * KoalaSnap 风格的 hideFixedElements 只能命中 computed position:fixed/sticky 的元素。
 * 但 SPA（如 Confluence、Notion）的顶栏 / 侧栏常用 JS 监听 scroll 事件、动态修改
 * transform / margin / top 来"假装"sticky，computed position 仍是 static/relative
 * → 漏网，长截图里每帧重复出现。
 *
 * 探测原理：物理特征区分
 *  - 真静态元素：scroll 时绝对位置 (rect.top + scrollY) 不变
 *  - 真/伪 sticky：scroll 时 rect.top（视口位置）几乎不变，绝对位置随滚动同步推移
 *
 * 操作步骤：
 *  1. 记录每个可见元素当前 rect.top + scrollY 作为 baseline
 *  2. 滚动 PROBE_DISTANCE 像素
 *  3. 再读一遍：若元素的 (rect.top + scrollY) 漂移量 ≈ 实际滚动距离
 *     说明它"跟着视口走"→ 加入隐藏
 *  4. 滚回原位
 *
 * 自带的兜底：
 *  - 大块元素（占视口高度 ≥ 80% 或 scrollHeight ≥ 文档高度 90%）豁免，
 *    防止 SPA 主内容容器（fixed 满屏定位）被误杀
 *  - keepSet 仍受 customKeepSelectors 控制
 *
 * 结果直接 append 到 hideFixedElements 已建立的 STORE 列表，
 * restoreFixedElements 一并恢复。
 */
export function detectAndHidePseudoSticky(rules: FullPageRuleSet): number {
  if (!rules || rules.enabled === false) return 0

  const MARK = "__myScreenshotHidden"
  const STORE = "__myScreenshotHiddenList"
  const PROBE_DISTANCE = 200 // 探测滚动距离 (px)
  const FOLLOW_RATIO = 0.7 // 漂移量 / 滚动距离 ≥ 此值即视为跟随视口
  const LARGE_AREA_RATIO = 0.8 // 占视口高度 ≥ 此值视为主内容容器，豁免
  const LARGE_SUBTREE_RATIO = 0.9 // scrollHeight / 文档高度 ≥ 此值视为主滚动容器，豁免

  const html = document.documentElement
  const SCROLLER_ATTR = "data-my-screenshot-scroller"
  const scroller = document.querySelector<HTMLElement>(
    `[${SCROLLER_ATTR}="1"]`
  )
  const getScrollTop = () => (scroller ? scroller.scrollTop : window.scrollY)
  const getScrollLeft = () => (scroller ? scroller.scrollLeft : window.scrollX)
  const scrollToPos = (top: number, left: number) => {
    if (scroller) {
      scroller.scrollTo({
        top,
        left,
        behavior: "instant" as ScrollBehavior
      })
    } else {
      window.scrollTo({
        top,
        left,
        behavior: "instant" as ScrollBehavior
      })
    }
  }
  const vw = scroller ? scroller.clientWidth : html.clientWidth
  const vh = scroller ? scroller.clientHeight : html.clientHeight
  const docHeight = scroller
    ? Math.max(scroller.scrollHeight, scroller.clientHeight)
    : Math.max(document.body.scrollHeight, document.documentElement.scrollHeight, vh)

  // 不足以滚动的页面无需探测
  const maxScroll = Math.max(0, docHeight - vh)
  if (maxScroll < PROBE_DISTANCE + 10) return 0

  // keepSet（含祖先链）
  const keepSet = new Set<HTMLElement>()
  ;(rules.customKeepSelectors || []).forEach((sel) => {
    if (!sel) return
    try {
      document.querySelectorAll<HTMLElement>(sel).forEach((el) => {
        let cur: HTMLElement | null = el
        while (cur && cur !== document.documentElement) {
          keepSet.add(cur)
          cur = cur.parentElement
        }
      })
    } catch {
      // 忽略
    }
  })

  // 仅扫描视口内可见、未隐藏元素：跟随视口的元素首帧一定在视口内
  const walk = (root: ParentNode): HTMLElement[] => {
    const out: HTMLElement[] = []
    const visit = (node: ParentNode) => {
      node.querySelectorAll<HTMLElement>("*").forEach((el) => {
        out.push(el)
        if (el.shadowRoot) visit(el.shadowRoot)
      })
    }
    visit(root)
    return out
  }

  const candidates: {
    el: HTMLElement
    baselineAbsTop: number
    baselineAbsLeft: number
  }[] = []

  const initialScrollY = getScrollTop()
  const initialScrollX = getScrollLeft()

  walk(document.documentElement).forEach((el) => {
    const ds = el.dataset as Record<string, string | undefined>
    if (MARK in ds) return // 已被 hideFixedElements 隐藏
    if (el.getAttribute(SCROLLER_ATTR) === "1") return
    if (keepSet.has(el)) return

    let cs: CSSStyleDeclaration
    try {
      cs = getComputedStyle(el)
    } catch {
      return
    }
    if (cs.visibility === "hidden" || cs.display === "none") return

    const rect = el.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return

    // 只取首屏可见的元素：跟随视口意味着首屏就在视口里
    if (rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw) {
      return
    }

    // 主内容容器豁免
    const heightRatio = vh > 0 ? rect.height / vh : 0
    const subtreeRatio = docHeight > 0 ? el.scrollHeight / docHeight : 0
    if (heightRatio >= LARGE_AREA_RATIO) return
    if (subtreeRatio >= LARGE_SUBTREE_RATIO) return

    candidates.push({
      el,
      baselineAbsTop: rect.top + initialScrollY,
      baselineAbsLeft: rect.left + initialScrollX
    })
  })

  if (candidates.length === 0) return 0

  // 滚动探测
  scrollToPos(initialScrollY + PROBE_DISTANCE, initialScrollX)
  const probedScrollY = getScrollTop()
  const actualMove = probedScrollY - initialScrollY

  // 必须实际滚动了才有判别意义
  if (Math.abs(actualMove) < PROBE_DISTANCE * 0.5) {
    // 回到原位
    scrollToPos(initialScrollY, initialScrollX)
    return 0
  }

  const toHide: HTMLElement[] = []
  candidates.forEach(({ el, baselineAbsTop }) => {
    const rect = el.getBoundingClientRect()
    const curAbsTop = rect.top + getScrollTop()
    const drift = curAbsTop - baselineAbsTop
    // 跟随视口的漂移量约等于 actualMove
    if (Math.abs(drift) >= actualMove * FOLLOW_RATIO) {
      toHide.push(el)
    }
  })

  // 滚回原位
  scrollToPos(initialScrollY, initialScrollX)

  if (toHide.length === 0) return 0

  // 追加到 STORE 列表，与 hideFixedElements 一起被 restoreFixedElements 恢复
  const store = (window as unknown as Record<string, unknown>)[STORE]
  const list = Array.isArray(store)
    ? (store as { el: HTMLElement; originalDisplay: string }[])
    : []
  toHide.forEach((el) => {
    const ds = el.dataset as Record<string, string | undefined>
    if (MARK in ds) return
    ;(el.dataset as Record<string, string>)[MARK] = "1"
    list.push({ el, originalDisplay: el.style.display })
    el.style.display = "none"
  })
  ;(window as unknown as Record<string, unknown>)[STORE] = list

  return toHide.length
}

/** 恢复页面原状（滚动条 + 滚动位置）。同时兜底清理隐藏列表残留。 */
export function restorePage(snapshot: PreparePageSnapshot): void {
  const SCROLLER_ATTR = "data-my-screenshot-scroller"
  // 万一 restoreFixedElements 因异常没被调用，这里再兜底一遍
  restoreFixedElements()

  document.documentElement.style.overflow = snapshot.htmlOverflow
  document.body.style.overflow = snapshot.bodyOverflow

  if (snapshot.scrollerIsElement) {
    const scroller = document.querySelector<HTMLElement>(
      `[${SCROLLER_ATTR}="1"]`
    )
    if (scroller) {
      scroller.scrollTo({
        top: snapshot.originalScrollerScrollTop,
        left: 0,
        behavior: "instant" as ScrollBehavior
      })
      scroller.removeAttribute(SCROLLER_ATTR)
    }
  }
  window.scrollTo({
    top: snapshot.originalScrollY,
    left: 0,
    behavior: "instant" as ScrollBehavior
  })
}

/**
 * 把"超高 fixed/sticky 弹窗"摊平为 absolute，使其底部能延伸到文档下方区域。
 *
 * 解决场景：iframe 弹窗（如菜单层、外部 url 浮窗）位于 fixed 容器内，
 * 总高度大于一屏。fixed 元素永远跟随视口，长截图首屏只能拍到顶部一截，
 * 第二屏起又被 hideFixedElements 隐藏 → 弹窗下半部分丢失。
 *
 * 思路：截图前把"含 iframe 且超出视口"的 fixed/sticky 元素改写为
 *   position: absolute
 *   top  = 当前 scrollY + 原 rect.top（保持视觉位置）
 *   left = 当前 scrollX + 原 rect.left
 *   width/height 锁死为 rect 实际尺寸，避免父容器宽度变化引起回流
 *   right/bottom/transform 清零
 *
 * 摊平后元素脱离 fixed/sticky 行为，进入文档流坐标系：
 *   - 第一屏看到弹窗顶部，第二屏看到弹窗中部，直至 scrollY > 弹窗 bottom
 *   - hideFixedElements / rehideFixedElements 不会命中（已不是 fixed/sticky）
 *
 * 返回 maxBottom = 摊平后所有元素 rect.bottom 的最大值（文档坐标），
 * 调用方据此扩展长截图 totalHeight，避免弹窗底部被裁。
 *
 * 限制条件：
 *   - 必须包含 iframe（自身或后代）。其他纯文字大弹窗不动，避免误伤
 *     SPA 全屏遮罩 / 主内容容器
 *   - 元素自身或祖先链命中 customKeepSelectors 时跳过（用户保留意图最高）
 */
export function flattenOversizedModals(rules: FullPageRuleSet): {
  count: number
  maxBottom: number
} {
  if (!rules || rules.enabled === false) return { count: 0, maxBottom: 0 }

  const STORE = "__myScreenshotFlattenedList"
  const MARK = "__myScreenshotFlattened"

  const html = document.documentElement
  const SCROLLER_ATTR = "data-my-screenshot-scroller"
  const scroller = document.querySelector<HTMLElement>(
    `[${SCROLLER_ATTR}="1"]`
  )
  const vw = scroller ? scroller.clientWidth : html.clientWidth
  const vh = scroller ? scroller.clientHeight : html.clientHeight

  // keepSet（含祖先链）：用户强制保留的元素链不参与摊平
  const keepSet = new Set<HTMLElement>()
  ;(rules.customKeepSelectors || []).forEach((sel) => {
    if (!sel) return
    try {
      document.querySelectorAll<HTMLElement>(sel).forEach((el) => {
        let cur: HTMLElement | null = el
        while (cur && cur !== document.documentElement) {
          keepSet.add(cur)
          cur = cur.parentElement
        }
      })
    } catch {
      // 忽略
    }
  })

  const scrollY = scroller ? scroller.scrollTop : window.scrollY
  const scrollX = scroller ? scroller.scrollLeft : window.scrollX

  interface FlattenedRecord {
    el: HTMLElement
    style: {
      position: string
      top: string
      left: string
      right: string
      bottom: string
      width: string
      height: string
      transform: string
      zIndex: string
      maxHeight: string
      maxWidth: string
      display: string
      visibility: string
      opacity: string
      pointerEvents: string
    }
    /** 摊平瞬间元素在 DOM 中的父节点（用于被删除时回补） */
    parent: ParentNode | null
    /** 在父节点 children 中的位置，用于按原顺序回补 */
    nextSibling: Node | null
  }
  const list: FlattenedRecord[] = []
  let maxBottom = 0

  // 主滚动容器豁免：fixed 全屏遮罩 + 内部 overflow:auto 的 SPA 主容器，
  // 误摊平会让整个页面布局崩坏。命中条件：自身 scrollHeight ≥ 文档高度 90%
  // 或自身高度 ≥ 视口 90% 且子树包含大量内容
  const docHeight = scroller
    ? Math.max(scroller.scrollHeight, scroller.clientHeight)
    : Math.max(document.body.scrollHeight, document.documentElement.scrollHeight, vh)
  const isMainContainer = (el: HTMLElement, rect: DOMRect): boolean => {
    if (vh > 0 && rect.height >= vh * 0.9 && rect.width >= vw * 0.9) {
      // 占满视口的 fixed 元素：除非它是真的弹窗，否则极可能是 SPA 主壳
      // 进一步看 scrollHeight：撑满文档的认为是主容器
      if (docHeight > 0 && el.scrollHeight >= docHeight * 0.85) return true
    }
    return false
  }

  // 判定元素「逻辑上是否跟随视口」：
  //   - 自身 position 是 fixed/sticky → 是
  //   - 否则向上查找祖先链，若途中遇到 fixed/sticky 祖先 → 是（典型场景：
  //     fixed 头部下挂 absolute dropdown，dropdown 视觉上随头部固定但
  //     computed position 仍是 absolute）
  const findStickyAncestor = (el: HTMLElement): HTMLElement | null => {
    let cur: HTMLElement | null = el.parentElement
    while (cur && cur !== document.documentElement) {
      let pcs: CSSStyleDeclaration
      try {
        pcs = getComputedStyle(cur)
      } catch {
        cur = cur.parentElement
        continue
      }
      if (pcs.position === "fixed" || pcs.position === "sticky") {
        return cur
      }
      cur = cur.parentElement
    }
    return null
  }

  // 遍历范围：document.documentElement 下所有元素 + open shadowRoot
  const visit = (root: ParentNode) => {
    root.querySelectorAll<HTMLElement>("*").forEach((el) => {
      let cs: CSSStyleDeclaration
      try {
        cs = getComputedStyle(el)
      } catch {
        return
      }
      // 自身 fixed/sticky 直接进入候选；
      // 否则若是 absolute 且祖先链有 fixed/sticky，也视为「视口跟随弹窗」候选。
      const isSelfSticky =
        cs.position === "fixed" || cs.position === "sticky"
      const isAbsoluteUnderSticky =
        cs.position === "absolute" && findStickyAncestor(el) !== null
      if (!isSelfSticky && !isAbsoluteUnderSticky) {
        if (el.shadowRoot) visit(el.shadowRoot)
        return
      }
      if (keepSet.has(el)) {
        if (el.shadowRoot) visit(el.shadowRoot)
        return
      }

      const rect = el.getBoundingClientRect()
      // oversize 判定：仅对「自身 fixed/sticky」要求超出首屏（避免误摊平
      // 占满视口的 SPA 主壳）。
      // 对「absolute-under-sticky」不要求 oversize：典型场景是 fixed 头部下挂的
      // 下拉 iframe 弹窗，即使整体在视口内，也需要摊平脱离父级——否则父级 fixed
      // 头部被 hideFixedElements display:none 时，iframe 会级联消失；同时长截图
      // 末屏与首屏重叠覆盖时也会丢失 iframe。
      if (isSelfSticky) {
        const oversize = rect.height > vh || rect.bottom > vh
        if (!oversize) {
          if (el.shadowRoot) visit(el.shadowRoot)
          return
        }
      } else {
        // absolute-under-sticky：起码得是可见、有尺寸的元素
        if (rect.width <= 0 || rect.height <= 0) {
          if (el.shadowRoot) visit(el.shadowRoot)
          return
        }
      }
      // 主容器豁免：避免 SPA 全屏 fixed 壳被误摊平
      if (isSelfSticky && isMainContainer(el, rect)) {
        if (el.shadowRoot) visit(el.shadowRoot)
        return
      }
      // 必须含 iframe（自身或后代），仅针对 iframe 弹窗
      const hasIframe =
        el.tagName === "IFRAME" || !!el.querySelector("iframe")
      if (!hasIframe) {
        if (el.shadowRoot) visit(el.shadowRoot)
        return
      }
      const ds = el.dataset as Record<string, string | undefined>
      if (MARK in ds) {
        if (el.shadowRoot) visit(el.shadowRoot)
        return
      }

      // 备份 inline style，便于恢复
      const s = el.style
      // 记录原 DOM 位置：absolute-under-sticky 场景需要把弹窗移到 body 末尾
      // 才能让 absolute 的 containing block 退化到 documentElement，确保
      // top/left 用文档坐标系书写后视觉位置准确。restore 时按 originalParent
      // / originalNextSibling 放回原位。
      const originalParent = el.parentNode
      const originalNextSibling = el.nextSibling
      list.push({
        el,
        style: {
          position: s.position,
          top: s.top,
          left: s.left,
          right: s.right,
          bottom: s.bottom,
          width: s.width,
          height: s.height,
          transform: s.transform,
          zIndex: s.zIndex,
          maxHeight: s.maxHeight,
          maxWidth: s.maxWidth,
          display: s.display,
          visibility: s.visibility,
          opacity: s.opacity,
          pointerEvents: s.pointerEvents
        },
        parent: originalParent,
        nextSibling: originalNextSibling
      })
      ;(el.dataset as Record<string, string>)[MARK] = "1"

      // 关键：把弹窗移到 body 末尾，脱离原父级（可能是 fixed 容器或含 transform
      // 的祖先）的 containing block 影响。这样 position:absolute + top/left
      // 用文档坐标系书写就能准确落位。
      // 仅当原父不是 body 或祖先链有 fixed/sticky 时才移动；纯 fixed 自身且挂
      // 在 body 下时无需移动，避免触发额外 reflow。
      const stickyAncestor = isAbsoluteUnderSticky
        ? findStickyAncestor(el)
        : null
      const needsMove =
        isAbsoluteUnderSticky ||
        (originalParent !== document.body && stickyAncestor !== null)
      if (needsMove) {
        try {
          document.body.appendChild(el)
        } catch {
          /* 移动失败按原位继续摊平，可能视觉错位但不致命 */
        }
      }

      // 改成 absolute；用 !important 顶住作者样式表
      const absTop = scrollY + rect.top
      const absLeft = scrollX + rect.left
      s.setProperty("position", "absolute", "important")
      s.setProperty("top", `${absTop}px`, "important")
      s.setProperty("left", `${absLeft}px`, "important")
      s.setProperty("right", "auto", "important")
      s.setProperty("bottom", "auto", "important")
      s.setProperty("width", `${rect.width}px`, "important")
      s.setProperty("height", `${rect.height}px`, "important")
      s.setProperty("max-height", "none", "important")
      s.setProperty("max-width", "none", "important")
      s.setProperty("transform", "none", "important")
      // zIndex 拉满：避免被同级 absolute 元素遮挡
      s.setProperty("z-index", "2147483647", "important")
      // 锁定显示状态：阻止 SPA hover/blur 事件回调把弹窗 display:none/opacity:0 收起。
      // 仅设置 !important 还会被 inline style 直接覆盖，需配合 freezeFlattenedModals
      // 启用的 MutationObserver 同步回滚才能真正抗住。
      s.setProperty("display", "block", "important")
      s.setProperty("visibility", "visible", "important")
      s.setProperty("opacity", "1", "important")
      // pointer-events:none 让弹窗不再接收鼠标事件，部分页面靠 mouseleave 收起菜单，
      // 顺便也阻断了截图扩展自身鼠标移动可能误触发的 hover/click
      s.setProperty("pointer-events", "none", "important")

      const docBottom = absTop + rect.height
      if (docBottom > maxBottom) maxBottom = docBottom

      // 摊平后不再继续向下深入：iframe 内部跨域 DOM 不可访问；
      // 普通子节点也不必递归，子树已经随父元素一起被定位
    })
  }
  visit(document.documentElement)

  ;(window as unknown as Record<string, unknown>)[STORE] = list

  // 调试日志：列出命中元素 + 跳过原因，便于现场判断 flatten 为何漏判
  try {
    const summary = list.map((r) => ({
      tag: r.el.tagName,
      cls: r.el.className,
      id: r.el.id,
      rect: r.el.getBoundingClientRect()
    }))
    console.log(
      "[fullPage] flattenOversizedModals hits:",
      summary,
      "maxBottom=",
      maxBottom
    )
  } catch {
    /* 忽略 */
  }

  // 撑高文档：absolute 元素不参与文档流，scrollHeight 不增长 → window 滚动达不到
  // 弹窗底部 → 长截图触发「scrollY === prevScrollY」提前终止 → 弹窗下半丢失。
  // 在 body 末尾插入透明 spacer，把 documentElement.scrollHeight 撑到 maxBottom，
  // 确保滚动循环能拍到弹窗下半区。
  const SPACER_STORE = "__myScreenshotFlattenSpacer"
  // 先清掉上轮可能残留的 spacer，避免重复插入
  const prevSpacer = (window as unknown as Record<string, unknown>)[
    SPACER_STORE
  ] as HTMLElement | undefined
  if (prevSpacer && prevSpacer.parentNode) {
    prevSpacer.parentNode.removeChild(prevSpacer)
  }
  delete (window as unknown as Record<string, unknown>)[SPACER_STORE]

  if (list.length > 0 && maxBottom > 0) {
    const curDocHeight = scroller
      ? Math.max(scroller.scrollHeight, scroller.clientHeight)
      : Math.max(
          document.body.scrollHeight,
          document.documentElement.scrollHeight,
          document.documentElement.clientHeight
        )
    if (maxBottom > curDocHeight) {
      const spacer = document.createElement("div")
      spacer.setAttribute("data-my-screenshot-spacer", "1")
      // 用 inline 样式 + !important，避免被作者样式表干扰；
      // 高度 = 需要补充的距离 + 1px 容差；其余属性确保不参与交互、不可见、不影响布局
      const fillHeight = Math.ceil(maxBottom - curDocHeight) + 1
      const ss = spacer.style
      ss.setProperty("display", "block", "important")
      ss.setProperty("width", "1px", "important")
      ss.setProperty("height", `${fillHeight}px`, "important")
      ss.setProperty("margin", "0", "important")
      ss.setProperty("padding", "0", "important")
      ss.setProperty("border", "0", "important")
      ss.setProperty("background", "transparent", "important")
      ss.setProperty("pointer-events", "none", "important")
      ss.setProperty("visibility", "hidden", "important")
      ss.setProperty("position", "static", "important")
      ss.setProperty("float", "none", "important")
      ss.setProperty("clear", "both", "important")
      // 内部滚动容器模式下，spacer 必须插到该容器里才能撑高它的 scrollHeight；
      // window 滚动模式才插 body。
      ;(scroller ?? document.body).appendChild(spacer)
      ;(window as unknown as Record<string, unknown>)[SPACER_STORE] = spacer
    }
  }

  return { count: list.length, maxBottom }
}

/** 与 flattenOversizedModals 配对：恢复 inline style，清理 MARK。 */
export function restoreFlattenedModals(): void {
  const STORE = "__myScreenshotFlattenedList"
  const MARK = "__myScreenshotFlattened"
  const SPACER_STORE = "__myScreenshotFlattenSpacer"

  // 先移除撑高用的 spacer
  const spacer = (window as unknown as Record<string, unknown>)[SPACER_STORE] as
    | HTMLElement
    | undefined
  if (spacer && spacer.parentNode) {
    try {
      spacer.parentNode.removeChild(spacer)
    } catch {
      /* 已被外部移除则忽略 */
    }
  }
  delete (window as unknown as Record<string, unknown>)[SPACER_STORE]

  const store = (window as unknown as Record<string, unknown>)[STORE]
  if (!Array.isArray(store)) return

  type Rec = {
    el: HTMLElement
    style: Record<string, string>
    parent: ParentNode | null
    nextSibling: Node | null
  }
  ;(store as Rec[]).forEach(({ el, style, parent, nextSibling }) => {
    const s = el.style
    // 先清掉摊平时设的 !important 声明
    ;[
      "position",
      "top",
      "left",
      "right",
      "bottom",
      "width",
      "height",
      "max-height",
      "max-width",
      "transform",
      "z-index",
      "display",
      "visibility",
      "opacity",
      "pointer-events"
    ].forEach((p) => s.removeProperty(p))
    // 再回填原 inline style（CSSStyleDeclaration 索引签名直接写）
    if (style.position) s.position = style.position
    if (style.top) s.top = style.top
    if (style.left) s.left = style.left
    if (style.right) s.right = style.right
    if (style.bottom) s.bottom = style.bottom
    if (style.width) s.width = style.width
    if (style.height) s.height = style.height
    if (style.maxHeight) s.maxHeight = style.maxHeight
    if (style.maxWidth) s.maxWidth = style.maxWidth
    if (style.transform) s.transform = style.transform
    if (style.zIndex) s.zIndex = style.zIndex
    if (style.display) s.display = style.display
    if (style.visibility) s.visibility = style.visibility
    if (style.opacity) s.opacity = style.opacity
    if (style.pointerEvents) s.pointerEvents = style.pointerEvents

    // 如果摊平时把节点移到了 body 末尾，按记录放回原父节点；
    // 注意只有当原 parent 仍在 DOM 里、且当前 parent != 原 parent 时才搬动，
    // 避免父级已被销毁时反复抛错。
    try {
      const parentEl = parent as Node | null
      if (parentEl && parentEl !== el.parentNode) {
        const isParentConnected =
          parentEl === document ||
          (parentEl as Node).isConnected !== false
        if (isParentConnected) {
          if (nextSibling && (nextSibling as Node).parentNode === parentEl) {
            parentEl.insertBefore(el, nextSibling as Node)
          } else {
            parentEl.appendChild(el)
          }
        }
      }
    } catch {
      /* 还原 DOM 位置失败仅会留下视觉位置错位（截图已结束），忽略 */
    }

    const ds = el.dataset as Record<string, string | undefined>
    delete ds[MARK]
  })
  delete (window as unknown as Record<string, unknown>)[STORE]
}

/**
 * 冻结被摊平的弹窗节点，防止页面 JS 在截图过程中把弹窗收回。
 *
 * 现实场景：很多 SPA 用 mouseleave / blur / scroll 等事件回调把弹窗
 * display:none 或直接 removeChild。摊平时设的 !important inline style
 * 会被 JS 用 `el.style.display = 'none'` 直接覆盖（同优先级 inline 后写覆盖前写），
 * 必须借助 MutationObserver 同步回滚。
 *
 * 守护策略：
 *  - attributes（style/class/hidden）变更 → 重新写入摊平时的 !important 声明
 *  - 节点被从父节点 removeChild → 立刻按记录的 parent / nextSibling 还原回去
 *
 * 同时给 documentElement 安装 capture-phase 事件吞噬：mouseover/mouseout/
 * mouseenter/mouseleave/focusin/focusout/blur 在截图期间一律 stopImmediatePropagation，
 * 阻断"鼠标移开 → 收菜单"链路；scroll 事件不动（截图本身要滚动）。
 *
 * 全部状态挂在 window 上，由 unfreezeFlattenedModals 统一卸载。
 */
export function freezeFlattenedModals(): number {
  const STORE = "__myScreenshotFlattenedList"
  const FREEZE_STORE = "__myScreenshotFreezeState"

  const store = (window as unknown as Record<string, unknown>)[STORE]
  if (!Array.isArray(store) || store.length === 0) return 0

  type Rec = {
    el: HTMLElement
    style: Record<string, string>
    parent: ParentNode | null
    nextSibling: Node | null
  }
  const list = store as Rec[]
  // 用 Set 加速查表：MutationObserver 在长截图过程中可能回调几万次
  const elSet = new Set<HTMLElement>(list.map((r) => r.el))
  const recByEl = new Map<HTMLElement, Rec>(list.map((r) => [r.el, r]))

  // 用一组 !important 声明把元素状态再次写死。
  // restoreFlattenedModals 时会清掉这些声明并按 list[i].style 回填原值。
  const overrides: Array<[string, string]> = [
    ["position", "absolute"],
    ["display", "block"],
    ["visibility", "visible"],
    ["opacity", "1"],
    ["pointer-events", "none"],
    ["z-index", "2147483647"]
  ]

  const enforce = (el: HTMLElement) => {
    overrides.forEach(([k, v]) => el.style.setProperty(k, v, "important"))
  }

  // 1) MutationObserver：守护 attributes + 父节点 childList
  // 监听 documentElement 的子树（包括弹窗本身和它的兄弟，便于覆盖 removeChild 场景）
  const observer = new MutationObserver((records) => {
    for (const rec of records) {
      if (rec.type === "attributes") {
        const target = rec.target as HTMLElement
        if (elSet.has(target)) {
          enforce(target)
        }
      } else if (rec.type === "childList") {
        // 检查每个被摊平元素是否还在 DOM 里；若不在则按记录回补
        rec.removedNodes.forEach((removed) => {
          const r = recByEl.get(removed as HTMLElement)
          if (!r || !r.parent) return
          if (r.el.isConnected) return
          try {
            // 优先按原 nextSibling 位置 insertBefore；nextSibling 已不在则 append
            if (r.nextSibling && r.nextSibling.parentNode === r.parent) {
              r.parent.insertBefore(r.el, r.nextSibling)
            } else {
              r.parent.appendChild(r.el)
            }
            enforce(r.el)
          } catch {
            // parent 也已脱离 DOM 等极端情况，放弃回补
          }
        })
      }
    }
  })

  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["style", "class", "hidden"]
  })

  // 2) 事件吞噬：拦截可能触发"收菜单"的鼠标 / 焦点事件
  const swallowedEvents = [
    "mouseover",
    "mouseout",
    "mouseenter",
    "mouseleave",
    "mousemove",
    "pointerover",
    "pointerout",
    "pointerenter",
    "pointerleave",
    "pointermove",
    "focusin",
    "focusout",
    "blur",
    "focus"
  ]
  const swallow = (e: Event) => {
    e.stopImmediatePropagation()
  }
  swallowedEvents.forEach((name) => {
    // capture 阶段、最先执行；不调 preventDefault，避免影响默认行为
    document.addEventListener(name, swallow, true)
    window.addEventListener(name, swallow, true)
  })

  ;(window as unknown as Record<string, unknown>)[FREEZE_STORE] = {
    observer,
    swallowedEvents,
    swallow
  }
  return list.length
}

/** 与 freezeFlattenedModals 配对：断开 observer + 卸载事件监听。 */
export function unfreezeFlattenedModals(): void {
  const FREEZE_STORE = "__myScreenshotFreezeState"
  const state = (window as unknown as Record<string, unknown>)[FREEZE_STORE] as
    | {
        observer: MutationObserver
        swallowedEvents: string[]
        swallow: (e: Event) => void
      }
    | undefined
  if (!state) return
  try {
    state.observer.disconnect()
  } catch {
    // 忽略
  }
  state.swallowedEvents.forEach((name) => {
    try {
      document.removeEventListener(name, state.swallow, true)
    } catch {
      // 忽略
    }
    try {
      window.removeEventListener(name, state.swallow, true)
    } catch {
      // 忽略
    }
  })
  delete (window as unknown as Record<string, unknown>)[FREEZE_STORE]
}
