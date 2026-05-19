/**
 * 屏幕共享截图：在「中转扩展窗口」中执行的核心逻辑
 *
 * 调用方：popup 入口（popup.html?action=desktopCapture）通过 chrome.windows.create
 * 被打开为独立小窗口，加载完成后立即调用本函数：
 *
 *   1. navigator.mediaDevices.getDisplayMedia → 弹出系统级共享选择器
 *      （即「选择要分享什么 / 整个屏幕 / 窗口」对话框）
 *   2. 把流绑到 <video>，等首帧解码
 *   3. 抓帧到 <canvas>，转 dataUrl
 *   4. 立即关闭所有 track，释放屏幕共享
 *
 * 为什么必须在独立扩展窗口里调用？
 *   - getDisplayMedia 需要「持有用户手势 + 拥有 DOM 上下文」
 *   - service worker 没有 DOM；注入到普通页面又会丢失用户手势
 *   - 由 popup 触发 chrome.windows.create 打开的扩展自有窗口，
 *     既保留了用户手势，也是稳定的扩展 origin
 */

export interface DesktopCaptureResult {
  ok: boolean
  /** 成功时返回 base64 dataUrl */
  dataUrl?: string
  cancelled?: boolean
  error?: string
}

export interface CaptureDesktopOptions {
  format: "png" | "jpeg"
  quality?: number
  /**
   * 在拿到 MediaStream 之后、开始抓帧之前调用。
   * 典型用途：把中转窗口最小化，避免它出现在屏幕共享画面里。
   */
  beforeCapture?: () => Promise<void> | void
}

export async function captureDesktopFrame(
  options: CaptureDesktopOptions
): Promise<DesktopCaptureResult> {
  const { format, quality, beforeCapture } = options
  let stream: MediaStream | null = null

  try {
    // 1) 调起系统级共享选择器
    //
    // 关键选项（参考 https://developer.chrome.google.cn/docs/web-platform/screen-sharing-controls）：
    //   - displaySurface: "monitor"   默认聚焦「整个屏幕」标签，与按钮语义一致
    //   - monitorTypeSurfaces: "include"   显示「整个屏幕」选项（Chrome 默认 include，写出来更明确）
    //   - selfBrowserSurface: "include"   允许共享自己的浏览器窗口/标签
    //                                     （Chrome 默认 exclude → 会让「Chrome 标签页」分类几乎为空）
    //   - surfaceSwitching: "exclude"     一次性截图无需切换源
    //   - systemAudio: "exclude"          截图场景不需要系统音频
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        displaySurface: "monitor",
        // 提高分辨率上限，让浏览器尽可能给原生大小
        width: { ideal: 7680 },
        height: { ideal: 4320 }
      } as MediaTrackConstraints,
      audio: false,
      // 下面这几个是 DisplayMediaStreamOptions 上的字段，TS 内置类型可能未完整收录，
      // 故用类型断言放宽
      ...({
        monitorTypeSurfaces: "include",
        selfBrowserSurface: "include",
        surfaceSwitching: "exclude",
        systemAudio: "exclude"
      } as Record<string, string>)
    } as DisplayMediaStreamOptions)
  } catch (err) {
    // 用户在选择器里点「取消」/关闭弹窗 → NotAllowedError 或 AbortError
    const name = (err as DOMException)?.name
    if (name === "NotAllowedError" || name === "AbortError") {
      return { ok: false, cancelled: true, error: "已取消" }
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }

  try {
    // 2) 让调用方先做准备工作（hideRelayWindow 会把本窗口移到屏幕外，
    //    并在 background 中等待 OS 动画结束后再 resolve；本上下文不用
    //    再额外 sleep）
    if (beforeCapture) {
      await beforeCapture()
    }

    // 3) 用 video 元素消费流
    const video = document.createElement("video")
    video.muted = true
    video.playsInline = true
    video.srcObject = stream

    await video.play()

    // 等到至少一帧就绪
    await new Promise<void>((resolve, reject) => {
      const tryResolve = () => {
        if (video.readyState >= 2 && video.videoWidth > 0) {
          requestAnimationFrame(() => resolve())
        }
      }
      tryResolve()
      video.onloadeddata = tryResolve
      video.onerror = () => reject(new Error("视频加载失败"))
      // 兜底超时
      setTimeout(() => reject(new Error("视频加载超时")), 5000)
    })

    // 再额外丢一帧，确保拿到的是「窗口已移走之后」的画面
    await new Promise<void>((r) => setTimeout(r, 100))

    const w = video.videoWidth
    const h = video.videoHeight
    if (!w || !h) throw new Error("无法读取视频帧尺寸")

    // 4) 抓帧到 canvas
    const canvas = document.createElement("canvas")
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext("2d")
    if (!ctx) throw new Error("无法获取 canvas 2D 上下文")
    ctx.drawImage(video, 0, 0, w, h)

    const dataUrl = canvas.toDataURL(
      `image/${format}`,
      format === "jpeg" && quality != null ? quality / 100 : undefined
    )

    video.pause()
    video.srcObject = null

    return { ok: true, dataUrl }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }
  } finally {
    // 5) 一定要停止 track，否则浏览器顶部会持续显示「正在共享屏幕」
    stream?.getTracks().forEach((t) => t.stop())
  }
}
