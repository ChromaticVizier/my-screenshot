/**
 * 选择 frame 面板。
 *
 * 注入到主 frame 后弹一个列表面板,让用户手动选要在哪个 frame 内框选滚动区。
 * 用于嵌套 iframe 的页面(企业知识库 / 在线文档 / 富文本编辑器内嵌 iframe)。
 *
 * 输入:候选 frame 列表 + frame 在主 frame viewport 中的 rect(none 表示主 frame)
 * 输出:用户选中的 frame 索引,或 null 取消
 *
 * 该函数会被 chrome.scripting.executeScript 序列化注入,必须自包含。
 */

export interface FramePickerOption {
  /** background 给的 frameId,用于回调路由 */
  frameId: number
  /** 用户可读的 url(主 frame 也填 location.href) */
  url: string
  /** 主 frame 还是 iframe */
  isMain: boolean
  /** iframe 在主 frame viewport 中的 rect;主 frame 自己填 viewport 自身 */
  rect: { left: number; top: number; width: number; height: number }
  /** 简短标题(可来自 iframe title 属性或 url path) */
  label: string
}

export function pickFrame(
  options: FramePickerOption[]
): Promise<number | null> {
  return new Promise((resolve) => {
    const ROOT_ID = "__myScreenshotFramePicker"
    const old = document.getElementById(ROOT_ID)
    if (old) old.remove()

    const cleanupFns: Array<() => void> = []
    let done = false
    const finish = (value: number | null) => {
      if (done) return
      done = true
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
        // ignore
      }
      resolve(value)
    }

    const root = document.createElement("div")
    root.id = ROOT_ID
    root.style.cssText = [
      "position:fixed",
      "inset:0",
      "z-index:2147483647",
      "background:rgba(0,0,0,.45)",
      "font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
      "color:#fff"
    ].join(";")

    // 高亮覆盖层(hover 时把对应 frame 区域罩起来)
    const overlay = document.createElement("div")
    overlay.style.cssText = [
      "position:absolute",
      "display:none",
      "border:3px solid #1677ff",
      "background:rgba(22,119,255,.12)",
      "box-shadow:0 0 0 99999px rgba(0,0,0,.15)",
      "border-radius:6px",
      "pointer-events:none",
      "transition:all .08s ease-out"
    ].join(";")
    root.appendChild(overlay)

    // 中央列表面板
    const panel = document.createElement("div")
    panel.style.cssText = [
      "position:absolute",
      "left:50%",
      "top:50%",
      "transform:translate(-50%,-50%)",
      "min-width:380px",
      "max-width:560px",
      "max-height:70vh",
      "overflow:auto",
      "background:#1f2937",
      "border-radius:12px",
      "padding:18px 18px 14px",
      "box-shadow:0 20px 60px rgba(0,0,0,.4)",
      "pointer-events:auto"
    ].join(";")

    const title = document.createElement("div")
    title.textContent = "选择要框选滚动区的 frame"
    title.style.cssText = "font-size:15px;font-weight:600;margin-bottom:4px;"
    panel.appendChild(title)

    const sub = document.createElement("div")
    sub.textContent = "鼠标移到列表项上预览,点击进入该 frame 框选;按 Esc 取消"
    sub.style.cssText = "font-size:12px;color:#9ca3af;margin-bottom:12px;"
    panel.appendChild(sub)

    const list = document.createElement("div")
    list.style.cssText = "display:flex;flex-direction:column;gap:8px;"
    panel.appendChild(list)

    options.forEach((opt) => {
      const row = document.createElement("button")
      row.type = "button"
      row.style.cssText = [
        "all:unset",
        "display:flex",
        "flex-direction:column",
        "gap:4px",
        "padding:10px 12px",
        "border-radius:8px",
        "background:#374151",
        "cursor:pointer",
        "transition:background .12s",
        "text-align:left"
      ].join(";")
      const heading = document.createElement("div")
      heading.style.cssText =
        "font-size:13px;font-weight:600;display:flex;gap:8px;align-items:center;"
      const tag = document.createElement("span")
      tag.textContent = opt.isMain ? "主页面" : "iframe"
      tag.style.cssText = [
        "display:inline-block",
        "padding:1px 6px",
        "border-radius:4px",
        "font-size:11px",
        "font-weight:500",
        opt.isMain
          ? "background:#10b981;color:#022c22"
          : "background:#3b82f6;color:#0c1734"
      ].join(";")
      heading.appendChild(tag)
      const label = document.createElement("span")
      label.textContent = opt.label || opt.url
      label.style.cssText = "color:#fff"
      heading.appendChild(label)
      row.appendChild(heading)

      const meta = document.createElement("div")
      meta.style.cssText =
        "font-size:11px;color:#9ca3af;line-height:1.4;word-break:break-all"
      meta.textContent = `${opt.url} · ${Math.round(opt.rect.width)}×${Math.round(opt.rect.height)}px`
      row.appendChild(meta)

      row.addEventListener("mouseenter", () => {
        row.style.background = "#4b5563"
        const r = opt.rect
        overlay.style.display = "block"
        overlay.style.left = `${r.left}px`
        overlay.style.top = `${r.top}px`
        overlay.style.width = `${r.width}px`
        overlay.style.height = `${r.height}px`
      })
      row.addEventListener("mouseleave", () => {
        row.style.background = "#374151"
        overlay.style.display = "none"
      })
      row.addEventListener("click", (e) => {
        e.preventDefault()
        e.stopPropagation()
        finish(opt.frameId)
      })
      list.appendChild(row)
    })

    const cancel = document.createElement("button")
    cancel.type = "button"
    cancel.textContent = "取消"
    cancel.style.cssText = [
      "all:unset",
      "margin-top:14px",
      "padding:6px 16px",
      "border-radius:6px",
      "background:#4b5563",
      "color:#fff",
      "font-size:12px",
      "cursor:pointer",
      "align-self:flex-start"
    ].join(";")
    cancel.addEventListener("click", (e) => {
      e.preventDefault()
      e.stopPropagation()
      finish(null)
    })
    panel.appendChild(cancel)

    root.appendChild(panel)
    document.documentElement.appendChild(root)

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish(null)
    }
    window.addEventListener("keydown", onKey, true)
    cleanupFns.push(() => window.removeEventListener("keydown", onKey, true))
  })
}

/**
 * 主 frame 内枚举页面里的 iframe(含 same-origin 嵌套层)。
 *
 * 返回每个 iframe 的 url(优先取 contentDocument.location.href —— iframe 加载
 * 后浏览器内部跳转会让 src 与真实 url 不一致;只有 same-origin 才能读
 * contentDocument)和它在主 frame viewport 中的累计 rect。
 *
 * 跨域子 iframe 无法递归,只能拿 src 和直接 rect。
 *
 * background 用返回的 url 与 chrome.webNavigation.getAllFrames 报告的 frame.url
 * 做匹配。匹配不上时,frame 仍然会出现在选择面板中(没有 rect 预览,但用户可
 * 凭 url 盲选)。
 */
export function listFramesInPage(): Array<{
  url: string
  title: string
  rect: { left: number; top: number; width: number; height: number }
}> {
  const result: Array<{
    url: string
    title: string
    rect: { left: number; top: number; width: number; height: number }
  }> = []

  /**
   * 在 frameDoc 里找所有 iframe,把每个 iframe 在「主 frame viewport」中的 rect
   * 累加偏移记录下来,然后递归进入 same-origin 子 iframe。
   */
  const visit = (
    doc: Document,
    offsetX: number,
    offsetY: number
  ) => {
    let iframes: HTMLIFrameElement[]
    try {
      iframes = Array.from(doc.querySelectorAll<HTMLIFrameElement>("iframe"))
    } catch {
      return
    }
    iframes.forEach((f) => {
      let r: DOMRect
      try {
        r = f.getBoundingClientRect()
      } catch {
        return
      }
      // 当前 iframe 元素在主 frame viewport 中的 left/top = 累计 offset + 局部 rect
      const rect = {
        left: offsetX + r.left,
        top: offsetY + r.top,
        width: r.width,
        height: r.height
      }
      if (rect.width < 50 || rect.height < 50) return

      // 优先取 contentDocument.location.href(only same-origin 可读)
      let url = f.src || "(空 src)"
      let nestedDoc: Document | null = null
      try {
        nestedDoc = f.contentDocument
        if (nestedDoc && nestedDoc.location && nestedDoc.location.href) {
          url = nestedDoc.location.href
        }
      } catch {
        // 跨域,nestedDoc 不可读,保留 src
      }

      result.push({
        url,
        title: f.title || f.getAttribute("name") || "",
        rect
      })

      // 递归进入 same-origin 子 frame
      if (nestedDoc) {
        visit(nestedDoc, rect.left, rect.top)
      }
    })
  }

  try {
    visit(document, 0, 0)
  } catch {
    // ignore
  }
  return result
}
