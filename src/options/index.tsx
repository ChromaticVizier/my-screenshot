/**
 * 设置页：使用 chrome.storage.sync 持久化用户偏好
 *
 * 当前支持：
 * - 延迟截图秒数（1 ~ 60）
 *
 * 后续可在此页继续追加：截图格式、文件名模板、默认存储位置等。
 */
import { useEffect, useState } from "react"

import {
  DEFAULT_SETTINGS,
  getSettings,
  setSettings,
  type AppSettings
} from "~src/shared/settings"

import "~src/styles/global.css"

import * as styles from "./index.module.css"

type SaveState = "idle" | "saving" | "saved"

function Options() {
  const [settings, setLocal] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [loaded, setLoaded] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>("idle")

  useEffect(() => {
    getSettings().then((s) => {
      setLocal(s)
      setLoaded(true)
    })
  }, [])

  const update = async (patch: Partial<AppSettings>) => {
    const next = { ...settings, ...patch }
    setLocal(next)
    setSaveState("saving")
    await setSettings(patch)
    setSaveState("saved")
    setTimeout(() => setSaveState("idle"), 1200)
  }

  const onDelaySecondsChange = (raw: string) => {
    const n = Number(raw)
    if (Number.isNaN(n)) return
    const clamped = Math.max(1, Math.min(60, Math.round(n)))
    update({ delaySeconds: clamped })
  }

  if (!loaded) return null

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>My Screenshot 设置</h1>
        <p className={styles.subtitle}>
          所有变更会自动保存，并通过 Chrome 同步到登录的设备。
        </p>
      </header>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>截图</h2>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="delaySeconds">
            延迟截取倒计时（秒）
          </label>
          <div className={styles.control}>
            <input
              id="delaySeconds"
              className={styles.input}
              type="number"
              min={1}
              max={60}
              step={1}
              value={settings.delaySeconds}
              onChange={(e) => onDelaySecondsChange(e.target.value)}
            />
            <span className={styles.hint}>1 ~ 60 秒；默认 3 秒</span>
          </div>
        </div>
      </section>

      <footer className={styles.footer}>
        {saveState === "saving" && <span>保存中…</span>}
        {saveState === "saved" && (
          <span className={styles.saved}>已保存 ✓</span>
        )}
      </footer>
    </div>
  )
}

export default Options
