/**
 * 录制控制栏注入脚本
 *
 * 通过 chrome.scripting.executeScript 注入到目标 tab 执行，必须自包含。
 *
 * 职责：
 *   - 在页面左下角注入控制栏（计时 / 暂停 / 停止），固定 z-index 顶层
 *   - 监听 background 广播的 RECORDER_STOP / RECORDER_PAUSE / RECORDER_RESUME
 *     消息，更新控制栏 UI 状态
 *   - 用户点击「暂停 / 停止」按钮时，向 background 发对应消息
 *
 * **不**做的事：
 *   - 不再调 getUserMedia / MediaRecorder（中转扩展窗口接管）
 *   - 不再处理 streamId / 下载等
 *
 * 之前把 MediaRecorder 放在这个网页进程里，输出的 webm 缺 Duration 且
 * 部分 Chrome 版本下文件结构异常，无法被内置播放器解析。改放到扩展自有
 * 中转窗口里跑后输出正常。
 */

export interface InjectedControlBarArgs {
  /** 一次注入的唯一 token，用于防重复注入与跨 reload 校验 */
  token: string
}

/* ========== 注入函数：必须自包含（chrome.scripting.executeScript 用 func 序列化） ========== */
export function injectRecorderControlBar(args: InjectedControlBarArgs): void {
  const FLAG = "__myScreenshotRecorderBar"
  const w = window as unknown as Record<string, unknown>
  if (w[FLAG]) return
  w[FLAG] = args.token

  const Z = 2147483647

  /* ---------- DOM：控制栏 ---------- */
  const bar = document.createElement("div")
  bar.setAttribute("data-my-screenshot-recorder-bar", "1")
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
  time.textContent = "0:00"
  Object.assign(time.style, {
    minWidth: "36px",
    fontVariantNumeric: "tabular-nums",
    color: "#ffffff",
    fontWeight: "500"
  } satisfies Partial<CSSStyleDeclaration>)

  const pauseBtn = makeBarButton("#4a90e2", "❚❚", "暂停")
  const stopBtn = makeBarButton("#cf3a3a", "■", "停止并保存")

  bar.appendChild(time)
  bar.appendChild(pauseBtn)
  bar.appendChild(stopBtn)
  document.documentElement.appendChild(bar)

  /* ---------- 计时（本地估算，与中转窗口的 MediaRecorder 时长可能微差） ---------- */
  const startTime = Date.now()
  let pausedAccumMs = 0
  let pauseStart = 0
  let paused = false

  const fmtTime = (ms: number) => {
    const total = Math.max(0, Math.floor(ms / 1000))
    const m = Math.floor(total / 60)
    const s = total % 60
    return `${m}:${s.toString().padStart(2, "0")}`
  }
  const timerId = window.setInterval(() => {
    if (paused) return
    time.textContent = fmtTime(Date.now() - startTime - pausedAccumMs)
  }, 250)

  /* ---------- 按钮事件：通过消息驱动中转窗口 ---------- */
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

  stopBtn.addEventListener("click", () => {
    void chrome.runtime
      .sendMessage({ type: "record/stop" })
      .catch(() => undefined)
  })

  /* ---------- 监听全局停止广播：移除控制栏自身 ---------- */
  const listener = (msg: { type?: string }) => {
    if (msg?.type === "recorder/stop" || msg?.type === "recorder/finish") {
      cleanup()
    }
  }
  chrome.runtime.onMessage.addListener(listener)

  function cleanup() {
    try {
      window.clearInterval(timerId)
      bar.remove()
      chrome.runtime.onMessage.removeListener(listener)
      delete (window as unknown as Record<string, unknown>)[FLAG]
    } catch {
      /* 忽略 */
    }
  }

  /* ---------- 帮助函数 ---------- */
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
