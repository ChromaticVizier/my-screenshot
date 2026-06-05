/**
 * 待裁剪图片的临时存储（模块级变量，service worker 生命周期内有效）。
 *
 * 截图完成后若用户开启了"截图后裁剪"，图片 dataUrl 暂存于此，
 * 然后打开编辑器 tab。编辑器 tab 加载后通过消息取走数据。
 */

interface PendingImage {
  dataUrl: string
  filename: string
}

let pending: PendingImage | null = null

export function setPendingImage(img: PendingImage): void {
  pending = img
}

export function getPendingImage(): PendingImage | null {
  return pending
}

export function clearPendingImage(): void {
  pending = null
}
