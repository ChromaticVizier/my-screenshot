/**
 * 生成截图/录屏的默认文件名
 */

/** 将字符串转为可作为文件名的安全形式 */
function sanitize(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").slice(0, 60)
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
}

export function buildScreenshotFilename(
  options: ScreenshotFilenameOptions
): string {
  const { tabTitle, ext } = options
  const prefix = tabTitle ? sanitize(tabTitle) : "screenshot"
  return `${prefix}-${timestamp()}.${ext}`
}
