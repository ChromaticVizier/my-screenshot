import { useEffect, useRef, useState } from "react"

import * as styles from "./index.module.css"

type PermissionKind = "microphone" | "camera"

type Phase = "requesting" | "granted" | "denied"

function MicrophonePermissionWindow() {
  const params = new URLSearchParams(window.location.search)
  const kind = (params.get("kind") === "camera" ? "camera" : "microphone") as PermissionKind
  const storageKey =
    kind === "camera"
      ? "__cameraPermissionGranted"
      : "__microphonePermissionGranted"
  const title = kind === "camera" ? "摄像头授权" : "麦克风授权"
  const target = kind === "camera" ? "摄像头" : "麦克风"
  const [phase, setPhase] = useState<Phase>("requesting")
  const [errMsg, setErrMsg] = useState("")
  const startedRef = useRef(false)

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true

    void requestPermission()

    async function requestPermission() {
      try {
        const constraints: MediaStreamConstraints =
          kind === "camera"
            ? {
                video: {
                  width: { ideal: 640 },
                  height: { ideal: 360 },
                  frameRate: { ideal: 30 }
                },
                audio: false
              }
            : {
                audio: {
                  echoCancellation: true,
                  noiseSuppression: true,
                  autoGainControl: true
                }
              }
        const stream = await navigator.mediaDevices.getUserMedia(constraints)
        stream.getTracks().forEach((track) => track.stop())
        await chrome.storage.local.set({ [storageKey]: true })
        setPhase("granted")
        window.setTimeout(() => window.close(), 500)
      } catch (err) {
        await chrome.storage.local.set({ [storageKey]: false })
        setErrMsg(err instanceof Error ? err.message : String(err))
        setPhase("denied")
      }
    }
  }, [])

  return (
    <div className={styles.window}>
      <div className={styles.title}>{title}</div>
      {phase === "requesting" && (
        <div className={styles.body}>请在浏览器弹窗中允许使用{target}</div>
      )}
      {phase === "granted" && <div className={styles.body}>{target}已授权</div>}
      {phase === "denied" && (
        <div className={styles.error}>
          <p>授权失败：{errMsg}</p>
          <button
            type="button"
            className={styles.closeBtn}
            onClick={() => window.close()}>
            关闭
          </button>
        </div>
      )}
    </div>
  )
}

export default MicrophonePermissionWindow
