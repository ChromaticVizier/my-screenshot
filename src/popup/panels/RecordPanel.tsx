/**
 * 录屏面板
 *
 * 已接入：
 *   - 「当前标签页」：通过 background 拉起 recorder 扩展窗口，
 *     在 recorder 窗口里调 getDisplayMedia + MediaRecorder 进行录制。
 *     录制状态写入 storage.local，popup 重开时也能反映为「结束录制」。
 *
 * 未接入（后续支持）：
 *   - 「桌面」「摄像头」「区域录制」
 *   - 「控制栏」开关（图中右侧的悬浮控制条）
 *   - 「云端」存储位置切换
 */
import { useEffect, useState } from "react"

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
import {
  startCurrentTabRecording,
  stopRecording
} from "~src/services/record"
import {
  DEFAULT_RECORD_OPTIONS,
  getRecordOptions,
  getRecordSession,
  onRecordSessionChanged,
  setRecordOptions,
  type RecordFileFormat,
  type RecordOptions,
  type RecordResolution,
  type RecordSession
} from "~src/shared/recordOptions"
import type { RecordMode } from "~src/types/popup"

import * as styles from "./RecordPanel.module.css"

function RecordPanel() {
  const [activeMode, setActiveMode] = useState<RecordMode>("currentTab")
  const [toolbar, setToolbar] = useState(true)
  const [options, setOptions] = useState<RecordOptions>(DEFAULT_RECORD_OPTIONS)
  const [session, setSession] = useState<RecordSession>({ recording: false })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /* ----- 初始化：读取选项 + 当前会话 ----- */
  useEffect(() => {
    void Promise.all([getRecordOptions(), getRecordSession()]).then(
      ([opts, sess]) => {
        setOptions(opts)
        setSession(sess)
      }
    )
    // 录制状态变化（如 recorder 窗口结束录制后清理 session）实时同步到 popup
    const off = onRecordSessionChanged(setSession)
    return off
  }, [])

  /* ----- 选项更新：写入 storage.local ----- */
  const updateOption = async <K extends keyof RecordOptions>(
    key: K,
    value: RecordOptions[K]
  ) => {
    const next = { ...options, [key]: value }
    setOptions(next)
    await setRecordOptions({ [key]: value } as Partial<RecordOptions>)
  }

  /* ----- 录制开始/结束 ----- */
  const handleToggleRecording = async () => {
    if (busy) return
    setError(null)
    setBusy(true)

    if (session.recording) {
      // 结束录制
      const res = await stopRecording()
      setBusy(false)
      if (!res.ok) {
        setError(res.error ?? "停止录制失败")
        return
      }
      // 关闭 popup，让用户回到页面看下载条
      window.close()
      return
    }

    // 开始录制：仅当选了「当前标签页」时实际启动
    if (activeMode !== "currentTab") {
      setBusy(false)
      setError("当前仅支持「当前标签页」录制")
      return
    }

    const res = await startCurrentTabRecording()
    setBusy(false)
    if (!res.ok) {
      setError(res.error ?? "无法启动录制")
      return
    }
    // 关闭 popup，让出焦点给 recorder 窗口的共享选择器
    window.close()
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
              disabled={action.disabled || session.recording}
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
        <ToggleIconButton
          on={options.systemAudio}
          icon={<SoundOffIcon width={16} height={16} />}
          title={options.systemAudio ? "系统声音：开" : "系统声音：关"}
          onClick={() => updateOption("systemAudio", !options.systemAudio)}
        />
        <ToggleIconButton
          on={options.microphone}
          icon={<MicMutedIcon width={16} height={16} />}
          title={options.microphone ? "麦克风：开" : "麦克风：关"}
          onClick={() => updateOption("microphone", !options.microphone)}
        />
        <div className={styles.toolbarToggle}>
          <ToolbarIcon width={16} height={16} />
          <span className={styles.toolbarLabel}>控制栏</span>
          <Switch checked={toolbar} onChange={setToolbar} />
        </div>
      </div>

      {/* 配置选项 */}
      <div className={styles.optionsRow}>
        <SelectButton
          icon={<HDIcon width={20} height={14} />}
          value={options.resolution}
          options={[
            { value: "720p", label: "720p" },
            { value: "1080p", label: "1080p" },
            { value: "4k", label: "4K" }
          ]}
          onChange={(v) => updateOption("resolution", v as RecordResolution)}
        />
        <SelectButton
          icon={<CloudIcon width={14} height={14} />}
          value="cloud"
          options={[{ value: "cloud", label: "云端" }]}
          onChange={() => undefined}
        />
        <SelectButton
          value={options.format}
          options={[
            { value: "webm", label: "WebM" },
            // MP4 暂不可用：Chrome MediaRecorder 在多数版本不支持
            // 直接录制 video/mp4，强行使用会导致输出无法播放
            { value: "mp4", label: "MP4（暂不支持）" }
          ]}
          onChange={(v) => {
            if (v === "mp4") return
            updateOption("format", v as RecordFileFormat)
          }}
        />
        <button type="button" className={styles.moreBtn}>
          更多
          <ChevronRightIcon width={14} height={14} />
        </button>
      </div>

      {/* 错误提示 */}
      {error && <div className={styles.errorTip}>{error}</div>}

      {/* 开始/结束录制按钮 */}
      <button
        type="button"
        className={`${styles.startBtn} ${session.recording ? styles.stopBtn : ""}`}
        disabled={busy}
        onClick={handleToggleRecording}>
        <RecordDotIcon width={14} height={14} />
        <span>
          {session.recording
            ? "结束录制"
            : busy
              ? "处理中…"
              : "开始录制"}
        </span>
      </button>
    </div>
  )
}

/* ============== 子组件 ============== */

interface ToggleIconButtonProps {
  icon: React.ReactNode
  on: boolean
  title?: string
  onClick: () => void
}

function ToggleIconButton({
  icon,
  on,
  title,
  onClick
}: ToggleIconButtonProps) {
  return (
    <button
      type="button"
      title={title}
      className={`${styles.iconBtn} ${on ? styles.iconBtnOn : styles.muted}`}
      onClick={onClick}>
      {icon}
      <ChevronDownIcon width={12} height={12} />
    </button>
  )
}

interface SelectOption {
  value: string
  label: string
}

interface SelectButtonProps {
  icon?: React.ReactNode
  value: string
  options: SelectOption[]
  onChange: (v: string) => void
}

/**
 * 用原生 <select> 实现下拉，省去自己实现菜单的复杂度。
 * 上面包一层覆盖样式按钮，hover/click 显示原生菜单。
 */
function SelectButton({ icon, value, options, onChange }: SelectButtonProps) {
  const current = options.find((o) => o.value === value)
  return (
    <label className={styles.optionBtn}>
      {icon}
      <span>{current?.label ?? value}</span>
      <ChevronDownIcon width={12} height={12} />
      <select
        className={styles.optionSelect}
        value={value}
        onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
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
