/**
 * 虚拟化 canvas 表格（飞书多维表格 Bitable / grid）的滚动区兼容。
 *
 * 这类表格没有原生 overflow 滚动容器：内容画在 <canvas> 上，滚动由 wheel 事件
 * 驱动，feishu 内部更新滚动偏移并重绘 canvas，同时把 `.faster-view` 下的 DOM
 * 覆盖层用负 `top` 平移（top=0 在顶部，越往下越负）。因此：
 *  - 滚动偏移 offset = -(min 负 top)（相对 canvas 视口顶部，CSS 像素）
 *  - 只能通过派发 WheelEvent 到 canvas 中心来推进，不能设 scrollTop
 *  - 列头行固定绘制在 canvas 顶部（冻结），逐帧会重复 → 需从后续帧裁掉
 *
 * 这些函数会被 executeScript 注入页面执行，必须【完全自包含】：
 * executeScript 只序列化被注入函数自身的函数体，模块作用域的其它函数不会一起注入，
 * 因此每个导出函数内部都内联了 findCanvas / readOffset / wheel / sleep 等辅助逻辑。
 */

export interface CanvasGridMetrics {
  found: boolean
  /** canvas 在浏览器视口中的 CSS 位置/尺寸（截图裁切用） */
  canvasX: number
  canvasY: number
  canvasW: number
  canvasH: number
  /** 冻结列头高度（CSS 像素），后续帧从此处向下裁切以免逐帧重复 */
  headerH: number
  /** 当前滚动偏移（CSS 像素，0=顶部） */
  offset: number
  devicePixelRatio: number
}

/**
 * 准备：定位 canvas、冻结动画、滚动回顶部、估算冻结列头高度，返回度量。
 * headerH 用 DOM 覆盖层的首行高度估算，取不到则用默认 33px。
 */
export async function prepareCanvasGrid(
  selector?: string
): Promise<CanvasGridMetrics> {
  // ---- 内联辅助（executeScript 只序列化本函数体，不能引用外部函数） ----
  const findCanvas = (sel?: string): HTMLCanvasElement | null => {
    let best: HTMLCanvasElement | null = null
    let bestArea = 0
    if (sel) {
      try {
        const el = document.querySelector(sel)
        if (el instanceof HTMLCanvasElement) return el
        if (el) {
          el.querySelectorAll("canvas").forEach((c) => {
            const r = c.getBoundingClientRect()
            const area = r.width * r.height
            if (area > bestArea) {
              best = c
              bestArea = area
            }
          })
          if (best) return best
        }
      } catch {
        /* selector 失效则回退 */
      }
    }
    best = null
    bestArea = 0
    document.querySelectorAll("canvas").forEach((c) => {
      const r = c.getBoundingClientRect()
      if (r.width < 400 || r.height < 200) return
      const inGrid =
        c.closest(".faster-view") ||
        c.closest('[class*="bitable"]') ||
        c.closest('[class*="grid"]')
      if (!inGrid) return
      const area = r.width * r.height
      if (area > bestArea) {
        best = c
        bestArea = area
      }
    })
    return best
  }
  const readOffset = (canvas: HTMLCanvasElement): number => {
    const view =
      (canvas.closest(".faster-view") as HTMLElement | null) ||
      canvas.parentElement
    if (!view) return 0
    let min = 0
    view.querySelectorAll<HTMLElement>("div").forEach((el) => {
      const t = parseFloat(getComputedStyle(el).top)
      if (!isNaN(t) && t < min) min = t
    })
    return -min
  }
  const wheel = (canvas: HTMLCanvasElement, deltaY: number) => {
    const r = canvas.getBoundingClientRect()
    canvas.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY,
        deltaMode: 0,
        clientX: r.left + r.width / 2,
        clientY: r.top + r.height / 2,
        bubbles: true,
        cancelable: true
      })
    )
  }
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  // ----------------------------------------------------------------

  const empty: CanvasGridMetrics = {
    found: false,
    canvasX: 0,
    canvasY: 0,
    canvasW: 0,
    canvasH: 0,
    headerH: 0,
    offset: 0,
    devicePixelRatio: window.devicePixelRatio || 1
  }
  const canvas = findCanvas(selector)
  if (!canvas) return empty

  const FREEZE_ID = "__my_screenshot_canvasgrid_freeze__"
  if (!document.getElementById(FREEZE_ID)) {
    const s = document.createElement("style")
    s.id = FREEZE_ID
    s.textContent =
      "*,*::before,*::after{transition:none !important;animation:none !important;}"
    ;(document.head || document.documentElement).appendChild(s)
  }

  // 滚回顶部：持续向上 wheel 直到 offset 稳定为 0
  let stall = 0
  for (let i = 0; i < 80; i++) {
    const before = readOffset(canvas)
    if (before <= 1) break
    wheel(canvas, -800)
    await sleep(50)
    const after = readOffset(canvas)
    if (after === before) {
      if (++stall >= 4) break
    } else stall = 0
  }
  await sleep(120)

  const r = canvas.getBoundingClientRect()
  let headerH = 33
  try {
    const view = canvas.closest(".faster-view") as HTMLElement | null
    if (view) {
      const cand = Array.from(view.querySelectorAll<HTMLElement>("div")).find(
        (el) => {
          const cls = String(el.className || "")
          const rr = el.getBoundingClientRect()
          return (
            /header|field-head|column-head|col-header|head-row/i.test(cls) &&
            rr.height > 12 &&
            rr.height < 80 &&
            rr.width > 200
          )
        }
      )
      if (cand) headerH = Math.round(cand.getBoundingClientRect().height)
    }
  } catch {
    /* 用默认 */
  }

  return {
    found: true,
    canvasX: Math.max(0, Math.round(r.left)),
    canvasY: Math.max(0, Math.round(r.top)),
    canvasW: Math.round(r.width),
    canvasH: Math.round(r.height),
    headerH,
    offset: readOffset(canvas),
    devicePixelRatio: window.devicePixelRatio || 1
  }
}

/** 读取当前偏移（每帧截图前用于对齐拼接）。自包含。 */
export function measureCanvasGridOffset(selector?: string): number {
  const findCanvas = (sel?: string): HTMLCanvasElement | null => {
    let best: HTMLCanvasElement | null = null
    let bestArea = 0
    if (sel) {
      try {
        const el = document.querySelector(sel)
        if (el instanceof HTMLCanvasElement) return el
        if (el) {
          el.querySelectorAll("canvas").forEach((c) => {
            const r = c.getBoundingClientRect()
            const area = r.width * r.height
            if (area > bestArea) {
              best = c
              bestArea = area
            }
          })
          if (best) return best
        }
      } catch {
        /* 回退 */
      }
    }
    best = null
    bestArea = 0
    document.querySelectorAll("canvas").forEach((c) => {
      const r = c.getBoundingClientRect()
      if (r.width < 400 || r.height < 200) return
      const inGrid =
        c.closest(".faster-view") ||
        c.closest('[class*="bitable"]') ||
        c.closest('[class*="grid"]')
      if (!inGrid) return
      const area = r.width * r.height
      if (area > bestArea) {
        best = c
        bestArea = area
      }
    })
    return best
  }
  const canvas = findCanvas(selector)
  if (!canvas) return 0
  const view =
    (canvas.closest(".faster-view") as HTMLElement | null) ||
    canvas.parentElement
  if (!view) return 0
  let min = 0
  view.querySelectorAll<HTMLElement>("div").forEach((el) => {
    const t = parseFloat(getComputedStyle(el).top)
    if (!isNaN(t) && t < min) min = t
  })
  return -min
}

/**
 * 滚动到目标偏移（CSS 像素）。通过多次 wheel 逼近，返回实际到达的偏移。
 * 到达阈值内或连续 stall 即停（视为触底 / 无法再滚）。自包含。
 */
export async function scrollCanvasGridTo(
  targetOffset: number,
  selector?: string
): Promise<number> {
  const findCanvas = (sel?: string): HTMLCanvasElement | null => {
    let best: HTMLCanvasElement | null = null
    let bestArea = 0
    if (sel) {
      try {
        const el = document.querySelector(sel)
        if (el instanceof HTMLCanvasElement) return el
        if (el) {
          el.querySelectorAll("canvas").forEach((c) => {
            const r = c.getBoundingClientRect()
            const area = r.width * r.height
            if (area > bestArea) {
              best = c
              bestArea = area
            }
          })
          if (best) return best
        }
      } catch {
        /* 回退 */
      }
    }
    best = null
    bestArea = 0
    document.querySelectorAll("canvas").forEach((c) => {
      const r = c.getBoundingClientRect()
      if (r.width < 400 || r.height < 200) return
      const inGrid =
        c.closest(".faster-view") ||
        c.closest('[class*="bitable"]') ||
        c.closest('[class*="grid"]')
      if (!inGrid) return
      const area = r.width * r.height
      if (area > bestArea) {
        best = c
        bestArea = area
      }
    })
    return best
  }
  const readOffset = (canvas: HTMLCanvasElement): number => {
    const view =
      (canvas.closest(".faster-view") as HTMLElement | null) ||
      canvas.parentElement
    if (!view) return 0
    let min = 0
    view.querySelectorAll<HTMLElement>("div").forEach((el) => {
      const t = parseFloat(getComputedStyle(el).top)
      if (!isNaN(t) && t < min) min = t
    })
    return -min
  }
  const wheel = (canvas: HTMLCanvasElement, deltaY: number) => {
    const r = canvas.getBoundingClientRect()
    canvas.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY,
        deltaMode: 0,
        clientX: r.left + r.width / 2,
        clientY: r.top + r.height / 2,
        bubbles: true,
        cancelable: true
      })
    )
  }
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  const canvas = findCanvas(selector)
  if (!canvas) return 0
  let stall = 0
  for (let i = 0; i < 200; i++) {
    const cur = readOffset(canvas)
    const diff = targetOffset - cur
    if (Math.abs(diff) <= 2) break
    const step = diff > 0 ? Math.min(600, diff + 40) : Math.max(-600, diff - 40)
    wheel(canvas, step)
    await sleep(55)
    const now = readOffset(canvas)
    if (now === cur) {
      if (++stall >= 5) break
    } else stall = 0
  }
  return readOffset(canvas)
}

/** 移除冻结样式（截完还原）。自包含。 */
export function restoreCanvasGrid(): void {
  document.getElementById("__my_screenshot_canvasgrid_freeze__")?.remove()
}
