/**
 * 麦克风授权窗口
 *
 * 由 background 以 type:"normal" 拉起（popup.html?action=micPermission）。
 * normal 窗口具备完整权限 UI，Windows 版 Chrome/Edge 下能正常弹出麦克风
 * 授权框（popup 类型窗口没有该 UI 载体，会静默失败、不弹框）。
 *
 * 流程：
 *   1) 挂载后立即 navigator.mediaDevices.getUserMedia({ audio }) 触发授权框
 *   2) 无论此前是否已授权都会走一遍，用于刷新授权状态
 *   3) 拿到结果后立刻停掉音轨（本窗口不录音，仅用于取得 origin 授权）
 *   4) 把 granted 结果回传 background，由其结束录制门禁并关闭本窗口
 */
import { useEffect, useState } from "react"

import { MessageType } from "~src/shared/messages"

import * as styles from "./index.module.css"

type Phase = "requesting" | "granted" | "denied"

function MicPermissionWindow() {
  const [phase, setPhase] = useState<Phase>("requesting")
  const [errMsg, setErrMsg] = useState<string>("")

  useEffect(() => {
    let done = false
    const report = (granted: boolean, error?: string) => {
      if (done) return
      done = true
      chrome.runtime
        .sendMessage({
          type: MessageType.MIC_PERMISSION_RESULT,
          payload: { granted, ...(error ? { error } : {}) }
        })
        .catch(() => undefined)
    }

    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          }
        })
        // 仅为取得 origin 授权，取得后立即释放设备
        stream.getTracks().forEach((t) => t.stop())
        setPhase("granted")
        report(true)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        setErrMsg(msg)
        setPhase("denied")
        report(false, msg)
      }
    })()
  }, [])

  return (
    <div className={styles.window}>
      <h3 className={styles.title}>麦克风授权</h3>
      {phase === "requesting" && (
        <p className={styles.body}>
          请在浏览器弹出的授权框中点击「允许」，以便录屏时录入麦克风声音。
        </p>
      )}
      {phase === "granted" && (
        <p className={styles.body}>已获得麦克风授权，正在开始录制…</p>
      )}
      {phase === "denied" && (
        <p className={styles.error}>
          未获得麦克风授权，本次将不录入麦克风。
          {errMsg ? <span className={styles.hint}>（{errMsg}）</span> : null}
        </p>
      )}
    </div>
  )
}

export default MicPermissionWindow
