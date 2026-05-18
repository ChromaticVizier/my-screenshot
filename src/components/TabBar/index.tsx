import type { TabItem } from "~src/types/popup"

import * as styles from "./index.module.css"

interface TabBarProps {
  items: TabItem[]
  activeKey: string
  onChange: (key: string) => void
}

function TabBar({ items, activeKey, onChange }: TabBarProps) {
  return (
    <div className={styles.tabBar} role="tablist">
      {items.map((item) => {
        const active = item.key === activeKey
        return (
          <button
            key={item.key}
            role="tab"
            aria-selected={active}
            className={`${styles.tab} ${active ? styles.active : ""}`}
            onClick={() => onChange(item.key)}>
            <span className={styles.icon}>{item.icon}</span>
            <span className={styles.label}>{item.label}</span>
          </button>
        )
      })}
    </div>
  )
}

export default TabBar
