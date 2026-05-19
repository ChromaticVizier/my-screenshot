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

import * as styles from "./index.module.css"

interface BootConfig {
  streamId: string
  tabId: number
  tabTitle: string
  microphone: boolean
  systemAudio: boolean
  filename: string
}

const RECORDER_BOOT_KEY = "__recorderBoot"

type Phase = "loading" | "recording" | "saving" | "done" | "error"

function OffscreenRecorder() {
  const [phase, setPhase] = useState<Phase>("loading")
  const [errMsg, setErrMsg] = useState<string>("")
  const startedRef = useRef(false)

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    void start()

    async function start() {
      let mediaRecorder: MediaRecorder | null = null
      let combinedStream: MediaStream | null = null
      let micStream: MediaStream | null = null
      let blobUrl = ""
      let finalized = false
      const chunks: Blob[] = []

      const cleanupTracks = () => {
        try {
          combinedStream?.getTracks().forEach((t) => t.stop())
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
        const constraints = {
          audio: boot.systemAudio
            ? {
                mandatory: {
                  chromeMediaSource: "tab",
                  chromeMediaSourceId: boot.streamId
                }
              }
            : false,
          video: {
            mandatory: {
              chromeMediaSource: "tab",
              chromeMediaSourceId: boot.streamId
            }
          }
        } as unknown as MediaStreamConstraints

        const tabStream = await navigator.mediaDevices.getUserMedia(constraints)

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

        const tracks: MediaStreamTrack[] = []
        tabStream.getVideoTracks().forEach((t) => tracks.push(t))
        if (boot.systemAudio) {
          tabStream.getAudioTracks().forEach((t) => tracks.push(t))
        }

        // 3) 麦克风
        if (boot.microphone) {
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

        // 4) MediaRecorder：仅 webm（Chrome 唯一稳定支持的录制容器）
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
          try {
            setPhase("saving")
            const blob = new Blob(chunks, { type: mimeType })
            blobUrl = URL.createObjectURL(blob)

            await chrome.downloads.download({
              url: blobUrl,
              filename: boot.filename,
              saveAs: false
            })

            setPhase("done")
            // 给浏览器读取 blob 留时间，再 revoke
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

        // 用户在 Chrome 共享栏点「停止」会让 video track ended
        tabStream.getVideoTracks().forEach((t) => {
          t.addEventListener("ended", () => {
            if (mediaRecorder && mediaRecorder.state !== "inactive") {
              mediaRecorder.stop()
            }
          })
        })

        // 不传 timeslice：让 MediaRecorder 在 stop() 时一次性产出完整 webm
        mediaRecorder.start()
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
            mediaRecorder.stop()
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

  return (
    <div className={styles.window}>
      <div className={styles.title}>录屏中</div>
      {phase === "loading" && <div className={styles.body}>启动中…</div>}
      {phase === "recording" && <div className={styles.body}>录制中</div>}
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

export default OffscreenRecorder
