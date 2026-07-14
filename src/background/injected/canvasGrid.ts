/**
 * 虚拟化 canvas 表格滚动区兼容。支持两类机制：
 *  1. faster（飞书多维表格）：wheel 驱动，`.faster-view` 覆盖层负 top 反映偏移。
 *  2. handle（网易灵犀 / SpreadJS 等）：忽略合成 wheel，只能拖动自定义滚动条把手
 *     （类名含 scroll-handle / scroll-thumb）。把手在轨道中的比例即滚动比例，
 *     据此换算出内容像素偏移。
 *
 * 关键：SpreadJS 会把拖动位移按自身比例缩放并按行吸附，无法「一次拖到目标」，
 * 目标寻址式闭环会来回抖动且久拖不停。故对外只提供「单调向下步进」与「回到顶部」，
 * 每帧只做一次短拖动，偏移用把手比例实测，天然单调、可随时被外层中止。
 *
 * 注入 executeScript 到【目标 frame】执行，必须完全自包含（不引用模块作用域符号）。
 */

export interface CanvasGridMetrics {
  found: boolean
  /** canvas 在【所在 frame】视口中的 CSS 位置/尺寸（跨 frame 时调用方叠加 frame 偏移） */
  canvasX: number
  canvasY: number
  canvasW: number
  canvasH: number
  headerH: number
  /** 当前滚动偏移（内容 CSS 像素，0=顶部） */
  offset: number
  /** 内容总高度（CSS 像素，估算） */
  totalHeight: number
  scrollMode: "faster" | "handle" | "none"
  devicePixelRatio: number
}

export interface CanvasGridStep {
  offset: number
  atBottom: boolean
}

/** 定位主 canvas（selector 优先，否则取最大者）。自包含。 */
export async function prepareCanvasGrid(
  selector?: string
): Promise<CanvasGridMetrics> {
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
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
            const a = r.width * r.height
            if (a > bestArea) {
              best = c
              bestArea = a
            }
          })
          if (best) return best
        }
      } catch {
        /* ignore */
      }
    }
    best = null
    bestArea = 0
    document.querySelectorAll("canvas").forEach((c) => {
      const r = c.getBoundingClientRect()
      if (r.width < 300 || r.height < 150) return
      const a = r.width * r.height
      if (a > bestArea) {
        best = c
        bestArea = a
      }
    })
    return best
  }
  const empty: CanvasGridMetrics = {
    found: false,
    canvasX: 0,
    canvasY: 0,
    canvasW: 0,
    canvasH: 0,
    headerH: 0,
    offset: 0,
    totalHeight: 0,
    scrollMode: "none",
    devicePixelRatio: window.devicePixelRatio || 1
  }
  const canvas = findCanvas(selector)
  if (!canvas) return empty

  let vHandle: HTMLElement | null = null
  let vTrack: HTMLElement | null = null
  for (const h of Array.from(
    document.querySelectorAll<HTMLElement>(
      '[class*="scroll-handle"],[class*="scroll-thumb"]'
    )
  )) {
    const tr = h.parentElement
    if (!tr) continue
    const trr = tr.getBoundingClientRect()
    const hr = h.getBoundingClientRect()
    if (
      trr.height > trr.width &&
      trr.height > 50 &&
      hr.height > 4 &&
      hr.width < 40
    ) {
      vHandle = h
      vTrack = tr
      break
    }
  }
  const mode: "faster" | "handle" | "none" = vHandle
    ? "handle"
    : canvas.closest(".faster-view")
      ? "faster"
      : "none"
  if (mode === "none") return empty

  const FREEZE_ID = "__my_screenshot_canvasgrid_freeze__"
  if (!document.getElementById(FREEZE_ID)) {
    const s = document.createElement("style")
    s.id = FREEZE_ID
    s.textContent =
      "*,*::before,*::after{transition:none !important;animation:none !important;}"
    ;(document.head || document.documentElement).appendChild(s)
  }

  const crect = () => canvas.getBoundingClientRect()
  const fireMouse = (
    el: EventTarget,
    type: string,
    x: number,
    y: number,
    btn: number
  ) =>
    el.dispatchEvent(
      new MouseEvent(type, {
        clientX: x,
        clientY: y,
        button: 0,
        buttons: btn,
        bubbles: true,
        cancelable: true
      })
    )
  const wheel = (dy: number) => {
    const r = crect()
    canvas.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY: dy,
        deltaMode: 0,
        clientX: r.left + r.width / 2,
        clientY: r.top + r.height / 2,
        bubbles: true,
        cancelable: true
      })
    )
  }
  const handleTop = () => {
    if (!vHandle || !vTrack) return 0
    return (
      vHandle.getBoundingClientRect().top - vTrack.getBoundingClientRect().top
    )
  }
  const fasterOffset = () => {
    const v =
      (canvas.closest(".faster-view") as HTMLElement | null) ||
      canvas.parentElement
    if (!v) return 0
    let min = 0
    v.querySelectorAll<HTMLElement>("div").forEach((el) => {
      const t = parseFloat(getComputedStyle(el).top)
      if (!isNaN(t) && t < min) min = t
    })
    return -min
  }
  const dragBy = async (dy: number) => {
    if (!vHandle) return
    const hr = vHandle.getBoundingClientRect()
    const sx = hr.left + hr.width / 2
    const sy = hr.top + hr.height / 2
    fireMouse(vHandle, "mousedown", sx, sy, 1)
    const N = 6
    for (let k = 1; k <= N; k++) {
      fireMouse(document, "mousemove", sx, sy + (dy * k) / N, 1)
      await sleep(16)
    }
    fireMouse(document, "mouseup", sx, sy + dy, 0)
    await sleep(90)
  }

  // 回到顶部（单调向上，直到到顶或 stall）
  let stall = 0
  for (let i = 0; i < 60; i++) {
    const before = mode === "handle" ? handleTop() : fasterOffset()
    if (before <= 1) break
    if (mode === "handle") await dragBy(-400)
    else {
      wheel(-800)
      await sleep(50)
    }
    const after = mode === "handle" ? handleTop() : fasterOffset()
    if (Math.abs(after - before) < 0.5) {
      if (++stall >= 4) break
    } else stall = 0
  }
  await sleep(120)

  const r = crect()
  const cH = r.height
  let totalHeight = cH
  if (mode === "handle" && vHandle && vTrack) {
    const hr = vHandle.getBoundingClientRect()
    const tr = vTrack.getBoundingClientRect()
    totalHeight = hr.height > 0 ? (cH * tr.height) / hr.height : cH
  }
  return {
    found: true,
    canvasX: Math.max(0, Math.round(r.left)),
    canvasY: Math.max(0, Math.round(r.top)),
    canvasW: Math.round(r.width),
    canvasH: Math.round(cH),
    headerH: 0,
    offset: 0,
    totalHeight: Math.round(totalHeight),
    scrollMode: mode,
    devicePixelRatio: window.devicePixelRatio || 1
  }
}

/** 读取当前偏移（内容 CSS 像素）。自包含。 */
export function measureCanvasGridOffset(selector?: string): number {
  const findCanvas = (sel?: string): HTMLCanvasElement | null => {
    let best: HTMLCanvasElement | null = null
    let bestArea = 0
    document.querySelectorAll("canvas").forEach((c) => {
      const r = c.getBoundingClientRect()
      if (r.width < 300 || r.height < 150) return
      const a = r.width * r.height
      if (a > bestArea) {
        best = c
        bestArea = a
      }
    })
    if (sel) {
      try {
        const el = document.querySelector(sel)
        if (el instanceof HTMLCanvasElement) return el
      } catch {
        /* ignore */
      }
    }
    return best
  }
  const canvas = findCanvas(selector)
  if (!canvas) return 0
  let vHandle: HTMLElement | null = null
  let vTrack: HTMLElement | null = null
  for (const h of Array.from(
    document.querySelectorAll<HTMLElement>(
      '[class*="scroll-handle"],[class*="scroll-thumb"]'
    )
  )) {
    const tr = h.parentElement
    if (!tr) continue
    const trr = tr.getBoundingClientRect()
    const hr = h.getBoundingClientRect()
    if (
      trr.height > trr.width &&
      trr.height > 50 &&
      hr.height > 4 &&
      hr.width < 40
    ) {
      vHandle = h
      vTrack = tr
      break
    }
  }
  const cH = canvas.getBoundingClientRect().height
  if (vHandle && vTrack) {
    const hr = vHandle.getBoundingClientRect()
    const tr = vTrack.getBoundingClientRect()
    const range = tr.height - hr.height
    if (range <= 0) return 0
    const frac = (hr.top - tr.top) / range
    const total = hr.height > 0 ? (cH * tr.height) / hr.height : cH
    return Math.round(frac * Math.max(0, total - cH))
  }
  const v =
    (canvas.closest(".faster-view") as HTMLElement | null) ||
    canvas.parentElement
  if (!v) return 0
  let min = 0
  v.querySelectorAll<HTMLElement>("div").forEach((el) => {
    const t = parseFloat(getComputedStyle(el).top)
    if (!isNaN(t) && t < min) min = t
  })
  return -min
}

/**
 * 向下步进一屏（单调）。返回步进后的内容偏移与是否到底。
 * 只做一次短滚动，绝不做目标寻址，避免 SpreadJS 拖动缩放/吸附导致的抖动，
 * 且每帧快速返回，外层可及时响应「强制停止」。
 */
export async function scrollCanvasGridStepDown(
  selector?: string
): Promise<CanvasGridStep> {
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
  const findCanvas = (sel?: string): HTMLCanvasElement | null => {
    let best: HTMLCanvasElement | null = null
    let bestArea = 0
    if (sel) {
      try {
        const el = document.querySelector(sel)
        if (el instanceof HTMLCanvasElement) return el
      } catch {
        /* ignore */
      }
    }
    document.querySelectorAll("canvas").forEach((c) => {
      const r = c.getBoundingClientRect()
      if (r.width < 300 || r.height < 150) return
      const a = r.width * r.height
      if (a > bestArea) {
        best = c
        bestArea = a
      }
    })
    return best
  }
  const canvas = findCanvas(selector)
  if (!canvas) return { offset: 0, atBottom: true }
  let vHandle: HTMLElement | null = null
  let vTrack: HTMLElement | null = null
  for (const h of Array.from(
    document.querySelectorAll<HTMLElement>(
      '[class*="scroll-handle"],[class*="scroll-thumb"]'
    )
  )) {
    const tr = h.parentElement
    if (!tr) continue
    const trr = tr.getBoundingClientRect()
    const hr = h.getBoundingClientRect()
    if (
      trr.height > trr.width &&
      trr.height > 50 &&
      hr.height > 4 &&
      hr.width < 40
    ) {
      vHandle = h
      vTrack = tr
      break
    }
  }
  const crect = () => canvas.getBoundingClientRect()
  const cH = crect().height
  const totalH = () => {
    if (vHandle && vTrack) {
      const hr = vHandle.getBoundingClientRect()
      const tr = vTrack.getBoundingClientRect()
      return hr.height > 0 ? (cH * tr.height) / hr.height : cH
    }
    return cH
  }
  const fasterOffset = () => {
    const v =
      (canvas.closest(".faster-view") as HTMLElement | null) ||
      canvas.parentElement
    if (!v) return 0
    let min = 0
    v.querySelectorAll<HTMLElement>("div").forEach((el) => {
      const t = parseFloat(getComputedStyle(el).top)
      if (!isNaN(t) && t < min) min = t
    })
    return -min
  }
  const offsetPx = () => {
    if (vHandle && vTrack) {
      const hr = vHandle.getBoundingClientRect()
      const tr = vTrack.getBoundingClientRect()
      const range = tr.height - hr.height
      if (range <= 0) return 0
      const frac = (hr.top - tr.top) / range
      return frac * Math.max(0, totalH() - cH)
    }
    return fasterOffset()
  }

  const before = offsetPx()
  // 目标推进约「一屏减去 ~10% 重叠」
  const advance = Math.max(40, cH * 0.9)

  if (vHandle && vTrack) {
    const fireMouse = (
      el: EventTarget,
      type: string,
      x: number,
      y: number,
      btn: number
    ) =>
      el.dispatchEvent(
        new MouseEvent(type, {
          clientX: x,
          clientY: y,
          button: 0,
          buttons: btn,
          bubbles: true,
          cancelable: true
        })
      )
    const dragBy = async (dy: number) => {
      const hr = vHandle!.getBoundingClientRect()
      const sx = hr.left + hr.width / 2
      const sy = hr.top + hr.height / 2
      fireMouse(vHandle!, "mousedown", sx, sy, 1)
      const N = 6
      for (let k = 1; k <= N; k++) {
        fireMouse(document, "mousemove", sx, sy + (dy * k) / N, 1)
        await sleep(16)
      }
      fireMouse(document, "mouseup", sx, sy + dy, 0)
      await sleep(90)
    }
    // 拖动量→内容位移非线性，闭环逼近「本帧目标推进」，但最多几次、单方向，不回退。
    let guard = 0
    while (offsetPx() < before + advance - 4 && guard < 8) {
      const remain = before + advance - offsetPx()
      // 经验系数：拖动位移约需 内容位移/3 ~ /4；给足并夹紧，避免过冲。
      const dragPx = Math.max(30, Math.min(360, remain / 3))
      const hBefore = vHandle.getBoundingClientRect().top
      await dragBy(dragPx)
      if (Math.abs(vHandle.getBoundingClientRect().top - hBefore) < 0.5) break
      guard++
    }
  } else {
    const wheel = (dy: number) => {
      const r = crect()
      canvas.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: dy,
          deltaMode: 0,
          clientX: r.left + r.width / 2,
          clientY: r.top + r.height / 2,
          bubbles: true,
          cancelable: true
        })
      )
    }
    let guard = 0
    while (offsetPx() < before + advance - 4 && guard < 12) {
      wheel(400)
      await sleep(50)
      guard++
    }
  }

  const after = offsetPx()
  return { offset: Math.round(after), atBottom: after <= before + 2 }
}

/** 移除冻结样式（截完还原）。 */
export function restoreCanvasGrid(): void {
  document.getElementById("__my_screenshot_canvasgrid_freeze__")?.remove()
}
