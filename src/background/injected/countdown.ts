/**
 * 倒计时浮窗：在页面上下文中执行的注入函数
 *
 * - 在右上角渲染一个倒计时圆环 + 取消按钮
 * - 返回 Promise<"done" | "cancel">
 *   - "done"   倒计时自然结束
 *   - "cancel" 用户点击取消按钮，或按 Esc
 *
 * 与 selection.ts 一样：必须自包含、不引用外部模块。
 */

export type CountdownResult = "done" | "cancel"

export function showCountdown(seconds: number): Promise<CountdownResult> {
  return new Promise((resolve) => {
    const Z = 2147483647
    const total = Math.max(1, Math.round(seconds))

    /* ---------- 容器 ---------- */
    const root = document.createElement("div")
    root.setAttribute("data-my-screenshot-countdown", "1")
    Object.assign(root.style, {
      position: "fixed",
      top: "16px",
      right: "16px",
      zIndex: String(Z),
      width: "104px",
      padding: "14px 12px 12px",
      background: "rgba(255, 255, 255, 0.98)",
      borderRadius: "10px",
      boxShadow: "0 6px 20px rgba(0, 0, 0, 0.18)",
      fontFamily: "system-ui, -apple-system, 'PingFang SC', sans-serif",
      color: "#2c3e50",
      textAlign: "center",
      userSelect: "none"
    } satisfies Partial<CSSStyleDeclaration>)

    /* ---------- 圆环（SVG） ---------- */
    const SIZE = 64
    const R = 26
    const C = 2 * Math.PI * R

    const svgNS = "http://www.w3.org/2000/svg"
    const svg = document.createElementNS(svgNS, "svg")
    svg.setAttribute("width", String(SIZE))
    svg.setAttribute("height", String(SIZE))
    svg.setAttribute("viewBox", `0 0 ${SIZE} ${SIZE}`)
    svg.style.display = "block"
    svg.style.margin = "0 auto"

    // 背景圆
    const bg = document.createElementNS(svgNS, "circle")
    bg.setAttribute("cx", String(SIZE / 2))
    bg.setAttribute("cy", String(SIZE / 2))
    bg.setAttribute("r", String(R))
    bg.setAttribute("fill", "none")
    bg.setAttribute("stroke", "#eef0f3")
    bg.setAttribute("stroke-width", "4")
    svg.appendChild(bg)

    // 进度圆（顺时针，从顶部开始）
    const fg = document.createElementNS(svgNS, "circle")
    fg.setAttribute("cx", String(SIZE / 2))
    fg.setAttribute("cy", String(SIZE / 2))
    fg.setAttribute("r", String(R))
    fg.setAttribute("fill", "none")
    fg.setAttribute("stroke", "#4a90e2")
    fg.setAttribute("stroke-width", "4")
    fg.setAttribute("stroke-linecap", "round")
    fg.setAttribute("stroke-dasharray", String(C))
    fg.setAttribute("stroke-dashoffset", "0")
    fg.setAttribute(
      "transform",
      `rotate(-90 ${SIZE / 2} ${SIZE / 2})`
    )
    fg.style.transition = "stroke-dashoffset 0.1s linear"
    svg.appendChild(fg)

    // 数字
    const num = document.createElementNS(svgNS, "text")
    num.setAttribute("x", "50%")
    num.setAttribute("y", "50%")
    num.setAttribute("text-anchor", "middle")
    num.setAttribute("dominant-baseline", "central")
    num.setAttribute("font-size", "20")
    num.setAttribute("font-weight", "600")
    num.setAttribute("fill", "#2c3e50")
    num.textContent = String(total)
    svg.appendChild(num)

    /* ---------- 取消按钮 ---------- */
    const btn = document.createElement("button")
    btn.type = "button"
    btn.textContent = "Cancel"
    Object.assign(btn.style, {
      marginTop: "10px",
      width: "100%",
      padding: "6px 0",
      background: "#f5f7fa",
      border: "none",
      borderRadius: "6px",
      fontSize: "12px",
      color: "#2c3e50",
      cursor: "pointer",
      fontFamily: "inherit"
    } satisfies Partial<CSSStyleDeclaration>)
    btn.addEventListener("mouseenter", () => {
      btn.style.background = "#eaf2ff"
    })
    btn.addEventListener("mouseleave", () => {
      btn.style.background = "#f5f7fa"
    })

    root.appendChild(svg)
    root.appendChild(btn)
    document.documentElement.appendChild(root)

    /* ---------- 倒计时逻辑 ---------- */
    const startedAt = performance.now()
    const durationMs = total * 1000
    let rafId = 0
    let finished = false

    const tick = () => {
      if (finished) return
      const elapsed = performance.now() - startedAt
      const remaining = Math.max(0, durationMs - elapsed)
      const remainSec = Math.ceil(remaining / 1000)
      num.textContent = String(remainSec)

      const progress = Math.min(1, elapsed / durationMs)
      fg.setAttribute("stroke-dashoffset", String(C * progress))

      if (remaining <= 0) {
        finish("done")
        return
      }
      rafId = requestAnimationFrame(tick)
    }

    const finish = (result: CountdownResult) => {
      if (finished) return
      finished = true
      cancelAnimationFrame(rafId)
      btn.removeEventListener("click", onCancel)
      window.removeEventListener("keydown", onKey, true)
      root.remove()
      resolve(result)
    }

    const onCancel = () => finish("cancel")
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation()
        e.preventDefault()
        finish("cancel")
      }
    }

    btn.addEventListener("click", onCancel)
    window.addEventListener("keydown", onKey, true)
    rafId = requestAnimationFrame(tick)
  })
}
