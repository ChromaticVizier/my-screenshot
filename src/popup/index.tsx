/**
 * Popup 主入口组件
 *
 * 复用 popup.html 作为多种 UI 的容器，根据 URL 查询参数分流：
 *   - 默认：渲染主截图/录屏面板（Tab 切换）
 *   - ?action=desktopCapture：渲染屏幕截图中转窗口（由 background 用
 *     chrome.windows.create 拉起的独立扩展窗口使用）
 */
import { useState } from "react"

import TabBar from "~src/components/TabBar"
import { TAB_ITEMS } from "~src/constants/tabs"
import DesktopCaptureWindow from "~src/popup/desktop"
import CapturePanel from "~src/popup/panels/CapturePanel"
import RecordPanel from "~src/popup/panels/RecordPanel"
import type { TabKey } from "~src/types/popup"

import "~src/styles/global.css"

import * as styles from "./index.module.css"

function Popup() {
  // 根据 query 参数决定渲染哪个界面
  const action = new URLSearchParams(window.location.search).get("action")
  if (action === "desktopCapture") {
    return <DesktopCaptureWindow />
  }
  return <MainPopup />
}

function MainPopup() {
  const [activeTab, setActiveTab] = useState<TabKey>("capture")

  return (
    <div className={styles.popup}>
      <TabBar
        items={TAB_ITEMS}
        activeKey={activeTab}
        onChange={(key) => setActiveTab(key as TabKey)}
      />
      <div className={styles.content}>
        {activeTab === "capture" ? <CapturePanel /> : <RecordPanel />}
      </div>
    </div>
  )
}

export default Popup
