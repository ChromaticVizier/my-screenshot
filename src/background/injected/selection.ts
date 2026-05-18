/**
 * 选区截图：在页面上下文中执行的辅助函数
 *
 * 注入一层全屏遮罩，让用户拖拽选择矩形。
 * 通过 Promise 返回 { x, y, width, height } 或 null（用户取消）。
 *
 * 同样必须自包含、不引用外部模块。
 */

export interface SelectionResult {
  x: number
  y: number
  width: number
  height: number
  devicePixelRatio: number
}

/** 在页面中渲染选区遮罩并等待用户操作 */
export function pickSelection(): Promise<SelectionResult | null> {
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
    tip.textContent = "拖拽选择截图区域，按 Esc 取消"
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

    const finish = (result: SelectionResult | null) => {
      cleanup()
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
        devicePixelRatio: window.devicePixelRatio || 1
      }
    }

    const onUp = (e: MouseEvent) => {
      if (!dragging) return
      dragging = false
      // 太小视为取消
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
