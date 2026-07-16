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
    userSelect: "none",
    cursor: "move"
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
  const collapseBtn = makeBtn("rgba(255,255,255,0.18)", "–", "收起")
  pauseBtn.style.display = "none"
  stopBtn.style.display = "none"

  bar.appendChild(dot)
  bar.appendChild(label)
  bar.appendChild(time)
  bar.appendChild(pauseBtn)
  bar.appendChild(stopBtn)
  bar.appendChild(collapseBtn)
  document.documentElement.appendChild(bar)

  /* ---------- 收起 / 展开 ---------- */
  // 收起态：只留一个小圆点，避免遮挡录制内容；再次点击展开。
  let collapsed = false
  const expandedChildren = [dot, label, time, pauseBtn, stopBtn]
  const setCollapsed = (next: boolean) => {
    collapsed = next
    if (collapsed) {
      expandedChildren.forEach((el) => {
        ;(el as HTMLElement).style.display = "none"
      })
      Object.assign(bar.style, {
        padding: "8px",
        gap: "0"
      } satisfies Partial<CSSStyleDeclaration>)
      collapseBtn.textContent = "●"
      collapseBtn.title = "展开"
      collapseBtn.style.background = "#e0392b"
    } else {
      dot.style.display = ""
      label.style.display = ""
      time.style.display = ""
      // 暂停/停止按钮仅在录制阶段显示
      const showCtrl = !finalized && !!mediaRecorder
      pauseBtn.style.display = showCtrl ? "inline-flex" : "none"
      stopBtn.style.display = showCtrl ? "inline-flex" : "none"
      Object.assign(bar.style, {
        padding: "8px 14px",
        gap: "10px"
      } satisfies Partial<CSSStyleDeclaration>)
      collapseBtn.textContent = "–"
      collapseBtn.title = "收起"
      collapseBtn.style.background = "rgba(255,255,255,0.18)"
    }
  }
  collapseBtn.addEventListener("click", (e) => {
    e.stopPropagation()
    setCollapsed(!collapsed)
  })

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

  /* ---------- 拖拽移动 ---------- */
  let dragging = false
  let dragDX = 0
  let dragDY = 0
  const onBarPointerDown = (e: PointerEvent) => {
    // 点在按钮上不触发拖拽
    if (
      e.target === pauseBtn ||
      e.target === stopBtn ||
      e.target === collapseBtn
    )
      return
    dragging = true
    const rect = bar.getBoundingClientRect()
    dragDX = e.clientX - rect.left
    dragDY = e.clientY - rect.top
    // 从 bottom 锚定切换为 top/left 绝对定位，便于自由移动
    bar.style.bottom = "auto"
    bar.style.left = rect.left + "px"
    bar.style.top = rect.top + "px"
    e.preventDefault()
  }
  const onPointerMove = (e: PointerEvent) => {
    if (!dragging) return
    let nx = e.clientX - dragDX
    let ny = e.clientY - dragDY
    nx = Math.max(0, Math.min(nx, window.innerWidth - bar.offsetWidth))
    ny = Math.max(0, Math.min(ny, window.innerHeight - bar.offsetHeight))
    bar.style.left = nx + "px"
    bar.style.top = ny + "px"
  }
  const onPointerUp = () => {
    dragging = false
  }
  bar.addEventListener("pointerdown", onBarPointerDown)
  window.addEventListener("pointermove", onPointerMove, true)
  window.addEventListener("pointerup", onPointerUp, true)

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
      window.removeEventListener("pointermove", onPointerMove, true)
      window.removeEventListener("pointerup", onPointerUp, true)
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

  /* ---------- 区域裁剪（canvas 方案） ----------
   * 注入脚本运行在内容脚本「隔离世界」，此环境下 WebCodecs 的
   * MediaStreamTrackProcessor/Generator 管线常不产出帧（能力检测通过但无输出），
   * 导致区域录制录不到内容。改用 <video> + canvas.drawImage + canvas.captureStream
   * 在隔离世界稳定可用；webm 可播放性由停止时的 Duration 补写保证。
   */
  const buildCroppedVideoTracks = (
    src: MediaStream,
    region: PageRecorderRegion
  ): MediaStreamTrack[] => {
    const srcTrack = src.getVideoTracks()[0]
    if (!srcTrack) throw new Error("源视频轨道为空")

    const dpr = region.devicePixelRatio || 1
    // 录制期页面残留的红色选区边框（约 2px+外阴影）会被录进去，向内缩进 3px 遮掉
    const FRAME_BORDER = 3
    const selX = region.x + FRAME_BORDER
    const selY = region.y + FRAME_BORDER
    const selW = Math.max(1, region.width - FRAME_BORDER * 2)
    const selH = Math.max(1, region.height - FRAME_BORDER * 2)

    const video = document.createElement("video")
    video.muted = true
    video.playsInline = true
    video.srcObject = new MediaStream([srcTrack])

    const canvas = document.createElement("canvas")
    const ctx = canvas.getContext("2d")
    if (!ctx) throw new Error("无法创建 canvas 上下文")

    let rafId = 0
    let stopped = false

    const draw = () => {
      if (stopped) return
      const fw = video.videoWidth
      const fh = video.videoHeight
      if (fw > 0 && fh > 0) {
        const vpW =
          region.viewportWidth && region.viewportWidth > 0
            ? region.viewportWidth
            : fw / dpr
        const vpH =
          region.viewportHeight && region.viewportHeight > 0
            ? region.viewportHeight
            : fh / dpr
        // object-fit:contain 映射（等比缩放 + 居中留白）
        const scale = Math.min(fw / vpW, fh / vpH)
        const offX = (fw - vpW * scale) / 2
        const offY = (fh - vpH * scale) / 2
        let sx = Math.round(offX + selX * scale)
        let sy = Math.round(offY + selY * scale)
        let sw = Math.round(selW * scale)
        let sh = Math.round(selH * scale)
        sx = Math.max(0, Math.min(sx, Math.max(0, fw - 2)))
        sy = Math.max(0, Math.min(sy, Math.max(0, fh - 2)))
        sw = Math.max(2, Math.min(sw, fw - sx))
        sh = Math.max(2, Math.min(sh, fh - sy))
        // 偶数对齐（VP8/VP9 要求）
        sw -= sw % 2
        sh -= sh % 2
        if (sw < 2) sw = 2
        if (sh < 2) sh = 2
        if (canvas.width !== sw || canvas.height !== sh) {
          canvas.width = sw
          canvas.height = sh
        }
        try {
          ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh)
        } catch {
          /* 跳过异常帧 */
        }
      }
      rafId = requestAnimationFrame(draw)
    }

    // 先给 canvas 一个初始尺寸，保证 captureStream 有有效轨道
    canvas.width = Math.max(2, Math.round(selW * dpr))
    canvas.height = Math.max(2, Math.round(selH * dpr))
    const outStream = canvas.captureStream(30)

    void video.play().then(() => {
      rafId = requestAnimationFrame(draw)
    })

    cropCancel = () => {
      stopped = true
      try {
        cancelAnimationFrame(rafId)
      } catch {
        /* 忽略 */
      }
      try {
        outStream.getTracks().forEach((t) => t.stop())
      } catch {
        /* 忽略 */
      }
      try {
        video.pause()
        video.srcObject = null
      } catch {
        /* 忽略 */
      }
    }

    return outStream.getVideoTracks()
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

      // ---------- 音频 ----------
      // 关键：注入脚本跑在页面「隔离世界」，本次录制的用户手势发生在扩展 popup、
      // 而非本页面文档，因此这里新建的 AudioContext 会处于 suspended（无页面激活），
      // 输出为空 —— 这会同时导致「回放静音」和「录到的音频轨为空/乱码」。
      // 所以：
      //   · 回放系统声音改用 <audio> 播放实时采集流（实时采集流的播放不受
      //     autoplay 限制，无需 AudioContext）；
      //   · 录制音轨优先直接用「原始轨道」，只有 mic+系统声音都在时才用 WebAudio
      //     混音，并对 suspended 情况兜底为直接用麦克风原始轨。
      const tracks: MediaStreamTrack[] = [...videoTracks]
      const micAudioTrack = micStream?.getAudioTracks()[0] ?? null
      const tabAudioTrack =
        args.systemAudio && tabStream.getAudioTracks().length > 0
          ? tabStream.getAudioTracks()[0]
          : null

      // 回放系统声音：tabCapture 会静音页面，用 <audio> 把采集到的 tab 音频播出来。
      // 用 clone() 的独立轨道回放，避免与送去 MediaRecorder 的同一轨道相互抢占
      // 导致录到的音频出现卡顿 / 乱码。
      if (tabAudioTrack) {
        try {
          const monitorTrack = tabAudioTrack.clone()
          const monitor = document.createElement("audio")
          monitor.autoplay = true
          ;(monitor as HTMLAudioElement).srcObject = new MediaStream([
            monitorTrack
          ])
          monitor.style.display = "none"
          document.documentElement.appendChild(monitor)
          void monitor.play().catch(() => undefined)
          const prevCancel = cropCancel
          cropCancel = () => {
            try {
              if (prevCancel) prevCancel()
            } catch {
              /* 忽略 */
            }
            try {
              monitor.pause()
              ;(monitor as HTMLAudioElement).srcObject = null
              monitor.remove()
              monitorTrack.stop()
            } catch {
              /* 忽略 */
            }
          }
        } catch {
          /* 回放失败不影响录制 */
        }
      }

      // 录制音轨
      if (micAudioTrack && tabAudioTrack) {
        // 两路都有：WebAudio 混成单条（MediaRecorder 只编第一条音轨）
        let mixed: MediaStreamTrack | null = null
        try {
          const mixCtx = new AudioContext()
          if (mixCtx.state === "suspended") await mixCtx.resume()
          if (mixCtx.state === "running") {
            const dest = mixCtx.createMediaStreamDestination()
            mixCtx
              .createMediaStreamSource(new MediaStream([tabAudioTrack]))
              .connect(dest)
            mixCtx
              .createMediaStreamSource(new MediaStream([micAudioTrack]))
              .connect(dest)
            mixed = dest.stream.getAudioTracks()[0] ?? null
          }
        } catch {
          mixed = null
        }
        // 混音不可用（context 挂起等）→ 至少保住麦克风人声
        tracks.push(mixed ?? micAudioTrack)
      } else if (micAudioTrack) {
        tracks.push(micAudioTrack)
      } else if (tabAudioTrack) {
        // 纯系统声音：直接用原始 tab 音频轨（不经可能挂起的 AudioContext）
        tracks.push(tabAudioTrack)
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
      // 展开态才显示暂停/停止；收起态保持最小化
      if (!collapsed) {
        pauseBtn.style.display = "inline-flex"
        stopBtn.style.display = "inline-flex"
      }

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
