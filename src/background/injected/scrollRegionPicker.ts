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

    const isScrollable = (el: HTMLElement) => {
      const cs = getComputedStyle(el)
      const oy = cs.overflowY
      return (
        (oy === "auto" || oy === "scroll") &&
        el.scrollHeight > el.clientHeight + 4 &&
        el.clientHeight > 0
      )
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
    root.appendChild(tip)
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
      tip.firstChild && (tip.firstChild.textContent = `选择: ${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""} ${Math.round(el.scrollHeight - el.clientHeight)}px 可滚动，点击确认，Esc 取消`)
    }

    const findCandidateFromPoint = (x: number, y: number) => {
      const hits = candidates.filter((el) => {
        const rect = el.getBoundingClientRect()
        return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
      })
      if (hits.length === 0) return null
      // 取面积最小者，便于在嵌套滚动容器中选择更具体的主体区域
      hits.sort((a, b) => {
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
        frameUrl: location.href
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
