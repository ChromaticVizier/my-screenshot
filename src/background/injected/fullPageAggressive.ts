/**
 * 激进隐藏模式专用的注入函数（在页面上下文执行，需自包含）。
 *
 * 与 fullPage.ts 的区别：本模式不保留首帧、不做顶栏补偿，而是先「隔离主滚动
 * 容器」——把容器之外的所有元素 display:none，让页面只剩 scroller 子树，再统一
 * 滚动截图。优点是彻底消除顶栏 / 侧栏 / 弹窗逐帧重复；缺点是词典官网等
 * 「内容分散在多个并列容器」的页面可能漏截非容器内的元素。
 *
 * 其余注入函数（preparePage / scrollToY / hideFixedElements /
 * detectAndHidePseudoSticky / hideOutsideFrameChain / rehideFixedElements /
 * measureScrollMetrics / waitForDynamicContent / kickScrollListeners /
 * restoreFixedElements / restorePage）与旧模式共用，直接从 fullPage.ts 引入。
 */
import type { FullPageRuleSet } from "~src/shared/settings"

/**
 * 隔离主滚动容器：把"通往 scroller 的祖先链"作为唯一可见路径，
 * 祖先链每层上不在链上的兄弟节点全部 display:none。
 *
 * 隔离后页面只剩 scroller 子树（+ customKeepSelectors 强制保留的分支），
 * 顶栏 / 侧栏 / 底栏 / 弹窗等会逐帧重复的元素一次性消失——长截图因此无需对
 * 首帧做特殊处理，所有帧统一截、统一裁切。
 *
 * window 滚动模式（无 scroller 元素）不做链隔离：body 即内容容器，没有"容器外
 * 元素"可隐藏，交给 hideFixedElements + detectAndHidePseudoSticky 处理会重复的
 * fixed/sticky 即可。
 *
 * 复用 hideFixedElements 的 STORE / MARK，restoreFixedElements 一并恢复。
 */
export function isolateScroller(rules: FullPageRuleSet): {
  isolated: boolean
  hidden: number
} {
  const SCROLLER_ATTR = "data-my-screenshot-scroller"
  const MARK = "__myScreenshotHidden"
  const STORE = "__myScreenshotHiddenList"
  const scroller = document.querySelector<HTMLElement>(
    `[${SCROLLER_ATTR}="1"]`
  )
  // window 模式：没有内部滚动元素，链隔离无意义
  if (!scroller) return { isolated: false, hidden: 0 }

  // scroller 到 documentElement 的祖先路径（自顶向下），用于逐层下钻剪枝
  const scrollerPath: HTMLElement[] = []
  {
    let p: HTMLElement | null = scroller
    while (p && p !== document.documentElement) {
      scrollerPath.unshift(p)
      p = p.parentElement
    }
  }

  // keepSet：用户 customKeepSelectors 命中元素及其祖先链强制保留（整棵子树可见）
  const keepSet = new Set<HTMLElement>()
  ;(rules?.customKeepSelectors || []).forEach((sel) => {
    if (!sel) return
    try {
      document.querySelectorAll<HTMLElement>(sel).forEach((el) => {
        let c: HTMLElement | null = el
        while (c && c !== document.documentElement) {
          keepSet.add(c)
          c = c.parentElement
        }
      })
    } catch {
      /* 选择器非法忽略 */
    }
  })

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

  // head / script / style 等非视觉节点：display:none 无意义且可能干扰页面，跳过
  const NON_VISUAL = new Set([
    "HEAD",
    "SCRIPT",
    "STYLE",
    "META",
    "LINK",
    "TITLE",
    "BASE",
    "NOSCRIPT"
  ])

  // 自顶向下沿 scrollerPath 下钻：每层把「非 scroller 分支、非 keep 分支」的兄弟隐藏。
  // 到达 scroller 自身即停止——它的整棵子树保持可见。
  let cursor: HTMLElement | null = document.documentElement
  let level = 0
  while (cursor && cursor !== scroller) {
    const branchChild = scrollerPath[level] ?? null
    const children = Array.from(cursor.children) as HTMLElement[]
    for (const child of children) {
      if (child === branchChild) continue // scroller 分支，下钻保留
      if (keepSet.has(child)) continue // 用户保留分支，整棵子树留可见
      if (NON_VISUAL.has(child.tagName)) continue
      hide(child)
    }
    cursor = branchChild
    level++
  }

  ;(window as unknown as Record<string, unknown>)[STORE] = list
  return { isolated: true, hidden: list.length }
}

/**
 * 隔离 / 隐藏完成后重新量取主滚动容器（或 window）在视口中的裁切区域与总高度。
 *
 * 隔离会移除 scroller 的兄弟元素（顶栏 / 侧栏等），scroller 在视口中的位置 / 尺寸
 * 随之回流变化，preparePage 抓的旧 captureX/Y/W/H 不再准确，必须重测。
 */
export function measureScrollerRect(): {
  scrollerIsElement: boolean
  captureX: number
  captureY: number
  captureWidth: number
  captureHeight: number
  totalHeight: number
} {
  const SCROLLER_ATTR = "data-my-screenshot-scroller"
  const html = document.documentElement
  const scroller = document.querySelector<HTMLElement>(
    `[${SCROLLER_ATTR}="1"]`
  )
  if (scroller) {
    const rect = scroller.getBoundingClientRect()
    const left = Math.max(0, rect.left)
    const top = Math.max(0, rect.top)
    const width = Math.max(1, Math.min(rect.width, html.clientWidth - left))
    const height = Math.max(1, Math.min(rect.height, html.clientHeight - top))
    return {
      scrollerIsElement: true,
      captureX: left,
      captureY: top,
      captureWidth: width,
      captureHeight: height,
      totalHeight: Math.max(scroller.scrollHeight, scroller.clientHeight)
    }
  }
  return {
    scrollerIsElement: false,
    captureX: 0,
    captureY: 0,
    captureWidth: html.clientWidth,
    captureHeight: html.clientHeight,
    totalHeight: Math.max(
      document.body.scrollHeight,
      html.scrollHeight,
      document.body.offsetHeight,
      html.offsetHeight,
      html.clientHeight
    )
  }
}
