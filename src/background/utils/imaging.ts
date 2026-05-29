/**
 * 图像处理工具
 * - 把 dataUrl 解码为 ImageBitmap
 * - 在 OffscreenCanvas 上裁剪 / 拼接，导出 Blob
 *
 * 设计动机：
 * - service worker 中无 DOM，使用 OffscreenCanvas 替代 <canvas>
 * - 用 ImageBitmap 比 Image 解码更快，且无需 src 异步加载
 */

/** dataUrl → ImageBitmap */
export async function dataUrlToBitmap(dataUrl: string): Promise<ImageBitmap> {
  const res = await fetch(dataUrl)
  const blob = await res.blob()
  return createImageBitmap(blob)
}

export interface CropParams {
  /** 源图（一般为整屏截图，单位是设备像素） */
  source: ImageBitmap
  /** 选区（CSS 像素，相对视口左上角） */
  rect: { x: number; y: number; width: number; height: number }
  /** 设备像素比，用于把 CSS 像素换算到设备像素 */
  devicePixelRatio: number
  format?: "png" | "jpeg"
  quality?: number
}

/** 按选区裁剪并导出 Blob */
export async function cropToBlob(params: CropParams): Promise<Blob> {
  const {
    source,
    rect,
    devicePixelRatio: dpr,
    format = "png",
    quality
  } = params

  // 把 CSS 像素映射到设备像素，并夹紧到源图边界
  const sx = Math.max(0, Math.round(rect.x * dpr))
  const sy = Math.max(0, Math.round(rect.y * dpr))
  const sw = Math.min(
    source.width - sx,
    Math.max(1, Math.round(rect.width * dpr))
  )
  const sh = Math.min(
    source.height - sy,
    Math.max(1, Math.round(rect.height * dpr))
  )

  const canvas = new OffscreenCanvas(sw, sh)
  const ctx = canvas.getContext("2d")
  if (!ctx) throw new Error("无法创建 OffscreenCanvas 2D 上下文")

  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh)

  return canvas.convertToBlob({
    type: `image/${format}`,
    quality: quality != null ? quality / 100 : undefined
  })
}

/** 一段截图（垂直拼接的输入项） */
export interface CaptureSlice {
  bitmap: ImageBitmap
  /** 该片段在页面中对应的 scrollY（CSS 像素） */
  scrollY: number
}

export interface StitchParams {
  slices: CaptureSlice[]
  /** 视口宽度（CSS 像素） */
  viewportWidth: number
  /** 页面总高度（CSS 像素） */
  totalHeight: number
  devicePixelRatio: number
  format?: "png" | "jpeg"
  quality?: number
}

/**
 * 将多张视口截图按 scrollY 拼接成完整长图
 *
 * 关键点：
 * - 用 scrollY 决定每片在长图上的目标 Y，避免最后一屏与前面重叠造成错位
 * - 后绘制的会覆盖先绘制的（重叠区取较新一帧），与"滚到底"的视觉一致
 */
export async function stitchToBlob(params: StitchParams): Promise<Blob> {
  const {
    slices,
    viewportWidth,
    totalHeight,
    devicePixelRatio: dpr,
    format = "png",
    quality
  } = params

  const canvasW = Math.round(viewportWidth * dpr)
  const canvasH = Math.round(totalHeight * dpr)
  const canvas = new OffscreenCanvas(canvasW, canvasH)
  const ctx = canvas.getContext("2d")
  if (!ctx) throw new Error("无法创建 OffscreenCanvas 2D 上下文")

  // 先填白底：dpr 非整数时各帧首尾对齐会有 1px 透明缝隙，
  // 透明区在某些查看器 / jpeg 输出下会显示为黑色细线
  ctx.fillStyle = "#ffffff"
  ctx.fillRect(0, 0, canvasW, canvasH)

  for (const slice of slices) {
    const dx = 0
    const dy = Math.round(slice.scrollY * dpr)
    // 注意：bitmap 自身宽高是设备像素
    // 直接 1:1 绘制即可（源大小 = 视口宽 * dpr × 视口高 * dpr）
    ctx.drawImage(slice.bitmap, dx, dy)
  }

  return canvas.convertToBlob({
    type: `image/${format}`,
    quality: quality != null ? quality / 100 : undefined
  })
}
