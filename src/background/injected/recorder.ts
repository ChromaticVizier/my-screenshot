/**
 * 录制控制栏注入脚本
 *
 * 通过 chrome.scripting.executeScript 注入到目标 tab 执行，必须自包含。
 */

const BAR_DATA_ATTR = "data-my-screenshot-recorder-bar"

export interface InjectedControlBarArgs {
  /** 录制开始时间（ms epoch），用于跨注入实例显示同一计时 */
  startTime: number
  /** 当前麦克风是否已启用 */
  microphone?: boolean
  /** 中转窗口是否仍在准备录制 */
  preparing?: boolean
}

export interface InjectedCameraPreviewArgs {
  url: string
}

/* ========== 注入函数：必须自包含（chrome.scripting.executeScript 用 func 序列化） ========== */
export function injectRecorderControlBar(args: InjectedControlBarArgs): void {
  const BAR_ATTR = "data-my-screenshot-recorder-bar"
  const FLAG = "__myScreenshotRecorderBar"
  const w = window as unknown as {
    [key: string]: unknown
    __myScreenshotRecorderBar?: {
      cleanup: () => void
    }
  }

  if (w[FLAG]) {
    try {
      w[FLAG]?.cleanup()
    } catch {
      /* 忽略 */
    }
  }
  document.querySelectorAll(`[${BAR_ATTR}]`).forEach((el) => el.remove())

  const Z = 2147483647

  const bar = document.createElement("div")
  bar.setAttribute(BAR_ATTR, "1")
  Object.assign(bar.style, {
    position: "fixed",
    left: "16px",
    bottom: "16px",
    zIndex: String(Z),
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "8px 14px",
    background: "rgba(34, 39, 46, 0.96)",
    color: "#ffffff",
    borderRadius: "8px",
    fontFamily: "system-ui, -apple-system, 'PingFang SC', sans-serif",
    fontSize: "13px",
    boxShadow: "0 6px 20px rgba(0, 0, 0, 0.35)",
    userSelect: "none"
  } satisfies Partial<CSSStyleDeclaration>)

  const time = document.createElement("span")
  time.textContent = args.preparing ? "准备中" : "0:00"
  Object.assign(time.style, {
    minWidth: args.preparing ? "48px" : "36px",
    fontVariantNumeric: "tabular-nums",
    color: "#ffffff",
    fontWeight: "500"
  } satisfies Partial<CSSStyleDeclaration>)

  const pauseBtn = makeBarButton("#4a90e2", "❚❚", "暂停")
  const micBtn = makeBarButton("#6b7280", "🎙", "麦克风：关")
  const stopBtn = makeBarButton("#cf3a3a", "■", "停止并保存")
  const tip = document.createElement("span")
  Object.assign(tip.style, {
    maxWidth: "120px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: "#fca5a5",
    fontSize: "12px",
    display: "none"
  } satisfies Partial<CSSStyleDeclaration>)

  bar.appendChild(time)
  bar.appendChild(pauseBtn)
  bar.appendChild(micBtn)
  bar.appendChild(stopBtn)
  bar.appendChild(tip)
  document.documentElement.appendChild(bar)

  const startTime = args.startTime
  let pausedAccumMs = 0
  let pauseStart = 0
  let paused = false
  let preparing = !!args.preparing
  let microphone = !!args.microphone
  let micPending = false
  let tipTimer = 0

  setMicrophoneState(microphone)

  const fmtTime = (ms: number) => {
    const total = Math.max(0, Math.floor(ms / 1000))
    const m = Math.floor(total / 60)
    const s = total % 60
    return `${m}:${s.toString().padStart(2, "0")}`
  }
  const timerId = window.setInterval(() => {
    if (paused || preparing) return
    time.textContent = fmtTime(Date.now() - startTime - pausedAccumMs)
  }, 250)

  pauseBtn.addEventListener("click", () => {
    if (paused) {
      pausedAccumMs += Date.now() - pauseStart
      paused = false
      pauseBtn.textContent = "❚❚"
      pauseBtn.title = "暂停"
      void chrome.runtime
        .sendMessage({ type: "recorder/resume" })
        .catch(() => undefined)
    } else {
      pauseStart = Date.now()
      paused = true
      pauseBtn.textContent = "▶"
      pauseBtn.title = "继续"
      void chrome.runtime
        .sendMessage({ type: "recorder/pause" })
        .catch(() => undefined)
    }
  })

  micBtn.addEventListener("click", () => {
    if (microphone || micPending) return
    micPending = true
    micBtn.title = "正在请求麦克风权限"
    micBtn.style.opacity = "0.7"
    showTip("请求授权…", "#fde68a")
    void chrome.runtime
      .sendMessage({ type: "record/microphone/request" })
      .catch(() => {
        micPending = false
        setMicrophoneState(false)
        showTip("授权失败", "#fca5a5")
      })
  })

  stopBtn.addEventListener("click", () => {
    void chrome.runtime
      .sendMessage({ type: "record/stop" })
      .catch(() => undefined)
  })

  const listener = (msg: {
    type?: string
    payload?: { enabled?: boolean; error?: string; startedAt?: number }
  }) => {
    if (msg?.type === "recorder/stop" || msg?.type === "recorder/finish") {
      cleanup()
      return
    }
    if (msg?.type === "recorder/started") {
      preparing = false
      time.style.minWidth = "36px"
      time.textContent = fmtTime(0)
      return
    }
    if (msg?.type === "recorder/microphone/status") {
      micPending = false
      setMicrophoneState(!!msg.payload?.enabled)
      if (msg.payload?.enabled) {
        showTip("麦克风已开启", "#86efac")
      } else if (msg.payload?.error) {
        showTip("授权失败", "#fca5a5")
      }
    }
  }
  chrome.runtime.onMessage.addListener(listener)

  function setMicrophoneState(enabled: boolean) {
    microphone = enabled
    micBtn.style.opacity = "1"
    micBtn.style.background = enabled ? "#16a34a" : "#6b7280"
    micBtn.title = enabled ? "麦克风：开" : "麦克风：关"
  }

  function showTip(text: string, color: string) {
    window.clearTimeout(tipTimer)
    tip.textContent = text
    tip.style.color = color
    tip.style.display = "inline"
    tipTimer = window.setTimeout(() => {
      tip.style.display = "none"
    }, 1800)
  }

  function cleanup() {
    try {
      window.clearInterval(timerId)
      window.clearTimeout(tipTimer)
      bar.remove()
      document.querySelectorAll(`[${BAR_ATTR}]`).forEach((el) => el.remove())
      chrome.runtime.onMessage.removeListener(listener)
      delete (window as unknown as Record<string, unknown>)[FLAG]
    } catch {
      /* 忽略 */
    }
  }

  w[FLAG] = { cleanup }

  function makeBarButton(
    bg: string,
    glyph: string,
    title: string
  ): HTMLButtonElement {
    const b = document.createElement("button")
    b.type = "button"
    b.title = title
    b.textContent = glyph
    Object.assign(b.style, {
      width: "32px",
      height: "26px",
      border: "none",
      borderRadius: "4px",
      cursor: "pointer",
      background: bg,
      color: "#ffffff",
      fontSize: "12px",
      lineHeight: "1",
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      fontFamily: "inherit"
    } satisfies Partial<CSSStyleDeclaration>)
    return b
  }
}

/**
 * 主动移除控制栏（background 在停止时跑这个函数，确保即便新文档刚加载、
 * 注入脚本未运行时，也能在下一次注入前先把残留 DOM 清掉）。
 */
export function removeRecorderControlBar(): void {
  const BAR_ATTR = "data-my-screenshot-recorder-bar"
  const FLAG = "__myScreenshotRecorderBar"
  try {
    const w = window as unknown as {
      [key: string]: unknown
      __myScreenshotRecorderBar?: { cleanup: () => void }
    }
    w[FLAG]?.cleanup()
  } catch {
    /* 忽略 */
  }
  document.querySelectorAll(`[${BAR_ATTR}]`).forEach((el) => el.remove())
}

export function injectCameraPreview(args: InjectedCameraPreviewArgs): void {
  const PREVIEW_ATTR = "data-my-screenshot-camera-preview"
  const FLAG = "__myScreenshotCameraPreview"
  const w = window as unknown as {
    [key: string]: unknown
    __myScreenshotCameraPreview?: { cleanup: () => void }
  }

  try {
    w[FLAG]?.cleanup()
  } catch {
    /* 忽略 */
  }
  document.querySelectorAll(`[${PREVIEW_ATTR}]`).forEach((el) => el.remove())

  const box = document.createElement("div")
  box.setAttribute(PREVIEW_ATTR, "1")
  Object.assign(box.style, {
    position: "fixed",
    right: "24px",
    bottom: "88px",
    width: "240px",
    height: "135px",
    zIndex: "2147483646",
    borderRadius: "12px",
    overflow: "hidden",
    background: "#111827",
    border: "1px solid rgba(255,255,255,0.65)",
    boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
    cursor: "move",
    userSelect: "none",
    visibility: "hidden"
  } satisfies Partial<CSSStyleDeclaration>)

  const label = document.createElement("div")
  label.textContent = "摄像头启动中…"
  Object.assign(label.style, {
    position: "absolute",
    inset: "0",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#ffffff",
    fontSize: "13px",
    fontFamily: "system-ui, -apple-system, 'PingFang SC', sans-serif",
    background: "#111827",
    pointerEvents: "none"
  } satisfies Partial<CSSStyleDeclaration>)

  const video = document.createElement("video")
  video.muted = true
  video.playsInline = true
  video.autoplay = true
  Object.assign(video.style, {
    position: "relative",
    width: "100%",
    height: "100%",
    border: "0",
    display: "block",
    background: "transparent",
    objectFit: "cover",
    transform: "scaleX(-1)"
  } satisfies Partial<CSSStyleDeclaration>)

  video.addEventListener("loadeddata", () => {
    label.remove()
    box.style.visibility = "visible"
  })

  box.appendChild(label)
  box.appendChild(video)
  let previewStream: MediaStream | null = null
  void navigator.mediaDevices
    .getUserMedia({
      video: {
        width: { ideal: 640 },
        height: { ideal: 360 },
        frameRate: { ideal: 30 }
      },
      audio: false
    })
    .then((stream) => {
      previewStream = stream
      video.srcObject = stream
      return video.play()
    })
    .then(() => {
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        label.remove()
        box.style.visibility = "visible"
      }
    })
    .catch((err) => {
      box.style.visibility = "visible"
      label.textContent = `摄像头不可用：${err instanceof Error ? err.message : String(err)}`
      label.style.color = "#fca5a5"
    })
  document.documentElement.appendChild(box)

  let dragging = false
  let startX = 0
  let startY = 0
  let startLeft = 0
  let startTop = 0

  const onPointerDown = (ev: PointerEvent) => {
    dragging = true
    startX = ev.clientX
    startY = ev.clientY
    const rect = box.getBoundingClientRect()
    startLeft = rect.left
    startTop = rect.top
    box.style.left = `${startLeft}px`
    box.style.top = `${startTop}px`
    box.style.right = "auto"
    box.style.bottom = "auto"
    box.setPointerCapture(ev.pointerId)
    ev.preventDefault()
  }

  const onPointerMove = (ev: PointerEvent) => {
    if (!dragging) return
    const nextLeft = Math.max(
      0,
      Math.min(window.innerWidth - box.offsetWidth, startLeft + ev.clientX - startX)
    )
    const nextTop = Math.max(
      0,
      Math.min(window.innerHeight - box.offsetHeight, startTop + ev.clientY - startY)
    )
    box.style.left = `${nextLeft}px`
    box.style.top = `${nextTop}px`
  }

  const onPointerUp = (ev: PointerEvent) => {
    dragging = false
    try {
      box.releasePointerCapture(ev.pointerId)
    } catch {
      /* 忽略 */
    }
  }

  const onMessage = (msg: { type?: string }) => {
    if (msg?.type === "recorder/stop" || msg?.type === "recorder/finish") {
      cleanup()
    }
  }

  box.addEventListener("pointerdown", onPointerDown)
  box.addEventListener("pointermove", onPointerMove)
  box.addEventListener("pointerup", onPointerUp)
  box.addEventListener("pointercancel", onPointerUp)
  chrome.runtime.onMessage.addListener(onMessage)

  function cleanup() {
    try {
      box.removeEventListener("pointerdown", onPointerDown)
      box.removeEventListener("pointermove", onPointerMove)
      box.removeEventListener("pointerup", onPointerUp)
      box.removeEventListener("pointercancel", onPointerUp)
      chrome.runtime.onMessage.removeListener(onMessage)
      previewStream?.getTracks().forEach((track) => track.stop())
      box.remove()
      delete (window as unknown as Record<string, unknown>)[FLAG]
    } catch {
      /* 忽略 */
    }
  }

  w[FLAG] = { cleanup }
}

export function removeCameraPreview(): void {
  const PREVIEW_ATTR = "data-my-screenshot-camera-preview"
  const FLAG = "__myScreenshotCameraPreview"
  try {
    const w = window as unknown as {
      [key: string]: unknown
      __myScreenshotCameraPreview?: { cleanup: () => void }
    }
    w[FLAG]?.cleanup()
  } catch {
    /* 忽略 */
  }
  document.querySelectorAll(`[${PREVIEW_ATTR}]`).forEach((el) => el.remove())
}
