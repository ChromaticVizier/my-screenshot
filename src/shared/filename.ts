/**
 * 生成截图/录屏的默认文件名
 */

import { DEFAULT_SETTINGS, getSettings } from "./settings"

/** 将字符串转为可作为文件名的安全形式 */
function sanitize(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").slice(0, 60)
}

function applyTemplate(
  template: string,
  values: { title: string; date: string; mode: string }
): string {
  const raw = (template || DEFAULT_SETTINGS.filenameTemplate)
    .replace(/\{title\}/g, values.title)
    .replace(/\{date\}/g, values.date)
    .replace(/\{mode\}/g, values.mode)
  return sanitize(raw || `${values.title}-${values.date}`)
}

/** 时间戳格式：20240518-161542 */
function timestamp(date = new Date()): string {
  const pad = (n: number) => n.toString().padStart(2, "0")
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

export interface ScreenshotFilenameOptions {
  /** 标签页标题，作为文件名前缀 */
  tabTitle?: string
  /** 扩展名，不含点 */
  ext: "png" | "jpeg"
  /** 截图模式，用于 {mode} */
  mode?: string
  /** 文件名模板；不传则读取设置 */
  template?: string
}

function sanitizePath(path: string): string {
  return path
    .replace(/^[a-zA-Z]:[/\\]?/, "")
    .replace(/[<>:"|?*]/g, "_")
    .replace(/\\+/g, "/")
    .replace(/\/+/g, "/")
}

export function joinDownloadPath(folder: string, filename: string): string {
  const cleanFolder = sanitizePath(folder)
    .replace(/^[/\\]+/, "")
    .replace(/[/\\]+$/, "")
  if (!cleanFolder) return filename
  return `${cleanFolder}/${filename}`
}

export async function buildScreenshotFilename(
  options: ScreenshotFilenameOptions
): Promise<string> {
  const { tabTitle, ext } = options
  const settings = options.template ? null : await getSettings()
  const prefix = applyTemplate(
    options.template ?? settings?.filenameTemplate ?? DEFAULT_SETTINGS.filenameTemplate,
    {
      title: tabTitle ? sanitize(tabTitle) : "screenshot",
      date: timestamp(),
      mode: options.mode ?? "screenshot"
    }
  )
  return joinDownloadPath(settings?.screenshotDefaultSavePath ?? "", `${prefix}.${ext}`)
}

export interface RecordingFilenameOptions {
  tabTitle?: string
  ext: "webm" | "mp4"
}

export async function buildRecordingFilename(
  options: RecordingFilenameOptions
): Promise<string> {
  const { tabTitle, ext } = options
  const settings = await getSettings()
  const prefix = applyTemplate(settings.filenameTemplate, {
    title: tabTitle ? sanitize(tabTitle) : "recording",
    date: timestamp(),
    mode: "recording"
  })
  return joinDownloadPath(settings.screenshotDefaultSavePath, `${prefix}.${ext}`)
}
