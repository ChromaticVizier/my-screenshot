/**
 * 网页内嵌「自定义滚动文档/表格」专家的注入函数（在承载文档的 frame 内执行）。
 *
 * 目标：网易灵犀（SpreadJS）等 canvas 渲染的表格 / 文档——没有原生可滚动元素，
 * 设 scrollTop 无效（故长截图「无法滚动」）。它们靠 wheel / 键盘自定义滚动，并自绘
 * 滚动条（SpreadJS：`.gc-scroll-handle` 在竖直轨道里）。
 *
 * 方案：
 *  - 用键盘 PageDown 逐页驱动滚动（实测可生效）；
 *  - 用竖直滚动条 thumb 的位置作为「滚动进度」标尺：
 *      progress = (thumbTop - trackTop) / (trackHeight - thumbHeight)
 *      visible/total ≈ thumbHeight / trackHeight  →  total = visible / 比例
 *    据此把每帧放到长图的正确 Y，并判断是否到底。
 *
 * 这些函数经 chrome.scripting.executeScript 序列化注入，必须自包含。
 */

/** 竖直自定义滚动条 + 网格区域的几何（frame 视口 CSS 像素） */
export interface EmbeddedScrollProbe {
  isCustomScroll: boolean
  /** 竖直滚动条轨道 */
  trackTop: number
  trackHeight: number
  /** 滚动条 thumb（拖块） */
  thumbTop: number
  thumbHeight: number
  /** 网格/文档内容区（canvas）在 frame 视口中的矩形 */
  gridLeft: number
  gridTop: number
  gridWidth: number
  gridHeight: number
}

/** 在当前 frame 里找竖直自定义滚动条的 {track, thumb}（SpreadJS .gc-scroll-handle） */
function findVerticalScrollbar(): {
  track: HTMLElement
  thumb: HTMLElement
} | null {
  const html = document.documentElement
  const vw = html.clientWidth || window.innerWidth
  const handles = Array.from(
    document.querySelectorAll<HTMLElement>(".gc-scroll-handle")
  )
  for (const h of handles) {
    let r: DOMRect
    try {
      r = h.getBoundingClientRect()
    } catch {
      continue
    }
    // 竖直 thumb：窄、贴右边、且高度 < 其轨道高度
    if (r.width <= 24 && r.left >= vw * 0.8 && r.height > 4) {
      const track = h.parentElement
      if (track) return { track, thumb: h }
    }
  }
  return null
}

/** 取最大的 canvas（电子表格视口）作为网格区域 */
function findGridCanvas(): HTMLElement | null {
  const byId = document.querySelector<HTMLElement>("#vp_vp")
  if (byId) return byId
  let best: HTMLElement | null = null
  let bestArea = 0
  document.querySelectorAll<HTMLElement>("canvas").forEach((c) => {
    let r: DOMRect
    try {
      r = c.getBoundingClientRect()
    } catch {
      return
    }
    const area = r.width * r.height
    if (area > bestArea) {
      bestArea = area
      best = c
    }
  })
  return best
}

/** 探测当前 frame 是否为「自定义滚动文档/表格」，并返回几何 */
export function detectEmbeddedScrollDoc(): EmbeddedScrollProbe {
  const empty: EmbeddedScrollProbe = {
    isCustomScroll: false,
    trackTop: 0,
    trackHeight: 0,
    thumbTop: 0,
    thumbHeight: 0,
    gridLeft: 0,
    gridTop: 0,
    gridWidth: 0,
    gridHeight: 0
  }
  const sb = findVerticalScrollbar()
  const canvas = findGridCanvas()
  if (!sb || !canvas) return empty
  let tr: DOMRect
  let thr: DOMRect
  let cr: DOMRect
  try {
    tr = sb.track.getBoundingClientRect()
    thr = sb.thumb.getBoundingClientRect()
    cr = canvas.getBoundingClientRect()
  } catch {
    return empty
  }
  // 轨道须明显高于 thumb（有可滚空间）；网格须够大
  if (tr.height - thr.height < 8) return empty
  if (cr.width < 100 || cr.height < 100) return empty
  return {
    isCustomScroll: true,
    trackTop: tr.top,
    trackHeight: tr.height,
    thumbTop: thr.top,
    thumbHeight: thr.height,
    gridLeft: cr.left,
    gridTop: cr.top,
    gridWidth: cr.width,
    gridHeight: cr.height
  }
}

/** 当前竖直滚动条 thumb / track 状态（用于读进度、判到底） */
export function embeddedScrollState(): {
  thumbTop: number
  thumbHeight: number
  trackTop: number
  trackHeight: number
} {
  const sb = findVerticalScrollbar()
  if (!sb) return { thumbTop: 0, thumbHeight: 0, trackTop: 0, trackHeight: 0 }
  const tr = sb.track.getBoundingClientRect()
  const thr = sb.thumb.getBoundingClientRect()
  return {
    thumbTop: thr.top,
    thumbHeight: thr.height,
    trackTop: tr.top,
    trackHeight: tr.height
  }
}

/** 聚焦网格并把视图滚到最顶（Ctrl+Home） */
export function embeddedScrollToTop(): void {
  const cv = findGridCanvas()
  const target: HTMLElement = cv ?? document.body
  if (cv) {
    try {
      cv.setAttribute("tabindex", "0")
      cv.focus()
    } catch {
      /* 忽略 */
    }
  }
  const fire = (type: string) =>
    target.dispatchEvent(
      new KeyboardEvent(type, {
        bubbles: true,
        cancelable: true,
        key: "Home",
        code: "Home",
        keyCode: 36,
        ctrlKey: true
      })
    )
  fire("keydown")
  fire("keyup")
}

/** 按一次 PageDown 推进一页，返回推进后的滚动条状态 */
export function embeddedScrollStepDown(): {
  thumbTop: number
  thumbHeight: number
  trackTop: number
  trackHeight: number
} {
  const cv = findGridCanvas()
  const target: HTMLElement = cv ?? document.body
  if (cv) {
    try {
      cv.focus()
    } catch {
      /* 忽略 */
    }
  }
  const fire = (type: string) =>
    target.dispatchEvent(
      new KeyboardEvent(type, {
        bubbles: true,
        cancelable: true,
        key: "PageDown",
        code: "PageDown",
        keyCode: 34
      })
    )
  fire("keydown")
  fire("keyup")
  return embeddedScrollState()
}
