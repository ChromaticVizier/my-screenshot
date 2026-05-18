/**
 * Popup 主入口组件
 * 采用 Tab 切换：截图 / 录屏
 */
import { useState } from "react"

import TabBar from "~src/components/TabBar"
import { TAB_ITEMS } from "~src/constants/tabs"
import CapturePanel from "~src/popup/panels/CapturePanel"
import RecordPanel from "~src/popup/panels/RecordPanel"
import type { TabKey } from "~src/types/popup"

import "~src/styles/global.css"

import * as styles from "./index.module.css"

function Popup() {
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
