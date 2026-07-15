/**
 * 选区截图 / 选区录制：在页面上下文中执行的辅助函数
 *
 * 注入一层全屏遮罩，让用户拖拽选择矩形。
 * 通过 Promise 返回 { x, y, width, height } 或 null（用户取消）。
 *
 * 必须自包含：函数体内不引用模块顶层变量、helper，因为 chrome.scripting
 * .executeScript({ func }) 只把函数体本身序列化注入。
 */

export interface SelectionResult {
  x: number
  y: number
  width: number
  height: number
  devicePixelRatio: number
  /** 选区时页面视口尺寸（CSS 像素）。区域录制裁剪按「选区/视口」比例映射到实际
   *  捕获帧尺寸，避免 tabCapture 帧分辨率与 dpr 假设不一致导致的错位。 */
  viewportWidth?: number
  viewportHeight?: number
}

export interface PickSelectionArgs {
  /**
   * true：松手后**保留**一个红色细边框 div 留在页面上（录制模式）；
   * false：松手后所有覆盖物全部移除（截图模式）。
   */
  keepFrameAfterPick: boolean
}

/** 注入到目标 tab 执行的选区交互（自包含）。 */
export function pickSelection(
  args: PickSelectionArgs
): Promise<SelectionResult | null> {
  return new Promise((resolve) => {
    const Z = 2147483647

    // 容器
    const root = document.createElement("div")
    root.setAttribute("data-my-screenshot-overlay", "1")
    Object.assign(root.style, {
      position: "fixed",
      inset: "0",
      zIndex: String(Z),
      cursor: "crosshair",
      userSelect: "none",
      background: "rgba(0, 0, 0, 0.25)"
    } satisfies Partial<CSSStyleDeclaration>)

    // 选区矩形
    const box = document.createElement("div")
    Object.assign(box.style, {
      position: "absolute",
      left: "0",
      top: "0",
      width: "0",
      height: "0",
      border: "1.5px solid #4a90e2",
      background: "rgba(74, 144, 226, 0.15)",
      boxShadow: "0 0 0 100vmax rgba(0, 0, 0, 0.0)",
      display: "none",
      pointerEvents: "none"
    } satisfies Partial<CSSStyleDeclaration>)

    // 提示
    const tip = document.createElement("div")
    tip.textContent = args.keepFrameAfterPick
      ? "拖拽选择录制区域，松手开始录制；按 Esc 取消"
      : "拖拽选择截图区域，按 Esc 取消"
    Object.assign(tip.style, {
      position: "absolute",
      top: "16px",
      left: "50%",
      transform: "translateX(-50%)",
      padding: "6px 12px",
      borderRadius: "4px",
      background: "rgba(0, 0, 0, 0.7)",
      color: "#fff",
      fontSize: "12px",
      fontFamily: "system-ui, sans-serif",
      pointerEvents: "none"
    } satisfies Partial<CSSStyleDeclaration>)

    root.appendChild(box)
    root.appendChild(tip)
    document.documentElement.appendChild(root)

    let startX = 0
    let startY = 0
    let dragging = false
    let rect: SelectionResult | null = null

    const cleanup = () => {
      root.removeEventListener("mousedown", onDown)
      window.removeEventListener("mousemove", onMove)
      window.removeEventListener("mouseup", onUp)
      window.removeEventListener("keydown", onKey, true)
      root.remove()
    }

    const planLeaveFrame = (r: SelectionResult) => {
      // 录制模式：松手后留下一个红色细边框，用户能持续看到「正在录哪一块」
      const frame = document.createElement("div")
      frame.setAttribute("data-my-screenshot-region-frame", "1")
      Object.assign(frame.style, {
        position: "fixed",
        left: `${r.x}px`,
        top: `${r.y}px`,
        width: `${r.width}px`,
        height: `${r.height}px`,
        border: "2px solid #ff5252",
        boxSizing: "border-box",
        pointerEvents: "none",
        zIndex: String(Z),
        boxShadow: "0 0 0 2px rgba(255, 82, 82, 0.3)"
      } satisfies Partial<CSSStyleDeclaration>)
      document.documentElement.appendChild(frame)
    }

    const finish = (result: SelectionResult | null) => {
      cleanup()
      if (result && args.keepFrameAfterPick) {
        planLeaveFrame(result)
      }
      resolve(result)
    }

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return
      dragging = true
      startX = e.clientX
      startY = e.clientY
      Object.assign(box.style, {
        left: `${startX}px`,
        top: `${startY}px`,
        width: "0",
        height: "0",
        display: "block"
      })
      tip.style.display = "none"
      e.preventDefault()
    }

    const onMove = (e: MouseEvent) => {
      if (!dragging) return
      const x = Math.min(startX, e.clientX)
      const y = Math.min(startY, e.clientY)
      const w = Math.abs(e.clientX - startX)
      const h = Math.abs(e.clientY - startY)
      Object.assign(box.style, {
        left: `${x}px`,
        top: `${y}px`,
        width: `${w}px`,
        height: `${h}px`
      })
      rect = {
        x,
        y,
        width: w,
        height: h,
        devicePixelRatio: window.devicePixelRatio || 1,
        // 用 innerWidth/innerHeight（含滚动条区域）而非 clientWidth/clientHeight：
        // tabCapture 捕获的是完整内视口、选区 clientX/Y 也相对完整内视口。用
        // clientWidth（去掉了竖直滚动条宽度）会使缩放系数偏大并引入错误居中偏移，
        // 导致裁剪整体右/下溢出边界。
        viewportWidth: window.innerWidth || document.documentElement.clientWidth,
        viewportHeight:
          window.innerHeight || document.documentElement.clientHeight
      }
    }

    const onUp = (e: MouseEvent) => {
      if (!dragging) return
      dragging = false
      if (!rect || rect.width < 3 || rect.height < 3) {
        finish(null)
        return
      }
      finish(rect)
      e.preventDefault()
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation()
        e.preventDefault()
        finish(null)
      }
    }

    root.addEventListener("mousedown", onDown)
    window.addEventListener("mousemove", onMove)
    window.addEventListener("mouseup", onUp)
    window.addEventListener("keydown", onKey, true)
  })
}

/**
 * 在指定坐标画一个红色边框（录制模式跨页面跳转后由 background 调用恢复）。
 */
export function injectRegionFrame(rect: SelectionResult): void {
  document
    .querySelectorAll("[data-my-screenshot-region-frame]")
    .forEach((el) => el.remove())

  const Z = 2147483647
  const frame = document.createElement("div")
  frame.setAttribute("data-my-screenshot-region-frame", "1")
  Object.assign(frame.style, {
    position: "fixed",
    left: `${rect.x}px`,
    top: `${rect.y}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    border: "2px solid #ff5252",
    boxSizing: "border-box",
    pointerEvents: "none",
    zIndex: String(Z),
    boxShadow: "0 0 0 2px rgba(255, 82, 82, 0.3)"
  } satisfies Partial<CSSStyleDeclaration>)
  document.documentElement.appendChild(frame)
}

/** 移除录制区域边框（录制结束时由 background 调用） */
export function removeRegionFrame(): void {
  document
    .querySelectorAll("[data-my-screenshot-region-frame]")
    .forEach((el) => el.remove())
}
