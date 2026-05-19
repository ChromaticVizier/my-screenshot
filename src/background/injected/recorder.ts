/**
 * 录制注入脚本
 *
 * 通过 chrome.scripting.executeScript 注入到目标 tab 执行，必须自包含。
 *
 * 职责：
 *   1. 用 chrome.tabCapture 提供的 streamId 构造 MediaStream
 *      （tabCapture 走 Chrome 私有约束语法，不走 getDisplayMedia）
 *   2. 启动 MediaRecorder，强制使用 webm（Chrome 唯一稳定支持的录制容器；
 *      指定 mp4 时多数 Chrome 版本会静默失败或回退）
 *   3. 在页面左下角注入控制栏（计时 / 暂停 / 停止），固定 z-index 顶层
 *   4. 监听 RECORDER_STOP 消息（来自 popup 通过 background 广播）
 *   5. 停止后把视频 dataUrl 发回 background 走下载
 *
 * 关于 mimeType：
 *   - 编码优先级：vp9+opus → vp8+opus → 默认 webm
 *   - 不再尝试 video/mp4：之前的 bug 就是这里强行声明了不支持的 mp4，
 *     导致内容是 webm 但文件名 .mp4，播放器拒绝
 */

export interface InjectedRecorderConfig {
  /** chrome.tabCapture.getMediaStreamId 返回值 */
  streamId: string
  /** 是否同时录入麦克风（用 getUserMedia 拿到再合流） */
  microphone: boolean
  /** 是否录入标签页系统声音（tabCapture 自带音频，仅控制是否丢弃） */
  systemAudio: boolean
}

export interface InjectedStartArgs {
  config: InjectedRecorderConfig
}

/* ========== 注入函数：必须自包含 ========== */

export function injectRecorderUI(args: InjectedStartArgs): void {
  // 防重复注入
  const FLAG = "__myScreenshotRecorderActive"
  const w = window as unknown as Record<string, unknown>
  if (w[FLAG]) return
  w[FLAG] = true

  const { config } = args
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

  /* ---------- 录制 ---------- */
  let mediaRecorder: MediaRecorder | null = null
  let micStream: MediaStream | null = null
  let combinedStream: MediaStream | null = null
  let chunks: Blob[] = []
  let startTime = 0
  let pausedAccumMs = 0
  let pauseStart = 0
  let timerId: number = 0
  let finalized = false

  const fmtTime = (ms: number) => {
    const total = Math.max(0, Math.floor(ms / 1000))
    const m = Math.floor(total / 60)
    const s = total % 60
    return `${m}:${s.toString().padStart(2, "0")}`
  }

  const tickTimer = () => {
    if (!startTime) return
    const elapsed = Date.now() - startTime - pausedAccumMs
    time.textContent = fmtTime(elapsed)
  }

  /* ---------- 通过 streamId 拿到 tab MediaStream ---------- */
  const constraints = {
    audio: config.systemAudio
      ? {
          mandatory: {
            chromeMediaSource: "tab",
            chromeMediaSourceId: config.streamId
          }
        }
      : false,
    video: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: config.streamId
      }
    }
  } as unknown as MediaStreamConstraints

  ;(async () => {
    try {
      const tabStream = await navigator.mediaDevices.getUserMedia(constraints)

      // 关键：tabCapture 拿到的 audio 会与原页面的音频"分流"，导致用户在录制时
      // 自己听不到页面的声音。把 audio track 也接到 destination 让其继续播放。
      if (config.systemAudio) {
        const audioCtx = new AudioContext()
        const source = audioCtx.createMediaStreamSource(tabStream)
        source.connect(audioCtx.destination)
      }

      // 收集轨道
      const tracks: MediaStreamTrack[] = []
      tabStream.getVideoTracks().forEach((t) => tracks.push(t))
      if (config.systemAudio) {
        tabStream.getAudioTracks().forEach((t) => tracks.push(t))
      }

      // 麦克风：用 getUserMedia 单独拿
      if (config.microphone) {
        try {
          micStream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true }
          })
          micStream.getAudioTracks().forEach((t) => tracks.push(t))
        } catch (err) {
          console.warn("[recorder] 麦克风获取失败", err)
        }
      }

      combinedStream = new MediaStream(tracks)

      // mimeType 选择：仅 webm（Chrome 中 video/mp4 多数版本不支持录制）
      const mimeCandidates = [
        "video/webm;codecs=vp9,opus",
        "video/webm;codecs=vp8,opus",
        "video/webm;codecs=vp9",
        "video/webm;codecs=vp8",
        "video/webm"
      ]
      const mimeType = mimeCandidates.find((t) =>
        MediaRecorder.isTypeSupported(t)
      )
      if (!mimeType) throw new Error("浏览器不支持任何 webm 编码")

      mediaRecorder = new MediaRecorder(combinedStream, { mimeType })
      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data)
      }
      mediaRecorder.onstop = async () => {
        if (finalized) return
        finalized = true
        try {
          const blob = new Blob(chunks, { type: mimeType })
          const dataUrl = await blobToDataUrl(blob)
          await chrome.runtime.sendMessage({
            type: "recorder/finish",
            payload: { dataUrl, ext: "webm" }
          })
        } catch (err) {
          await chrome.runtime
            .sendMessage({
              type: "recorder/finish",
              payload: {
                dataUrl: "",
                ext: "webm",
                error:
                  err instanceof Error ? err.message : String(err)
              }
            })
            .catch(() => undefined)
        } finally {
          cleanup()
        }
      }
      // 用户在 Chrome 共享栏点「停止」会让 video track ended（tabCapture 也支持）
      tabStream.getVideoTracks().forEach((t) => {
        t.addEventListener("ended", () => {
          if (mediaRecorder && mediaRecorder.state !== "inactive") {
            mediaRecorder.stop()
          }
        })
      })

      mediaRecorder.start(1000) // 每秒切片，便于丢失少
      startTime = Date.now()
      timerId = window.setInterval(tickTimer, 250)
    } catch (err) {
      console.error("[recorder] 启动失败", err)
      await chrome.runtime
        .sendMessage({
          type: "recorder/finish",
          payload: {
            dataUrl: "",
            ext: "webm",
            error: err instanceof Error ? err.message : String(err)
          }
        })
        .catch(() => undefined)
      cleanup()
    }
  })()

  /* ---------- 控制按钮 ---------- */
  pauseBtn.addEventListener("click", () => {
    if (!mediaRecorder) return
    if (mediaRecorder.state === "recording") {
      mediaRecorder.pause()
      pauseStart = Date.now()
      pauseBtn.textContent = "▶"
      pauseBtn.title = "继续"
    } else if (mediaRecorder.state === "paused") {
      mediaRecorder.resume()
      pausedAccumMs += Date.now() - pauseStart
      pauseBtn.textContent = "❚❚"
      pauseBtn.title = "暂停"
    }
  })

  stopBtn.addEventListener("click", () => stopAll())

  /* ---------- 监听 background 转发的 RECORDER_STOP ---------- */
  const messageListener = (msg: { type?: string }) => {
    if (msg?.type === "recorder/stop") stopAll()
  }
  chrome.runtime.onMessage.addListener(messageListener)

  function stopAll() {
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.stop() // → onstop 里发完成消息 + cleanup
    } else {
      cleanup()
    }
  }

  function cleanup() {
    try {
      if (timerId) clearInterval(timerId)
      combinedStream?.getTracks().forEach((t) => t.stop())
      micStream?.getTracks().forEach((t) => t.stop())
      bar.remove()
      chrome.runtime.onMessage.removeListener(messageListener)
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

  async function blobToDataUrl(blob: Blob): Promise<string> {
    const buffer = await blob.arrayBuffer()
    const bytes = new Uint8Array(buffer)
    const CHUNK = 0x8000
    let binary = ""
    for (let i = 0; i < bytes.length; i += CHUNK) {
      const chunk = bytes.subarray(i, i + CHUNK)
      binary += String.fromCharCode(...chunk)
    }
    const base64 = btoa(binary)
    return `data:${blob.type || "video/webm"};base64,${base64}`
  }
}
