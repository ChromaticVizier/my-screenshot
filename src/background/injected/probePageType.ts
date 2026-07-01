/**
 * 页面类型探测（MoE 路由的 gating 网络）。
 *
 * 在 chrome.scripting.executeScript 序列化注入到「主 frame」执行，因此必须自包含：
 *  - 不依赖任何外部 import（类型 import 不会被打包，安全）
 *  - 返回值必须可结构化克隆（纯数据对象）
 *
 * 职责：一次性、无副作用地采集"决定该用哪套长截图专家"所需的页面特征信号，
 * 交给 background 的 fullPageRouter 做纯函数分类。它**不**做隐藏 / 滚动截图，
 * 唯一的副作用是探测 window 是否可滚时临时 scrollBy(+1) 后立即还原。
 *
 * 设计取舍：
 *  - 评分逻辑刻意比 preparePage 简化：这里只需"是否存在一个占主体的内部滚动容器"
 *    这一粗判，真正精确的 scroller 选取仍由选中的专家在其 preparePage 内完成。
 *  - 对所有元素做一次 getComputedStyle 遍历，与 preparePage 同量级开销；
 *    长截图本身是秒级操作，这点探测开销可忽略。
 */

/** 探测结果：交给 fullPageRouter.classifyPageType 做纯函数分类 */
export interface PageTypeProbe {
  /** window 自身是否可滚（scrollTo 探测） */
  windowScrollable: boolean
  viewportWidth: number
  viewportHeight: number
  /** 文档可滚动溢出量（docHeight - viewportHeight） */
  docOverflowPx: number

  /** 命中"内部滚动容器"判据的元素个数 */
  scrollerCandidateCount: number
  /** 最高分内部滚动容器的得分（0~1，视口可见面积比） */
  bestScrollerScore: number
  /** 最高分容器是否占据视口主体（宽≥60%vw 且 高≥60%vh） */
  bestScrollerCoversViewport: boolean
  /** 最高分容器 scrollHeight / 文档高度（接近 1 表示它承载页面主体内容） */
  bestScrollerScrollHeightRatio: number

  /** 占视口主体的最大可见 iframe（用于判别"内容主体在 iframe 内"） */
  dominantIframe: {
    /** iframe 的 src（用于 frame 定位）；可能为空字符串 */
    src: string
    /** 是否同源（能读到 contentDocument） */
    sameOrigin: boolean
    /** iframe 面积 / 视口面积 */
    areaRatio: number
  } | null

  /** 传统 frameset/frame 页面：内容主体在 <frame> 内，主 window 不滚动 */
  legacyFrame: {
    count: number
    scrollableCount: number
    mainFrameUrl: string
    mainFrameName: string
    mainFrameAreaRatio: number
    chromeFrameCount: number
  } | null
  /** fixed/sticky 元素总数（弹窗/吸顶密度的粗略指标） */
  fixedStickyCount: number
  /** 是否存在高层级、覆盖近全屏的 fixed 遮罩（Cookie 横幅 / 模态弹窗） */
  fullscreenOverlay: boolean
  /** 是否存在贯穿大半视口、贴左/右边的大侧边栏（任意定位；gitlab / confluence 导航壳） */
  hasSidebar: boolean
  /** 是否存在贴顶、较宽的固定/吸顶顶栏 */
  hasTopBar: boolean
  /** window 不可滚且 body/html overflow 被锁（典型 SPA 主壳） */
  bodyScrollLocked: boolean
  /** AI 聊天类页面：底部有输入/发送框，且主体是内部滚动聊天列表 */
  hasChatComposer: boolean
}

export function probePageType(): PageTypeProbe {
  const html = document.documentElement
  const body = document.body
  const vw = html.clientWidth || window.innerWidth || 1
  const vh = html.clientHeight || window.innerHeight || 1

  /* ---- 1) window 是否可滚（探测后立即还原） ---- */
  const originalScrollY = window.scrollY
  window.scrollTo({
    top: originalScrollY + 1,
    left: 0,
    behavior: "instant" as ScrollBehavior
  })
  const windowScrollable = window.scrollY !== originalScrollY
  window.scrollTo({
    top: originalScrollY,
    left: 0,
    behavior: "instant" as ScrollBehavior
  })

  const docHeight = Math.max(
    body ? body.scrollHeight : 0,
    html.scrollHeight,
    body ? body.offsetHeight : 0,
    html.offsetHeight,
    html.clientHeight
  )
  const docOverflowPx = Math.max(0, docHeight - vh)

  /* ---- 2) 单遍历：内部滚动容器候选 + fixed/sticky 统计 + 全屏遮罩 ---- */
  const MIN_OVERFLOW = 80
  const MIN_RATIO = 1.05
  let scrollerCandidateCount = 0
  let bestScrollerScore = 0
  let bestScrollerCoversViewport = false
  let bestScrollerScrollHeightRatio = 0
  let fixedStickyCount = 0
  let fullscreenOverlay = false
  // 「SPA 壳」特征：贯穿大半视口的侧边栏 / 固定顶栏（导航 chrome）。
  // 这类元素在长截图里会逐帧重复，需要 spa-like 专家只在首帧保留。
  let hasSidebar = false
  let hasTopBar = false
  // 限制侧栏/顶栏检测的 getBoundingClientRect 次数，避免大页面布局抖动
  let rectCheckBudget = 800

  let all: HTMLElement[]
  try {
    all = Array.from(document.querySelectorAll<HTMLElement>("*"))
  } catch {
    all = []
  }

  for (const el of all) {
    let cs: CSSStyleDeclaration
    try {
      cs = getComputedStyle(el)
    } catch {
      continue
    }
    if (cs.display === "none" || cs.visibility === "hidden") continue

    const pos = cs.position
    const isFixedSticky = pos === "fixed" || pos === "sticky"
    if (isFixedSticky) {
      fixedStickyCount++
      try {
        const r = el.getBoundingClientRect()
        const areaRatio = (r.width * r.height) / Math.max(1, vw * vh)
        const z = parseInt(cs.zIndex || "0", 10)
        // 全屏遮罩：高层级 + 覆盖近全屏
        if (areaRatio >= 0.85 && (Number.isNaN(z) ? false : z >= 100)) {
          fullscreenOverlay = true
        }
      } catch {
        /* 忽略 */
      }
    }

    // 大侧栏 / 顶栏检测：侧栏不限 CSS 定位——gitlab / confluence 等「flex 壳 +
    // 内容区内部滚动」布局里，侧栏是 static 的，但因处于不滚动的壳中而逐帧重复，
    // 只认 fixed/sticky 会漏判。用 rectCheckBudget 限制 getBoundingClientRect
    // 次数（侧栏在 DOM 靠前），避免大页面布局抖动；命中后短路。
    if ((!hasSidebar || !hasTopBar) && rectCheckBudget > 0) {
      rectCheckBudget--
      try {
        const r = el.getBoundingClientRect()
        const heightRatio = r.height / Math.max(1, vh)
        const widthRatio = r.width / Math.max(1, vw)
        // 贴左/右视口边（gitlab / confluence 等贴边导航）
        const nearLeft = r.left <= vw * 0.02
        const nearRight = r.right >= vw * 0.98
        // 或明显偏左 / 偏右（居中三栏布局的左右副栏，如微博——不贴边但整列在左/右侧）
        const leftOfCenter = r.right <= vw * 0.45
        const rightOfCenter = r.left >= vw * 0.55
        // 大侧边栏：贯穿大半视口高、较窄、位于左/右侧（任意定位）
        if (
          !hasSidebar &&
          heightRatio >= 0.55 &&
          widthRatio >= 0.06 &&
          widthRatio <= 0.4 &&
          (nearLeft || nearRight || leftOfCenter || rightOfCenter)
        ) {
          hasSidebar = true
        }
        // 顶栏：贴顶、较宽、较矮（要求 fixed/sticky——static 顶栏会随滚动离开，不重复）
        if (
          !hasTopBar &&
          isFixedSticky &&
          r.top <= vh * 0.02 &&
          widthRatio >= 0.6 &&
          heightRatio > 0.01 &&
          heightRatio <= 0.3
        ) {
          hasTopBar = true
        }
      } catch {
        /* 忽略 */
      }
    }

    // 内部滚动容器候选（body/html 的滚动由 window 驱动，排除）
    if (el === body || el === html) continue
    const oy = cs.overflowY
    if (oy === "visible") continue
    const clientHeight = el.clientHeight
    const overflowPx = el.scrollHeight - clientHeight
    if (clientHeight <= 0 || overflowPx < MIN_OVERFLOW) continue
    if (el.scrollHeight / Math.max(1, clientHeight) < MIN_RATIO) continue

    let rect: DOMRect
    try {
      rect = el.getBoundingClientRect()
    } catch {
      continue
    }
    if (rect.width < vw * 0.15 || rect.height < vh * 0.25) continue
    if (rect.bottom <= 0 || rect.top >= vh) continue

    const visibleW = Math.max(
      0,
      Math.min(rect.right, vw) - Math.max(rect.left, 0)
    )
    const visibleH = Math.max(
      0,
      Math.min(rect.bottom, vh) - Math.max(rect.top, 0)
    )
    const visibleAreaRatio = Math.min(
      1,
      (visibleW * visibleH) / Math.max(1, vw * vh)
    )
    if (visibleAreaRatio <= 0.03) continue

    scrollerCandidateCount++
    if (visibleAreaRatio > bestScrollerScore) {
      bestScrollerScore = visibleAreaRatio
      bestScrollerCoversViewport = visibleW >= vw * 0.6 && visibleH >= vh * 0.6
      bestScrollerScrollHeightRatio = el.scrollHeight / Math.max(1, docHeight)
    }
  }

  /* ---- 3) 主体 iframe ---- */
  let dominantIframe: PageTypeProbe["dominantIframe"] = null
  try {
    let bestArea = 0
    document.querySelectorAll<HTMLIFrameElement>("iframe").forEach((f) => {
      let r: DOMRect
      try {
        r = f.getBoundingClientRect()
      } catch {
        return
      }
      if (r.width <= 0 || r.height <= 0) return
      let cs: CSSStyleDeclaration
      try {
        cs = getComputedStyle(f)
      } catch {
        return
      }
      if (cs.display === "none" || cs.visibility === "hidden") return
      const area = r.width * r.height
      if (area <= bestArea) return
      bestArea = area
      let sameOrigin = false
      try {
        sameOrigin = !!f.contentDocument
      } catch {
        sameOrigin = false
      }
      dominantIframe = {
        src: f.src || "",
        sameOrigin,
        areaRatio: area / Math.max(1, vw * vh)
      }
    })
  } catch {
    dominantIframe = null
  }

  /* ---- 4) 传统 frameset/frame ---- */
  let legacyFrame: PageTypeProbe["legacyFrame"] = null
  try {
    const frames = Array.from(
      document.querySelectorAll<HTMLFrameElement>("frame")
    )
    if (frames.length >= 2) {
      let best: {
        frame: HTMLFrameElement
        area: number
        url: string
        name: string
        scrollable: boolean
      } | null = null
      let scrollableCount = 0
      let chromeFrameCount = 0
      frames.forEach((f) => {
        const r = f.getBoundingClientRect()
        const area = Math.max(0, r.width) * Math.max(0, r.height)
        if (area <= 0) return
        let doc: Document | null = null
        try {
          doc = f.contentDocument
        } catch {
          doc = null
        }
        const docH = doc
          ? Math.max(
              doc.documentElement.scrollHeight,
              doc.body?.scrollHeight ?? 0,
              doc.documentElement.offsetHeight,
              doc.body?.offsetHeight ?? 0
            )
          : 0
        const frameH = Math.max(1, r.height)
        const scrollable = docH > frameH + 8
        if (scrollable) scrollableCount++
        if (
          r.height <= vh * 0.25 ||
          /head|header|top|foot|bottom|menu|nav/i.test(f.name || f.src || "")
        ) {
          chromeFrameCount++
        }
        const item = {
          frame: f,
          area,
          url: doc?.location?.href || f.src || "",
          name: f.name || "",
          scrollable
        }
        if (!best || (scrollable && !best.scrollable) || area > best.area) {
          best = item
        }
      })
      if (best) {
        legacyFrame = {
          count: frames.length,
          scrollableCount,
          mainFrameUrl: best.url,
          mainFrameName: best.name,
          mainFrameAreaRatio: best.area / Math.max(1, vw * vh),
          chromeFrameCount
        }
      }
    }
  } catch {
    legacyFrame = null
  }

  /* ---- 5) body/html overflow 锁 ---- */
  let bodyScrollLocked = false
  try {
    const bodyCs = body ? getComputedStyle(body) : null
    const htmlCs = getComputedStyle(html)
    const locked = (cs: CSSStyleDeclaration | null) =>
      !!cs && (cs.overflowY === "hidden" || cs.overflow === "hidden")
    bodyScrollLocked = !windowScrollable && (locked(bodyCs) || locked(htmlCs))
  } catch {
    bodyScrollLocked = false
  }

  // AI 聊天类页面：底部输入/发送框通常 sticky/fixed 在主聊天 scroller 底部。
  let hasChatComposer = false
  try {
    const controls = Array.from(
      document.querySelectorAll<HTMLElement>(
        'textarea,input,[contenteditable="true"],[role="textbox"]'
      )
    )
    hasChatComposer = controls.some((el) => {
      const r = el.getBoundingClientRect()
      if (r.width < 120 || r.height < 20) return false
      if (r.top < vh * 0.45 || r.bottom < vh * 0.65) return false
      const text = `${el.getAttribute("placeholder") || ""} ${el.getAttribute("aria-label") || ""} ${el.getAttribute("name") || ""} ${el.id || ""} ${String(el.className || "")}`
      return /chat|message|prompt|send|ask|输入|发送|提问|消息|deepseek|gpt|claude|gemini|kimi|豆包/i.test(
        text
      )
    })
  } catch {
    hasChatComposer = false
  }

  return {
    windowScrollable,
    viewportWidth: vw,
    viewportHeight: vh,
    docOverflowPx,
    scrollerCandidateCount,
    bestScrollerScore,
    bestScrollerCoversViewport,
    bestScrollerScrollHeightRatio,
    dominantIframe,
    legacyFrame,
    fixedStickyCount,
    fullscreenOverlay,
    hasSidebar,
    hasTopBar,
    bodyScrollLocked,
    hasChatComposer
  }
}
