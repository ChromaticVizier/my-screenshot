/**
 * 手动选择整页截图的滚动区域。
 *
 * 该函数会被 chrome.scripting.executeScript 注入页面执行，必须自包含。
 *
 * 多 frame 场景：上层为每个可注入 frame 都调用一次此函数，谁先 mousedown 谁
 * 胜出。胜出 frame 自身正常返回 PickedScrollRegion；其它 frame 通过 window
 * 上挂的 `__myScreenshotScrollRegionAbort` 标记被 background 调用 abort 函数
 * 拆掉遮罩并 resolve(null)。
 */
export interface PickedScrollRegion {
  selector: string
  label: string
  tag: string
  id: string
  className: string
  rect: { top: number; left: number; width: number; height: number }
  scrollHeight: number
  clientHeight: number
  /** 选取时所在 frame 的 location.href；background 用它定位 frameId */
  frameUrl: string
  /** 选中的是虚拟化 canvas 表格（无原生滚动，wheel 驱动）；截图走 canvas grid 流程 */
  canvasGrid?: boolean
}

/**
 * 让正在等待用户点击的 picker 主动结束（resolve(null)）。
 * background 会在某个 frame 已胜出后，向其它 frame 注入此函数清场。
 */
export function abortScrollRegionPicker(): void {
  const w = window as unknown as { __myScreenshotScrollRegionAbort?: () => void }
  try {
    w.__myScreenshotScrollRegionAbort?.()
  } catch {
    /* ignore */
  }
}

export function pickScrollRegion(): Promise<PickedScrollRegion | null> {
  return new Promise((resolve) => {
    const ROOT_ID = "__myScreenshotScrollRegionPicker"
    const old = document.getElementById(ROOT_ID)
    if (old) old.remove()

    const cleanupFns: Array<() => void> = []
    let done = false

    const finish = (value: PickedScrollRegion | null) => {
      if (done) return
      done = true
      try {
        delete (window as unknown as Record<string, unknown>)[
          "__myScreenshotScrollRegionAbort"
        ]
      } catch {
        /* ignore */
      }
      cleanupFns.forEach((fn) => {
        try {
          fn()
        } catch {
          // ignore
        }
      })
      try {
        root.remove()
      } catch {
        // root 可能还没建好（early return 路径），忽略
      }
      resolve(value)
    }

    // 暴露给 background：其它 frame 胜出时通过 abortScrollRegionPicker 调用，
    // 让本 frame 的 picker 安静退场。
    ;(window as unknown as Record<string, unknown>)[
      "__myScreenshotScrollRegionAbort"
    ] = () => finish(null)

    const cssEscape = (value: string) => {
      const css = (window as unknown as { CSS?: { escape?: (v: string) => string } }).CSS
      if (css?.escape) return css.escape(value)
      return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`)
    }

    const uniqueSelector = (el: HTMLElement): string => {
      if (el.id) {
        const sel = `#${cssEscape(el.id)}`
        try {
          if (document.querySelectorAll(sel).length === 1) return sel
        } catch {
          // ignore
        }
      }

      const parts: string[] = []
      let cur: HTMLElement | null = el
      while (cur && cur !== document.documentElement && parts.length < 6) {
        let part = cur.tagName.toLowerCase()
        const classList = Array.from(cur.classList)
          .filter((c) => c && !/^(active|selected|hover|focus|open|show|hide)$/.test(c))
          .slice(0, 3)
        if (classList.length > 0) {
          part += classList.map((c) => `.${cssEscape(c)}`).join("")
        }
        const parent = cur.parentElement
        if (parent) {
          const sameTag = Array.from(parent.children).filter(
            (node) => (node as HTMLElement).tagName === cur!.tagName
          )
          if (sameTag.length > 1) {
            const index = sameTag.indexOf(cur) + 1
            part += `:nth-of-type(${index})`
          }
        }
        parts.unshift(part)
        const sel = parts.join(" > ")
        try {
          if (document.querySelectorAll(sel).length === 1) return sel
        } catch {
          // ignore
        }
        cur = parent
      }
      return parts.join(" > ")
    }

    // 虚拟化 canvas 表格（飞书多维表格 / 电子表格等）：内容画在 <canvas> 上，
    // 无原生 overflow 滚动（scrollHeight==clientHeight），靠 wheel 驱动虚拟滚动。
    // 这类大 canvas 也应可被选为滚动区，截图时交给 canvas grid 专用流程。
    const isVirtualCanvas = (el: HTMLElement) => {
      if (el.tagName !== "CANVAS") return false
      const rect = el.getBoundingClientRect()
      return rect.width >= 300 && rect.height >= 150
    }

    const isScrollable = (el: HTMLElement) => {
      if (isVirtualCanvas(el)) return true
      const cs = getComputedStyle(el)
      const oy = cs.overflowY
      // 关键：overflow:hidden / clip 的元素同样能被 JS（scrollTop）滚动，只是没滚动条。
      // 网易系页面（如慕课 div.g-body）常用「固定高度 + overflow:hidden」做主滚动视口，
      // 真正可滚的是它而非 overflow:auto 的 body。只有 visible 永不裁剪、不可滚，需排除。
      if (oy === "visible") return false
      return el.scrollHeight > el.clientHeight + 4 && el.clientHeight > 0
    }

    const candidates = Array.from(document.querySelectorAll<HTMLElement>("*"))
      .filter(isScrollable)
      .filter((el) => {
        const rect = el.getBoundingClientRect()
        return rect.width > 20 && rect.height > 20 && rect.bottom > 0 && rect.right > 0
      })

    if (candidates.length === 0) {
      // 多 frame 模式下不弹 alert（每个 frame 都注入了 picker，没有候选的 frame
      // 直接安静返回 null，让用户在另一个 frame 里框选）。
      finish(null)
      return
    }

    const root = document.createElement("div")
    root.id = ROOT_ID
    root.style.cssText = [
      "position:fixed",
      "inset:0",
      "z-index:2147483647",
      "pointer-events:none",
      "font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif"
    ].join(";")

    const shade = document.createElement("div")
    shade.style.cssText = [
      "position:absolute",
      "inset:0",
      "background:rgba(0,0,0,.08)",
      "pointer-events:none"
    ].join(";")

    const box = document.createElement("div")
    box.style.cssText = [
      "position:absolute",
      "display:none",
      "border:3px solid #1677ff",
      "background:rgba(22,119,255,.12)",
      "box-shadow:0 0 0 99999px rgba(0,0,0,.15)",
      "border-radius:6px",
      "pointer-events:none",
      "box-sizing:border-box"
    ].join(";")

    const tip = document.createElement("div")
    tip.textContent = "移动鼠标选择滚动区域，点击确认，Esc 取消"
    tip.style.cssText = [
      "position:absolute",
      "left:16px",
      "top:16px",
      "padding:8px 12px",
      "border-radius:8px",
      "background:#111827",
      "color:#fff",
      "font-size:13px",
      "line-height:1.4",
      "box-shadow:0 6px 20px rgba(0,0,0,.2)",
      "pointer-events:auto"
    ].join(";")

    const cancel = document.createElement("button")
    cancel.type = "button"
    cancel.textContent = "取消"
    cancel.style.cssText = [
      "margin-left:10px",
      "padding:2px 8px",
      "border-radius:4px",
      "background:#fff",
      "color:#111827",
      "font-size:12px",
      "cursor:pointer"
    ].join(";")
    tip.appendChild(cancel)

    root.appendChild(shade)
    root.appendChild(box)
    // 提示条只在顶层 frame 显示：picker 会注入到每个 frame（含 iframe），
    // 若每个 frame 各自渲染提示条会出现多个。顶层渲染一个即可，
    // 子 frame 仍保留高亮框 / 点击选择能力。
    const isTopFrame = (() => {
      try {
        return window.top === window.self
      } catch {
        return false
      }
    })()
    if (isTopFrame) root.appendChild(tip)
    document.documentElement.appendChild(root)

    let current: HTMLElement | null = null

    const updateBox = (el: HTMLElement | null) => {
      current = el
      if (!el) {
        box.style.display = "none"
        return
      }
      const rect = el.getBoundingClientRect()
      box.style.display = "block"
      box.style.left = `${Math.max(0, rect.left)}px`
      box.style.top = `${Math.max(0, rect.top)}px`
      box.style.width = `${Math.min(rect.width, window.innerWidth - Math.max(0, rect.left))}px`
      box.style.height = `${Math.min(rect.height, window.innerHeight - Math.max(0, rect.top))}px`
      tip.firstChild &&
        (tip.firstChild.textContent = isVirtualCanvas(el)
          ? `选择: ${el.tagName.toLowerCase()} 画布表格，点击确认，Esc 取消`
          : `选择: ${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""} ${Math.round(el.scrollHeight - el.clientHeight)}px 可滚动，点击确认，Esc 取消`)
    }

    const findCandidateFromPoint = (x: number, y: number) => {
      const hits = candidates.filter((el) => {
        const rect = el.getBoundingClientRect()
        return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
      })
      if (hits.length === 0) return null
      // 取面积最小者，便于在嵌套滚动容器中选择更具体的主体区域；
      // 面积相等时优先「被包含者」（更内层、更具体），避免误选外层 body 等包裹元素
      // （慕课 div.g-body 与 body 几乎等大，真正可滚的是内层 g-body）。
      hits.sort((a, b) => {
        if (a !== b && a.contains(b)) return 1
        if (a !== b && b.contains(a)) return -1
        const ar = a.getBoundingClientRect()
        const br = b.getBoundingClientRect()
        return ar.width * ar.height - br.width * br.height
      })
      return hits[0]
    }

    const onMove = (e: MouseEvent) => {
      updateBox(findCandidateFromPoint(e.clientX, e.clientY))
    }
    const onClick = (e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (!current) return
      const rect = current.getBoundingClientRect()
      const selector = uniqueSelector(current)
      const isCanvas = isVirtualCanvas(current)
      finish({
        selector,
        label: `${current.tagName.toLowerCase()}${current.id ? `#${current.id}` : ""}${current.className ? `.${String(current.className).trim().split(/\s+/).slice(0, 2).join(".")}` : ""}`,
        tag: current.tagName,
        id: current.id,
        className: String(current.className || ""),
        rect: {
          top: rect.top,
          left: rect.left,
          width: rect.width,
          height: rect.height
        },
        scrollHeight: current.scrollHeight,
        clientHeight: current.clientHeight,
        frameUrl: location.href,
        canvasGrid: isCanvas || undefined
      })
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish(null)
    }

    document.addEventListener("mousemove", onMove, true)
    document.addEventListener("click", onClick, true)
    window.addEventListener("keydown", onKey, true)
    cancel.addEventListener("click", (e) => {
      e.preventDefault()
      e.stopPropagation()
      finish(null)
    })

    cleanupFns.push(() => document.removeEventListener("mousemove", onMove, true))
    cleanupFns.push(() => document.removeEventListener("click", onClick, true))
    cleanupFns.push(() => window.removeEventListener("keydown", onKey, true))
  })
}
