/**
 * 设置页：使用 chrome.storage.sync 持久化用户偏好
 *
 * 支持：
 * - 延迟截图秒数（1 ~ 60）
 * - 整页截图判别规则（每项可调，含恢复默认 / 全部重置 / 导出 / 导入）
 *
 * 字段命名与 shared/settings.ts 中 FullPageRuleSet 一一对应。
 */
import { useEffect, useMemo, useRef, useState } from "react"

import {
  DEFAULT_FULL_PAGE_RULES,
  DEFAULT_SETTINGS,
  getSettings,
  setSettings,
  type AppSettings,
  type FullPageRuleSet
} from "~src/shared/settings"

import "~src/styles/global.css"

import * as styles from "./index.module.css"

type SaveState = "idle" | "saving" | "saved"

/** 每个字段对应一段说明，便于用户调试时理解“调小/调大”的含义 */
interface RuleFieldMeta<K extends keyof FullPageRuleSet> {
  key: K
  label: string
  hint: string
  /** 数字字段的最小/最大/步长；slider/number 用得到 */
  min?: number
  max?: number
  step?: number
  /** 控件类型，按字段类型自动推断时的覆盖 */
  control?: "number" | "slider" | "text" | "toggle" | "tags" | "lines"
}

const RULE_GROUPS: Array<{
  title: string
  fields: RuleFieldMeta<keyof FullPageRuleSet>[]
}> = [
  {
    title: "总开关",
    fields: [
      {
        key: "enabled",
        label: "启用动态隐藏",
        hint: "关掉则后续帧不做任何隐藏；首帧同样原样保留所有元素。"
      }
    ]
  },
  {
    title: "1. 行为判别",
    fields: [
      {
        key: "followThresholdPx",
        label: "绝对位置漂移阈值 (px)",
        hint: "首帧与当前帧的文档绝对位置差超过此值视为“跟着视口走”。",
        min: 0,
        max: 50,
        step: 1
      },
      {
        key: "viewportStableThresholdPx",
        label: "视口位置稳定阈值 (px)",
        hint: "rect 在视口里的位置偏移不超过此值才视为“稳定贴在视口”。",
        min: 0,
        max: 100,
        step: 1
      }
    ]
  },
  {
    title: "2. 内容容器豁免",
    fields: [
      {
        key: "contentRatio",
        label: "子树高度占比阈值",
        hint: "scrollHeight / 文档高度 ≥ 此值视为主内容容器，保留。",
        min: 0,
        max: 1,
        step: 0.01,
        control: "slider"
      },
      {
        key: "contentText",
        label: "文本量阈值",
        hint: "元素 innerText 长度 ≥ 此值视为内容容器，保留。",
        min: 0,
        max: 10000,
        step: 50
      }
    ]
  },
  {
    title: "3. 背景层 / 水印豁免",
    fields: [
      {
        key: "backgroundArea",
        label: "背景层最小面积比",
        hint: "占视口面积 ≥ 此值且少文本无交互才算背景层。",
        min: 0,
        max: 1,
        step: 0.01,
        control: "slider"
      },
      {
        key: "backgroundText",
        label: "背景层最大文本量",
        hint: "背景层允许的最大 innerText 长度。",
        min: 0,
        max: 500,
        step: 5
      },
      {
        key: "watermarkAreaMin",
        label: "水印最小面积比",
        hint: "pointer-events:none 且面积 ≥ 此值的元素一律视为水印，保留。",
        min: 0,
        max: 1,
        step: 0.01,
        control: "slider"
      }
    ]
  },
  {
    title: "4. 浮层硬命中",
    fields: [
      {
        key: "highZIndex",
        label: "高 z-index 阈值",
        hint: "computed z-index ≥ 此值即视为高层级浮层候选。",
        min: 0,
        max: 999999,
        step: 1
      },
      {
        key: "nearEdgePx",
        label: "贴边像素阈值",
        hint: "距视口任一边 ≤ 此像素视为“贴边”。",
        min: 0,
        max: 200,
        step: 1
      },
      {
        key: "viewportSizedRatio",
        label: "视口级大块面积比",
        hint: "面积 ≥ 此值视为“视口级大块”，不会按浮层处理（保护主内容容器）。",
        min: 0,
        max: 1,
        step: 0.01,
        control: "slider"
      }
    ]
  },
  {
    title: "5. 角色识别",
    fields: [
      {
        key: "semanticMainRegex",
        label: "主内容容器正则",
        hint: "按 id/class 字符串匹配，命中即视为内容容器（不区分大小写）。",
        control: "text"
      },
      {
        key: "extensionOverlayKeywords",
        label: "扩展浮层关键词",
        hint: "命中即标记为插件浮层（按小写子串匹配 id/class/tag/role）。",
        control: "tags"
      }
    ]
  },
  {
    title: "7. 主滚动容器识别",
    fields: [
      {
        key: "detectScrollContainer",
        label: "自动检测内部滚动容器",
        hint: "适配 window 不滚、主体 div 滚动的 SPA/三栏页面。关闭后只使用 window 滚动。"
      },
      {
        key: "scrollContainerMinRatio",
        label: "滚动容器最小高度比",
        hint: "scrollHeight / clientHeight ≥ 此值才作为候选。调小更容易命中短滚动区域。",
        min: 1,
        max: 3,
        step: 0.01,
        control: "slider"
      },
      {
        key: "scrollContainerMinOverflowPx",
        label: "滚动容器最小溢出距离 (px)",
        hint: "scrollHeight - clientHeight 至少超过此值才作为候选。调小更激进。",
        min: 0,
        max: 1000,
        step: 10
      },
      {
        key: "scrollContainerAreaWeight",
        label: "视口面积权重",
        hint: "越高越偏向占屏大的容器；三栏页面可适当降低。",
        min: 0,
        max: 1,
        step: 0.01,
        control: "slider"
      },
      {
        key: "scrollContainerTextWeight",
        label: "文本量权重",
        hint: "越高越偏向正文/聊天内容等文本较多的容器。",
        min: 0,
        max: 1,
        step: 0.01,
        control: "slider"
      },
      {
        key: "scrollContainerSemanticWeight",
        label: "语义命中权重",
        hint: "越高越依赖 id/class 命中 main/content/chat/scroll 等关键词。",
        min: 0,
        max: 1,
        step: 0.01,
        control: "slider"
      },
      {
        key: "scrollContainerRegex",
        label: "滚动容器语义正则",
        hint: "按 id/class 字符串匹配，命中会提高主体滚动容器评分。",
        control: "text"
      },
      {
        key: "scrollerBottomSafetyPx",
        label: "滚动容器底部安全裕量 (px)",
        hint: "仅内部滚动容器模式下从底部多裁掉的像素，规避虚拟列表渲染溢出 / 邻近输入框 box-shadow 上溢导致的周期性白底条。代价是长图末尾会有等高的小空白。设为 0 关闭。",
        min: 0,
        max: 100,
        step: 1
      },
      {
        key: "fullPageOverlapRatio",
        label: "长截图相邻帧重叠比例",
        hint: "0~0.5。相邻帧重叠比例越大，越能补全 scroller 底部 padding/box-shadow 不渲染区域，避免长图衔接处出现白条 / 截断文字；代价是截图次数增加。富文本编辑器（popo / 飞书文档等）建议 0.05~0.15；普通静态页可设 0 提速。",
        min: 0,
        max: 0.5,
        step: 0.01,
        control: "number"
      }
    ]
  },
  {
    title: "8. 模式开关",
    fields: [
      {
        key: "hideAllFixedFallback",
        label: "兜底隐藏剩余跟随视口元素",
        hint: "关闭后只隐藏明确命中浮层/插件规则的元素，更保守。"
      }
    ]
  },
  {
    title: "6. 自定义选择器（最高优先级）",
    fields: [
      {
        key: "customKeepSelectors",
        label: "永远保留 (每行一条 CSS 选择器)",
        hint: "命中元素及其祖先都不会被任何规则隐藏。",
        control: "lines"
      },
      {
        key: "customHideSelectors",
        label: "永远隐藏 (每行一条 CSS 选择器)",
        hint: "命中元素在每一帧（含首帧后续）都强制隐藏。",
        control: "lines"
      }
    ]
  }
]

function Options() {
  const [settings, setLocal] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [loaded, setLoaded] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>("idle")
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    getSettings().then((s) => {
      setLocal(s)
      setLoaded(true)
    })
  }, [])

  // 节流保存：3 次输入合并 1 次写入，避免输入框抖动
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flushSave = (next: AppSettings) => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    setSaveState("saving")
    saveTimer.current = setTimeout(async () => {
      await setSettings(next)
      setSaveState("saved")
      setTimeout(() => setSaveState("idle"), 1200)
    }, 200)
  }

  const update = (patch: Partial<AppSettings>) => {
    const next: AppSettings = {
      ...settings,
      ...patch,
      fullPageRules: patch.fullPageRules
        ? { ...settings.fullPageRules, ...patch.fullPageRules }
        : settings.fullPageRules
    }
    setLocal(next)
    flushSave(next)
  }

  const updateRule = <K extends keyof FullPageRuleSet>(
    key: K,
    value: FullPageRuleSet[K]
  ) => {
    update({ fullPageRules: { ...settings.fullPageRules, [key]: value } })
  }

  const resetRuleField = <K extends keyof FullPageRuleSet>(key: K) => {
    updateRule(key, DEFAULT_FULL_PAGE_RULES[key])
  }

  const resetAllRules = () => {
    update({ fullPageRules: { ...DEFAULT_FULL_PAGE_RULES } })
  }

  const onDelaySecondsChange = (raw: string) => {
    const n = Number(raw)
    if (Number.isNaN(n)) return
    const clamped = Math.max(1, Math.min(60, Math.round(n)))
    update({ delaySeconds: clamped })
  }

  /* ---- 导出 / 导入 ---- */
  const exportJson = () => {
    const blob = new Blob([JSON.stringify(settings, null, 2)], {
      type: "application/json"
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = "my-screenshot-settings.json"
    a.click()
    URL.revokeObjectURL(url)
  }

  const onImportFile = async (file: File) => {
    try {
      const text = await file.text()
      const parsed = JSON.parse(text) as Partial<AppSettings>
      const merged: AppSettings = {
        ...DEFAULT_SETTINGS,
        ...parsed,
        fullPageRules: {
          ...DEFAULT_FULL_PAGE_RULES,
          ...(parsed.fullPageRules ?? {})
        }
      }
      setLocal(merged)
      flushSave(merged)
    } catch (err) {
      // 静默失败：用户看到“保存中”消失即可；可后续加 toast
      console.error("导入失败", err)
    }
  }

  /** 把 RULE_GROUPS 按字段元数据渲染成控件 */
  const renderRuleField = (meta: RuleFieldMeta<keyof FullPageRuleSet>) => {
    const value = settings.fullPageRules[meta.key]
    const defaultValue = DEFAULT_FULL_PAGE_RULES[meta.key]
    const isDefault = JSON.stringify(value) === JSON.stringify(defaultValue)

    let control: React.ReactNode = null

    if (typeof defaultValue === "boolean") {
      control = (
        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => updateRule(meta.key, e.target.checked as never)}
          />
          <span>{value ? "已启用" : "已关闭"}</span>
        </label>
      )
    } else if (typeof defaultValue === "number") {
      if (meta.control === "slider") {
        control = (
          <div className={styles.sliderRow}>
            <input
              className={styles.slider}
              type="range"
              min={meta.min ?? 0}
              max={meta.max ?? 1}
              step={meta.step ?? 0.01}
              value={Number(value)}
              onChange={(e) =>
                updateRule(meta.key, Number(e.target.value) as never)
              }
            />
            <span className={styles.sliderValue}>{Number(value).toFixed(2)}</span>
          </div>
        )
      } else {
        control = (
          <input
            className={styles.input}
            type="number"
            min={meta.min}
            max={meta.max}
            step={meta.step ?? 1}
            value={Number(value)}
            onChange={(e) =>
              updateRule(meta.key, Number(e.target.value) as never)
            }
          />
        )
      }
    } else if (Array.isArray(defaultValue)) {
      const arr = (value as string[]) ?? []
      if (meta.control === "tags") {
        // 关键词：以逗号分隔，渲染成 chip 列表 + 单行输入追加
        return (
          <div className={styles.field} key={String(meta.key)}>
            <FieldHeader
              label={meta.label}
              hint={meta.hint}
              isDefault={isDefault}
              onReset={() => resetRuleField(meta.key)}
            />
            <TagInput
              values={arr}
              onChange={(next) => updateRule(meta.key, next as never)}
            />
          </div>
        )
      }
      // lines: 每行一条
      control = (
        <textarea
          className={styles.textarea}
          rows={4}
          value={arr.join("\n")}
          placeholder={`例如:\n.my-keep\n#main`}
          onChange={(e) =>
            updateRule(
              meta.key,
              e.target.value
                .split("\n")
                .map((s) => s.trim())
                .filter(Boolean) as never
            )
          }
        />
      )
    } else if (typeof defaultValue === "string") {
      control = (
        <input
          className={styles.input}
          type="text"
          value={String(value)}
          onChange={(e) => updateRule(meta.key, e.target.value as never)}
        />
      )
    }

    return (
      <div className={styles.field} key={String(meta.key)}>
        <FieldHeader
          label={meta.label}
          hint={meta.hint}
          isDefault={isDefault}
          onReset={() => resetRuleField(meta.key)}
        />
        <div className={styles.control}>{control}</div>
      </div>
    )
  }

  const groups = useMemo(() => RULE_GROUPS, [])

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

        <div className={styles.field}>
          <label className={styles.label}>截图后裁剪</label>
          <div className={styles.control}>
            <label className={styles.toggle}>
              <input
                type="checkbox"
                checked={settings.cropBeforeDownload}
                onChange={(e) => update({ cropBeforeDownload: e.target.checked })}
              />
              <span>{settings.cropBeforeDownload ? "已启用" : "已关闭"}</span>
            </label>
            <span className={styles.hint}>
              开启后截图完成会打开编辑器，可裁剪后再下载；关闭则直接下载。
            </span>
          </div>
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>整页截图规则</h2>
          <div className={styles.sectionActions}>
            <button
              type="button"
              className={styles.secondaryBtn}
              onClick={exportJson}>
              导出 JSON
            </button>
            <button
              type="button"
              className={styles.secondaryBtn}
              onClick={() => fileInputRef.current?.click()}>
              导入 JSON
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) onImportFile(f)
                e.target.value = ""
              }}
            />
            <button
              type="button"
              className={styles.dangerBtn}
              onClick={resetAllRules}>
              全部恢复默认
            </button>
          </div>
        </div>

        <p className={styles.subtitle}>
          调小数值或开启“兜底”一般更激进（隐藏更多元素），调大或关掉一般更保守。
        </p>

        {groups.map((g) => (
          <details className={styles.group} key={g.title} open>
            <summary className={styles.groupTitle}>{g.title}</summary>
            <div className={styles.groupBody}>{g.fields.map(renderRuleField)}</div>
          </details>
        ))}
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

interface FieldHeaderProps {
  label: string
  hint?: string
  isDefault: boolean
  onReset: () => void
}

function FieldHeader({ label, hint, isDefault, onReset }: FieldHeaderProps) {
  return (
    <div className={styles.fieldHeader}>
      <label className={styles.label}>{label}</label>
      <button
        type="button"
        className={styles.resetLink}
        disabled={isDefault}
        title={isDefault ? "已是默认值" : "恢复默认"}
        onClick={onReset}>
        恢复默认
      </button>
      {hint ? <p className={styles.hint}>{hint}</p> : null}
    </div>
  )
}

interface TagInputProps {
  values: string[]
  onChange: (next: string[]) => void
}

function TagInput({ values, onChange }: TagInputProps) {
  const [draft, setDraft] = useState("")
  const commit = () => {
    const v = draft.trim()
    if (!v) return
    if (values.includes(v)) {
      setDraft("")
      return
    }
    onChange([...values, v])
    setDraft("")
  }
  return (
    <div className={styles.tagWrap}>
      {values.map((v) => (
        <span key={v} className={styles.tag}>
          {v}
          <button
            type="button"
            className={styles.tagRemove}
            onClick={() => onChange(values.filter((x) => x !== v))}>
            ×
          </button>
        </span>
      ))}
      <input
        className={styles.tagInput}
        type="text"
        value={draft}
        placeholder="输入后回车添加"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault()
            commit()
          }
        }}
      />
    </div>
  )
}

export default Options
