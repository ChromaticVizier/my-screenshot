/**
 * 录屏「中转扩展窗口」（offscreen recorder）
 *
 * popup.html?action=offscreenRecorder 通过 chrome.windows.create 由 background
 * 拉起，加载完成后立刻：
 *   1) 从 chrome.storage.local 读取本次录制的启动配置（streamId / 选项 / 文件名）
 *   2) navigator.mediaDevices.getUserMedia 用 chromeMediaSourceId 消费 streamId
 *   3) MediaRecorder 启动，监听 RECORDER_STOP / PAUSE / RESUME 消息驱动状态
 *   4) onstop：URL.createObjectURL(blob) → chrome.downloads.download 下载
 *   5) 通知 background → background 关闭本窗口、清理会话
 *
 * 为什么 MediaRecorder 必须放在这里而不是目标 tab 的注入脚本：
 *   - 注入脚本运行在普通网页进程，部分 Chrome 版本下产出的 webm Duration
 *     缺失且字节布局异常，Chrome 内置播放器无法解析（控件灰、时间 0）
 *   - 扩展自有 origin 的中转窗口里 MediaRecorder 输出与社区主流录屏扩展
 *     一致，文件可被 Chrome / VLC / 系统播放器正常播放
 *
 * 窗口由 background 在创建后立刻挪到屏幕外（与屏幕截图中转窗口同样的手法），
 * 用户看不见。
 */
import { useEffect, useRef, useState } from "react"

import {
  RESOLUTION_MAX_PIXELS,
  type RecordResolution
} from "~src/shared/recordOptions"

import * as styles from "./index.module.css"

interface BootRegion {
  x: number
  y: number
  width: number
  height: number
  devicePixelRatio: number
  viewportWidth?: number
  viewportHeight?: number
}

interface BootConfig {
  streamId: string
  tabId: number
  tabTitle: string
  microphone: boolean
  systemAudio: boolean
  resolution?: RecordResolution
  filename: string
  /** 区域录制：裁剪矩形（CSS 像素 + dpr）。省略 = 录整个视口 */
  region?: BootRegion
}

const RECORDER_BOOT_KEY = "__recorderBoot"

type Phase = "loading" | "recording" | "saving" | "done" | "error"

function OffscreenRecorder() {
  const [phase, setPhase] = useState<Phase>("loading")
  const [errMsg, setErrMsg] = useState<string>("")
  const [paused, setPaused] = useState(false)
  const [elapsedMs, setElapsedMs] = useState(0)
  const startedRef = useRef(false)
  // 录制起点（MediaRecorder.start() 瞬间）与暂停累计时长，供窗口内计时使用
  const startTimeRef = useRef(0)
  const pausedAccumRef = useRef(0)
  const pauseStartRef = useRef(0)

  // 计时：仅在 recording 且未暂停时推进
  useEffect(() => {
    if (phase !== "recording" || paused) return
    const tick = () => {
      if (startTimeRef.current > 0) {
        setElapsedMs(
          Math.max(0, Date.now() - startTimeRef.current - pausedAccumRef.current)
        )
      }
    }
    tick()
    const id = window.setInterval(tick, 250)
    return () => window.clearInterval(id)
  }, [phase, paused])

  const handlePauseToggle = () => {
    if (paused) {
      // 恢复：累计本次暂停时长
      if (pauseStartRef.current > 0) {
        pausedAccumRef.current += Date.now() - pauseStartRef.current
        pauseStartRef.current = 0
      }
      setPaused(false)
      chrome.runtime
        .sendMessage({ type: "recorder/resume" })
        .catch(() => undefined)
    } else {
      pauseStartRef.current = Date.now()
      setPaused(true)
      chrome.runtime
        .sendMessage({ type: "recorder/pause" })
        .catch(() => undefined)
    }
  }

  const handleStop = () => {
    chrome.runtime.sendMessage({ type: "record/stop" }).catch(() => undefined)
  }

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    void start()

    async function start() {
      let mediaRecorder: MediaRecorder | null = null
      let combinedStream: MediaStream | null = null
      let micStream: MediaStream | null = null
      let tabStreamRef: MediaStream | null = null
      let blobUrl = ""
      let finalized = false
      let cropCancel: (() => void) | null = null
      const chunks: Blob[] = []
      // 收尾函数：onstop 与停止兜底共用；在 mediaRecorder 建好后赋值。
      let finalizeRecording: () => Promise<void> = async () => {}

      const cleanupTracks = () => {
        try {
          if (cropCancel) cropCancel()
          combinedStream?.getTracks().forEach((t) => t.stop())
          tabStreamRef?.getTracks().forEach((t) => t.stop())
          micStream?.getTracks().forEach((t) => t.stop())
        } catch {
          /* 忽略 */
        }
      }

      const finish = async (params: {
        cancelled?: boolean
        error?: string
      }) => {
        if (finalized) return
        finalized = true
        cleanupTracks()
        try {
          await chrome.runtime.sendMessage({
            type: "recorder/finish",
            payload: params
          })
        } catch {
          /* background 已关闭等情况，忽略 */
        }
      }

      try {
        // 1) 读启动配置
        const store = await chrome.storage.local.get(RECORDER_BOOT_KEY)
        const boot = store[RECORDER_BOOT_KEY] as BootConfig | undefined
        if (!boot?.streamId) {
          throw new Error("未找到录制启动配置")
        }

        // 2) 用 streamId 拿 MediaStream
        //    注：chromeMediaSource:"tab" 是 Chrome 私有约束，不走 getDisplayMedia
        //    分辨率上限：仅整页录制时应用；区域录制会经 WebCodecs 裁剪，
        //    源用原生分辨率以保证裁剪坐标精度
        const videoMandatory: Record<string, string | number> = {
          chromeMediaSource: "tab",
          chromeMediaSourceId: boot.streamId
        }
        if (!boot.region && boot.resolution) {
          const cap = RESOLUTION_MAX_PIXELS[boot.resolution]
          if (cap) {
            videoMandatory.maxWidth = cap.width
            videoMandatory.maxHeight = cap.height
          }
        }
        const constraints = {
          audio: boot.systemAudio
            ? {
                mandatory: {
                  chromeMediaSource: "tab",
                  chromeMediaSourceId: boot.streamId
                }
              }
            : false,
          video: { mandatory: videoMandatory }
        } as unknown as MediaStreamConstraints

        const tabStream = await navigator.mediaDevices.getUserMedia(constraints)
        tabStreamRef = tabStream

        // 把 tabCapture 拿到的音频接回 destination，让用户依然能听到页面声音
        if (boot.systemAudio) {
          try {
            const audioCtx = new AudioContext()
            const source = audioCtx.createMediaStreamSource(tabStream)
            source.connect(audioCtx.destination)
          } catch {
            /* 音频上下文创建失败不影响录制 */
          }
        }

        // 3) 麦克风
        if (boot.microphone) {
          try {
            micStream = await navigator.mediaDevices.getUserMedia({
              audio: { echoCancellation: true, noiseSuppression: true }
            })
          } catch (err) {
            console.warn("[recorder] 麦克风获取失败", err)
          }
        }

        // 4) 组装最终 MediaStream
        //    - 视频：整页录制 → 直接用 tab 视频；区域录制 → 通过 canvas 裁剪
        //    - 音频：tab 音频（systemAudio）+ 麦克风（按选项叠加）
        let finalVideoTracks: MediaStreamTrack[]
        if (boot.region) {
          finalVideoTracks = await buildCroppedVideoTracks(
            tabStream,
            boot.region,
            (cancel) => {
              cropCancel = cancel
            }
          )
        } else {
          finalVideoTracks = tabStream.getVideoTracks()
        }

        const tracks: MediaStreamTrack[] = [...finalVideoTracks]
        if (boot.systemAudio) {
          tabStream.getAudioTracks().forEach((t) => tracks.push(t))
        }
        if (micStream) {
          micStream.getAudioTracks().forEach((t) => tracks.push(t))
        }

        combinedStream = new MediaStream(tracks)

        // 5) MediaRecorder：仅 webm（Chrome 唯一稳定支持的录制容器）
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
        finalizeRecording = async () => {
          if (finalized) return
          try {
            setPhase("saving")
            if (chunks.length === 0) {
              throw new Error("未录到任何帧（编码失败）")
            }
            const blob = new Blob(chunks, { type: mimeType })
            blobUrl = URL.createObjectURL(blob)

            await chrome.downloads.download({
              url: blobUrl,
              filename: boot.filename,
              saveAs: false
            })

            setPhase("done")
            window.setTimeout(() => {
              try {
                URL.revokeObjectURL(blobUrl)
              } catch {
                /* 忽略 */
              }
            }, 60_000)

            await finish({})
          } catch (err) {
            setErrMsg(err instanceof Error ? err.message : String(err))
            setPhase("error")
            await finish({
              error: err instanceof Error ? err.message : String(err)
            })
          }
        }
        mediaRecorder.onstop = finalizeRecording

        // 用户在 Chrome 共享栏点「停止」会让 tab 视频 track ended
        tabStream.getVideoTracks().forEach((t) => {
          t.addEventListener("ended", () => {
            if (mediaRecorder && mediaRecorder.state !== "inactive") {
              mediaRecorder.stop()
            }
          })
        })

        // 不传 timeslice：让 MediaRecorder 在 stop() 时一次性产出完整 webm
        mediaRecorder.start()
        // 记录真实起点，供窗口内计时使用
        startTimeRef.current = Date.now()
        // 把"真正的起点"回传 background，覆盖 bootstrap 时设的 startedAt
        // （后者包含创建窗口+加载popup+getUserMedia 等约 1s 准备时间，
        //  否则控制栏计时会比实际视频时长多约 1 秒）
        try {
          await chrome.runtime.sendMessage({
            type: "recorder/started",
            payload: { startedAt: Date.now() }
          })
        } catch {
          /* 忽略 */
        }
        setPhase("recording")
      } catch (err) {
        setErrMsg(err instanceof Error ? err.message : String(err))
        setPhase("error")
        await finish({
          error: err instanceof Error ? err.message : String(err)
        })
        return
      }

      /* ---------- 监听消息：停止 / 暂停 / 继续 ---------- */
      const listener = (msg: { type?: string }) => {
        if (!mediaRecorder) return
        if (msg?.type === "recorder/stop") {
          if (mediaRecorder.state !== "inactive") {
            try {
              mediaRecorder.stop()
            } catch {
              /* 忽略 */
            }
            // 兜底：某些情况下（如区域录制 generator 轨已结束）onstop 可能不触发，
            // 2s 后仍未 finalize 就手动收尾，保证用户点“结束录制”一定有反馈。
            window.setTimeout(() => {
              if (!finalized) void finalizeRecording()
            }, 2000)
          } else if (!finalized) {
            // 录制轨已提前结束、recorder 已 inactive：直接收尾
            void finalizeRecording()
          }
        } else if (msg?.type === "recorder/pause") {
          if (mediaRecorder.state === "recording") {
            mediaRecorder.pause()
          }
        } else if (msg?.type === "recorder/resume") {
          if (mediaRecorder.state === "paused") {
            mediaRecorder.resume()
          }
        }
      }
      chrome.runtime.onMessage.addListener(listener)
    }
  }, [])

  const fmtTime = (ms: number) => {
    const total = Math.floor(ms / 1000)
    const m = Math.floor(total / 60)
    const s = total % 60
    return `${m}:${String(s).padStart(2, "0")}`
  }

  return (
    <div className={styles.window}>
      <div className={styles.header}>
        <span className={styles.dot} data-paused={paused} />
        <span className={styles.title}>
          {phase === "recording"
            ? paused
              ? "已暂停"
              : "录制中"
            : phase === "saving"
              ? "保存中…"
              : phase === "done"
                ? "已保存"
                : phase === "error"
                  ? "录制失败"
                  : "启动中…"}
        </span>
        <span className={styles.timer}>{fmtTime(elapsedMs)}</span>
      </div>

      {phase === "recording" && (
        <div className={styles.controls}>
          <button
            type="button"
            className={styles.ctrlBtn}
            onClick={handlePauseToggle}>
            {paused ? "继续" : "暂停"}
          </button>
          <button
            type="button"
            className={`${styles.ctrlBtn} ${styles.stopBtn}`}
            onClick={handleStop}>
            结束录制
          </button>
        </div>
      )}

      {phase === "loading" && <div className={styles.body}>启动中…</div>}
      {phase === "saving" && <div className={styles.body}>保存中…</div>}
      {phase === "done" && <div className={styles.body}>已保存 ✓</div>}
      {phase === "error" && (
        <div className={styles.error}>
          <p>失败：{errMsg}</p>
        </div>
      )}
    </div>
  )
}

/**
 * 把 tab 视频 stream 裁剪到 region。
 *
 * **采用 WebCodecs Insertable Streams 在帧层面裁剪**（Chrome 94+）：
 *   原 tab video track
 *     → MediaStreamTrackProcessor → ReadableStream<VideoFrame>
 *     → TransformStream：用 new VideoFrame(src, { visibleRect, ... }) 裁剪，
 *        关键是**保留原 frame.timestamp**
 *     → MediaStreamTrackGenerator → 输出新的 video track
 *
 * 为什么不再用 canvas.captureStream:
 *   canvas.captureStream 输出的 track 没有真实 frame timestamp 源 ——
 *   MediaRecorder 写出的 webm Cluster timecode / Duration 元数据异常，
 *   Chrome 内置播放器拒绝渲染（控件灰、时间 0）。
 *   Insertable Streams 路径下输出 track 的每一帧带有从源 track 继承的
 *   timestamp，MediaRecorder 写出的 webm 与整页录制路径性质一致，可正常播放。
 *
 * 坐标换算：
 *   tabCapture 输出帧的物理像素 = 目标 tab CSS 像素 × devicePixelRatio
 *   VideoFrame.visibleRect 接受物理像素坐标，所以 = region × dpr
 */
async function buildCroppedVideoTracks(
  tabStream: MediaStream,
  region: BootRegion,
  onSetup: (cancel: () => void) => void
): Promise<MediaStreamTrack[]> {
  const srcTrack = tabStream.getVideoTracks()[0]
  if (!srcTrack) throw new Error("源视频轨道为空")

  // 检查 API 可用性
  const win = window as unknown as {
    MediaStreamTrackProcessor?: new (init: { track: MediaStreamTrack }) => {
      readable: ReadableStream<VideoFrame>
    }
    MediaStreamTrackGenerator?: new (init: { kind: "video" }) => MediaStreamTrack & {
      writable: WritableStream<VideoFrame>
    }
  }
  if (!win.MediaStreamTrackProcessor || !win.MediaStreamTrackGenerator) {
    throw new Error(
      "当前浏览器不支持 WebCodecs Insertable Streams（需 Chrome 94+）"
    )
  }

  const dpr = region.devicePixelRatio || 1
  // 录制期页面上留有的红色选区边框（2px + 2px 外阴影），会被 tabCapture 录进去。
  // 裁剪时向内缩进 3px（略大于边框），确保视频里不残留红框。
  const FRAME_BORDER = 3
  const selX = region.x + FRAME_BORDER
  const selY = region.y + FRAME_BORDER
  const selW = Math.max(1, region.width - FRAME_BORDER * 2)
  const selH = Math.max(1, region.height - FRAME_BORDER * 2)

  const processor = new win.MediaStreamTrackProcessor({ track: srcTrack })
  const generator = new win.MediaStreamTrackGenerator({ kind: "video" })

  // 首帧时间戳基准：把输出帧 timestamp 重映射为「相对录制起点」，
  // 保证 webm Cluster timecode 从 0 起、Duration 正常、与音频轨对齐。
  let baseTimestamp: number | null = null

  const transformer = new TransformStream<VideoFrame, VideoFrame>({
    transform(frame, controller) {
      // 关键修正：不假设「捕获帧尺寸 = 视口CSS × dpr」。tabCapture 的帧分辨率
      // 可能与该假设不一致（缩放/上限/多屏 dpr 差异），直接用 region×dpr 会错位。
      // 改为按「选区 / 视口」比例映射到当前帧的实际 codedWidth/Height。
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
      // tabCapture 帧可能与视口不同比例（被「等比缩放 + 居中」letterbox 进帧内）。
      // 用 object-fit:contain 映射：统一缩放系数取两轴较小者，另一轴产生居中留白偏移。
      // 之前只按宽度比例缩放、忽略竖直居中偏移，导致整体上移/下移。
      const scale = Math.min(fw / vpW, fh / vpH)
      const drawnW = vpW * scale
      const drawnH = vpH * scale
      const offX = (fw - drawnW) / 2
      const offY = (fh - drawnH) / 2
      let x = Math.round(offX + selX * scale)
      let y = Math.round(offY + selY * scale)
      let w = Math.round(selW * scale)
      let h = Math.round(selH * scale)
      // 越界裁剪保护
      x = Math.max(0, Math.min(x, Math.max(0, fw - 2)))
      y = Math.max(0, Math.min(y, Math.max(0, fh - 2)))
      w = Math.max(2, Math.min(w, fw - x))
      h = Math.max(2, Math.min(h, fh - y))
      // VP8/VP9 要求帧宽高为偶数；奇数会导致每帧编码失败、webm 损坏。
      // 对齐到偶数（起点向下取偶、尺寸向下取偶，并保证仍在帧内）。
      x -= x % 2
      y -= y % 2
      w -= w % 2
      h -= h % 2
      if (w < 2) w = 2
      if (h < 2) h = 2
      if (x + w > fw) w = fw - x - ((fw - x) % 2)
      if (y + h > fh) h = fh - y - ((fh - y) % 2)
      const srcTs = frame.timestamp ?? 0
      if (baseTimestamp === null) baseTimestamp = srcTs
      const relTs = Math.max(0, srcTs - baseTimestamp)
      try {
        const cropped = new VideoFrame(frame, {
          visibleRect: { x, y, width: w, height: h },
          timestamp: relTs
        })
        controller.enqueue(cropped)
      } catch (err) {
        // 偶发的 codedWidth/Height = 0 等情况，跳过本帧
        console.warn("[recorder] 裁剪帧失败", err)
      } finally {
        frame.close()
      }
    },
    flush() {
      /* 源 stream 关闭时 transform 会自然终止 */
    }
  })

  // pipe：source → transform → generator
  // 不 await pipeTo —— 它会在 source 关闭时才 resolve
  let pipeAborted = false
  const abortController = new AbortController()
  processor.readable
    .pipeThrough(transformer, { signal: abortController.signal })
    .pipeTo(generator.writable, { signal: abortController.signal })
    .catch((err: unknown) => {
      if (!pipeAborted) {
        console.warn("[recorder] insertable stream pipeline error", err)
      }
    })

  const cancel = () => {
    pipeAborted = true
    try {
      abortController.abort()
    } catch {
      /* 忽略 */
    }
    try {
      generator.stop()
    } catch {
      /* 忽略 */
    }
  }
  onSetup(cancel)

  return [generator]
}

export default OffscreenRecorder
