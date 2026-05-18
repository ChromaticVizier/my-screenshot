/**
 * 录屏面板
 * 内部逻辑暂时留空，后续接入录屏核心能力
 */
import { useState } from "react"

import {
  ChevronDownIcon,
  ChevronRightIcon,
  CloudIcon,
  HDIcon,
  MicMutedIcon,
  RecordDotIcon,
  SoundOffIcon,
  ToolbarIcon
} from "~src/components/icons"
import { RECORD_MODE_ACTIONS } from "~src/constants/recordActions"
import type { RecordMode } from "~src/types/popup"

import * as styles from "./RecordPanel.module.css"

function RecordPanel() {
  const [activeMode, setActiveMode] = useState<RecordMode>("desktop")
  const [toolbar, setToolbar] = useState(true)

  const handleStart = () => {
    // TODO: 接入具体录屏逻辑
    console.log("[record] start, mode:", activeMode)
  }

  return (
    <div className={styles.panel}>
      {/* 录制模式 2x2 卡片 */}
      <div className={styles.modeGrid}>
        {RECORD_MODE_ACTIONS.map((action) => {
          const active = activeMode === action.key
          return (
            <button
              key={action.key}
              type="button"
              disabled={action.disabled}
              className={`${styles.modeCard} ${active ? styles.modeActive : ""}`}
              onClick={() => setActiveMode(action.key)}>
              <span className={styles.modeIcon}>{action.icon}</span>
              <span className={styles.modeLabel}>{action.label}</span>
            </button>
          )
        })}
      </div>

      {/* 麦克风 / 系统声音 / 控制栏 */}
      <div className={styles.controlsRow}>
        <DropdownButton icon={<SoundOffIcon width={16} height={16} />} muted />
        <DropdownButton icon={<MicMutedIcon width={16} height={16} />} muted />
        <div className={styles.toolbarToggle}>
          <ToolbarIcon width={16} height={16} />
          <span className={styles.toolbarLabel}>控制栏</span>
          <Switch checked={toolbar} onChange={setToolbar} />
        </div>
      </div>

      {/* 配置选项 */}
      <div className={styles.optionsRow}>
        <OptionButton icon={<HDIcon width={20} height={14} />} label="720p" />
        <OptionButton
          icon={<CloudIcon width={14} height={14} />}
          label="云端"
        />
        <OptionButton label="MP4" />
        <button type="button" className={styles.moreBtn}>
          更多
          <ChevronRightIcon width={14} height={14} />
        </button>
      </div>

      {/* 开始录制按钮 */}
      <button
        type="button"
        className={styles.startBtn}
        onClick={handleStart}>
        <RecordDotIcon width={14} height={14} />
        <span>开始录制</span>
      </button>
    </div>
  )
}

interface DropdownButtonProps {
  icon: React.ReactNode
  muted?: boolean
}

function DropdownButton({ icon, muted }: DropdownButtonProps) {
  return (
    <button
      type="button"
      className={`${styles.iconBtn} ${muted ? styles.muted : ""}`}>
      {icon}
      <ChevronDownIcon width={12} height={12} />
    </button>
  )
}

interface OptionButtonProps {
  icon?: React.ReactNode
  label: string
}

function OptionButton({ icon, label }: OptionButtonProps) {
  return (
    <button type="button" className={styles.optionBtn}>
      {icon}
      <span>{label}</span>
      <ChevronDownIcon width={12} height={12} />
    </button>
  )
}

interface SwitchProps {
  checked: boolean
  onChange: (v: boolean) => void
}

function Switch({ checked, onChange }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={`${styles.switch} ${checked ? styles.switchOn : ""}`}
      onClick={() => onChange(!checked)}>
      <span className={styles.switchThumb} />
    </button>
  )
}

export default RecordPanel
