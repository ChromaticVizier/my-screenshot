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

import type {
  FullPageRuleSet,
  SiteScrollRegionRule
} from "~src/shared/settings"

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
export function preparePage(
  rules?: FullPageRuleSet,
  siteScrollRegion?: SiteScrollRegionRule | null,
  options?: { preferWindowScroll?: boolean }
): PageMetrics & {
  snapshot: PreparePageSnapshot
} {
  const SCROLLER_ATTR = "data-my-screenshot-scroller"
  const html = document.documentElement
  const body = document.body

  // 清掉上一轮可能残留的标记
  document
    .querySelectorAll(`[${SCROLLER_ATTR}="1"]`)
    .forEach((el) => el.removeAttribute(SCROLLER_ATTR))

  // 注入全局「冻结样式」：截图全程关闭平滑滚动与所有过渡/动画。
  // 参考 awesome-screenshot 逆向（docs/screenshot-flow-reference.md #4 #5）：
  //   - scroll-behavior:auto → scrollTo / scrollTop 立即生效，不产生滚动动画帧；
  //   - transition/animation:none → position 切换、懒加载图标、骨架屏等不会被截到
  //     运动中间态（对方"待优化点 #2"里 SVG 图标 0×0 的根因）。
  // 由 restorePage 按 id 移除。新旧两套模式都走 preparePage，因此统一受益。
  const FREEZE_STYLE_ID = "__my_screenshot_freeze_style__"
  if (!document.getElementById(FREEZE_STYLE_ID)) {
    const freeze = document.createElement("style")
    freeze.id = FREEZE_STYLE_ID
    freeze.textContent =
      "html{scroll-behavior:auto !important;}" +
      "*,*::before,*::after{" +
      "transition:none !important;" +
      "animation:none !important;" +
      "scroll-behavior:auto !important;" +
      "}"
    ;(document.head || document.documentElement).appendChild(freeze)
  }

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
  // 用户手动选择的站点规则最高优先级；若 selector 失效，再走自动评分。
  let scrollerEl: HTMLElement | null = null
  if (siteScrollRegion?.selector) {
    try {
      const el = document.querySelector<HTMLElement>(siteScrollRegion.selector)
      if (el) {
        const cs = getComputedStyle(el)
        const oy = cs.overflowY
        const rect = el.getBoundingClientRect()
        // overflow:hidden/clip 的元素也能被 JS（scrollTop）滚动（网易系 div.g-body 即此类），
        // 只要 scrollHeight 溢出即视为有效滚动容器；仅 visible 永不裁剪、不可滚。
        const scrollable =
          oy !== "visible" &&
          el.scrollHeight > el.clientHeight + 4 &&
          rect.width > 0 &&
          rect.height > 0 &&
          cs.display !== "none" &&
          cs.visibility !== "hidden"
        if (scrollable) {
          scrollerEl = el
          scrollerEl.setAttribute(SCROLLER_ATTR, "1")
        }
      }
    } catch {
      // selector 失效则继续走自动检测
    }
  }

  // 不再只限「接近全屏」：三栏应用/知识库/IM 页面经常只有中间栏是主体可滚区。
  // 评分同时考虑：可滚动距离、视口面积、文本量、语义类名、居中程度。
  //
  // preferWindowScroll（逆向还原模式）：闭源插件实测 scroll target 几乎全是 window，
  // 仅当 window 完全不可滚（如网易邮箱 html/body 都 overflow:hidden）才用内部容器。
  // 慕课等 body.overflow=hidden|auto 的页面其实是 window 可滚的，自动评分却会把某个
  // 内部 div 误判成主滚动容器 → scrollToY 设错对象 → 只出首帧、后续空白。
  // 因此该模式下：window 可滚就直接用 window，跳过内部容器评分。
  if (
    !scrollerEl &&
    options?.preferWindowScroll &&
    windowScrollable
  ) {
    // 标记不命中任何内部 scroller，走 window 滚动路径
  } else if (!scrollerEl) {
    const vw = html.clientWidth || window.innerWidth
    const vh = html.clientHeight || window.innerHeight
    // 滚动容器评分阈值/权重：原为用户可调设置，引入 MoE 路由后固化为常量
    // （"该不该用内部容器"已由 fullPageRouter 在截图前判别，无需再暴露调参）。
    const minRatio = 1.05
    const minOverflowPx = 80
    const areaWeight = 0.35
    const textWeight = 0.3
    const semanticWeight = 0.35
    let semanticRe: RegExp | null = null
    try {
      semanticRe = new RegExp(
        "(^|[-_\\s])(main|content|body|center|middle|scroll|scroller|container|workspace|chat|conversation|message|article|detail|panel|pane)([-_\\s]|$)",
        "i"
      )
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
      // body/html 的滚动由 window.scrollTo 驱动，el.scrollTop 在标准模式下永远返回 0，
      // 不能作为内部滚动容器（否则 scrollToY 设 body.scrollTop 无效，触发 stall 退出）。
      if (el === body || el === html) return
      let cs: CSSStyleDeclaration
      try {
        cs = getComputedStyle(el)
      } catch {
        return
      }
      const oy = cs.overflowY
      // 同 picker：overflow:hidden/clip 也可 JS 滚动，仅排除 visible
      if (oy === "visible") return
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
    const winner = bestEl as HTMLElement | null
    if (winner) {
      // window 可覆盖全页时，内部容器还须足够宽（≥ 视口宽的 30%）才能抢主滚动权。
      // 否则 Confluence 等左侧窄侧边栏因有大量文本且自身可滚，会错误地被选为主 scroller，
      // 导致截图只滚侧边栏而非右侧主内容。
      // window 不可滚时不加宽度限制（内部窄容器本就是唯一出口）。
      const winnerWidthRatio =
        winner.getBoundingClientRect().width / Math.max(1, vw)
      const wideEnough = !windowCanCover || winnerWidthRatio >= 0.3
      // window 可覆盖全页时，内部容器的 scrollHeight 必须足够大（≥ 文档高度 40%），
      // 防止轮播卡片、产品列表等局部溢出容器（scrollHeight 远小于页面总高）
      // 因大量文本/高评分被误判为主滚动容器（典型：阿里云首页产品区轮播 div）。
      // window 不可滚时不加此限制（内部容器的 scrollHeight 就是内容总高）。
      const tallEnough =
        !windowCanCover || winner.scrollHeight >= windowDocHeight * 0.4
      if (wideEnough && tallEnough && (!windowCanCover || bestScore >= 0.55)) {
        scrollerEl = winner
        scrollerEl.setAttribute(SCROLLER_ATTR, "1")
      }
    }
  }

  const scrollerRect = scrollerEl?.getBoundingClientRect()

  // 内部滚动容器模式下,从 scroller 高度里扣掉一个底部安全裕量。
  //
  // 现实问题：vue-recycle-scroller 等虚拟列表在 chrome 合成层下,
  // 内部 absolute/transform item 的渲染可能超出 scroller 自身 overflow:hidden
  // 边界(getBoundingClientRect 报告的 bottom 比真实视觉裁切线更下)。
  // 同时 SPA 里 scroller 紧邻输入框/状态栏,box-shadow 会从相邻元素向上溢出几像素。
  //
  // 在 IM/聊天类 SPA 长截图时,这两种溢出会让每帧底部出现一条白底圆角条,
  // 拼接后表现为周期性遮挡文字。
  //
  // 直接从底部裁掉一个常数像素裕量即可避免,代价是长图末尾会出现等高的小空白条
  // (远比"周期性遮挡正文"轻),且仅影响 scroller 模式,普通整页截图(window 滚动)
  // 不受影响。具体值由 rules.scrollerBottomSafetyPx 提供,设为 0 即关闭该裕量。
  // 内部滚动容器模式下底部安全裕量。原为用户可调设置 rules.scrollerBottomSafetyPx，
  // 默认 0（关闭）；MoE 路由化后移除该设置项，固化为 0，保持原默认行为。
  // 如某些虚拟列表/邻近 box-shadow 站点需要裕量，由对应专家在拼接侧用帧重叠补偿。
  const scrollerSafetyPx = 0
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
      ? Math.max(
          1,
          Math.min(scrollerRect.height, html.clientHeight - Math.max(0, scrollerRect.top)) -
            scrollerSafetyPx
        )
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
  // captureHeight 与 stepHeight (viewportHeight) 必须一致：
  //   slice 源高度 = 滚动步长，长图衔接处才不会出现白条。
  //   原本的 scrollerBottomSafetyPx 想避开底部 box-shadow，但任何 slice
  //   矮于步长都会让两帧之间漏 safety 像素 → 长图缝隙。已废弃。
  const captureHeight = scrollerRect
    ? Math.max(
        1,
        Math.min(scrollerRect.height, html.clientHeight - Math.max(0, scrollerRect.top))
      )
    : html.clientHeight

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
 * 读取主滚动容器（或 window）当前的 scrollHeight / clientHeight。
 *
 * 动态加载页面（懒加载图片、虚拟列表、IntersectionObserver 触发的 fetch）在
 * 滚动过程中 scrollHeight 持续增长，preparePage 抓到的初始 totalHeight 会偏小，
 * 导致循环过早判定"已到底"。
 *
 * 调用方在每次截完一帧后重新调用此函数，把最新 scrollHeight 喂回循环上限。
 */
export function measureScrollMetrics(): {
  scrollHeight: number
  clientHeight: number
  scrollTop: number
} {
  const SCROLLER_ATTR = "data-my-screenshot-scroller"
  const scroller = document.querySelector<HTMLElement>(
    `[${SCROLLER_ATTR}="1"]`
  )
  if (scroller) {
    return {
      scrollHeight: Math.max(scroller.scrollHeight, scroller.clientHeight),
      clientHeight: scroller.clientHeight,
      scrollTop: scroller.scrollTop
    }
  }
  const html = document.documentElement
  const body = document.body
  return {
    scrollHeight: Math.max(
      body.scrollHeight,
      html.scrollHeight,
      body.offsetHeight,
      html.offsetHeight,
      html.clientHeight
    ),
    clientHeight: html.clientHeight || window.innerHeight,
    scrollTop: window.scrollY
  }
}

/**
 * 等待动态内容加载稳定。
 *
 * 在动态渲染 / DOM 回收页面（懒加载图片、IntersectionObserver、虚拟列表）里，
 * 滚到新位置后内容不是立即出现的。固定 sleep 太短会拍到空白；太长又慢。
 *
 * 策略：
 *  1. 轮询 scrollHeight + 视口内图片完成度，连续 STABLE_CHECKS 次结果一致即算稳定
 *  2. 同时等待视口内 <img> 的 complete 标志（不阻塞，仅作为稳定判据之一）
 *  3. 超过 maxWaitMs 强制返回，避免页面无限重排时永远不结束
 *
 * 返回最终 scrollHeight，便于调用方更新循环上限。
 */
export function waitForDynamicContent(maxWaitMs: number): Promise<{
  scrollHeight: number
  stable: boolean
  iterations: number
}> {
  const SCROLLER_ATTR = "data-my-screenshot-scroller"
  const scroller = document.querySelector<HTMLElement>(
    `[${SCROLLER_ATTR}="1"]`
  )
  const POLL_INTERVAL = 80
  const STABLE_CHECKS = 3
  const start = performance.now()

  const measure = () => {
    if (scroller) {
      return Math.max(scroller.scrollHeight, scroller.clientHeight)
    }
    const html = document.documentElement
    const body = document.body
    return Math.max(
      body.scrollHeight,
      html.scrollHeight,
      body.offsetHeight,
      html.offsetHeight,
      html.clientHeight
    )
  }

  // 视口内 <img> 完成数：越多 image 还在加载，签名差异越大
  const imageSignature = () => {
    const vh = scroller ? scroller.clientHeight : window.innerHeight
    const vw = scroller ? scroller.clientWidth : window.innerWidth
    let total = 0
    let complete = 0
    document.querySelectorAll<HTMLImageElement>("img").forEach((img) => {
      const r = img.getBoundingClientRect()
      if (r.bottom < 0 || r.top > vh) return
      if (r.right < 0 || r.left > vw) return
      total++
      if (img.complete && img.naturalWidth > 0) complete++
    })
    return `${total}/${complete}`
  }

  return new Promise((resolve) => {
    let lastH = measure()
    let lastImg = imageSignature()
    let stableCount = 0
    let iters = 0

    const tick = () => {
      iters++
      const h = measure()
      const img = imageSignature()
      if (h === lastH && img === lastImg) {
        stableCount++
      } else {
        stableCount = 0
        lastH = h
        lastImg = img
      }
      if (stableCount >= STABLE_CHECKS) {
        resolve({ scrollHeight: h, stable: true, iterations: iters })
        return
      }
      if (performance.now() - start >= maxWaitMs) {
        resolve({ scrollHeight: h, stable: false, iterations: iters })
        return
      }
      setTimeout(tick, POLL_INTERVAL)
    }
    setTimeout(tick, POLL_INTERVAL)
  })
}

/**
 * 戳醒只监听 wheel/scroll 事件的懒加载逻辑。
 * 直接修改 scrollTop 不会冒泡 wheel 事件；某些 infinite-scroll 站监听 wheel
 * 触发下一页加载。stall 时调用此函数派发一组事件试图唤醒它们。
 */
export function kickScrollListeners(stepHeight: number): void {
  const SCROLLER_ATTR = "data-my-screenshot-scroller"
  const scroller = document.querySelector<HTMLElement>(
    `[${SCROLLER_ATTR}="1"]`
  )
  const target: EventTarget = scroller ?? window
  try {
    target.dispatchEvent(new Event("scroll", { bubbles: true }))
  } catch {
    /* 忽略 */
  }
  try {
    const wheel = new WheelEvent("wheel", {
      deltaY: Math.max(100, stepHeight),
      bubbles: true,
      cancelable: true
    })
    target.dispatchEvent(wheel)
  } catch {
    /* 忽略 */
  }
  // 强制一次 layout，让 IntersectionObserver 重新评估
  void document.documentElement.offsetHeight
}

/**
 * 滚动到指定 Y 位置（同步：滚动后立即返回当前实际 scrollY）。
 * 若 preparePage 检测到主滚动容器在某个内部元素上，则用 element.scrollTop 直接赋值
 * （而非 scrollTo），避免 CSS `scroll-behavior: smooth` 触发动画导致
 * scrollToY 立即返回的 scrollTop 远小于目标 → 长截图前两帧错位。
 * window 模式同理，先临时关闭 html/body 上的 scroll-behavior，赋值完恢复。
 *
 * 同时临时禁用 scroll-snap-type：很多 SPA 容器有 `scroll-snap-type: y mandatory`
 * 会把 scrollTop=600 吸附到 0/800 这类离散点，造成长图中间真实空洞。
 */
export function scrollToY(y: number): number {
  const SCROLLER_ATTR = "data-my-screenshot-scroller"
  const scroller = document.querySelector<HTMLElement>(
    `[${SCROLLER_ATTR}="1"]`
  )
  if (scroller) {
    const prevBehavior = scroller.style.scrollBehavior
    const prevSnap = scroller.style.scrollSnapType
    scroller.style.scrollBehavior = "auto"
    scroller.style.scrollSnapType = "none"
    scroller.scrollTop = y
    const got = scroller.scrollTop
    scroller.style.scrollBehavior = prevBehavior
    scroller.style.scrollSnapType = prevSnap
    return got
  }
  const html = document.documentElement
  const body = document.body
  const prevHtmlBehavior = html.style.scrollBehavior
  const prevBodyBehavior = body.style.scrollBehavior
  const prevHtmlSnap = html.style.scrollSnapType
  const prevBodySnap = body.style.scrollSnapType
  html.style.scrollBehavior = "auto"
  body.style.scrollBehavior = "auto"
  html.style.scrollSnapType = "none"
  body.style.scrollSnapType = "none"
  window.scrollTo(0, y)
  const got = window.scrollY
  html.style.scrollBehavior = prevHtmlBehavior
  body.style.scrollBehavior = prevBodyBehavior
  html.style.scrollSnapType = prevHtmlSnap
  body.style.scrollSnapType = prevBodySnap
  return got
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
export function hideFixedElements(
  rules: FullPageRuleSet,
  aggressiveChrome = false
): number {
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

  // scroller 的祖先链（含弹窗容器）也无条件豁免。
  // isContentLikeFixed 是启发式检测，面积/高度不足时会误判弹窗为「普通 fixed 元素」
  // 而将其 display:none——用户已显式选定弹窗内的滚动区，必须保留整条祖先链。
  const SCROLLER_ATTR_KEEP = "data-my-screenshot-scroller"
  const scrollerElForKeep = document.querySelector<HTMLElement>(
    `[${SCROLLER_ATTR_KEEP}="1"]`
  )
  if (scrollerElForKeep) {
    let cur: HTMLElement | null = scrollerElForKeep.parentElement
    while (cur && cur !== document.documentElement) {
      keepSet.add(cur)
      cur = cur.parentElement
    }
  }

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

  const list: { el: HTMLElement; originalDisplay: string; rect?: DOMRect }[] =
    []
  const hide = (el: HTMLElement) => {
    if (keepSet.has(el)) return
    const ds = el.dataset as Record<string, string | undefined>
    if (MARK in ds) return
    // 隐藏前记录矩形：供 measureTopHeaderBottom 判定「顶部锚定头部」下沿，
    // 长截图首帧只保留头部，其下整屏交给干净帧覆盖，避免底栏/伪 sticky 遮挡。
    let rect: DOMRect | undefined
    try {
      rect = el.getBoundingClientRect()
    } catch {
      rect = undefined
    }
    ;(el.dataset as Record<string, string>)[MARK] = "1"
    list.push({ el, originalDisplay: el.style.display, rect })
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
  const html = document.documentElement
  const vw = html.clientWidth || window.innerWidth
  const vh = html.clientHeight || window.innerHeight
  const docHeight = Math.max(
    document.body.scrollHeight,
    html.scrollHeight,
    vh
  )
  const viewportSizedRatio = 0.5
  const contentRatio = 0.45

  // 大块 fixed 容器豁免：真正的 SPA 主壳 scrollHeight 接近文档总高（subtreeRatio ≥ contentRatio），
  // 弹窗覆盖层 scrollHeight ≈ 视口高（subtreeRatio 很低），不再用 textLen 判断以防误豁免。
  const isContentLikeFixed = (el: HTMLElement): boolean => {
    // 含主滚动容器后代 → 无条件豁免，必须放在所有面积/高度检查之前。
    // 用户已选中该容器内的滚动区；若先做面积过滤，小弹窗（areaRatio < 0.5）会被
    // 早返回拦截，导致弹窗被 display:none 后整个对话框从截图中消失。
    if (el.querySelector(`[data-my-screenshot-scroller="1"]`)) return true
    // 激进 chrome 模式（spa-like 专家）：不再豁免「全高窄侧栏 / 内容型大块」，
    // 顶栏 + 侧边栏一律隐藏（只在首帧出现）。window 可滚页面正文非 fixed/sticky，
    // 不会被本函数命中，故此处一律返回 false 是安全的。
    if (aggressiveChrome) return false
    const rect = el.getBoundingClientRect()
    const areaRatio = (rect.width * rect.height) / Math.max(1, vw * vh)
    const heightRatio = rect.height / Math.max(1, vh)
    const widthRatio = rect.width / Math.max(1, vw)
    // 不够大 → 直接隐藏（小浮窗/角落按钮/横向通知条等）
    if (areaRatio < viewportSizedRatio && heightRatio < 0.9) return false
    // 全高窄栏（侧边栏）：贯穿视口全高、宽度 < 30% → 结构性导航，无论页面高度如何均保留
    if (heightRatio >= 0.9 && widthRatio < 0.3) return true
    // scrollHeight 接近文档总高 → 真正的 SPA 主壳（body overflow:hidden 时文档高 ≈ 视口，
    // 主壳 scrollHeight 是其内部滚动高度，通常远大于视口）。
    const subtreeRatio = el.scrollHeight / Math.max(1, docHeight)
    if (subtreeRatio >= contentRatio) return true
    return false
  }

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
      // 大块内容容器豁免
      if (isContentLikeFixed(el)) return
      hide(el)
    }
  })

  // 挂到 window 上方便 restoreFixedElements 取回；类型用 unknown 兼容
  ;(window as unknown as Record<string, unknown>)[STORE] = list
  return list.length
}

/**
 * scroller 在子 frame 时主 frame 的清场逻辑（更激进的 hideFixedElementsExcludeFrame）。
 *
 * 背景：用户在子 iframe 里 picker 选了 scroller。主 frame 自身可能不滚动
 *  （body 100vh），它上面的顶栏 / 侧栏 / 面包屑等元素 computed position 是
 *  static/relative，并非 fixed/sticky——hideFixedElements 抓不到，每帧截图里
 *  这些元素都贴在原位重复出现。
 *
 * 思路：从 documentElement 出发，定位承载目标 frame 的 iframe，把"通往该
 * iframe 的祖先链"作为唯一可见路径；祖先链每一层上**不在链上的兄弟节点全部
 * display:none**。这样主 frame 上只剩下"装着目标 iframe 的管道"。
 *
 * 复用 hideFixedElements 的 STORE / MARK，restoreFixedElements 一并恢复。
 */
export function hideOutsideFrameChain(keepFrameUrl: string): number {
  const MARK = "__myScreenshotHidden"
  const STORE = "__myScreenshotHiddenList"

  const matches = (a: string, b: string): boolean => {
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

  // 递归同源文档树定位目标 iframe
  const findIframe = (doc: Document): HTMLIFrameElement | null => {
    let iframes: HTMLIFrameElement[]
    try {
      iframes = Array.from(doc.querySelectorAll<HTMLIFrameElement>("iframe"))
    } catch {
      return null
    }
    for (const f of iframes) {
      const candidates: string[] = []
      let nestedDoc: Document | null = null
      try {
        nestedDoc = f.contentDocument
      } catch {
        nestedDoc = null
      }
      if (nestedDoc?.location?.href) candidates.push(nestedDoc.location.href)
      if (f.src) candidates.push(f.src)
      if (candidates.some((u) => matches(u, keepFrameUrl))) return f
      if (nestedDoc) {
        const nested = findIframe(nestedDoc)
        if (nested) return f
      }
    }
    return null
  }

  let targetIframe: HTMLIFrameElement | null = null
  try {
    targetIframe = findIframe(document)
  } catch {
    return 0
  }
  if (!targetIframe) return 0

  // 收集祖先链
  const chain = new Set<HTMLElement>()
  let cur: HTMLElement | null = targetIframe
  while (cur && cur !== document.documentElement) {
    chain.add(cur)
    cur = cur.parentElement
  }

  // 沿用 hideFixedElements 的 STORE
  const existing = (window as unknown as Record<string, unknown>)[STORE]
  const list: { el: HTMLElement; originalDisplay: string }[] = Array.isArray(
    existing
  )
    ? (existing as { el: HTMLElement; originalDisplay: string }[])
    : []
  const hide = (el: HTMLElement) => {
    const ds = el.dataset as Record<string, string | undefined>
    if (MARK in ds) return
    ;(el.dataset as Record<string, string>)[MARK] = "1"
    list.push({ el, originalDisplay: el.style.display })
    el.style.display = "none"
  }

  // 从根开始：祖先链上每个节点，把它的"非链上兄弟"全部 hide
  // 注意：document.documentElement 是顶层，不能 hide 它本身；从它的子节点开始处理。
  let cursor: HTMLElement | null = document.documentElement
  while (cursor) {
    const children = Array.from(cursor.children) as HTMLElement[]
    let nextOnChain: HTMLElement | null = null
    for (const child of children) {
      if (chain.has(child)) {
        nextOnChain = child
      } else {
        // body 之外的特殊节点（如 head / script）不处理；它们 display:none
        // 浏览器会忽略，但避免破坏页面 head。head/script/style 跳过即可。
        if (
          child.tagName === "HEAD" ||
          child.tagName === "SCRIPT" ||
          child.tagName === "STYLE" ||
          child.tagName === "META" ||
          child.tagName === "LINK" ||
          child.tagName === "TITLE"
        ) {
          continue
        }
        hide(child)
      }
    }
    cursor = nextOnChain
  }

  ;(window as unknown as Record<string, unknown>)[STORE] = list
  return list.length
}


/**
 * 隐藏主 frame 上的 fixed/sticky 元素（含跨域 iframe 父级页面的顶栏 / 侧栏）。
 *
 * 调用时机：scroller 在子 iframe 内时——主 frame 上的 fixed 顶栏不会被
 * scroller frame 内的 hideFixedElements 扫到，每帧都会重复出现。
 * 解决方案：在主 frame 单独跑一份隐藏逻辑，但要保留承载 scroller 的 iframe 链。
 *
 * 输入 keepFrameUrl: scroller 所在 frame 的 location.href，递归 same-origin
 * 文档树定位 iframe 元素，把它和它的祖先链全部加入 keepSet 不隐藏，
 * 保证 iframe 容器不被一起 display:none。
 *
 * 复用 hideFixedElements 的 STORE / MARK，restoreFixedElements 一并恢复。
 */
export function hideFixedElementsExcludeFrame(
  rules: FullPageRuleSet,
  keepFrameUrl: string
): number {
  if (!rules || rules.enabled === false) return 0

  const MARK = "__myScreenshotHidden"
  const STORE = "__myScreenshotHiddenList"

  // 找到承载目标 frame 的 iframe 元素 + 收集祖先链作为 keepSet
  const keepSet = new Set<HTMLElement>()
  const matches = (a: string, b: string): boolean => {
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
  const visitForIframe = (doc: Document): HTMLIFrameElement | null => {
    let iframes: HTMLIFrameElement[]
    try {
      iframes = Array.from(doc.querySelectorAll<HTMLIFrameElement>("iframe"))
    } catch {
      return null
    }
    for (const f of iframes) {
      const candidates: string[] = []
      let nestedDoc: Document | null = null
      try {
        nestedDoc = f.contentDocument
      } catch {
        nestedDoc = null
      }
      if (nestedDoc?.location?.href) candidates.push(nestedDoc.location.href)
      if (f.src) candidates.push(f.src)
      if (candidates.some((u) => matches(u, keepFrameUrl))) return f
      if (nestedDoc) {
        const nested = visitForIframe(nestedDoc)
        if (nested) return f // 把外层 iframe 加 keepSet 即可
      }
    }
    return null
  }
  try {
    const targetIframe = visitForIframe(document)
    if (targetIframe) {
      let cur: HTMLElement | null = targetIframe
      while (cur && cur !== document.documentElement) {
        keepSet.add(cur)
        cur = cur.parentElement
      }
    }
  } catch {
    /* 跨域兜底，没找到也没事，下面 isContentLikeFixed 还有面积豁免 */
  }

  // 再叠加用户 customKeepSelectors
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
      /* 忽略 */
    }
  })

  // 沿用 hideFixedElements 的 STORE，方便统一 restore
  const existing = (window as unknown as Record<string, unknown>)[STORE]
  const list: { el: HTMLElement; originalDisplay: string }[] = Array.isArray(
    existing
  )
    ? (existing as { el: HTMLElement; originalDisplay: string }[])
    : []
  const hide = (el: HTMLElement) => {
    if (keepSet.has(el)) return
    const ds = el.dataset as Record<string, string | undefined>
    if (MARK in ds) return
    ;(el.dataset as Record<string, string>)[MARK] = "1"
    list.push({ el, originalDisplay: el.style.display })
    el.style.display = "none"
  }

  const html = document.documentElement
  const vw = html.clientWidth || window.innerWidth
  const vh = html.clientHeight || window.innerHeight
  const docHeight = Math.max(
    document.body.scrollHeight,
    html.scrollHeight,
    vh
  )
  const viewportSizedRatio = 0.5
  const contentRatio = 0.45
  const isContentLikeFixed = (el: HTMLElement): boolean => {
    const rect = el.getBoundingClientRect()
    const areaRatio = (rect.width * rect.height) / Math.max(1, vw * vh)
    const heightRatio = rect.height / Math.max(1, vh)
    const widthRatio = rect.width / Math.max(1, vw)
    if (areaRatio < viewportSizedRatio && heightRatio < 0.9) return false
    if (heightRatio >= 0.9 && widthRatio < 0.3) return true
    const subtreeRatio = el.scrollHeight / Math.max(1, docHeight)
    if (subtreeRatio >= contentRatio) return true
    return false
  }

  // 用户 customHideSelectors 在主 frame 也走一次
  ;(rules.customHideSelectors || []).forEach((sel) => {
    if (!sel) return
    try {
      document.querySelectorAll<HTMLElement>(sel).forEach(hide)
    } catch {
      /* 忽略 */
    }
  })

  const visit = (root: ParentNode) => {
    root.querySelectorAll<HTMLElement>("*").forEach((el) => {
      let cs: CSSStyleDeclaration
      try {
        cs = getComputedStyle(el)
      } catch {
        return
      }
      if (cs.position === "fixed" || cs.position === "sticky") {
        if (isContentLikeFixed(el)) return
        hide(el)
      }
      if (el.shadowRoot) visit(el.shadowRoot)
    })
  }
  visit(document.documentElement)

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
export function rehideFixedElements(
  rules: FullPageRuleSet,
  aggressiveChrome = false
): number {
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

  // scroller 祖先链豁免（同 hideFixedElements）
  {
    const scrollerElRehide = document.querySelector<HTMLElement>(
      `[data-my-screenshot-scroller="1"]`
    )
    if (scrollerElRehide) {
      let cur: HTMLElement | null = scrollerElRehide.parentElement
      while (cur && cur !== document.documentElement) {
        keepSet.add(cur)
        cur = cur.parentElement
      }
    }
  }

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
  const html = document.documentElement
  const vw = html.clientWidth || window.innerWidth
  const vh = html.clientHeight || window.innerHeight
  const docHeight = Math.max(
    document.body.scrollHeight,
    html.scrollHeight,
    vh
  )
  const viewportSizedRatio = 0.5
  const contentRatio = 0.45
  const isContentLikeFixed = (el: HTMLElement): boolean => {
    if (el.querySelector(`[data-my-screenshot-scroller="1"]`)) return true
    // 激进 chrome 模式（spa-like 专家）：顶栏 + 侧边栏一律隐藏，不豁免
    if (aggressiveChrome) return false
    const rect = el.getBoundingClientRect()
    const areaRatio = (rect.width * rect.height) / Math.max(1, vw * vh)
    const heightRatio = rect.height / Math.max(1, vh)
    const widthRatio = rect.width / Math.max(1, vw)
    if (areaRatio < viewportSizedRatio && heightRatio < 0.9) return false
    if (heightRatio >= 0.9 && widthRatio < 0.3) return true
    const subtreeRatio = el.scrollHeight / Math.max(1, docHeight)
    if (subtreeRatio >= contentRatio) return true
    return false
  }

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
        if (isContentLikeFixed(el)) return
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

  // scroller 祖先链豁免（同 hideFixedElements）
  {
    const scrollerElDetect = document.querySelector<HTMLElement>(
      `[data-my-screenshot-scroller="1"]`
    )
    if (scrollerElDetect) {
      let cur: HTMLElement | null = scrollerElDetect.parentElement
      while (cur && cur !== document.documentElement) {
        keepSet.add(cur)
        cur = cur.parentElement
      }
    }
  }

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

    // fixed/sticky 祖先容器内的元素不应视为「伪 sticky」：
    // 它们跟随视口是因为祖先是 fixed，而非自身有伪 sticky 行为。
    // 典型场景：全屏购买弹窗（position:fixed 的 .wrap）内的所有子元素都会被
    // 探测到"跟随视口"，但它们只是普通的相对定位子元素，不应被 display:none。
    let hasFixedAncestor = false
    {
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
          hasFixedAncestor = true
          break
        }
        cur = cur.parentElement
      }
    }
    if (hasFixedAncestor) return

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
    ? (store as {
        el: HTMLElement
        originalDisplay: string
        rect?: DOMRect
      }[])
    : []
  toHide.forEach((el) => {
    const ds = el.dataset as Record<string, string | undefined>
    if (MARK in ds) return
    let rect: DOMRect | undefined
    try {
      rect = el.getBoundingClientRect()
    } catch {
      rect = undefined
    }
    ;(el.dataset as Record<string, string>)[MARK] = "1"
    list.push({ el, originalDisplay: el.style.display, rect })
    el.style.display = "none"
  })
  ;(window as unknown as Record<string, unknown>)[STORE] = list

  return toHide.length
}

/**
 * 逐帧隐藏「会跟随视口的 chrome」（顶栏 / 频道导航 / 侧栏 / 底栏等），每帧调用。
 *
 * 解决两类既往漏网：
 *  1) 常态 display:none、滚动时才由 JS 临时 display:block 的固定头部（如今日头条的
 *     .fix-header）。它 computed position 始终是 fixed，但：
 *       - 扫描可见元素会漏（探测时它是 none）；
 *       - 内联 display:none 会被站点 JS 重新设回 block 覆盖。
 *     对策：连 display:none 的 fixed/sticky 也一并标记；用「属性 + 全局 !important
 *     样式表」锁定隐藏——`[attr]{display:none!important}` 胜过站点的内联 display:block。
 *  2) 滚过阈值后才由 JS（transform）变吸顶、computed 非 fixed 的伪 sticky：用循环
 *     每帧之间的真实滚动位移做参照，比较元素「文档绝对位置」是否随 scrollTop 同步
 *     漂移（跟随视口）来判定。
 *
 * 标记的元素记于 window[ATTR_STORE]，由 restorePage 统一移除属性 + 删样式表 + 清状态。
 */
export function hideFrameChrome(
  rules: FullPageRuleSet,
  keepSpace = false
): number {
  if (!rules || rules.enabled === false) return 0

  const ATTR = "data-my-ss-frame-hide"
  const STYLE_ID = "__my_ss_frame_hide_style"
  const ATTR_STORE = "__myScreenshotFrameHideList"
  const STATE = "__myScreenshotFollowState"
  const SCROLLER_ATTR = "data-my-screenshot-scroller"
  const FOLLOW_RATIO = 0.7
  const MIN_DELTA = 24
  const LARGE_AREA_RATIO = 0.85
  const LARGE_SUBTREE_RATIO = 0.9

  const html = document.documentElement
  const scroller = document.querySelector<HTMLElement>(
    `[${SCROLLER_ATTR}="1"]`
  )
  const scrollTop = scroller ? scroller.scrollTop : window.scrollY
  const scrollLeft = scroller ? scroller.scrollLeft : window.scrollX
  const vw = scroller ? scroller.clientWidth : html.clientWidth
  const vh = scroller ? scroller.clientHeight : html.clientHeight
  const docHeight = scroller
    ? Math.max(scroller.scrollHeight, scroller.clientHeight)
    : Math.max(document.body.scrollHeight, html.scrollHeight, vh)

  // 全局 !important 隐藏样式表（只注入一次）：胜过站点 JS 设回的内联 display。
  //  - 属性值 "1"：display:none（彻底移除，会回流——scroller / iframe 模式用）；
  //  - 属性值 "2"：仅 visibility:hidden（**保留布局占位、不回流**——类 SPA 副栏用，
  //    避免主滚动区因副栏脱流而被撑宽）。
  if (!document.getElementById(STYLE_ID)) {
    const st = document.createElement("style")
    st.id = STYLE_ID
    st.textContent =
      `[${ATTR}="1"]{display:none!important;visibility:hidden!important}` +
      `[${ATTR}="2"]{visibility:hidden!important}`
    ;(document.head || html).appendChild(st)
  }

  // 豁免名单：customKeepSelectors（含祖先链）+ 主滚动容器祖先链
  const keepSet = new Set<HTMLElement>()
  ;(rules.customKeepSelectors || []).forEach((sel) => {
    if (!sel) return
    try {
      document.querySelectorAll<HTMLElement>(sel).forEach((el) => {
        let cur: HTMLElement | null = el
        while (cur && cur !== html) {
          keepSet.add(cur)
          cur = cur.parentElement
        }
      })
    } catch {
      /* 忽略非法选择器 */
    }
  })
  if (scroller) {
    let cur: HTMLElement | null = scroller.parentElement
    while (cur && cur !== html) {
      keepSet.add(cur)
      cur = cur.parentElement
    }
  }

  // 内容容器 / 主滚动容器豁免（不该被当 chrome 隐藏）。
  // 注意：这里**不**豁免「全高窄栏」——对逐帧 chrome 隐藏而言，吸顶 / 固定的左右
  // 副栏（如微博三栏布局的左导航 / 右热搜）正是要在首帧后隐藏的目标；它们只在
  // 第一帧（整窗保留）出现。仅豁免「真正承载主体内容的大块」（subtreeRatio 高）
  // 与主滚动容器链。
  const isContentLike = (el: HTMLElement, rect: DOMRect): boolean => {
    if (el.querySelector(`[${SCROLLER_ATTR}="1"]`)) return true
    const areaRatio = (rect.width * rect.height) / Math.max(1, vw * vh)
    const heightRatio = rect.height / Math.max(1, vh)
    if (areaRatio < 0.5 && heightRatio < 0.9) return false
    const subtreeRatio = el.scrollHeight / Math.max(1, docHeight)
    if (subtreeRatio >= 0.6) return true
    return false
  }

  const w = window as unknown as Record<string, unknown>
  let state = w[STATE] as
    | Map<HTMLElement, { t: number; l: number; s: number; sl: number }>
    | undefined
  if (!(state instanceof Map)) {
    state = new Map()
    w[STATE] = state
  }
  const storeRaw = w[ATTR_STORE]
  const store = Array.isArray(storeRaw) ? (storeRaw as HTMLElement[]) : []

  const tag = (el: HTMLElement) => {
    el.setAttribute(ATTR, keepSpace ? "2" : "1")
    store.push(el)
  }

  let count = 0
  const all: HTMLElement[] = []
  const visit = (node: ParentNode) => {
    node.querySelectorAll<HTMLElement>("*").forEach((el) => {
      all.push(el)
      if (el.shadowRoot) visit(el.shadowRoot)
    })
  }
  visit(html)

  for (const el of all) {
    if (el.getAttribute(ATTR)) continue
    if (el.getAttribute(SCROLLER_ATTR) === "1") continue
    if (keepSet.has(el)) continue

    let cs: CSSStyleDeclaration
    try {
      cs = getComputedStyle(el)
    } catch {
      continue
    }
    const pos = cs.position

    // 分支 A：computed fixed/sticky —— 即使当前 display:none 也标记（如 .fix-header
    // 常态隐藏、滚动时才 display:block）。标记后样式表 !important 持续压制。
    if (pos === "fixed" || pos === "sticky") {
      let rect: DOMRect
      try {
        rect = el.getBoundingClientRect()
      } catch {
        rect = { width: 0, height: 0 } as DOMRect
      }
      if (isContentLike(el, rect)) continue
      tag(el)
      count++
      continue
    }

    // 分支 B：computed 非 fixed/sticky 的伪 sticky（JS transform 跟随）。
    // 只看当前可见、贴顶/贴底带内的元素，用跨帧位移参照判定是否跟随视口。
    if (cs.visibility === "hidden" || cs.display === "none") continue
    let rect: DOMRect
    try {
      rect = el.getBoundingClientRect()
    } catch {
      continue
    }
    if (rect.width < 1 || rect.height < 1) continue
    if (rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw) {
      continue
    }
    const inTopBand = rect.top <= vh * 0.3
    const inBottomBand = rect.bottom >= vh * 0.7
    if (!inTopBand && !inBottomBand) continue
    const heightRatio = vh > 0 ? rect.height / vh : 0
    const subtreeRatio = docHeight > 0 ? el.scrollHeight / docHeight : 0
    if (heightRatio >= LARGE_AREA_RATIO) continue
    if (subtreeRatio >= LARGE_SUBTREE_RATIO) continue
    // fixed/sticky 祖先内的子元素跟随是因为祖先，不单独处理
    let hasFixedAncestor = false
    {
      let cur: HTMLElement | null = el.parentElement
      while (cur && cur !== html) {
        let pcs: CSSStyleDeclaration
        try {
          pcs = getComputedStyle(cur)
        } catch {
          cur = cur.parentElement
          continue
        }
        if (pcs.position === "fixed" || pcs.position === "sticky") {
          hasFixedAncestor = true
          break
        }
        cur = cur.parentElement
      }
    }
    if (hasFixedAncestor) continue

    const absTop = rect.top + scrollTop
    const absLeft = rect.left + scrollLeft
    const prev = state.get(el)
    if (prev) {
      const dS = scrollTop - prev.s
      const dL = scrollLeft - prev.sl
      const followsY =
        Math.abs(dS) >= MIN_DELTA &&
        Math.abs(absTop - prev.t) >= Math.abs(dS) * FOLLOW_RATIO
      const followsX =
        Math.abs(dL) >= MIN_DELTA &&
        Math.abs(absLeft - prev.l) >= Math.abs(dL) * FOLLOW_RATIO
      if (followsY || followsX) {
        tag(el)
        count++
        continue
      }
    }
    state.set(el, { t: absTop, l: absLeft, s: scrollTop, sl: scrollLeft })
  }

  w[ATTR_STORE] = store
  return count
}

/**
 * 逐帧「重定位」chrome（借鉴 awesome-screenshot）：把 fixed/sticky 的顶栏 / 侧栏
 * 改成 position:absolute，并钉在它「当前文档位置」。效果：
 *   - 该元素脱离视口跟随，变成普通文档元素 → 只在它所在的那一屏出现一次；
 *   - 脱离文档流后，原本被侧栏占据的横向空间会被正文回填 → 长图无侧栏留白。
 *
 * 与 hideFrameChrome（display:none 隐藏 + 留白）的区别就在「重定位而非隐藏」。
 * 仅处理 computed 为 fixed/sticky 且当前可见的元素；display:none 的（如今日头条
 * 滚动才显示的 fix-header）测不到位置，跳过——那类仍建议用 hideFrameChrome。
 *
 * 在「滚到顶部、截首帧之前」调用一次即可把 chrome 钉在文档顶部、正文回填；循环里
 * 每帧再增量调用以处理新出现的 chrome。所有改动记于 window[STORE]，restorePage 还原。
 */
export function relocateFrameChrome(rules: FullPageRuleSet): number {
  if (!rules || rules.enabled === false) return 0

  const RELOC_ATTR = "data-my-ss-reloc"
  const STORE = "__myScreenshotRelocList"
  const BODY_POS = "__myScreenshotBodyPos"
  const SCROLLER_ATTR = "data-my-screenshot-scroller"

  const html = document.documentElement
  const body = document.body
  const vw = html.clientWidth || window.innerWidth || 1
  const vh = html.clientHeight || window.innerHeight || 1
  const docHeight = Math.max(body.scrollHeight, html.scrollHeight, vh)
  const w = window as unknown as Record<string, unknown>

  // body position:relative（一次），让 absolute 子元素以 body 为基准更可控
  if (!(BODY_POS in w)) {
    w[BODY_POS] = body.style.position
    try {
      if (getComputedStyle(body).position === "static") {
        body.style.setProperty("position", "relative", "important")
      }
    } catch {
      /* 忽略 */
    }
  }

  // 豁免：customKeepSelectors（含祖先链）+ 主滚动容器祖先链
  const keepSet = new Set<HTMLElement>()
  ;(rules.customKeepSelectors || []).forEach((sel) => {
    if (!sel) return
    try {
      document.querySelectorAll<HTMLElement>(sel).forEach((el) => {
        let cur: HTMLElement | null = el
        while (cur && cur !== html) {
          keepSet.add(cur)
          cur = cur.parentElement
        }
      })
    } catch {
      /* 忽略 */
    }
  })
  const scroller = document.querySelector<HTMLElement>(`[${SCROLLER_ATTR}="1"]`)
  if (scroller) {
    let cur: HTMLElement | null = scroller.parentElement
    while (cur && cur !== html) {
      keepSet.add(cur)
      cur = cur.parentElement
    }
  }

  const isContentLike = (el: HTMLElement, rect: DOMRect): boolean => {
    if (el.querySelector(`[${SCROLLER_ATTR}="1"]`)) return true
    const areaRatio = (rect.width * rect.height) / Math.max(1, vw * vh)
    const heightRatio = rect.height / Math.max(1, vh)
    if (areaRatio < 0.5 && heightRatio < 0.9) return false
    const subtreeRatio = el.scrollHeight / Math.max(1, docHeight)
    if (subtreeRatio >= 0.6) return true
    return false
  }

  const storeRaw = w[STORE]
  const store = Array.isArray(storeRaw)
    ? (storeRaw as {
        el: HTMLElement
        cssText: string
        pinTop: number
        pinLeft: number
        w: number
        h: number
      }[])
    : []

  const pin = (el: HTMLElement, t: number, l: number, wpx: number, hpx: number) => {
    el.style.setProperty("position", "absolute", "important")
    el.style.setProperty("top", `${t}px`, "important")
    el.style.setProperty("left", `${l}px`, "important")
    el.style.setProperty("right", "auto", "important")
    el.style.setProperty("bottom", "auto", "important")
    el.style.setProperty("margin", "0", "important")
    el.style.setProperty("width", `${wpx}px`, "important")
    el.style.setProperty("height", `${hpx}px`, "important")
    el.style.setProperty("transition", "none", "important")
  }

  // 1) 复钉已重定位元素：每帧重新强制 absolute + 固定文档位。
  //    防止站点 JS 把它改回 sticky/fixed 重新跟随视口（→ 逐帧重复）；
  //    钉在「首次重定位时的文档位」→ 全程只出现在那一屏一次。
  const already = new Set<HTMLElement>()
  for (const rec of store) {
    const el = rec.el
    if (!el || !el.isConnected) continue
    already.add(el)
    pin(el, rec.pinTop, rec.pinLeft, rec.w, rec.h)
  }

  let count = 0
  const all: HTMLElement[] = []
  const visit = (node: ParentNode) => {
    node.querySelectorAll<HTMLElement>("*").forEach((el) => {
      all.push(el)
      if (el.shadowRoot) visit(el.shadowRoot)
    })
  }
  visit(html)

  // 2) 扫描本帧新出现的 fixed/sticky chrome → 重定位
  for (const el of all) {
    if (already.has(el)) continue
    if (el.getAttribute(SCROLLER_ATTR) === "1") continue
    if (keepSet.has(el)) continue
    let cs: CSSStyleDeclaration
    try {
      cs = getComputedStyle(el)
    } catch {
      continue
    }
    if (cs.position !== "fixed" && cs.position !== "sticky") continue
    if (cs.display === "none" || cs.visibility === "hidden") continue
    let rect: DOMRect
    try {
      rect = el.getBoundingClientRect()
    } catch {
      continue
    }
    if (rect.width < 1 || rect.height < 1) continue
    if (isContentLike(el, rect)) continue

    // 转 absolute 并钉在「当前视口位置对应的文档位置」：作为文档元素它随文档滚动，
    // 即固定在当前这一屏，只出现一次；脱离流后正文回填其占位。
    const savedCss = el.style.cssText
    el.style.setProperty("position", "absolute", "important")
    let opRect = { top: 0, left: 0 } as { top: number; left: number }
    let opBT = 0
    let opBL = 0
    try {
      const op = (el.offsetParent as HTMLElement) || body
      opRect = op.getBoundingClientRect()
      const opCs = getComputedStyle(op)
      opBT = parseFloat(opCs.borderTopWidth) || 0
      opBL = parseFloat(opCs.borderLeftWidth) || 0
    } catch {
      /* 退化为以视口为基准 */
    }
    const pinTop = Math.round(rect.top - opRect.top - opBT)
    const pinLeft = Math.round(rect.left - opRect.left - opBL)
    const wpx = Math.round(rect.width)
    const hpx = Math.round(rect.height)
    pin(el, pinTop, pinLeft, wpx, hpx)
    el.setAttribute(RELOC_ATTR, "1")
    store.push({ el, cssText: savedCss, pinTop, pinLeft, w: wpx, h: hpx })
    count++
  }

  w[STORE] = store
  return count
}

/**
 * 读取 hideFixedElements / detectAndHidePseudoSticky 隐藏列表里记录的矩形，
 * 算出「顶部锚定的横向头部」下沿（视口 CSS 像素）。
 *
 * 用途：长截图首帧保留 fixed/sticky（顶栏、banner），但底栏 / 浮动按钮 /
 * 伪 sticky 会遮挡首帧正文。让首帧只保留 [0, headerBottom] 的头部，
 * headerBottom 以下整屏由「已隐藏」的干净帧覆盖即可消除遮挡。
 *
 * 判定「顶部锚定头部」：贴视口顶（top≤2）、横向铺开（width≥视口宽 50%）、
 * 且不超过视口高 60%（排除满屏遮罩 / 纵向侧栏）。取其最大 bottom。
 * 调用时机：滚回顶部、隐藏完成后（rect 记录于隐藏前、滚动位置在顶部）。
 */
export function measureTopHeaderBottom(): number {
  const STORE = "__myScreenshotHiddenList"
  const store = (window as unknown as Record<string, unknown>)[STORE]
  const list = Array.isArray(store)
    ? (store as { rect?: DOMRect }[])
    : []
  const html = document.documentElement
  const vpw = html.clientWidth || window.innerWidth
  const vph = html.clientHeight || window.innerHeight
  let bottom = 0
  for (const item of list) {
    const r = item.rect
    if (!r) continue
    if (
      r.top <= 2 &&
      r.bottom > 0 &&
      r.bottom <= vph &&
      r.width >= vpw * 0.5
      // 不再限制 height <= vph * 0.6：
      // SPA 主壳（全屏 fixed）因 subtreeRatio 高被 hideFixedElements 豁免，
      // 永远不进隐藏列表，无需此过滤。
      // 去掉限制后，全屏弹窗（如 VIP 购买弹窗，height ≈ vph）可以正确贡献
      // 到 headerBottom，使 contentOffsetY = 弹窗高 - reservedTop，
      // 确保后续干净帧从弹窗结束处开始，不覆盖第一帧的弹窗内容。
    ) {
      if (r.bottom > bottom) bottom = r.bottom
    }
  }
  return bottom
}

/**
 * 量取页面左/右「侧栏」占据的水平区间，返回正文列的左右边界 { left, right }
 * （CSS 像素，相对视口；无侧栏时 left=0、right=视口宽）。
 *
 * 用途：window 滚动 + 固定侧栏页面（旧版 GitLab 等），后续干净帧若按整窗整宽
 * 拼接，会覆盖掉首帧里保留的侧栏列。改为只截 [left, right] 正文列，侧栏列保留首帧。
 *
 * 侧栏判据与 probePageType 一致：贯穿 ≥70% 视口高、宽 6%~35%、贴左/右边（任意定位）。
 */
export function measureContentInsets(): { left: number; right: number } {
  const html = document.documentElement
  const vw = html.clientWidth || window.innerWidth || 1
  const vh = html.clientHeight || window.innerHeight || 1
  let left = 0
  let right = vw
  let budget = 1500
  const all = document.querySelectorAll<HTMLElement>("*")
  for (const el of all) {
    if (budget-- <= 0) break
    let cs: CSSStyleDeclaration
    try {
      cs = getComputedStyle(el)
    } catch {
      continue
    }
    if (cs.display === "none" || cs.visibility === "hidden") continue
    let r: DOMRect
    try {
      r = el.getBoundingClientRect()
    } catch {
      continue
    }
    const hr = r.height / vh
    const wr = r.width / vw
    if (hr < 0.7 || wr < 0.06 || wr > 0.35) continue
    // 左侧栏：贴左、右沿在视口左半区
    if (r.left <= vw * 0.02 && r.right > left && r.right < vw * 0.5) {
      left = Math.max(left, r.right)
    }
    // 右侧栏：贴右、左沿在视口右半区
    if (r.right >= vw * 0.98 && r.left < right && r.left > vw * 0.5) {
      right = Math.min(right, r.left)
    }
  }
  return { left: Math.round(left), right: Math.round(Math.max(left + 1, right)) }
}

/**
 * 量取网页有效背景色（CSS 颜色串）。用于长图画布底色，使后续帧未绘制的
 * 侧栏槽等留白与网页背景一致，而非默认白色。
 * 取 body → documentElement 的第一个不透明 background-color；都透明则回退白色。
 */
export function measurePageBackground(): string {
  const isOpaque = (c: string): boolean => {
    if (!c || c === "transparent") return false
    const m = c.match(/rgba?\(([^)]+)\)/i)
    if (m) {
      const parts = m[1].split(",").map((s) => parseFloat(s))
      if (parts.length >= 4 && parts[3] === 0) return false
    }
    return true
  }
  try {
    const b = getComputedStyle(document.body).backgroundColor
    if (isOpaque(b)) return b
  } catch {
    /* 忽略 */
  }
  try {
    const h = getComputedStyle(document.documentElement).backgroundColor
    if (isOpaque(h)) return h
  } catch {
    /* 忽略 */
  }
  return "#ffffff"
}

/**
 * 量取「正文真实顶部」距视口顶的距离（视口 CSS 像素），即顶部已为固定栏
 * 预留的空白（padding/margin）。调用前提：已滚到顶部、顶栏已隐藏。
 *
 * 用途：长截图把正文整体下移给顶栏带让位时，需扣掉这段已预留空白，
 * 否则会给「本就为固定栏留好 padding-top」的站点叠加一段多余空白。
 *
 * 取法：扫描 DOM，找最上沿的可见文本 / 图片 / 媒体（绕开「容器盒子从 0 起、
 * 真实内容却在 padding 之下」的整页 wrapper 结构），返回其 rect.top。
 */
export function measureContentTopReservedSpace(): number {
  const SCROLLER_ATTR = "data-my-screenshot-scroller"
  const scroller = document.querySelector<HTMLElement>(
    `[${SCROLLER_ATTR}="1"]`
  )
  const root: ParentNode =
    scroller || document.body || document.documentElement
  const vph = scroller
    ? scroller.clientHeight
    : document.documentElement.clientHeight || window.innerHeight

  let minTop = Infinity
  let scanned = 0
  const SCAN_LIMIT = 4000

  let walker: TreeWalker
  try {
    walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT
    )
  } catch {
    return 0
  }

  let n: Node | null = walker.currentNode
  while ((n = walker.nextNode()) && scanned < SCAN_LIMIT) {
    scanned++
    let rect: DOMRect | null = null

    if (n.nodeType === Node.TEXT_NODE) {
      if (!(n.textContent || "").trim()) continue
      try {
        const range = document.createRange()
        range.selectNodeContents(n)
        rect = range.getBoundingClientRect()
      } catch {
        continue
      }
    } else if (n instanceof HTMLElement) {
      const tag = n.tagName
      if (
        tag === "IMG" ||
        tag === "VIDEO" ||
        tag === "CANVAS" ||
        tag === "SVG"
      ) {
        try {
          rect = n.getBoundingClientRect()
        } catch {
          continue
        }
      }
    }

    if (!rect || rect.width < 2 || rect.height < 2) continue
    if (rect.top < 0 || rect.top > vph) continue
    if (rect.top < minTop) minTop = rect.top
    // 已贴近视口顶，不可能更小，提前结束扫描
    if (minTop <= 2) break
  }

  return minTop === Infinity ? 0 : minTop
}

/** 恢复页面原状（滚动条 + 滚动位置）。同时兜底清理隐藏列表残留。 */
export function restorePage(snapshot: PreparePageSnapshot): void {
  const SCROLLER_ATTR = "data-my-screenshot-scroller"
  // 兜底恢复 hideFixedElements 的隐藏列表。
  // 这里**必须内联实现**，不能调 restoreFixedElements()：
  // chrome.scripting.executeScript({ func }) 走的是 Function.prototype.toString
  // 序列化函数体注入到页面执行；跨模块函数引用经 Parcel 压缩后变成单字母
  // 标识符（如 `m()`），在页面 global 找不到 → ReferenceError。
  {
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
    // 清理逐帧 chrome 隐藏（hideFrameChrome 用）：移除属性 + 删 !important 样式表 + 清状态
    try {
      document
        .querySelectorAll("[data-my-ss-frame-hide]")
        .forEach((el) => el.removeAttribute("data-my-ss-frame-hide"))
      document.getElementById("__my_ss_frame_hide_style")?.remove()
    } catch {
      /* 忽略 */
    }
    delete (window as unknown as Record<string, unknown>)["__myScreenshotFrameHideList"]
    delete (window as unknown as Record<string, unknown>)["__myScreenshotFollowState"]
    // 还原 relocateFrameChrome 的重定位：恢复各元素 inline style + body position
    try {
      const relRaw = (window as unknown as Record<string, unknown>)[
        "__myScreenshotRelocList"
      ]
      if (Array.isArray(relRaw)) {
        ;(relRaw as { el: HTMLElement; cssText: string }[]).forEach(
          ({ el, cssText }) => {
            el.style.cssText = cssText
            el.removeAttribute("data-my-ss-reloc")
          }
        )
      }
    } catch {
      /* 忽略 */
    }
    delete (window as unknown as Record<string, unknown>)["__myScreenshotRelocList"]
    {
      const bodyPos = (window as unknown as Record<string, unknown>)[
        "__myScreenshotBodyPos"
      ]
      if (typeof bodyPos === "string") {
        document.body.style.position = bodyPos
      }
      delete (window as unknown as Record<string, unknown>)["__myScreenshotBodyPos"]
    }
  }

  // 移除 preparePage 注入的全局冻结样式，恢复页面原有的平滑滚动 / 过渡动画
  const FREEZE_STYLE_ID = "__my_screenshot_freeze_style__"
  document.getElementById(FREEZE_STYLE_ID)?.remove()

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

      // 当前不可见的浮层不得被摊平：典型是 popo 文档"流程图编辑器"这类
      // 非活动抽屉，作者通过 visibility/display/opacity/transform 隐藏在视口外。
      // 摊平流程会强行写 display:block/visibility:visible/opacity:1/transform:none，
      // 把这些抽屉显形并定位到正文头部，第一帧就被拍进长截图。
      //
      // 判定:
      //   - display:none / visibility:hidden / opacity ≤ 0.01 → 不可见
      //   - 自身或祖先链命中 transform 把整体挪出视口（rect.right ≤ 0 / rect.bottom
      //     ≤ 0 / rect.left ≥ vw / rect.top ≥ vh）→ 不可见
      //   - 祖先链有 display:none / visibility:hidden → 不可见
      if (cs.display === "none" || cs.visibility === "hidden") {
        if (el.shadowRoot) visit(el.shadowRoot)
        return
      }
      const opacityNum = parseFloat(cs.opacity || "1")
      if (!isNaN(opacityNum) && opacityNum <= 0.01) {
        if (el.shadowRoot) visit(el.shadowRoot)
        return
      }
      // 祖先链可见性检查
      let ancestor: HTMLElement | null = el.parentElement
      let ancestorHidden = false
      while (ancestor && ancestor !== document.documentElement) {
        let acs: CSSStyleDeclaration
        try {
          acs = getComputedStyle(ancestor)
        } catch {
          ancestor = ancestor.parentElement
          continue
        }
        if (acs.display === "none" || acs.visibility === "hidden") {
          ancestorHidden = true
          break
        }
        const ao = parseFloat(acs.opacity || "1")
        if (!isNaN(ao) && ao <= 0.01) {
          ancestorHidden = true
          break
        }
        ancestor = ancestor.parentElement
      }
      if (ancestorHidden) {
        if (el.shadowRoot) visit(el.shadowRoot)
        return
      }

      const rect = el.getBoundingClientRect()

      // 完全在视口外的浮层不摊平：常见手法是 transform: translateX(100%) 或
      // 直接把 left/top 设到视口外，这类「非活动抽屉」不应被显形。
      // 注意 oversize 检测里 rect.bottom > vh 是对外溢的合法情况（弹窗超出底部
      // 一截），这里只过滤"完全在视口外"。
      if (
        rect.right <= 0 ||
        rect.bottom <= 0 ||
        rect.left >= vw ||
        rect.top >= vh
      ) {
        if (el.shadowRoot) visit(el.shadowRoot)
        return
      }

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

/**
 * 第一帧弹窗保全：scrollToY(0) 之前调用。
 *
 * 问题：很多 SPA 付费弹窗（如有道翻译 VIP 购买弹窗）监听 window scroll 事件，
 * 一旦 scrollToY 触发，立刻把弹窗 display:none 或 visibility:hidden。
 * 这导致第一帧截图拍不到弹窗——「第一帧保留弹窗，后续隐藏」的预期完全失效。
 *
 * 方案：对所有当前可见的 fixed/sticky 元素设置 MutationObserver，一旦检测到
 * style/class/hidden 使其不可见，立刻还原 inline style。
 * 等第一帧拍完后调用 unfreezeScrollModals 断开 observer，弹窗恢复正常关闭行为。
 *
 * 与 freezeFlattenedModals 的区别：
 *  - freezeFlattenedModals 守护已被「摊平」的 iframe 弹窗（须含 iframe）
 *  - 本函数守护普通非 iframe 弹窗（如付费对话框），仅保护至第一帧拍完为止
 *  - 两者使用不同的 window key，互不干扰
 */
export function freezeScrollModals(): number {
  const STORE = "__myScreenshotScrollModalFreeze"

  type Target = { el: HTMLElement; display: string; visibility: string; opacity: string }
  const targets: Target[] = []

  document.querySelectorAll<HTMLElement>("*").forEach((el) => {
    let cs: CSSStyleDeclaration
    try {
      cs = getComputedStyle(el)
    } catch {
      return
    }
    if (cs.position !== "fixed" && cs.position !== "sticky") return
    // 已不可见的不需要保护
    if (cs.display === "none" || cs.visibility === "hidden") return
    const op = parseFloat(cs.opacity || "1")
    if (!isNaN(op) && op <= 0.01) return
    targets.push({
      el,
      display: el.style.display,
      visibility: el.style.visibility,
      opacity: el.style.opacity
    })
  })

  if (targets.length === 0) return 0

  const byEl = new Map<HTMLElement, Target>(targets.map((t) => [t.el, t]))

  const observer = new MutationObserver((records) => {
    for (const rec of records) {
      if (rec.type !== "attributes") continue
      const el = rec.target as HTMLElement
      const t = byEl.get(el)
      if (!t) continue
      let cs: CSSStyleDeclaration
      try {
        cs = getComputedStyle(el)
      } catch {
        continue
      }
      if (
        cs.display === "none" ||
        cs.visibility === "hidden" ||
        parseFloat(cs.opacity || "1") <= 0.01
      ) {
        // 还原为截图前的 inline style 状态
        el.style.display = t.display
        el.style.visibility = t.visibility
        el.style.opacity = t.opacity
      }
    }
  })

  observer.observe(document.documentElement, {
    subtree: true,
    attributes: true,
    attributeFilter: ["style", "class", "hidden"]
  })

  ;(window as unknown as Record<string, unknown>)[STORE] = { observer }
  return targets.length
}

/** 配对 freezeScrollModals：断开 observer，让弹窗恢复正常关闭行为。 */
export function unfreezeScrollModals(): void {
  const STORE = "__myScreenshotScrollModalFreeze"
  const state = (window as unknown as Record<string, unknown>)[STORE] as
    | { observer: MutationObserver }
    | undefined
  if (!state) return
  try {
    state.observer.disconnect()
  } catch {
    // 忽略
  }
  delete (window as unknown as Record<string, unknown>)[STORE]
}
