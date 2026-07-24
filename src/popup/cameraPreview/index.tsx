import { useEffect, useRef, useState } from "react"

import * as styles from "./index.module.css"

function CameraPreviewWindow() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState("")

  useEffect(() => {
    let stream: MediaStream | null = null
    let cancelled = false

    void start()

    async function start() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 640 },
            height: { ideal: 360 },
            frameRate: { ideal: 30 }
          },
          audio: false
        })
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }
        const video = videoRef.current
        if (video) {
          video.srcObject = stream
          await video.play().catch(() => undefined)
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    }

    return () => {
      cancelled = true
      stream?.getTracks().forEach((track) => track.stop())
    }
  }, [])

  return (
    <div className={styles.preview}>
      <video ref={videoRef} className={styles.video} muted playsInline />
      {error && <div className={styles.error}>摄像头不可用</div>}
    </div>
  )
}

export default CameraPreviewWindow
