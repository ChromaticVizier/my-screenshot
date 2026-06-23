/**
 * 截图面板
 *
 * 已接入：
 * - 可视区域（visible）：直接整屏截图后下载
 * - 整个页面（fullPage）：popup 立即关闭以让出焦点，background 继续完成滚动拼接长截图
 * - 选择区域（selection）：popup 立刻关闭以让出焦点，背景脚本继续完成选区流程
 */
import { useState } from "react"

import { getCapturableActiveTab } from "~src/background/utils/tabHelper"
import { CloudIcon } from "~src/components/icons"
import {
  CAPTURE_CARD_ACTIONS,
  CAPTURE_LIST_ACTIONS
} from "~src/constants/captureActions"
import {
  captureDelayed,
  captureDesktop,
  captureFullPage,
  captureSelection,
  captureVisibleArea,
  clearScrollRegion,
  selectScrollRegion
} from "~src/services/capture"
import type { CaptureAction, CaptureMode } from "~src/types/popup"

import * as styles from "./CapturePanel.module.css"

function CapturePanel() {
  const [busy, setBusy] = useState<CaptureMode | "scrollRegion" | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleSelectScrollRegion = async () => {
    if (busy) return
    setError(null)
    ;(window as any)._rlog?.push(['_trackCustom', 'event', [['action', 'screenshot_scroll_region_select_click'], ['from', 'capture_panel']]])
    setBusy("scrollRegion")
    const res = await selectScrollRegion()
    setBusy(null)
    if (!res.ok) {
      if (!res.cancelled) setError(res.error ?? "选择滚动区域失败")
      return
    }
    window.close()
  }

  const handleClearScrollRegion = async () => {
    if (busy) return
    setError(null)
    ;(window as any)._rlog?.push(['_trackCustom', 'event', [['action', 'screenshot_scroll_region_clear_click'], ['from', 'capture_panel']]])
    setBusy("scrollRegion")
    const res = await clearScrollRegion()
    setBusy(null)
    if (!res.ok) setError(res.error ?? "清除滚动区域失败")
  }

  const handleAction = async (mode: CaptureMode) => {
    if (busy) return
    setError(null)
    const rlog = (window as any)._rlog

    // 关闭 popup 前先校验当前页是否可截图（chrome://、扩展页、商店页等不可）。
    // selection/fullPage/delayed 会立即关闭 popup，若不在此拦截，background 返回的
    // “不允许截图”错误将无处显示（popup 已销毁）→ 表现为点完按钮没反应直接消失。
    // desktop 模式走 getDisplayMedia 截整屏 / 窗口，不依赖当前 tab，跳过该校验。
    if (mode !== "desktop") {
      const cap = await getCapturableActiveTab()
      if (!cap.ok) {
        setError(cap.error ?? "当前页面不允许截图")
        return
      }
    }

    switch (mode) {
      case "visible": {
        rlog?.push(['_trackCustom', 'event', [['action', 'screenshot_capture_visible_click'], ['from', 'capture_panel']]])
        setBusy(mode)
        const res = await captureVisibleArea()
        rlog?.push(['_trackCustom', 'event', [['action', 'screenshot_capture_visible_result'], ['result', res.ok ? 'success' : 'fail'], ...(res.ok ? [] : [['error_code', String(res.error ?? 'unknown').slice(0, 50)]])]])
        setBusy(null)
        if (!res.ok) setError(res.error ?? "截图失败")
        else window.close()
        break
      }

      case "fullPage": {
        rlog?.push(['_trackCustom', 'event', [['action', 'screenshot_capture_fullpage_click'], ['from', 'capture_panel']]])
        // 整页截图要滚动拼接好几秒，若在此 await 期间保持 popup 打开，
        // popup 会作为一个独立窗口长期驻留在屏幕上。与 selection/delayed 一致：
        // 立即关闭 popup，由 background 独立完成后续截图与下载，不影响功能。
        captureFullPage().catch(() => {
          /* popup 已关闭，错误由 background 控制台输出 */
        })
        window.close()
        break
      }

      case "selection": {
        rlog?.push(['_trackCustom', 'event', [['action', 'screenshot_capture_selection_click'], ['from', 'capture_panel']]])
        // 选区交互需要页面接收鼠标焦点，popup 必须先关闭。
        // background 会接管后续：注入遮罩 → 等待用户拖拽 → 截图裁剪下载。
        captureSelection().catch(() => {
          /* popup 已关闭，错误由 background 控制台输出 */
        })
        window.close()
        break
      }

      case "delayed": {
        rlog?.push(['_trackCustom', 'event', [['action', 'screenshot_capture_delayed_click'], ['from', 'capture_panel']]])
        // 倒计时浮窗在页面上展示，popup 必须先关闭，否则用户看不到也点不到「Cancel」。
        // 倒计时秒数由 background 从 chrome.storage.sync 读取（默认 3 秒）。
        captureDelayed().catch(() => {
          /* popup 已关闭，错误由 background 控制台输出 */
        })
        window.close()
        break
      }

      case "desktop": {
        rlog?.push(['_trackCustom', 'event', [['action', 'screenshot_capture_desktop_click'], ['from', 'capture_panel']]])
        // 通过中转窗口调用 getDisplayMedia：直接在 popup 调会导致系统
        // 选择器锚定在 popup 位置（extension icon 附近，偏右超出屏幕）。
        // 中转窗口由 background 创建在屏幕居中位置，选择器锚定到它就不会溢出。
        captureDesktop().catch(() => {})
        window.close()
        break
      }

      default: {
        rlog?.push(['_trackCustom', 'event', [['action', 'screenshot_capture_annotate_click'], ['from', 'capture_panel']]])
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

      <div className={styles.regionActions}>
        <button
          type="button"
          className={styles.regionBtn}
          disabled={busy !== null}
          onClick={handleSelectScrollRegion}>
          {busy === "scrollRegion" ? "选择中…" : "选择滚动区域"}
        </button>
        <button
          type="button"
          className={styles.regionBtnSecondary}
          disabled={busy !== null}
          onClick={handleClearScrollRegion}>
          清除本网站区域
        </button>
      </div>

      {/* 错误提示 */}
      {error && <div className={styles.errorTip}>{error}</div>}

      {/* 底部存储位置 + 设置入口 */}
      <div className={styles.footer}>
        <span className={styles.footerLabel}>把截屏存储到</span>
        <button type="button" className={styles.storageBtn}>
          <CloudIcon width={14} height={14} />
          <span>云端</span>
        </button>
        <button
          type="button"
          className={styles.settingsBtn}
          title="打开设置"
          onClick={() => chrome.runtime.openOptionsPage()}>
          ⚙
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
