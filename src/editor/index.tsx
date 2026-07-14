/**
 * 截图裁剪 + 标注编辑器
 *
 * 流程：
 *  1. 从 background 获取待编辑图片
 *  2. 展示图片，支持：
 *     - 裁剪框拖拽
 *     - 标注：矩形 / 自由画线 / 文字（颜色、线宽可选，可撤销）
 *  3. 用户确认 → canvas 先 burn-in 所有标注 → 再裁剪 → 发回 background 下载
 *
 * 坐标系：所有标注/裁剪框都以「图片自然像素」为单位存储；渲染时
 * SVG 用 viewBox 自适应当前 DOM 尺寸，避免缩放窗口/响应式时偏移。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { MessageType } from "~src/shared/messages"
import type { GetPendingImageResponse } from "~src/shared/messages"
import { getSettings } from "~src/shared/settings"

import "~src/styles/global.css"

import * as styles from "./index.module.css"

interface CropRect {
  x: number
  y: number
  w: number
  h: number
}

type EditMode = "none" | "crop" | "select" | "rect" | "draw" | "text" | "mosaic"

interface AnnoBase {
  id: string
  color: string
  stroke: number
}
interface AnnoRect extends AnnoBase {
  type: "rect"
  x: number
  y: number
  w: number
  h: number
}
interface AnnoPath extends AnnoBase {
  type: "path"
  points: { x: number; y: number }[]
}
interface AnnoText extends AnnoBase {
  type: "text"
  x: number
  y: number
  text: string
  fontSize: number
}
interface AnnoMosaic extends AnnoBase {
  type: "mosaic"
  points: { x: number; y: number }[]
  size: number
}
type Annotation = AnnoRect | AnnoPath | AnnoText | AnnoMosaic

type DragState =
  | { type: "crop"; start: { x: number; y: number } }
  | { type: "annotation"; id: string; start: { x: number; y: number }; original: Annotation }
  | { type: "crop-move"; start: { x: number; y: number }; original: CropRect }
  | { type: "crop-resize"; handle: string; start: { x: number; y: number }; original: CropRect }

const COLORS = ["#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#a855f7", "#000000", "#ffffff"]
const STROKE_OPTIONS = [2, 4, 6, 10]
/** 文字字号档位（自然像素）。和 stroke 解耦，避免线宽影响字号。 */
const FONT_SIZES = [16, 24, 32, 48, 64, 80, 100]
const MOSAIC_BLOCK = 16
const MOSAIC_STROKES = [12, 18, 24, 32]
const DEFAULT_ZOOM = 1
const ZOOM_LEVELS = [0.5, 0.75, 1, 1.25, 1.5, 2]

type ExportQuality = "original" | "high" | "medium" | "low"

function getQualityPreset(preset: ExportQuality): {
  scale: number
  mime: "image/png" | "image/jpeg"
  quality: number
} {
  if (preset === "high") return { scale: 0.9, mime: "image/jpeg", quality: 0.9 }
  if (preset === "medium") return { scale: 0.75, mime: "image/jpeg", quality: 0.78 }
  if (preset === "low") return { scale: 0.55, mime: "image/jpeg", quality: 0.68 }
  return { scale: 1, mime: "image/png", quality: 1 }
}

function filenameForQuality(filename: string, preset: ExportQuality): string {
  if (preset === "original") return filename
  return filename.replace(/\.(png|jpe?g)$/i, ".jpeg")
}

/** 清洗文件名：去除零宽/控制字符与非法路径字符，保证非空且带扩展名。
 *  钉钉/飞书等文档标题常含零宽不可见字符，chrome.downloads 会报 "invalid filename"。 */
function sanitizeFilename(name: string): string {
  const fallback = "screenshot.png"
  if (!name) return fallback
  // 保留目录分隔（download 相对路径），逐段清洗
  const cleaned = name
    // 零宽 / BOM / 双向控制符
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, "")
    // ASCII 控制字符
    .replace(/[\u0000-\u001F\u007F]/g, "")
    // Windows/通用非法字符（保留 / 作为目录分隔）
    .replace(/[<>:"\\|?*]/g, "_")
    .split("/")
    .map((seg) => seg.trim().replace(/^\.+|\.+$/g, ""))
    .filter((seg) => seg.length > 0)
    .join("/")
  if (!cleaned) return fallback
  return /\.(png|jpe?g)$/i.test(cleaned) ? cleaned : `${cleaned}.png`
}

function moveAnnotation(a: Annotation, dx: number, dy: number): Annotation {
  if (a.type === "rect") return { ...a, x: a.x + dx, y: a.y + dy }
  if (a.type === "text") return { ...a, x: a.x + dx, y: a.y + dy }
  return { ...a, points: a.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) }
}

let _id = 0
const nextId = () => `a${++_id}`

/** 关闭当前编辑器 tab。
 *  编辑器通过 chrome.tabs.create 打开，window.close() 在这种 tab 上无效，
 *  必须走 chrome.tabs.remove。 */
function closeEditorTab(): void {
  try {
    chrome.tabs.getCurrent((tab) => {
      if (tab?.id != null) {
        chrome.tabs.remove(tab.id).catch(() => undefined)
      } else {
        window.close()
      }
    })
  } catch {
    window.close()
  }
}

let mosaicScratch: HTMLCanvasElement | null = null

function getMosaicScratch(width: number, height: number): HTMLCanvasElement {
  if (!mosaicScratch) mosaicScratch = document.createElement("canvas")
  if (mosaicScratch.width !== width) mosaicScratch.width = width
  if (mosaicScratch.height !== height) mosaicScratch.height = height
  return mosaicScratch
}

function applyMosaic(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  rect: CropRect,
  blockSize: number,
  sourceScale = 1
): void {
  const x0 = Math.max(0, Math.floor(rect.x))
  const y0 = Math.max(0, Math.floor(rect.y))
  const x1 = Math.min(ctx.canvas.width, Math.ceil(rect.x + rect.w))
  const y1 = Math.min(ctx.canvas.height, Math.ceil(rect.y + rect.h))
  const size = Math.max(4, Math.round(blockSize))
  if (x1 <= x0 || y1 <= y0) return

  const sw = Math.max(1, Math.ceil((x1 - x0) / size))
  const sh = Math.max(1, Math.ceil((y1 - y0) / size))
  const tmp = getMosaicScratch(sw, sh)
  const tctx = tmp.getContext("2d")
  if (!tctx) return
  tctx.clearRect(0, 0, sw, sh)
  tctx.imageSmoothingEnabled = true
  tctx.drawImage(
    source,
    x0 / sourceScale,
    y0 / sourceScale,
    (x1 - x0) / sourceScale,
    (y1 - y0) / sourceScale,
    0,
    0,
    sw,
    sh
  )
  ctx.save()
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(tmp, 0, 0, sw, sh, x0, y0, x1 - x0, y1 - y0)
  ctx.restore()
}

function applyMosaicBrush(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  points: { x: number; y: number }[],
  brushSize: number,
  blockSize: number,
  renderScale = 1
): void {
  if (points.length === 0) return
  const radius = Math.max(6, (brushSize * renderScale) / 2)
  const paint = (x: number, y: number) => {
    applyMosaic(
      ctx,
      source,
      { x: x * renderScale - radius, y: y * renderScale - radius, w: radius * 2, h: radius * 2 },
      blockSize * renderScale,
      renderScale
    )
  }
  paint(points[0].x, points[0].y)
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]
    const cur = points[i]
    const distance = Math.hypot(cur.x - prev.x, cur.y - prev.y)
    const steps = Math.max(1, Math.ceil((distance * renderScale) / (radius * 0.45)))
    for (let s = 1; s <= steps; s++) {
      const t = s / steps
      paint(prev.x + (cur.x - prev.x) * t, prev.y + (cur.y - prev.y) * t)
    }
  }
}

/** 在 canvas 上烘焙一条标注。
 *  与 SVG 渲染要保持视觉一致，所以参数（lineWidth/font）都用自然像素，
 *  上游传进来的 canvas 必须是「自然尺寸」。 */
function bakeAnnotation(
  ctx: CanvasRenderingContext2D,
  a: Annotation,
  mosaicSource: CanvasImageSource = ctx.canvas,
  mosaicScale = 1
): void {
  ctx.save()
  if (a.type === "mosaic") {
    applyMosaicBrush(ctx, mosaicSource, a.points, a.stroke, a.size, mosaicScale)
    ctx.restore()
    return
  }
  ctx.strokeStyle = a.color
  ctx.fillStyle = a.color
  ctx.lineWidth = a.stroke
  ctx.lineJoin = "round"
  ctx.lineCap = "round"
  if (a.type === "rect") {
    ctx.strokeRect(a.x, a.y, a.w, a.h)
  } else if (a.type === "path") {
    if (a.points.length === 0) {
      ctx.restore()
      return
    }
    if (a.points.length === 1) {
      // 单点 → 画圆点，避免 stroke 一条 0 长路径什么都看不到
      ctx.beginPath()
      ctx.arc(a.points[0].x, a.points[0].y, a.stroke / 2, 0, Math.PI * 2)
      ctx.fill()
    } else {
      ctx.beginPath()
      ctx.moveTo(a.points[0].x, a.points[0].y)
      for (let i = 1; i < a.points.length; i++) {
        ctx.lineTo(a.points[i].x, a.points[i].y)
      }
      ctx.stroke()
    }
  } else if (a.type === "text") {
    ctx.font = `${a.fontSize}px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`
    ctx.textBaseline = "top"
    // 多行支持
    const lines = a.text.split("\n")
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], a.x, a.y + i * a.fontSize * 1.2)
    }
  }
  ctx.restore()
}

function Editor() {
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [filename, setFilename] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [imgSize, setImgSize] = useState({ w: 0, h: 0 })
  const [crop, setCrop] = useState<CropRect | null>(null)
  /** 进入裁剪模式前的裁剪框，用于“取消”恢复 */
  const [cropBeforeEdit, setCropBeforeEdit] = useState<CropRect | null>(null)
  /** 裁剪历史：每次确认裁剪压入裁剪前的完整状态，供撤销回退 */
  const [cropHistory, setCropHistory] = useState<
    { dataUrl: string; imgSize: { w: number; h: number }; annotations: Annotation[] }[]
  >([])
  const [quality, setQuality] = useState(92)
  const [exportQuality, setExportQuality] = useState<ExportQuality>("original")

  // 裁剪交互

  // 标注
  const [mode, setMode] = useState<EditMode>("none")
  const [color, setColor] = useState(COLORS[0])
  const [stroke, setStroke] = useState<number>(4)
  const [fontSize, setFontSize] = useState<number>(24)
  const [zoom, setZoom] = useState<number>(DEFAULT_ZOOM)
  const [selectedAnnoId, setSelectedAnnoId] = useState<string | null>(null)
  const [processingMessage, setProcessingMessage] = useState<string | null>(null)
  const [viewportWidth, setViewportWidth] = useState<number>(0)
  const [annotations, setAnnotations] = useState<Annotation[]>([])
  /** 正在拖拽创建中的标注（rect / path），松开鼠标后才 commit 进 annotations */
  const [draft, setDraft] = useState<AnnoRect | AnnoPath | AnnoMosaic | null>(null)
  const [mosaicDragging, setMosaicDragging] = useState(false)
  const [mosaicPreviewVersion, setMosaicPreviewVersion] = useState(0)
  const [textDraft, setTextDraft] = useState<{
    x: number
    y: number
    value: string
  } | null>(null)
  const [dragState, setDragState] = useState<DragState | null>(null)

  const containerRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const mosaicCanvasRef = useRef<HTMLCanvasElement>(null)
  const previewFrameRef = useRef<number | null>(null)

  useEffect(() => {
    chrome.runtime.sendMessage(
      { type: MessageType.GET_PENDING_IMAGE },
      (res: GetPendingImageResponse) => {
        if (res?.ok && res.dataUrl) {
          setDataUrl(res.dataUrl)
          setFilename(res.filename ?? "screenshot.png")
        } else {
          setError(res?.error ?? "没有待编辑的图片")
        }
      }
    )
    getSettings().then((s) => setQuality(s.imageQuality))
  }, [])

  useEffect(() => {
    const update = () => {
      const width = containerRef.current?.clientWidth ?? window.innerWidth
      setViewportWidth(Math.max(320, width - 40))
    }
    update()
    window.addEventListener("resize", update)
    return () => window.removeEventListener("resize", update)
  }, [dataUrl])

  // 撤销快捷键
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault()
        setAnnotations((arr) => arr.slice(0, -1))
        setSelectedAnnoId(null)
        return
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selectedAnnoId) {
        e.preventDefault()
        setAnnotations((arr) => arr.filter((a) => a.id !== selectedAnnoId))
        setSelectedAnnoId(null)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [selectedAnnoId])

  const onImgLoad = useCallback(() => {
    if (!imgRef.current) return
    const { naturalWidth: w, naturalHeight: h } = imgRef.current
    setImgSize({ w, h })
  }, [])

  useEffect(() => {
    if (imgSize.w <= 0 || imgSize.h <= 0) return
    // 仅夹紧已有裁剪框到图片范围内；不再默认整幅裁剪框，
    // 让「裁剪」模式下先显示整幅遮罩、由用户拖拽生成裁剪框。
    setCrop((current) => {
      if (!current || current.w <= 0 || current.h <= 0) return null
      const x = Math.max(0, Math.min(imgSize.w, current.x))
      const y = Math.max(0, Math.min(imgSize.h, current.y))
      const w = Math.min(current.w, imgSize.w - x)
      const h = Math.min(current.h, imgSize.h - y)
      if (w <= 0 || h <= 0) return null
      return { x, y, w, h }
    })
  }, [imgSize])

  const getScale = useCallback(() => {
    if (!imgRef.current || imgSize.w === 0) return 1
    return imgRef.current.clientWidth / imgSize.w
  }, [imgSize])

  /** 鼠标坐标 → 图片自然像素坐标。
   *  用 img 的 boundingClientRect，包含响应式缩放后的真实尺寸，
   *  比依赖 imgWrap 更稳。 */
  const clientToNatural = useCallback(
    (clientX: number, clientY: number) => {
      const img = imgRef.current
      if (!img || imgSize.w === 0) return { x: 0, y: 0 }
      const rect = img.getBoundingClientRect()
      const sx = imgSize.w / rect.width
      const sy = imgSize.h / rect.height
      let x = (clientX - rect.left) * sx
      let y = (clientY - rect.top) * sy
      x = Math.max(0, Math.min(imgSize.w, x))
      y = Math.max(0, Math.min(imgSize.h, y))
      return { x, y }
    },
    [imgSize]
  )

  // ============ 裁剪框交互 ============
  const handleCropResizeDown = useCallback(
    (e: React.MouseEvent, handle: string) => {
      if (!crop) return
      e.preventDefault()
      e.stopPropagation()
      const { x, y } = clientToNatural(e.clientX, e.clientY)
      setDragState({ type: "crop-resize", handle, start: { x, y }, original: crop })
    },
    [crop, clientToNatural]
  )

  const handleCropMoveDown = useCallback(
    (e: React.MouseEvent) => {
      if (!crop) return
      e.preventDefault()
      e.stopPropagation()
      const { x, y } = clientToNatural(e.clientX, e.clientY)
      setDragState({ type: "crop-move", start: { x, y }, original: crop })
    },
    [crop, clientToNatural]
  )

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (dragState?.type === "crop") {
        const { x, y } = clientToNatural(e.clientX, e.clientY)
        const start = dragState.start
        setCrop({
          x: Math.min(start.x, x),
          y: Math.min(start.y, y),
          w: Math.abs(x - start.x),
          h: Math.abs(y - start.y)
        })
        return
      }
      if (dragState?.type === "crop-move") {
        const { x, y } = clientToNatural(e.clientX, e.clientY)
        const dx = x - dragState.start.x
        const dy = y - dragState.start.y
        const next = {
          ...dragState.original,
          x: dragState.original.x + dx,
          y: dragState.original.y + dy
        }
        next.x = Math.max(0, Math.min(imgSize.w - next.w, next.x))
        next.y = Math.max(0, Math.min(imgSize.h - next.h, next.y))
        setCrop(next)
        return
      }
      if (dragState?.type === "crop-resize") {
        const { x, y } = clientToNatural(e.clientX, e.clientY)
        let { x: cx, y: cy, w, h } = dragState.original
        if (dragState.handle.includes("l")) {
          const nx = Math.max(0, Math.min(cx + w - 10, x))
          w = w - (nx - cx)
          cx = nx
        }
        if (dragState.handle.includes("r")) {
          w = Math.max(10, Math.min(imgSize.w - cx, x - cx))
        }
        if (dragState.handle.includes("t")) {
          const ny = Math.max(0, Math.min(cy + h - 10, y))
          h = h - (ny - cy)
          cy = ny
        }
        if (dragState.handle.includes("b")) {
          h = Math.max(10, Math.min(imgSize.h - cy, y - cy))
        }
        setCrop({ x: cx, y: cy, w, h })
        return
      }
      if (dragState?.type === "annotation") {
        const { x, y } = clientToNatural(e.clientX, e.clientY)
        const dx = x - dragState.start.x
        const dy = y - dragState.start.y
        setAnnotations((arr) =>
          arr.map((a) =>
            a.id === dragState.id ? moveAnnotation(dragState.original, dx, dy) : a
          )
        )
        setMosaicPreviewVersion((v) => v + 1)
        return
      }
    },
    [dragState, clientToNatural, imgSize]
  )

  const handleMouseUp = useCallback(() => {
    setDragState(null)
  }, [])

  // ============ 标注交互 ==========
  const onAnnotationSelect = useCallback(
    (e: React.MouseEvent, id: string) => {
      e.preventDefault()
      e.stopPropagation()
      const { x, y } = clientToNatural(e.clientX, e.clientY)
      const anno = annotations.find((a) => a.id === id)
      if (!anno) return
      setSelectedAnnoId(id)
      setDragState({ type: "annotation", id, start: { x, y }, original: anno })
    },
    [annotations, clientToNatural]
  )

  const commitTextDraft = useCallback(() => {
    if (!textDraft) return
    const text = textDraft.value.trimEnd()
    if (text.trim()) {
      setAnnotations((arr) => [
        ...arr,
        {
          id: nextId(),
          type: "text",
          x: textDraft.x,
          y: textDraft.y,
          text,
          color,
          stroke,
          fontSize
        }
      ])
    }
    setTextDraft(null)
  }, [textDraft, color, stroke, fontSize])

  const cancelTextDraft = useCallback(() => {
    setTextDraft(null)
  }, [])

  const onAnnoDown = useCallback(
    (e: React.MouseEvent) => {
      if (mode === "crop") {
        e.preventDefault()
        e.stopPropagation()
        const { x, y } = clientToNatural(e.clientX, e.clientY)
        setCrop({ x, y, w: 0, h: 0 })
        setDragState({ type: "crop", start: { x, y } })
        return
      }
      if (mode === "select") {
        setSelectedAnnoId(null)
        return
      }
      setSelectedAnnoId(null)
      // 文字模式：点击出现文本输入框
      if (mode === "text") {
        e.preventDefault()
        e.stopPropagation()
        commitTextDraft()
        const { x, y } = clientToNatural(e.clientX, e.clientY)
        setTextDraft({ x, y, value: "" })
        return
      }
      e.preventDefault()
      e.stopPropagation()
      const { x, y } = clientToNatural(e.clientX, e.clientY)
      if (mode === "rect") {
        setDraft({
          id: nextId(),
          type: "rect",
          x,
          y,
          w: 0,
          h: 0,
          color,
          stroke
        })
      } else if (mode === "draw") {
        setDraft({
          id: nextId(),
          type: "path",
          points: [{ x, y }],
          color,
          stroke
        })
      } else if (mode === "mosaic") {
        setDraft(null)
        const anno: AnnoMosaic = {
          id: nextId(),
          type: "mosaic",
          points: [{ x, y }],
          color,
          stroke,
          size: MOSAIC_BLOCK
        }
        setAnnotations((arr) => [...arr, anno])
        setSelectedAnnoId(null)
        setMosaicDragging(true)
        setMosaicPreviewVersion((v) => v + 1)
      }
    },
    [mode, color, stroke, fontSize, clientToNatural, commitTextDraft, dragState]
  )

  const onAnnoMove = useCallback(
    (e: React.MouseEvent) => {
      const { x, y } = clientToNatural(e.clientX, e.clientY)
      if (draft) {
        if (draft.type === "rect") {
          setDraft({ ...draft, w: x - draft.x, h: y - draft.y })
        } else {
          setDraft({ ...draft, points: [...draft.points, { x, y }] })
        }
        return
      }
      if (mode === "mosaic" && mosaicDragging) {
        setAnnotations((arr) => {
          const last = arr[arr.length - 1]
          if (!last || last.type !== "mosaic") return arr
          const prev = last.points[last.points.length - 1]
          if (prev && Math.hypot(prev.x - x, prev.y - y) < Math.max(2, stroke * 0.25)) return arr
          const next = [...arr]
          next[next.length - 1] = {
            ...last,
            points: [...last.points, { x, y }]
          }
          return next
        })
        setMosaicPreviewVersion((v) => v + 1)
      }
    },
    [draft, clientToNatural, mode, stroke, mosaicDragging]
  )

  const onAnnoUp = useCallback(() => {
    setMosaicDragging(false)
    if (!draft) return
    // 矩形归一化（允许向左上拖）
    if (draft.type === "rect") {
      const x = draft.w < 0 ? draft.x + draft.w : draft.x
      const y = draft.h < 0 ? draft.y + draft.h : draft.y
      const w = Math.abs(draft.w)
      const h = Math.abs(draft.h)
      // 拖动太小当无效（避免误点击产生 0×0 矩形）
      if (w >= 3 && h >= 3) {
        setAnnotations((arr) => [...arr, { ...draft, x, y, w, h }])
      }
    } else if (draft.type === "path") {
      if (draft.points.length > 0) {
        setAnnotations((arr) => [...arr, draft])
      }
    }
    setDraft(null)
  }, [draft])

  const doUndo = useCallback(() => {
    // 优先撤销最近一次裁剪，回退到裁剪前的完整图与标注
    if (cropHistory.length > 0) {
      const prev = cropHistory[cropHistory.length - 1]
      setCropHistory((h) => h.slice(0, -1))
      setDataUrl(prev.dataUrl)
      setImgSize(prev.imgSize)
      setAnnotations(prev.annotations)
      setCrop(null)
      setCropBeforeEdit(null)
      setSelectedAnnoId(null)
      setMosaicPreviewVersion((v) => v + 1)
      return
    }
    setAnnotations((arr) => arr.slice(0, -1))
    setSelectedAnnoId(null)
    setMosaicPreviewVersion((v) => v + 1)
  }, [cropHistory])

  const cancelCropEdit = useCallback(() => {
    setCrop(cropBeforeEdit)
    setCropBeforeEdit(null)
    setDragState(null)
    setMode("none")
  }, [cropBeforeEdit])

  const confirmCropEdit = useCallback(async () => {
    if (!crop || crop.w < 1 || crop.h < 1 || !dataUrl) {
      setError("请先拖动选择裁剪区域")
      return
    }
    setProcessingMessage("正在应用裁剪，请稍候...")
    try {
      const img = new Image()
      img.src = dataUrl
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve()
        img.onerror = () => reject(new Error("图片加载失败"))
      })
      const rect = {
        x: Math.max(0, Math.round(crop.x)),
        y: Math.max(0, Math.round(crop.y)),
        w: Math.max(1, Math.round(crop.w)),
        h: Math.max(1, Math.round(crop.h))
      }
      const out = document.createElement("canvas")
      out.width = rect.w
      out.height = rect.h
      const ctx = out.getContext("2d")
      if (!ctx) throw new Error("无法创建裁剪画布")
      ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h)

      // 压入裁剪前的完整状态，供“撤销”回退到上一级
      setCropHistory((h) => [
        ...h,
        { dataUrl, imgSize: { ...imgSize }, annotations: [...annotations] }
      ])

      // 已有标注保留在新图中：裁剪框外丢弃，框内坐标平移到新原点。
      setAnnotations((arr) =>
        arr
          .map((a) => moveAnnotation(a, -rect.x, -rect.y))
          .filter((a) => {
            const b = selectionBounds(a)
            return b.x + b.w > 0 && b.y + b.h > 0 && b.x < rect.w && b.y < rect.h
          })
      )
      setDataUrl(out.toDataURL("image/png"))
      setImgSize({ w: rect.w, h: rect.h })
      setCrop(null)
      setCropBeforeEdit(null)
      setSelectedAnnoId(null)
      setMosaicPreviewVersion((v) => v + 1)
      setMode("none")
      setProcessingMessage(null)
    } catch (err) {
      setProcessingMessage(null)
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [crop, dataUrl, imgSize, annotations])

  const doDeleteSelected = useCallback(() => {
    if (!selectedAnnoId) return
    setAnnotations((arr) => arr.filter((a) => a.id !== selectedAnnoId))
    setSelectedAnnoId(null)
    setMosaicPreviewVersion((v) => v + 1)
  }, [selectedAnnoId])

  const doClearAnno = useCallback(() => {
    if (annotations.length === 0) return
    if (window.confirm("清除所有标注？")) {
      setAnnotations([])
      setSelectedAnnoId(null)
      setMosaicPreviewVersion((v) => v + 1)
    }
  }, [annotations.length])

  // ============ 导出 ============
  /** 加载源图 + burn-in 标注 + 裁剪 → dataUrl。ignoreCrop=true 时导出整幅（跳过裁剪）。 */
  const renderExport = useCallback(
    async (ignoreCrop = false): Promise<string | null> => {
      if (!dataUrl) return null
      const img = new Image()
      img.src = dataUrl
      await new Promise<void>((r, j) => {
        img.onload = () => r()
        img.onerror = () => j(new Error("图片加载失败"))
      })
      const full = document.createElement("canvas")
      full.width = imgSize.w
      full.height = imgSize.h
      const fctx = full.getContext("2d")!
      fctx.drawImage(img, 0, 0)
      for (const a of annotations) bakeAnnotation(fctx, a, img)

      const sourceRect =
        ignoreCrop || !crop ? { x: 0, y: 0, w: imgSize.w, h: imgSize.h } : crop
      const preset = getQualityPreset(exportQuality)
      const out = document.createElement("canvas")
      out.width = Math.max(1, Math.round(sourceRect.w * preset.scale))
      out.height = Math.max(1, Math.round(sourceRect.h * preset.scale))
      const octx = out.getContext("2d")!
      octx.imageSmoothingEnabled = true
      octx.imageSmoothingQuality = "high"
      octx.drawImage(
        full,
        Math.round(sourceRect.x),
        Math.round(sourceRect.y),
        Math.round(sourceRect.w),
        Math.round(sourceRect.h),
        0,
        0,
        out.width,
        out.height
      )
      if (preset.mime === "image/jpeg") {
        return out.toDataURL(preset.mime, preset.quality)
      }
      const isJpeg = /\.jpe?g$/i.test(filename)
      return isJpeg
        ? out.toDataURL("image/jpeg", quality / 100)
        : out.toDataURL("image/png")
    },
    [dataUrl, crop, imgSize, annotations, filename, quality, exportQuality]
  )

  const getExportBlob = useCallback(
    async (ignoreCrop = false): Promise<Blob | null> => {
      const url = await renderExport(ignoreCrop)
      if (!url) return null
      return await (await fetch(url)).blob()
    },
    [renderExport]
  )

  /** 统一下载：Blob URL + chrome.downloads（避免超大 dataURL 经消息传递被丢弃），
   *  文件名清洗防止 "invalid filename"，成功后清理并关闭编辑器 tab。 */
  const downloadBlob = useCallback((blob: Blob, rawName: string) => {
    const url = URL.createObjectURL(blob)
    const name = sanitizeFilename(rawName)
    chrome.downloads.download({ url, filename: name, saveAs: true }, () => {
      const err = chrome.runtime.lastError
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
      if (err) {
        setProcessingMessage(null)
        setError(`下载失败：${err.message ?? "未知错误"}`)
        return
      }
      chrome.runtime.sendMessage(
        { type: MessageType.EDITOR_DISCARD },
        () => closeEditorTab()
      )
    })
  }, [])

  const doCopy = useCallback(async () => {
    if (processingMessage) return
    setProcessingMessage("正在处理大图并复制到剪贴板，请稍候...")
    try {
      const blob = await getExportBlob()
      if (!blob) return
      await navigator.clipboard.write([
        new ClipboardItem({ [blob.type || "image/png"]: blob })
      ])
      setProcessingMessage("已复制到剪贴板")
      window.setTimeout(() => setProcessingMessage(null), 1200)
    } catch (err) {
      setProcessingMessage(null)
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [getExportBlob, processingMessage])

  const doCrop = useCallback(async () => {
    if (processingMessage) return
    setProcessingMessage("正在处理大图并准备下载，请稍候...")
    try {
      const blob = await getExportBlob()
      if (!blob) {
        setProcessingMessage(null)
        setError("裁剪失败：未能生成图片")
        return
      }
      downloadBlob(blob, filenameForQuality(filename, exportQuality))
    } catch (err) {
      setProcessingMessage(null)
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [getExportBlob, downloadBlob, filename, processingMessage, exportQuality])

  const doDownloadOriginal = useCallback(async () => {
    if (!dataUrl || processingMessage) return
    setProcessingMessage("正在处理大图并准备下载，请稍候...")
    try {
      // 跳过裁剪：导出整幅（含标注），走统一 Blob 下载 + 文件名清洗
      const blob = await getExportBlob(true)
      if (!blob) {
        setProcessingMessage(null)
        setError("下载失败：未能生成图片")
        return
      }
      downloadBlob(blob, filenameForQuality(filename, exportQuality))
    } catch (err) {
      setProcessingMessage(null)
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [dataUrl, getExportBlob, downloadBlob, filename, processingMessage, exportQuality])

  const doDiscard = useCallback(() => {
    chrome.runtime.sendMessage(
      { type: MessageType.EDITOR_DISCARD },
      () => closeEditorTab()
    )
  }, [])

  // 渲染 SVG 路径 d
  const pathD = useCallback((pts: { x: number; y: number }[]): string => {
    if (pts.length === 0) return ""
    let d = `M ${pts[0].x} ${pts[0].y}`
    for (let i = 1; i < pts.length; i++) d += ` L ${pts[i].x} ${pts[i].y}`
    return d
  }, [])

  const allAnnos = useMemo<Annotation[]>(
    () => (draft ? [...annotations, draft] : annotations),
    [annotations, draft]
  )

  const renderMosaicPreview = useCallback(() => {
    const canvas = mosaicCanvasRef.current
    const img = imgRef.current
    if (!canvas || !img || imgSize.w === 0 || imgSize.h === 0) return
    const scale = img.clientWidth > 0 ? img.clientWidth / imgSize.w : 1
    const width = Math.max(1, Math.round(imgSize.w * scale))
    const height = Math.max(1, Math.round(imgSize.h * scale))
    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== height) canvas.height = height
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    ctx.clearRect(0, 0, width, height)
    for (const a of annotations) {
      if (a.type === "mosaic") bakeAnnotation(ctx, a, img, scale)
    }
  }, [annotations, imgSize, mosaicPreviewVersion, zoom, viewportWidth])

  useEffect(() => {
    if (previewFrameRef.current != null) {
      cancelAnimationFrame(previewFrameRef.current)
    }
    previewFrameRef.current = requestAnimationFrame(() => {
      previewFrameRef.current = null
      renderMosaicPreview()
    })
    return () => {
      if (previewFrameRef.current != null) {
        cancelAnimationFrame(previewFrameRef.current)
        previewFrameRef.current = null
      }
    }
  }, [renderMosaicPreview])

  const selectionBounds = useCallback((a: Annotation): CropRect => {
    if (a.type === "rect") return { x: a.x, y: a.y, w: a.w, h: a.h }
    if (a.type === "mosaic") {
      const xs = a.points.map((p) => p.x)
      const ys = a.points.map((p) => p.y)
      const pad = a.stroke / 2 + 4
      const minX = Math.min(...xs) - pad
      const minY = Math.min(...ys) - pad
      const maxX = Math.max(...xs) + pad
      const maxY = Math.max(...ys) + pad
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
    }
    if (a.type === "text") {
      const lines = a.text.split("\n")
      const maxLine = Math.max(...lines.map((line) => line.length), 1)
      return {
        x: a.x,
        y: a.y,
        w: maxLine * a.fontSize * 0.62,
        h: lines.length * a.fontSize * 1.2
      }
    }
    const xs = a.points.map((p) => p.x)
    const ys = a.points.map((p) => p.y)
    const pad = a.stroke + 4
    const minX = Math.min(...xs) - pad
    const minY = Math.min(...ys) - pad
    const maxX = Math.max(...xs) + pad
    const maxY = Math.max(...ys) + pad
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
  }, [])

  if (error) {
    return (
      <div className={styles.page}>
        <div className={styles.error}>{error}</div>
        <div className={styles.actions}>
          <button type="button" className={styles.btnDanger} onClick={doDiscard}>
            关闭
          </button>
        </div>
      </div>
    )
  }
  if (!dataUrl) {
    return (
      <div className={styles.page}>
        <div className={styles.loading}>加载中...</div>
      </div>
    )
  }

  const scale = getScale()
  const baseWidth = imgSize.w > 0 ? Math.min(imgSize.w, viewportWidth || imgSize.w) : 0
  const displayWidth = Math.max(1, baseWidth * zoom)
  const displayHeight = imgSize.w > 0 ? (displayWidth * imgSize.h) / imgSize.w : 0
  const renderW = imgRef.current?.clientWidth ?? displayWidth
  const renderH = imgRef.current?.clientHeight ?? displayHeight
  const cropPx = mode === "crop" && crop && crop.w > 0 && crop.h > 0
    ? {
        left: crop.x * scale,
        top: crop.y * scale,
        width: crop.w * scale,
        height: crop.h * scale
      }
    : null

  const textDraftPx = textDraft
    ? {
        left: textDraft.x * scale,
        top: textDraft.y * scale,
        width: Math.max(180, Math.min(420, renderW - textDraft.x * scale - 8)),
        fontSize: fontSize * scale
      }
    : null

  const selectedAnnotation = annotations.find((a) => a.id === selectedAnnoId)
  const selectedBounds = selectedAnnotation
    ? selectionBounds(selectedAnnotation)
    : null

  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
            <span className={styles.info}>
              {imgSize.w} x {imgSize.h}
              {crop && ` → ${Math.round(crop.w)} x ${Math.round(crop.h)}`}
              {annotations.length > 0 && ` · ${annotations.length} 处标注`}
            </span>
        <div className={styles.actions}>
          {processingMessage && (
            <span className={styles.processing}>{processingMessage}</span>
          )}
          <button
            type="button"
            className={styles.btnDanger}
            onClick={doDiscard}
            disabled={!!processingMessage}>
            放弃本次截图
          </button>
          <button
            type="button"
            className={styles.btnSecondary}
            onClick={doCopy}
            disabled={!!processingMessage}>
            复制到剪贴板
          </button>
          <button
            type="button"
            className={styles.btnSecondary}
            onClick={doDownloadOriginal}
            disabled={!!processingMessage}>
            跳过裁剪，直接下载
          </button>
          <button
            type="button"
            className={styles.btnPrimary}
            onClick={doCrop}
            disabled={!!processingMessage}>
            {processingMessage ? "处理中..." : "确认裁剪并下载"}
          </button>
        </div>
      </div>

      <div className={styles.toolbarRow}>
        {mode === "crop" ? (
          <div className={styles.cropToolActions}>
            <span className={styles.toolLabel}>
              {crop && crop.w > 0 && crop.h > 0
                ? `裁剪区域 ${Math.round(crop.w)} × ${Math.round(crop.h)}`
                : "拖动鼠标选择裁剪区域"}
            </span>
            <button
              type="button"
              className={styles.btnPrimary}
              disabled={!crop || crop.w < 1 || crop.h < 1 || !!processingMessage}
              onClick={confirmCropEdit}>
              确认
            </button>
            <button
              type="button"
              className={styles.btnSecondary}
              disabled={!!processingMessage}
              onClick={cancelCropEdit}>
              取消
            </button>
          </div>
        ) : (
          <>
        <div className={styles.toolGroup}>
          <span className={styles.toolLabel}>工具</span>
          {(
            [
              ["none", "无"],
              ["crop", "裁剪"],
              ["select", "选择"],
              ["rect", "矩形"],
              ["draw", "画笔"],
              ["text", "文字"],
              ["mosaic", "马赛克"]
            ] as [EditMode, string][]
          ).map(([m, label]) => (
            <button
              key={m}
              type="button"
              className={`${styles.toolBtn} ${mode === m ? styles.toolBtnActive : ""}`}
              onClick={() => {
                // 进入裁剪模式：清空裁剪框，先显示整幅深色遮罩，等用户拖出裁剪框
                if (m === "crop") {
                  setCropBeforeEdit(crop)
                  setCrop(null)
                }
                setMode(m)
                setSelectedAnnoId(null)
              }}>
              {label}
            </button>
          ))}
        </div>

        <div className={styles.toolGroup}>
          <span className={styles.toolLabel}>颜色</span>
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={c}
              className={`${styles.colorSwatch} ${color === c ? styles.colorSwatchActive : ""}`}
              style={{ background: c }}
              onClick={() => setColor(c)}
            />
          ))}
        </div>

        {mode !== "text" && (
          <div className={styles.toolGroup}>
            <span className={styles.toolLabel}>线宽</span>
            <select
              className={styles.strokeSelect}
              value={stroke}
              onChange={(e) => setStroke(Number(e.target.value))}>
              {(mode === "mosaic" ? MOSAIC_STROKES : STROKE_OPTIONS).map((s) => (
                <option key={s} value={s}>
                  {mode === "mosaic" ? `${s}px 笔刷` : `${s}px`}
                </option>
              ))}
            </select>
          </div>
        )}

        {mode === "text" && (
          <div className={styles.toolGroup}>
            <span className={styles.toolLabel}>字号</span>
            <select
              className={styles.strokeSelect}
              value={FONT_SIZES.includes(fontSize) ? fontSize : "custom"}
              onChange={(e) => {
                if (e.target.value !== "custom") setFontSize(Number(e.target.value))
              }}>
              {FONT_SIZES.map((s) => (
                <option key={s} value={s}>
                  {s}px
                </option>
              ))}
              <option value="custom">自定义</option>
            </select>
            <input
              className={styles.customSizeInput}
              type="number"
              min={1}
              max={100}
              step={1}
              value={fontSize}
              onChange={(e) => {
                const next = Number(e.target.value)
                if (Number.isFinite(next)) {
                  setFontSize(Math.max(1, Math.min(100, Math.round(next))))
                }
              }}
            />
          </div>
        )}

        <div className={styles.toolGroup}>
          <span className={styles.toolLabel}>清晰度</span>
          <select
            className={styles.strokeSelect}
            value={exportQuality}
            onChange={(e) => setExportQuality(e.target.value as ExportQuality)}>
            <option value="original">原图</option>
            <option value="high">高清压缩</option>
            <option value="medium">均衡</option>
            <option value="low">小体积</option>
          </select>
        </div>

        <div className={`${styles.toolGroup} ${styles.zoomControl}`}>
            <button
              type="button"
              className={styles.zoomBtn}
              onClick={() => {
                const index = ZOOM_LEVELS.findIndex((z) => z >= zoom)
                setZoom(ZOOM_LEVELS[Math.max(0, index - 1)] ?? ZOOM_LEVELS[0])
              }}>
              −
            </button>
            <span className={styles.zoomValue}>{Math.round(zoom * 100)}%</span>
            <button
              type="button"
              className={styles.zoomBtn}
              onClick={() => {
                const index = ZOOM_LEVELS.findIndex((z) => z > zoom)
                setZoom(index === -1 ? ZOOM_LEVELS[ZOOM_LEVELS.length - 1] : ZOOM_LEVELS[index])
              }}>
              +
            </button>
        </div>

        <div className={styles.toolGroup}>
          <button
            type="button"
            className={styles.toolBtn}
            onClick={doUndo}
            disabled={annotations.length === 0 && cropHistory.length === 0}>
            撤销
          </button>
          <button
            type="button"
            className={styles.toolBtn}
            onClick={doDeleteSelected}
            disabled={!selectedAnnoId}>
            删除选中
          </button>
          <button
            type="button"
            className={styles.toolBtn}
            onClick={doClearAnno}
            disabled={annotations.length === 0}>
            清空标注
          </button>
        </div>
          </>
        )}
      </div>

      <div
        ref={containerRef}
        className={styles.canvas}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}>
        <div className={styles.imgWrap} style={{ width: displayWidth, height: displayHeight }}>
          <img
            ref={imgRef}
            src={dataUrl}
            className={styles.image}
            style={{ width: displayWidth, height: displayHeight }}
            onLoad={onImgLoad}
            draggable={false}
          />
          <canvas
            ref={mosaicCanvasRef}
            className={styles.mosaicCanvas}
            style={{ width: displayWidth, height: displayHeight }}
          />

          {/* 裁剪模式尚未拖出裁剪框：整幅深色遮罩，按住拖拽生成裁剪框 */}
          {mode === "crop" && !cropPx && (
            <div className={styles.overlay}>
              <div
                className={styles.mask}
                style={{ top: 0, left: 0, right: 0, bottom: 0 }}
                onMouseDown={onAnnoDown}
              />
            </div>
          )}

          {/* 裁剪 overlay：仅 crop 模式下可交互 */}
          {cropPx && (
            <div className={styles.overlay}>
              <div
                className={styles.mask}
                style={{ top: 0, left: 0, right: 0, height: cropPx.top }}
                onMouseDown={onAnnoDown}
              />
              <div
                className={styles.mask}
                style={{
                  top: cropPx.top,
                  left: 0,
                  width: cropPx.left,
                  height: cropPx.height
                }}
                onMouseDown={onAnnoDown}
              />
              <div
                className={styles.mask}
                style={{
                  top: cropPx.top,
                  left: cropPx.left + cropPx.width,
                  right: 0,
                  height: cropPx.height
                }}
                onMouseDown={onAnnoDown}
              />
              <div
                className={styles.mask}
                style={{
                  top: cropPx.top + cropPx.height,
                  left: 0,
                  right: 0,
                  bottom: 0
                }}
                onMouseDown={onAnnoDown}
              />
              <div
                  className={styles.cropBox}
                  style={{
                    left: cropPx.left,
                    top: cropPx.top,
                    width: cropPx.width,
                    height: cropPx.height
                  }}
                  onMouseDown={handleCropMoveDown}>
                <div
                  className={`${styles.handle} ${styles.handleTL}`}
                  onMouseDown={(e) => handleCropResizeDown(e, "tl")}
                />
                <div
                  className={`${styles.handle} ${styles.handleTR}`}
                  onMouseDown={(e) => handleCropResizeDown(e, "tr")}
                />
                <div
                  className={`${styles.handle} ${styles.handleBL}`}
                  onMouseDown={(e) => handleCropResizeDown(e, "bl")}
                />
                <div
                  className={`${styles.handle} ${styles.handleBR}`}
                  onMouseDown={(e) => handleCropResizeDown(e, "br")}
                />
                <div
                  className={`${styles.handle} ${styles.handleT}`}
                  onMouseDown={(e) => handleCropResizeDown(e, "t")}
                />
                <div
                  className={`${styles.handle} ${styles.handleB}`}
                  onMouseDown={(e) => handleCropResizeDown(e, "b")}
                />
                <div
                  className={`${styles.handle} ${styles.handleL}`}
                  onMouseDown={(e) => handleCropResizeDown(e, "l")}
                />
                <div
                  className={`${styles.handle} ${styles.handleR}`}
                  onMouseDown={(e) => handleCropResizeDown(e, "r")}
                />
              </div>
            </div>
          )}

          {textDraft && textDraftPx && (
            <textarea
              className={styles.textInputOverlay}
              autoFocus
              value={textDraft.value}
              style={{
                left: textDraftPx.left,
                top: textDraftPx.top,
                width: textDraftPx.width,
                fontSize: Math.max(12, textDraftPx.fontSize),
                color
              }}
              placeholder="输入文字，支持换行"
              onChange={(e) =>
                setTextDraft((draft) =>
                  draft ? { ...draft, value: e.target.value } : draft
                )
              }
              onBlur={commitTextDraft}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault()
                  cancelTextDraft()
                }
                if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                  e.preventDefault()
                  commitTextDraft()
                }
              }}
            />
          )}

          {/* 标注层 SVG。viewBox 用自然像素，宽高用渲染像素 → 缩放自动适配。
              仅在非 crop 模式下接收指针事件。 */}
          {imgSize.w > 0 && (
            <svg
              className={`${styles.annoLayer} ${mode === "crop" ? styles.annoLayerCrop : ""}`}
              width={renderW}
              height={renderH}
              viewBox={`0 0 ${imgSize.w} ${imgSize.h}`}
              style={{ cursor: mode === "text" ? "text" : mode === "select" ? "move" : mode === "none" ? "default" : "crosshair" }}
              onMouseDown={onAnnoDown}
              onMouseMove={onAnnoMove}
              onMouseUp={onAnnoUp}
              onMouseLeave={onAnnoUp}>
              {allAnnos.map((a) => {
                if (a.type === "mosaic") {
                  const bounds = selectionBounds(a)
                  return (
                    <rect
                      key={a.id}
                      x={bounds.x}
                      y={bounds.y}
                      width={bounds.w}
                      height={bounds.h}
                      fill="transparent"
                      stroke="transparent"
                      className={styles.annoHit}
                      onMouseDown={(e) => onAnnotationSelect(e, a.id)}
                    />
                  )
                }
                if (a.type === "rect") {
                  const x = a.w < 0 ? a.x + a.w : a.x
                  const y = a.h < 0 ? a.y + a.h : a.y
                  const w = Math.abs(a.w)
                  const h = Math.abs(a.h)
                  return (
                    <rect
                      key={a.id}
                      x={x}
                      y={y}
                      width={w}
                      height={h}
                      fill="none"
                      stroke={a.color}
                      strokeWidth={a.stroke}
                      className={styles.annoHit}
                      onMouseDown={(e) => onAnnotationSelect(e, a.id)}
                    />
                  )
                }
                if (a.type === "path") {
                  return (
                    <path
                      key={a.id}
                      d={pathD(a.points)}
                      fill="none"
                      stroke={a.color}
                      strokeWidth={a.stroke}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className={styles.annoHit}
                      onMouseDown={(e) => onAnnotationSelect(e, a.id)}
                    />
                  )
                }
                // text
                const lines = a.text.split("\n")
                return (
                  <text
                    key={a.id}
                    x={a.x}
                    y={a.y}
                    fill={a.color}
                    fontSize={a.fontSize}
                    fontFamily='system-ui, -apple-system, "Segoe UI", sans-serif'
                    dominantBaseline="hanging"
                    className={styles.annoHit}
                    onMouseDown={(e) => onAnnotationSelect(e, a.id)}>
                    {lines.map((line, i) => (
                      <tspan
                        key={i}
                        x={a.x}
                        dy={i === 0 ? 0 : a.fontSize * 1.2}>
                        {line}
                      </tspan>
                    ))}
                  </text>
                )
              })}
              {selectedBounds && (
                <rect
                  x={selectedBounds.x}
                  y={selectedBounds.y}
                  width={selectedBounds.w}
                  height={selectedBounds.h}
                  fill="none"
                  stroke="#38bdf8"
                  strokeWidth={2 / Math.max(zoom, 0.1)}
                  strokeDasharray="6 4"
                  pointerEvents="none"
                />
              )}
            </svg>
          )}
        </div>
      </div>
    </div>
  )
}

export default Editor
