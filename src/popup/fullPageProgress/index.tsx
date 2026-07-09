import { useEffect, useMemo, useState } from "react"

import {
  cancelFullPageCapture,
  getFullPageCaptureProgress
} from "~src/services/capture"
import {
  MessageType,
  type CaptureFullPageProgressState
} from "~src/shared/messages"

import * as styles from "../index.module.css"

function FullPageProgressWindow() {
  const expectedTaskId = useMemo(
    () => new URLSearchParams(window.location.search).get("taskId"),
    []
  )
  const [progress, setProgress] = useState<CaptureFullPageProgressState | null>(
    null
  )

  useEffect(() => {
    let alive = true
    getFullPageCaptureProgress().then((res) => {
      if (!alive || !res.ok || !res.progress) return
      if (expectedTaskId && res.progress.taskId !== expectedTaskId) return
      setProgress(res.progress)
    })

    const listener = (msg: unknown) => {
      const req = msg as {
        type?: string
        payload?: CaptureFullPageProgressState
      }
      if (req.type !== MessageType.CAPTURE_FULL_PAGE_PROGRESS || !req.payload) {
        return
      }
      if (expectedTaskId && req.payload.taskId !== expectedTaskId) return
      setProgress(req.payload)
    }
    chrome.runtime.onMessage.addListener(listener)
    return () => {
      alive = false
      chrome.runtime.onMessage.removeListener(listener)
    }
  }, [expectedTaskId])

  const phase = progress?.phase ?? "capturing"
  const total = Math.max(1, progress?.total ?? 1)
  const current = Math.max(0, Math.min(progress?.current ?? 0, total))
  const percent = Math.round((current / total) * 100)
  const showBar = phase === "capturing"
  const title =
    phase === "stitching"
      ? "正在拼接"
      : phase === "cancelled"
        ? "已停止"
        : phase === "error"
          ? "截图失败"
          : phase === "done"
            ? "已完成"
            : "正在长截图"

  const stop = async () => {
    await cancelFullPageCapture()
  }

  return (
    <div className={styles.progressWindow}>
      <div className={styles.progressTitle}>{title}</div>
      {showBar ? (
        <>
          <div className={styles.progressMeta}>
            <span>{progress?.message ?? "正在滚动并截图"}</span>
            <span>{percent}%</span>
          </div>
          <div className={styles.progressTrack}>
            <div
              className={styles.progressFill}
              style={{ width: `${percent}%` }}
            />
          </div>
          <button type="button" className={styles.stopBtn} onClick={stop}>
            强制停止
          </button>
        </>
      ) : (
        <div className={styles.progressMessage}>
          {progress?.error ?? progress?.message ?? title}
        </div>
      )}
    </div>
  )
}

export default FullPageProgressWindow
