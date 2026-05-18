/**
 * 截图面板
 *
 * 已接入：
 * - 可视区域（visible）：通过 background 调用 chrome.tabs.captureVisibleTab，
 *   并触发 chrome.downloads.download 下载 png 图片
 *
 * 其余按钮逻辑后续补充
 */
import { useState } from "react"

import { CloudIcon } from "~src/components/icons"
import {
  CAPTURE_CARD_ACTIONS,
  CAPTURE_LIST_ACTIONS
} from "~src/constants/captureActions"
import { captureVisibleArea } from "~src/services/capture"
import type { CaptureAction, CaptureMode } from "~src/types/popup"

import * as styles from "./CapturePanel.module.css"

function CapturePanel() {
  const [busy, setBusy] = useState<CaptureMode | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleAction = async (mode: CaptureMode) => {
    if (busy) return
    setError(null)

    switch (mode) {
      case "visible": {
        setBusy(mode)
        const res = await captureVisibleArea({ format: "png" })
        setBusy(null)
        if (!res.ok) {
          setError(res.error ?? "截图失败")
        } else {
          // 截图成功后关闭 popup，让用户回到下载条/页面
          window.close()
        }
        break
      }
      default: {
        // TODO: 其他截图模式
        console.log("[capture] action not implemented:", mode)
      }
    }
  }

  return (
    <div className={styles.panel}>
      {/* 顶部卡片区 */}
      <div className={styles.cardGroup}>
        {CAPTURE_CARD_ACTIONS.map((action) => (
          <CaptureCard
            key={action.key}
            action={action}
            loading={busy === action.key}
            onClick={() => handleAction(action.key)}
          />
        ))}
      </div>

      {/* 列表项区 */}
      <ul className={styles.list}>
        {CAPTURE_LIST_ACTIONS.map((action) => (
          <li key={action.key}>
            <button
              type="button"
              className={styles.listItem}
              disabled={action.disabled || busy !== null}
              onClick={() => handleAction(action.key)}>
              <span className={styles.listIcon}>{action.icon}</span>
              <span className={styles.listLabel}>{action.label}</span>
            </button>
          </li>
        ))}
      </ul>

      {/* 错误提示 */}
      {error && <div className={styles.errorTip}>{error}</div>}

      {/* 底部存储位置 */}
      <div className={styles.footer}>
        <span className={styles.footerLabel}>把截屏存储到</span>
        <button type="button" className={styles.storageBtn}>
          <CloudIcon width={14} height={14} />
          <span>云端</span>
        </button>
      </div>
    </div>
  )
}

interface CaptureCardProps {
  action: CaptureAction
  loading?: boolean
  onClick: () => void
}

function CaptureCard({ action, loading, onClick }: CaptureCardProps) {
  return (
    <button
      type="button"
      className={styles.card}
      disabled={action.disabled || loading}
      onClick={onClick}>
      <span className={styles.cardIcon}>{action.icon}</span>
      <span className={styles.cardLabel}>
        {loading ? "处理中…" : action.label}
      </span>
    </button>
  )
}

export default CapturePanel
