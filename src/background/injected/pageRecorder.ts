/**
 * 页内录屏脚本（注入到目标 tab 执行）
 *
 * 通过 chrome.scripting.executeScript 注入到目标 tab，**必须自包含**
 * （func 会被序列化，不能引用模块作用域变量 / import）。
 *
 * 为什么整条管线放在页面里：
 *   - 麦克风授权按 origin 隔离。要让授权弹窗**在浏览器页面内弹出**（而不是
 *     独立扩展窗口——Mac 全屏下会被丢到单独 Space、用户来不及点），必须在
 *     目标页面（页面源）里调 getUserMedia。
 *   - 控制栏也直接画在页面里，全屏时无需切屏。
 *
 * 职责：
 *   1) getUserMedia：麦克风（页内弹授权框）+ tab 捕获（chromeMediaSource:"tab"）
 *   2) 区域录制经 WebCodecs Insertable Streams 裁剪；整页直接用 tab 视频
 *   3) 系统声音 + 麦克风用 WebAudio 混成单条音轨
 *   4) MediaRecorder 录 webm；停止后**补写 Duration 头**保证可播放，再用
 *      <a download> 在页内触发下载
 *   5) 页内控制栏（计时 / 暂停 / 停止）
 *   6) 监听 background 经 chrome.tabs.sendMessage 下发的 recorder/stop
 *   7) 页面卸载（导航/关闭）时尽量抢救已录内容并下载
 */

export interface PageRecorderRegion {
  x: number
  y: number
  width: number
  height: number
  devicePixelRatio: number
  viewportWidth?: number
  viewportHeight?: number
}

export interface PageRecorderArgs {
  streamId: string
  microphone: boolean
  systemAudio: boolean
  /** 整页录制的分辨率上限（区域录制不传，用原生分辨率保证裁剪精度） */
  maxWidth?: number
  maxHeight?: number
  region?: PageRecorderRegion | null
  filename: string
  /** 录制起点（ms epoch），用于控制栏计时 */
  startTime: number
}

/* ========== 注入函数：必须自包含 ========== */
export function injectPageRecorder(args: PageRecorderArgs): void {
  const FLAG = "__myScreenshotPageRecorder"
  const w = window as unknown as {
    [key: string]: unknown
    __myScreenshotPageRecorder?: { cleanup: () => void }
  }
  // 已有实例先清掉，保证页面唯一
  if (w[FLAG]) {
    try {
      w[FLAG]?.cleanup()
    } catch {
      /* 忽略 */
    }
  }

  const Z = 2147483647
  const BAR_ATTR = "data-my-screenshot-recorder-bar"
  document.querySelectorAll(`[${BAR_ATTR}]`).forEach((el) => el.remove())

  /* ---------- 运行时状态 ---------- */
  let mediaRecorder: MediaRecorder | null = null
  let combinedStream: MediaStream | null = null
  let tabStream: MediaStream | null = null
  let micStream: MediaStream | null = null
  let cropCancel: (() => void) | null = null
  let mimeType = "video/webm"
  const chunks: Blob[] = []
  let finalized = false
  let paused = false
  const startTime = args.startTime
  let pausedAccumMs = 0
  let pauseStart = 0

  /* ---------- 控制栏 DOM ---------- */
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

  const dot = document.createElement("span")
  Object.assign(dot.style, {
    width: "10px",
    height: "10px",
    borderRadius: "50%",
    background: "#e0392b"
  } satisfies Partial<CSSStyleDeclaration>)

  const label = document.createElement("span")
  label.textContent = "启动中…"
  Object.assign(label.style, {
    color: "#ffffff",
    fontWeight: "500"
  } satisfies Partial<CSSStyleDeclaration>)

  const time = document.createElement("span")
  time.textContent = "0:00"
  Object.assign(time.style, {
    minWidth: "36px",
    fontVariantNumeric: "tabular-nums",
    color: "#ffffff"
  } satisfies Partial<CSSStyleDeclaration>)

  const makeBtn = (bg: string, glyph: string, title: string) => {
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
  const pauseBtn = makeBtn("#4a90e2", "❚❚", "暂停")
  const stopBtn = makeBtn("#cf3a3a", "■", "停止并保存")
  pauseBtn.style.display = "none"
  stopBtn.style.display = "none"

  bar.appendChild(dot)
  bar.appendChild(label)
  bar.appendChild(time)
  bar.appendChild(pauseBtn)
  bar.appendChild(stopBtn)
  document.documentElement.appendChild(bar)

  const fmtTime = (ms: number) => {
    const total = Math.max(0, Math.floor(ms / 1000))
    const m = Math.floor(total / 60)
    const s = total % 60
    return `${m}:${s.toString().padStart(2, "0")}`
  }
  const timerId = window.setInterval(() => {
    if (paused || startTime <= 0) return
    time.textContent = fmtTime(Date.now() - startTime - pausedAccumMs)
  }, 250)

  /* ---------- 收尾 ---------- */
  const cleanupTracks = () => {
    try {
      if (cropCancel) cropCancel()
      combinedStream?.getTracks().forEach((t) => t.stop())
      tabStream?.getTracks().forEach((t) => t.stop())
      micStream?.getTracks().forEach((t) => t.stop())
    } catch {
      /* 忽略 */
    }
  }

  const removeBar = () => {
    try {
      window.clearInterval(timerId)
      bar.remove()
      document.querySelectorAll(`[${BAR_ATTR}]`).forEach((el) => el.remove())
    } catch {
      /* 忽略 */
    }
  }

  const cleanup = () => {
    cleanupTracks()
    removeBar()
    try {
      chrome.runtime.onMessage.removeListener(msgListener)
    } catch {
      /* 忽略 */
    }
    window.removeEventListener("pagehide", onPageHide)
    delete (window as unknown as Record<string, unknown>)[FLAG]
  }

  /* ---------- webm Duration 补写（best-effort，失败回退原 blob） ---------- */
  const fixWebmDuration = async (
    blob: Blob,
    durationMs: number
  ): Promise<Blob> => {
    try {
      if (!(durationMs > 0)) return blob
      const data = new Uint8Array(await blob.arrayBuffer())

      const readVint = (p: number, keepMarker: boolean) => {
        const first = data[p]
        if (first === undefined) return null
        let mask = 0x80
        let len = 1
        while (len <= 8 && (first & mask) === 0) {
          mask >>= 1
          len++
        }
        if (len > 8) return null
        let value = keepMarker ? first : first & (mask - 1)
        for (let i = 1; i < len; i++) value = value * 256 + data[p + i]
        return { value, len }
      }

      // 定位 Segment(0x18538067) → Info(0x1549A966)
      const findChild = (
        start: number,
        end: number,
        targetId: number
      ): { contentStart: number; contentEnd: number; sizeAt: number } | null => {
        let p = start
        while (p < end) {
          const id = readVint(p, true)
          if (!id) return null
          const sizeAt = p + id.len
          const size = readVint(sizeAt, false)
          if (!size) return null
          const contentStart = sizeAt + size.len
          // unknown size（全 1）：内容延伸到 end
          const isUnknown =
            size.value >= Math.pow(2, 7 * size.len) - 1
          const contentEnd = isUnknown ? end : contentStart + size.value
          if (id.value === targetId) {
            return { contentStart, contentEnd, sizeAt }
          }
          p = contentEnd
        }
        return null
      }

      const segment = findChild(0, data.length, 0x18538067)
      if (!segment) return blob
      const info = findChild(
        segment.contentStart,
        segment.contentEnd,
        0x1549a966
      )
      if (!info) return blob

      // Info 内已有 Duration(0x4489)？有则直接改写其 double 值
      const existing = findChild(info.contentStart, info.contentEnd, 0x4489)
      const view = new DataView(data.buffer)
      if (existing) {
        // existing.contentStart 指向 double 数据（8 字节）
        if (existing.contentEnd - existing.contentStart >= 8) {
          view.setFloat64(existing.contentStart, durationMs, false)
          return new Blob([data], { type: blob.type })
        }
        return blob
      }

      // 无 Duration：在 Info 内容起始处插入 [0x4489][0x88][8 字节 double]
      const dur = new Uint8Array(11)
      dur[0] = 0x44
      dur[1] = 0x89
      dur[2] = 0x88 // size = 8（vint）
      new DataView(dur.buffer).setFloat64(3, durationMs, false)

      // 重写 Info 的 size（+11）。Info 的 size vint 从 info.sizeAt 起。
      const infoSize = readVint(info.sizeAt, false)
      if (!infoSize) return blob
      const infoIsUnknown =
        infoSize.value >= Math.pow(2, 7 * infoSize.len) - 1
      if (infoIsUnknown) return blob // 少见，放弃补写

      const newInfoSize = infoSize.value + dur.length
      // 用与原来相同的字节长度重新编码 size（避免整体位移导致 SeekHead 失配）
      const encodeVint = (val: number, len: number): Uint8Array | null => {
        const max = Math.pow(2, 7 * len) - 1
        if (val > max) return null
        const out = new Uint8Array(len)
        let v = val
        for (let i = len - 1; i >= 0; i--) {
          out[i] = v & 0xff
          v = Math.floor(v / 256)
        }
        out[0] |= 0x80 >> (len - 1)
        return out
      }
      const encoded = encodeVint(newInfoSize, infoSize.len)
      if (!encoded) return blob

      const out = new Uint8Array(data.length + dur.length)
      out.set(data.subarray(0, info.sizeAt), 0)
      out.set(encoded, info.sizeAt)
      out.set(
        data.subarray(info.sizeAt + infoSize.len, info.contentStart),
        info.sizeAt + infoSize.len
      )
      out.set(dur, info.contentStart)
      out.set(data.subarray(info.contentStart), info.contentStart + dur.length)
      return new Blob([out], { type: blob.type })
    } catch {
      return blob
    }
  }

  /* ---------- 下载（页内 <a download>） ---------- */
  const triggerDownload = (blob: Blob) => {
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = args.filename
    a.style.display = "none"
    document.documentElement.appendChild(a)
    a.click()
    window.setTimeout(() => {
      try {
        a.remove()
        URL.revokeObjectURL(url)
      } catch {
        /* 忽略 */
      }
    }, 60_000)
  }

  const finalize = async () => {
    if (finalized) return
    finalized = true
    label.textContent = "保存中…"
    pauseBtn.style.display = "none"
    stopBtn.style.display = "none"
    try {
      if (chunks.length > 0) {
        const raw = new Blob(chunks, { type: mimeType })
        const durationMs = Math.max(0, Date.now() - startTime - pausedAccumMs)
        const fixed = await fixWebmDuration(raw, durationMs)
        triggerDownload(fixed)
        label.textContent = "已保存 ✓"
      } else {
        label.textContent = "未录到内容"
      }
    } catch {
      label.textContent = "保存失败"
    }
    cleanupTracks()
    // 通知 background 清理会话
    try {
      await chrome.runtime.sendMessage({
        type: "recorder/finish",
        payload: {}
      })
    } catch {
      /* 忽略 */
    }
    window.setTimeout(cleanup, 1500)
  }

  const stopRecording = () => {
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      try {
        mediaRecorder.stop()
      } catch {
        /* 忽略 */
      }
      // 兜底：onstop 未触发时手动收尾
      window.setTimeout(() => {
        if (!finalized) void finalize()
      }, 2000)
    } else if (!finalized) {
      void finalize()
    }
  }

  const togglePause = () => {
    if (!mediaRecorder) return
    if (paused) {
      if (pauseStart > 0) {
        pausedAccumMs += Date.now() - pauseStart
        pauseStart = 0
      }
      paused = false
      pauseBtn.textContent = "❚❚"
      pauseBtn.title = "暂停"
      dot.style.background = "#e0392b"
      if (mediaRecorder.state === "paused") mediaRecorder.resume()
    } else {
      pauseStart = Date.now()
      paused = true
      pauseBtn.textContent = "▶"
      pauseBtn.title = "继续"
      dot.style.background = "#b0b6bf"
      if (mediaRecorder.state === "recording") mediaRecorder.pause()
    }
  }

  pauseBtn.addEventListener("click", togglePause)
  stopBtn.addEventListener("click", () => {
    // 通知 background（清理会话 + 广播），随后本地收尾
    void chrome.runtime.sendMessage({ type: "record/stop" }).catch(() => undefined)
    stopRecording()
  })

  /* ---------- 监听 background 下发的停止（如 popup 点结束） ---------- */
  const msgListener = (msg: { type?: string }) => {
    if (msg?.type === "recorder/stop") stopRecording()
    else if (msg?.type === "recorder/pause" && !paused) togglePause()
    else if (msg?.type === "recorder/resume" && paused) togglePause()
  }
  chrome.runtime.onMessage.addListener(msgListener)

  /* ---------- 页面卸载（导航/关闭）：抢救已录内容 ---------- */
  const onPageHide = () => {
    if (!finalized && chunks.length > 0 && mediaRecorder) {
      try {
        if (mediaRecorder.state !== "inactive") mediaRecorder.stop()
      } catch {
        /* 忽略 */
      }
    }
  }
  window.addEventListener("pagehide", onPageHide)

  w[FLAG] = { cleanup }

  /* ---------- WebCodecs 裁剪（区域录制） ---------- */
  const buildCroppedVideoTracks = (
    src: MediaStream,
    region: PageRecorderRegion
  ): MediaStreamTrack[] => {
    const srcTrack = src.getVideoTracks()[0]
    if (!srcTrack) throw new Error("源视频轨道为空")
    const winAny = window as unknown as {
      MediaStreamTrackProcessor?: new (init: {
        track: MediaStreamTrack
      }) => { readable: ReadableStream<VideoFrame> }
      MediaStreamTrackGenerator?: new (init: {
        kind: "video"
      }) => MediaStreamTrack & { writable: WritableStream<VideoFrame> }
    }
    if (!winAny.MediaStreamTrackProcessor || !winAny.MediaStreamTrackGenerator) {
      throw new Error("当前浏览器不支持 WebCodecs Insertable Streams（需 Chrome 94+）")
    }
    const dpr = region.devicePixelRatio || 1
    const FRAME_BORDER = 3
    const selX = region.x + FRAME_BORDER
    const selY = region.y + FRAME_BORDER
    const selW = Math.max(1, region.width - FRAME_BORDER * 2)
    const selH = Math.max(1, region.height - FRAME_BORDER * 2)
    const processor = new winAny.MediaStreamTrackProcessor({ track: srcTrack })
    const generator = new winAny.MediaStreamTrackGenerator({ kind: "video" })
    let baseTs: number | null = null
    const transformer = new TransformStream<VideoFrame, VideoFrame>({
      transform(frame, controller) {
        const fw = frame.codedWidth
        const fh = frame.codedHeight
        const vpW =
          region.viewportWidth && region.viewportWidth > 0
            ? region.viewportWidth
            : fw / dpr
        const vpH =
          region.viewportHeight && region.viewportHeight > 0
            ? region.viewportHeight
            : fh / dpr
        const scale = Math.min(fw / vpW, fh / vpH)
        const drawnW = vpW * scale
        const drawnH = vpH * scale
        const offX = (fw - drawnW) / 2
        const offY = (fh - drawnH) / 2
        let x = Math.round(offX + selX * scale)
        let y = Math.round(offY + selY * scale)
        let cw = Math.round(selW * scale)
        let ch = Math.round(selH * scale)
        x = Math.max(0, Math.min(x, Math.max(0, fw - 2)))
        y = Math.max(0, Math.min(y, Math.max(0, fh - 2)))
        cw = Math.max(2, Math.min(cw, fw - x))
        ch = Math.max(2, Math.min(ch, fh - y))
        x -= x % 2
        y -= y % 2
        cw -= cw % 2
        ch -= ch % 2
        if (cw < 2) cw = 2
        if (ch < 2) ch = 2
        if (x + cw > fw) cw = fw - x - ((fw - x) % 2)
        if (y + ch > fh) ch = fh - y - ((fh - y) % 2)
        const srcTs = frame.timestamp ?? 0
        if (baseTs === null) baseTs = srcTs
        const relTs = Math.max(0, srcTs - baseTs)
        try {
          const cropped = new VideoFrame(frame, {
            visibleRect: { x, y, width: cw, height: ch },
            timestamp: relTs
          })
          controller.enqueue(cropped)
        } catch {
          /* 跳过异常帧 */
        } finally {
          frame.close()
        }
      }
    })
    const abort = new AbortController()
    processor.readable
      .pipeThrough(transformer, { signal: abort.signal })
      .pipeTo(generator.writable, { signal: abort.signal })
      .catch(() => undefined)
    cropCancel = () => {
      try {
        abort.abort()
      } catch {
        /* 忽略 */
      }
    }
    return [generator]
  }

  /* ---------- 启动录制 ---------- */
  const start = async () => {
    try {
      // 麦克风：先发起（页内弹授权框），不 await —— 让 streamId 立刻被 tab 捕获消费
      let micResult: MediaStream | null = null
      const micPromise = args.microphone
        ? navigator.mediaDevices
            .getUserMedia({
              audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
              }
            })
            .then((s) => {
              micResult = s
            })
            .catch(() => {
              micResult = null
            })
        : null

      // tab 捕获
      const videoMandatory: Record<string, string | number> = {
        chromeMediaSource: "tab",
        chromeMediaSourceId: args.streamId
      }
      if (!args.region && args.maxWidth && args.maxHeight) {
        videoMandatory.maxWidth = args.maxWidth
        videoMandatory.maxHeight = args.maxHeight
      }
      const constraints = {
        audio: args.systemAudio
          ? {
              mandatory: {
                chromeMediaSource: "tab",
                chromeMediaSourceId: args.streamId
              }
            }
          : false,
        video: { mandatory: videoMandatory }
      } as unknown as MediaStreamConstraints

      tabStream = await navigator.mediaDevices.getUserMedia(constraints)

      // 系统声音：tabCapture 会静音页面，接回 destination 让用户仍能听到
      if (args.systemAudio) {
        try {
          const ac = new AudioContext()
          ac.createMediaStreamSource(tabStream).connect(ac.destination)
        } catch {
          /* 忽略 */
        }
      }

      // 等麦克风结果（streamId 已消费，不会过期）
      if (micPromise) {
        await micPromise
        micStream = micResult
      }

      // 视频轨：区域裁剪 or 整页直用
      let videoTracks: MediaStreamTrack[]
      if (args.region) {
        videoTracks = buildCroppedVideoTracks(tabStream, args.region)
      } else {
        videoTracks = tabStream.getVideoTracks()
      }

      // 音频轨：mic + systemAudio 混成单条
      const tracks: MediaStreamTrack[] = [...videoTracks]
      const micAudio = micStream ? micStream.getAudioTracks() : []
      const tabAudio =
        args.systemAudio && tabStream.getAudioTracks().length > 0
          ? tabStream.getAudioTracks()
          : []
      if (micAudio.length > 0 && tabAudio.length > 0) {
        try {
          const mixCtx = new AudioContext()
          if (mixCtx.state === "suspended") await mixCtx.resume()
          const dest = mixCtx.createMediaStreamDestination()
          mixCtx
            .createMediaStreamSource(new MediaStream([tabAudio[0]]))
            .connect(dest)
          mixCtx
            .createMediaStreamSource(new MediaStream([micAudio[0]]))
            .connect(dest)
          tracks.push(dest.stream.getAudioTracks()[0] ?? micAudio[0])
        } catch {
          tracks.push(micAudio[0])
        }
      } else if (micAudio.length > 0) {
        tracks.push(micAudio[0])
      } else if (tabAudio.length > 0) {
        tracks.push(tabAudio[0])
      }

      combinedStream = new MediaStream(tracks)

      const mimeCandidates = [
        "video/webm;codecs=vp9,opus",
        "video/webm;codecs=vp8,opus",
        "video/webm;codecs=vp9",
        "video/webm;codecs=vp8",
        "video/webm"
      ]
      const picked = mimeCandidates.find((t) =>
        MediaRecorder.isTypeSupported(t)
      )
      if (!picked) throw new Error("浏览器不支持任何 webm 编码")
      mimeType = picked

      mediaRecorder = new MediaRecorder(combinedStream, { mimeType })
      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data)
      }
      mediaRecorder.onstop = () => void finalize()

      // Chrome 共享栏「停止共享」→ tab 视频 track ended
      tabStream.getVideoTracks().forEach((t) => {
        t.addEventListener("ended", () => {
          if (mediaRecorder && mediaRecorder.state !== "inactive") {
            mediaRecorder.stop()
          }
        })
      })

      mediaRecorder.start()
      label.textContent = "录制中"
      pauseBtn.style.display = "inline-flex"
      stopBtn.style.display = "inline-flex"

      // 回传真实起点，覆盖 bootstrap 时的估计值
      try {
        await chrome.runtime.sendMessage({
          type: "recorder/started",
          payload: { startedAt: Date.now() }
        })
      } catch {
        /* 忽略 */
      }
    } catch (err) {
      label.textContent =
        "录制失败：" + (err instanceof Error ? err.message : String(err))
      dot.style.background = "#b0b6bf"
      cleanupTracks()
      try {
        await chrome.runtime.sendMessage({
          type: "recorder/finish",
          payload: {
            error: err instanceof Error ? err.message : String(err)
          }
        })
      } catch {
        /* 忽略 */
      }
      window.setTimeout(cleanup, 3000)
    }
  }

  void start()
}

/** 主动移除页内录制器（background 停止时兜底调用） */
export function removePageRecorder(): void {
  const FLAG = "__myScreenshotPageRecorder"
  const BAR_ATTR = "data-my-screenshot-recorder-bar"
  try {
    const w = window as unknown as {
      [key: string]: unknown
      __myScreenshotPageRecorder?: { cleanup: () => void }
    }
    w[FLAG]?.cleanup()
  } catch {
    /* 忽略 */
  }
  document.querySelectorAll(`[${BAR_ATTR}]`).forEach((el) => el.remove())
}
