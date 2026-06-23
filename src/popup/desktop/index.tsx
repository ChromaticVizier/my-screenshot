/**
 * 「整个屏幕或应用窗口」中转窗口
 *
 * 当 popup.html 被以 `?action=desktopCapture` 打开时（由 background 通过
 * chrome.windows.create 拉起），渲染本组件而非主截图面板。
 *
 * 流程：
 *   1) 显示「准备共享屏幕…」过渡 UI
 *   2) 调 captureDesktopFrame() → 弹出系统级共享选择器
 *   3) 拿到 dataUrl 后通过消息把图交给 background 下载
 *   4) 关闭本窗口
 *
 * 失败/取消时显示提示并允许用户手动关闭。
 */
import { useEffect, useRef, useState } from "react"

import {
  closeRelayWindow,
  downloadDesktopImage,
  hideRelayWindow
} from "~src/services/desktopBridge"
import { getSettings } from "~src/shared/settings"

import * as styles from "./index.module.css"

import { captureDesktopFrame } from "./captureDesktop"

type Phase = "preparing" | "sharing" | "downloading" | "done" | "error"

function DesktopCaptureWindow() {
  const [phase, setPhase] = useState<Phase>("preparing")
  const [errMsg, setErrMsg] = useState<string>("")
  // 防止 React StrictMode 双触发
  const startedRef = useRef(false)

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true

    void run()

    async function run() {
      try {
        setPhase("sharing")
        const settings = await getSettings()
        const format = settings.imageFormat
        const quality = settings.imageQuality
        const result = await captureDesktopFrame({
          format,
          quality,
          // 拿到流之后、抓帧之前，把本中转窗口移到屏幕外，
          // 避免在「整个屏幕」截图里把自己也截进去
          beforeCapture: () => hideRelayWindow()
        })

        if (!result.ok) {
          if (result.cancelled) {
            // 用户取消：直接销毁本窗口
            await closeRelayWindow()
            return
          }
          throw new Error(result.error ?? "屏幕截图失败")
        }
        if (!result.dataUrl) throw new Error("屏幕截图失败：返回数据为空")

        setPhase("downloading")
        const res = await downloadDesktopImage({
          dataUrl: result.dataUrl,
          format
        })
        if (!res.ok) throw new Error(res.error ?? "下载失败")

        // 成功：直接销毁中转窗口（窗口此刻在屏幕外，用户根本看不到，
        // 也无需「已保存 ✓」的过渡 UI）
        await closeRelayWindow()
      } catch (err) {
        setErrMsg(err instanceof Error ? err.message : String(err))
        setPhase("error")
      }
    }
  }, [])

  return (
    <div className={styles.window}>
      <div className={styles.title}>屏幕截图</div>

      {phase === "preparing" && (
        <div className={styles.body}>正在准备屏幕共享…</div>
      )}
      {phase === "sharing" && (
        <div className={styles.body}>请在弹出的窗口中选择要截图的屏幕或窗口</div>
      )}
      {phase === "downloading" && (
        <div className={styles.body}>正在保存图片…</div>
      )}
      {phase === "done" && <div className={styles.body}>已保存 ✓</div>}

      {phase === "error" && (
        <div className={styles.error}>
          <p>失败：{errMsg}</p>
          <button
            type="button"
            className={styles.closeBtn}
            onClick={() => closeRelayWindow()}>
            关闭
          </button>
        </div>
      )}
    </div>
  )
}

export default DesktopCaptureWindow
