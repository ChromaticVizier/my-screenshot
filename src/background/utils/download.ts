/**
 * 下载工具：统一处理「图片 Blob → 浏览器下载」
 *
 * MV3 service worker 中 `URL.createObjectURL` 不可用（Chrome 已禁用），
 * 因此一律把 Blob 转成 dataUrl 再交给 chrome.downloads.download。
 * dataUrl 体积比 Blob 大约 1.33 倍（Base64），但截图场景一般 < 几十 MB，
 * 与体验对比可以接受；后续若需优化可换用 fetch + service worker route。
 */
import {
  buildRecordingFilename,
  buildScreenshotFilename
} from "~src/shared/filename"

export interface DownloadImageOptions {
  /** 图片二进制 */
  blob: Blob
  /** 标签页标题，用于文件名 */
  tabTitle?: string
  /** 扩展名 */
  ext: "png" | "jpeg"
}

/** 下载图片 Blob，返回 downloadId */
export async function downloadImageBlob(
  options: DownloadImageOptions
): Promise<number> {
  const { blob, tabTitle, ext } = options
  const dataUrl = await blobToDataUrl(blob)
  const filename = buildScreenshotFilename({ tabTitle, ext })

  return chrome.downloads.download({
    url: dataUrl,
    filename,
    saveAs: false
  })
}

export interface DownloadRecordingOptions {
  /** 视频 dataUrl（recorder 窗口已自行 base64 编码） */
  dataUrl: string
  tabTitle?: string
  ext: "webm" | "mp4"
}

/** 下载录屏视频 */
export async function downloadRecordingDataUrl(
  options: DownloadRecordingOptions
): Promise<number> {
  const { dataUrl, tabTitle, ext } = options
  const filename = buildRecordingFilename({ tabTitle, ext })
  return chrome.downloads.download({
    url: dataUrl,
    filename,
    saveAs: false
  })
}

/**
 * Blob → dataUrl
 * 在 service worker 中无 FileReader 时也可工作（用 ArrayBuffer + base64 编码）
 */
async function blobToDataUrl(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer()
  const base64 = arrayBufferToBase64(buffer)
  const mime = blob.type || "application/octet-stream"
  return `data:${mime};base64,${base64}`
}

/** ArrayBuffer → Base64（分块处理避免栈溢出） */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const CHUNK = 0x8000
  let binary = ""
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const chunk = bytes.subarray(i, i + CHUNK)
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}
