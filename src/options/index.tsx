/**
 * 设置页：使用 chrome.storage.local 持久化用户偏好（见 shared/settings.ts）
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
  type FullPageMode,
  type FullPageRuleSet
} from "~src/shared/settings"
import { clearRouteLog, getRouteLog } from "~src/shared/routeLog"

import "~src/styles/global.css"

import * as styles from "./index.module.css"

type SaveState = "idle" | "saving" | "saved" | "error"

/**
 * 解析并校验数字输入：丢掉 NaN / 空 / ±Infinity，按 min/max 夹紧。
 * 用于所有数值阈值字段（z-index、像素、比例、质量等），避免 Number(e.target.value)
 * 把负数 / 空 / 非法字符直接落库导致后台判别逻辑失效。
 *
 * 返回 null 表示「应忽略本次更改」（典型场景：用户暂时清空输入框正在重新输入），
 * 调用方据此跳过 updateXxx，输入框会在下一帧被受控值回填到旧值。
 */
function parseClampedNumber(
  raw: string,
  opts: { min?: number; max?: number }
): number | null {
  if (raw === "" || raw === "-" || raw === "+") return null
  const n = Number(raw)
  if (!Number.isFinite(n)) return null
  let v = n
  if (typeof opts.min === "number" && v < opts.min) v = opts.min
  if (typeof opts.max === "number" && v > opts.max) v = opts.max
  return v
}

/** 受控数字输入框的展示值兜底：value 已被旧版坏数据污染（NaN/负数）时显示默认值 */
function safeNumberValue(
  value: unknown,
  fallback: number,
  opts: { min?: number; max?: number }
): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  if (typeof opts.min === "number" && n < opts.min) return opts.min
  if (typeof opts.max === "number" && n > opts.max) return opts.max
  return n
}

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
    title: "长截图参数",
    fields: [
      {
        key: "fullPageOverlapRatio",
        label: "长截图相邻帧重叠比例",
        hint: "0~0.5。相邻帧重叠比例越大，越能补全 scroller 底部 padding/box-shadow 不渲染区域，避免长图衔接处出现白条 / 截断文字；代价是截图次数增加。富文本编辑器（popo / 飞书文档等）建议 0.05~0.15；普通静态页可设 0 提速。",
        min: 0,
        max: 0.5,
        step: 0.01,
        control: "number"
      },
      {
        key: "maxFullPageHeightPx",
        label: "长截图图片高度上限 (px)",
        hint: "无限滚动页面（信息流 / 评论流）会一直加载，长截图无法自动停止；达到此高度后立即停止并封顶。0 = 不限制（不建议，可能因画布过大失败）。默认 20000。",
        min: 0,
        max: 100000,
        step: 1000
      }
    ]
  },
  {
    title: "自定义选择器（最高优先级）",
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
  const [saveError, setSaveError] = useState<string | null>(null)
  const [logCount, setLogCount] = useState(0)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    getSettings().then((s) => {
      setLocal(s)
      setLoaded(true)
    })
    getRouteLog().then((list) => setLogCount(list.length))
  }, [])

  // 节流保存：3 次输入合并 1 次写入，避免输入框抖动
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flushSave = (next: AppSettings) => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    setSaveState("saving")
    setSaveError(null)
    saveTimer.current = setTimeout(async () => {
      try {
        await setSettings(next)
        setSaveState("saved")
        setTimeout(() => setSaveState("idle"), 1200)
      } catch (err) {
        // 暴露失败原因，避免「静默失败 + 数据丢失」
        setSaveState("error")
        setSaveError(err instanceof Error ? err.message : String(err))
      }
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

  /* ---- 页面类型路由日志（调试）---- */
  const exportRouteLogJson = async () => {
    const list = await getRouteLog()
    const blob = new Blob([JSON.stringify(list, null, 2)], {
      type: "application/json"
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    a.href = url
    a.download = `my-screenshot-moe-route-log-${stamp}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleClearRouteLog = async () => {
    await clearRouteLog()
    setLogCount(0)
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
      const numOpts = { min: meta.min, max: meta.max }
      const safeValue = safeNumberValue(value, defaultValue, numOpts)
      if (meta.control === "slider") {
        control = (
          <div className={styles.sliderRow}>
            <input
              className={styles.slider}
              type="range"
              min={meta.min ?? 0}
              max={meta.max ?? 1}
              step={meta.step ?? 0.01}
              value={safeValue}
              onChange={(e) => {
                const next = parseClampedNumber(e.target.value, numOpts)
                if (next !== null) updateRule(meta.key, next as never)
              }}
            />
            <span className={styles.sliderValue}>{safeValue.toFixed(2)}</span>
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
            value={safeValue}
            onChange={(e) => {
              const next = parseClampedNumber(e.target.value, numOpts)
              if (next !== null) updateRule(meta.key, next as never)
            }}
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
        <p className={styles.subtitle}>所有变更会自动保存到本机浏览器。</p>
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
          <label className={styles.label} htmlFor="imageFormat">
            图片格式
          </label>
          <div className={styles.control}>
            <select
              id="imageFormat"
              className={styles.input}
              value={settings.imageFormat}
              onChange={(e) =>
                update({ imageFormat: e.target.value as "png" | "jpeg" })
              }>
              <option value="png">PNG（无损，体积大）</option>
              <option value="jpeg">JPEG（有损，可压缩，体积小）</option>
            </select>
            <span className={styles.hint}>
              超大屏 / 超长页建议选 JPEG 以显著减小体积；默认 PNG。
            </span>
          </div>
        </div>

        {settings.imageFormat === "jpeg" && (
          <div className={styles.field}>
            <label className={styles.label} htmlFor="imageQuality">
              JPEG 质量
            </label>
            <div className={styles.control}>
              <div className={styles.sliderRow}>
                <input
                  id="imageQuality"
                  className={styles.slider}
                  type="range"
                  min={1}
                  max={100}
                  step={1}
                  value={safeNumberValue(settings.imageQuality, 92, {
                    min: 1,
                    max: 100
                  })}
                  onChange={(e) => {
                    const next = parseClampedNumber(e.target.value, {
                      min: 1,
                      max: 100
                    })
                    if (next !== null) update({ imageQuality: next })
                  }}
                />
                <span className={styles.sliderValue}>
                  {settings.imageQuality}
                </span>
              </div>
              <span className={styles.hint}>
                1 ~ 100，越高越清晰、体积越大；默认 92。仅 JPEG 生效。
              </span>
            </div>
          </div>
        )}

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

        <div className={styles.field}>
          <label className={styles.label}>长截图模式</label>
          <div className={styles.control}>
            <select
              className={styles.input}
              value={settings.fullPageMode}
              onChange={(e) =>
                update({ fullPageMode: e.target.value as FullPageMode })
              }>
              <option value="auto">自动（按页面类型路由，推荐）</option>
              <option value="standard">标准（首帧保留 + 逐帧补偿）</option>
              <option value="isolate">隔离（隔离主滚动容器）</option>
              <option value="spa-like">类 SPA（首帧保留 + 隐藏顶栏/侧边栏）</option>
            </select>
            <span className={styles.hint}>
              「自动」会在截图前探测页面类型（纯内容 / SPA 单容器 / 内嵌 iframe），
              路由到对应专家流程，多数情况无需手动干预。
              遇到自动判别不理想的页面，可临时切到「标准」或「隔离」：
              标准对 window 滚动、内容分散页面最稳；
              隔离会先隔离主滚动容器、隐藏容器外所有元素，
              对顶栏 / 侧栏 / 弹窗逐屏重复的 SPA 效果最好，
              但「内容分散在多个并列容器」的页面可能漏截部分元素。
            </span>
          </div>
        </div>

        <div className={styles.field}>
          <label className={styles.label}>显示页面类型判定（调试）</label>
          <div className={styles.control}>
            <label className={styles.toggle}>
              <input
                type="checkbox"
                checked={settings.showPageTypeToast}
                onChange={(e) =>
                  update({ showPageTypeToast: e.target.checked })
                }
              />
              <span>{settings.showPageTypeToast ? "已启用" : "已关闭"}</span>
            </label>
            <span className={styles.hint}>
              开启后，点击「整页截图」时会先在页面顶部短暂弹出本次 MoE 判定的页面类型，
              便于排查路由是否符合预期。浮层会在正式截图前自动移除，不会进入截图。
            </span>
          </div>
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>页面类型日志（调试）</h2>
          <div className={styles.sectionActions}>
            <button
              type="button"
              className={styles.secondaryBtn}
              disabled={logCount === 0}
              onClick={exportRouteLogJson}>
              导出日志 JSON
            </button>
            <button
              type="button"
              className={styles.dangerBtn}
              disabled={logCount === 0}
              onClick={handleClearRouteLog}>
              清空日志
            </button>
          </div>
        </div>

        <p className={styles.subtitle}>
          每次整页截图都会记录一条「网址 + MoE 判定类型 + 判定依据」，已累计{" "}
          {logCount} 条（最多保留 1000 条）。导出的 JSON 可用于核对路由是否符合预期、
          积累页面类型样本集。
        </p>
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
          页面类型由 MoE 路由在截图前自动判别，原先的判别阈值已无需手动调参；
          这里只保留与判别无关的操作项（帧重叠、长图高度上限、自定义选择器）。
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
        {saveState === "error" && (
          <span className={styles.saveError} role="alert">
            ⚠ 保存失败：{saveError ?? "未知错误"}
          </span>
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
