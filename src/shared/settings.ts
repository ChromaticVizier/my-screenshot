/**
 * 用户设置：基于 chrome.storage.sync 的轻量封装
 *
 * 设计：
 * - 单一 key "settings" 存储整个对象，避免逐字段 IO
 * - 提供 getSettings / setSettings / onSettingsChanged 三个原语
 * - 默认值集中维护，缺省字段自动补齐（向后兼容）
 */

export interface AppSettings {
  /** 延迟截图的等待秒数，默认 3 */
  delaySeconds: number
}

export const DEFAULT_SETTINGS: AppSettings = {
  delaySeconds: 3
}

const KEY = "settings"

/** 读取设置（自动用默认值补齐缺失字段） */
export async function getSettings(): Promise<AppSettings> {
  const raw = await chrome.storage.sync.get(KEY)
  const stored = (raw[KEY] as Partial<AppSettings> | undefined) ?? {}
  return { ...DEFAULT_SETTINGS, ...stored }
}

/** 部分更新设置 */
export async function setSettings(patch: Partial<AppSettings>): Promise<void> {
  const current = await getSettings()
  const next = { ...current, ...patch }
  await chrome.storage.sync.set({ [KEY]: next })
}

/** 订阅设置变更（返回取消监听的函数） */
export function onSettingsChanged(
  cb: (settings: AppSettings) => void
): () => void {
  const listener = (
    changes: { [key: string]: chrome.storage.StorageChange },
    areaName: string
  ) => {
    if (areaName !== "sync" || !changes[KEY]) return
    cb({
      ...DEFAULT_SETTINGS,
      ...((changes[KEY].newValue as Partial<AppSettings>) ?? {})
    })
  }
  chrome.storage.onChanged.addListener(listener)
  return () => chrome.storage.onChanged.removeListener(listener)
}
