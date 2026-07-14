/**
 * 下载工具：统一处理「图片 Blob → 浏览器下载」
 *
 * MV3 service worker 中 `URL.createObjectURL` 自 Chrome 110+ 已恢复支持，
 * 但截图链路里源数据一般来自其他进程（content script 网页进程），blob URL
 * 不能跨进程；为简洁统一，截图统一把数据编码成 dataUrl 再交给
 * chrome.downloads.download。
 *
 * 录屏视频不走这里：MediaRecorder 在「中转扩展窗口」里跑，窗口里直接用
 * URL.createObjectURL + chrome.downloads.download 落盘，避免 base64 编码
 * 和跨进程拷贝。
 */
import { buildScreenshotFilename } from "~src/shared/filename"
import { getSettings } from "~src/shared/settings"

import { setPendingImage } from "./pendingImage"

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
  const filename = await buildScreenshotFilename({ tabTitle, ext })

  const settings = await getSettings()
  if (settings.cropBeforeDownload) {
    setPendingImage({ dataUrl, filename })
    const editorUrl = chrome.runtime.getURL("popup.html") + "?action=editor"
    await chrome.tabs.create({ url: editorUrl })
    return -1
  }

  return chrome.downloads.download({
    url: dataUrl,
    filename,
    saveAs: true
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
