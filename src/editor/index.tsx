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

type EditMode = "crop" | "rect" | "draw" | "text"

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
type Annotation = AnnoRect | AnnoPath | AnnoText

const COLORS = ["#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#a855f7", "#000000", "#ffffff"]
const STROKE_OPTIONS = [2, 4, 6, 10]
/** 文字字号档位（自然像素）。和 stroke 解耦，避免线宽影响字号。 */
const FONT_SIZES = [16, 24, 32, 48]

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

/** 在 canvas 上烘焙一条标注。
 *  与 SVG 渲染要保持视觉一致，所以参数（lineWidth/font）都用自然像素，
 *  上游传进来的 canvas 必须是「自然尺寸」。 */
function bakeAnnotation(ctx: CanvasRenderingContext2D, a: Annotation): void {
  ctx.save()
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
  const [quality, setQuality] = useState(92)

  // 裁剪交互
  const [dragging, setDragging] = useState<string | null>(null)
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 })
  const [cropStart, setCropStart] = useState<CropRect>({ x: 0, y: 0, w: 0, h: 0 })

  // 标注
  const [mode, setMode] = useState<EditMode>("crop")
  const [color, setColor] = useState(COLORS[0])
  const [stroke, setStroke] = useState<number>(4)
  const [fontSize, setFontSize] = useState<number>(24)
  const [annotations, setAnnotations] = useState<Annotation[]>([])
  /** 正在拖拽创建中的标注（rect / path），松开鼠标后才 commit 进 annotations */
  const [draft, setDraft] = useState<AnnoRect | AnnoPath | null>(null)

  const containerRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)

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

  // 撤销快捷键
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault()
        setAnnotations((arr) => arr.slice(0, -1))
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const onImgLoad = useCallback(() => {
    if (!imgRef.current) return
    const { naturalWidth: w, naturalHeight: h } = imgRef.current
    setImgSize({ w, h })
    setCrop({ x: 0, y: 0, w, h })
  }, [])

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

  // ============ 裁剪框交互（原有） ============
  const handleMouseDown = useCallback(
    (e: React.MouseEvent, handle: string) => {
      e.preventDefault()
      e.stopPropagation()
      setDragging(handle)
      setDragStart({ x: e.clientX, y: e.clientY })
      if (crop) setCropStart({ ...crop })
    },
    [crop]
  )

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!dragging || !crop) return
      const scale = getScale()
      const dx = (e.clientX - dragStart.x) / scale
      const dy = (e.clientY - dragStart.y) / scale
      let { x, y, w, h } = cropStart

      if (dragging === "move") {
        x = Math.max(0, Math.min(imgSize.w - w, x + dx))
        y = Math.max(0, Math.min(imgSize.h - h, y + dy))
      } else {
        if (dragging.includes("l")) {
          const nx = Math.max(0, Math.min(x + w - 20, x + dx))
          w = w - (nx - x)
          x = nx
        }
        if (dragging.includes("r")) {
          w = Math.max(20, Math.min(imgSize.w - x, w + dx))
        }
        if (dragging.includes("t")) {
          const ny = Math.max(0, Math.min(y + h - 20, y + dy))
          h = h - (ny - y)
          y = ny
        }
        if (dragging.includes("b")) {
          h = Math.max(20, Math.min(imgSize.h - y, h + dy))
        }
      }

      setCrop({ x, y, w, h })
    },
    [dragging, crop, dragStart, cropStart, getScale, imgSize]
  )

  const handleMouseUp = useCallback(() => {
    setDragging(null)
  }, [])

  // ============ 标注交互 ============
  const onAnnoDown = useCallback(
    (e: React.MouseEvent) => {
      if (mode === "crop") return
      // 文字模式：点击落字
      if (mode === "text") {
        e.preventDefault()
        e.stopPropagation()
        const { x, y } = clientToNatural(e.clientX, e.clientY)
        const text = window.prompt("输入文字：")
        if (!text) return
        setAnnotations((arr) => [
          ...arr,
          {
            id: nextId(),
            type: "text",
            x,
            y,
            text,
            color,
            stroke,
            fontSize
          }
        ])
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
      }
    },
    [mode, color, stroke, fontSize, clientToNatural]
  )

  const onAnnoMove = useCallback(
    (e: React.MouseEvent) => {
      if (!draft) return
      const { x, y } = clientToNatural(e.clientX, e.clientY)
      if (draft.type === "rect") {
        setDraft({ ...draft, w: x - draft.x, h: y - draft.y })
      } else {
        setDraft({ ...draft, points: [...draft.points, { x, y }] })
      }
    },
    [draft, clientToNatural]
  )

  const onAnnoUp = useCallback(() => {
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
    setAnnotations((arr) => arr.slice(0, -1))
  }, [])

  const doClearAnno = useCallback(() => {
    if (annotations.length === 0) return
    if (window.confirm("清除所有标注？")) {
      setAnnotations([])
    }
  }, [annotations.length])

  // ============ 导出 ============
  /** 加载源图 + burn-in 标注 + 裁剪 → dataUrl */
  const renderExport = useCallback(async (): Promise<string | null> => {
    if (!dataUrl || !crop) return null
    const img = new Image()
    img.src = dataUrl
    await new Promise<void>((r, j) => {
      img.onload = () => r()
      img.onerror = () => j(new Error("图片加载失败"))
    })
    // 1) 在自然尺寸 canvas 上画 img + 全部标注
    const full = document.createElement("canvas")
    full.width = imgSize.w
    full.height = imgSize.h
    const fctx = full.getContext("2d")!
    fctx.drawImage(img, 0, 0)
    for (const a of annotations) bakeAnnotation(fctx, a)
    // 2) 再做一次裁剪
    const out = document.createElement("canvas")
    out.width = Math.round(crop.w)
    out.height = Math.round(crop.h)
    const octx = out.getContext("2d")!
    octx.drawImage(
      full,
      Math.round(crop.x),
      Math.round(crop.y),
      Math.round(crop.w),
      Math.round(crop.h),
      0,
      0,
      Math.round(crop.w),
      Math.round(crop.h)
    )
    const isJpeg = /\.jpe?g$/i.test(filename)
    return isJpeg
      ? out.toDataURL("image/jpeg", quality / 100)
      : out.toDataURL("image/png")
  }, [dataUrl, crop, imgSize, annotations, filename, quality])

  const doCrop = useCallback(async () => {
    const url = await renderExport()
    if (!url) return
    chrome.runtime.sendMessage(
      {
        type: MessageType.EDITOR_DOWNLOAD,
        payload: { dataUrl: url, filename }
      },
      () => closeEditorTab()
    )
  }, [renderExport, filename])

  const doDownloadOriginal = useCallback(async () => {
    if (!dataUrl) return
    // 「跳过裁剪」也尊重标注：有标注就 burn-in 后下载，没标注直接发原图
    if (annotations.length === 0) {
      chrome.runtime.sendMessage(
        { type: MessageType.EDITOR_DOWNLOAD, payload: { dataUrl, filename } },
        () => closeEditorTab()
      )
      return
    }
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
    for (const a of annotations) bakeAnnotation(fctx, a)
    const isJpeg = /\.jpe?g$/i.test(filename)
    const url = isJpeg
      ? full.toDataURL("image/jpeg", quality / 100)
      : full.toDataURL("image/png")
    chrome.runtime.sendMessage(
      { type: MessageType.EDITOR_DOWNLOAD, payload: { dataUrl: url, filename } },
      () => closeEditorTab()
    )
  }, [dataUrl, annotations, imgSize, filename, quality])

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
  const renderW = imgRef.current?.clientWidth ?? 0
  const renderH = imgRef.current?.clientHeight ?? 0
  const cropPx = crop
    ? {
        left: crop.x * scale,
        top: crop.y * scale,
        width: crop.w * scale,
        height: crop.h * scale
      }
    : null

  const inAnnoMode = mode !== "crop"

  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
        <span className={styles.info}>
          {imgSize.w} x {imgSize.h}
          {crop && ` → ${Math.round(crop.w)} x ${Math.round(crop.h)}`}
          {annotations.length > 0 && ` · ${annotations.length} 处标注`}
        </span>
        <div className={styles.actions}>
          <button type="button" className={styles.btnDanger} onClick={doDiscard}>
            放弃本次截图
          </button>
          <button
            type="button"
            className={styles.btnSecondary}
            onClick={doDownloadOriginal}>
            跳过裁剪，直接下载
          </button>
          <button type="button" className={styles.btnPrimary} onClick={doCrop}>
            确认裁剪并下载
          </button>
        </div>
      </div>

      <div className={styles.toolbarRow}>
        <div className={styles.toolGroup}>
          <span className={styles.toolLabel}>工具</span>
          {(
            [
              ["crop", "裁剪"],
              ["rect", "矩形"],
              ["draw", "画笔"],
              ["text", "文字"]
            ] as [EditMode, string][]
          ).map(([m, label]) => (
            <button
              key={m}
              type="button"
              className={`${styles.toolBtn} ${mode === m ? styles.toolBtnActive : ""}`}
              onClick={() => setMode(m)}>
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
              {STROKE_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s}px
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
              value={fontSize}
              onChange={(e) => setFontSize(Number(e.target.value))}>
              {FONT_SIZES.map((s) => (
                <option key={s} value={s}>
                  {s}px
                </option>
              ))}
            </select>
          </div>
        )}

        <div className={styles.toolGroup}>
          <button
            type="button"
            className={styles.toolBtn}
            onClick={doUndo}
            disabled={annotations.length === 0}>
            撤销
          </button>
          <button
            type="button"
            className={styles.toolBtn}
            onClick={doClearAnno}
            disabled={annotations.length === 0}>
            清空标注
          </button>
        </div>
      </div>

      <div
        ref={containerRef}
        className={styles.canvas}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}>
        <div className={styles.imgWrap}>
          <img
            ref={imgRef}
            src={dataUrl}
            className={styles.image}
            onLoad={onImgLoad}
            draggable={false}
          />

          {/* 裁剪 overlay：仅 crop 模式下可交互 */}
          {cropPx && (
            <div className={styles.overlay}>
              <div
                className={styles.mask}
                style={{ top: 0, left: 0, right: 0, height: cropPx.top }}
              />
              <div
                className={styles.mask}
                style={{
                  top: cropPx.top,
                  left: 0,
                  width: cropPx.left,
                  height: cropPx.height
                }}
              />
              <div
                className={styles.mask}
                style={{
                  top: cropPx.top,
                  left: cropPx.left + cropPx.width,
                  right: 0,
                  height: cropPx.height
                }}
              />
              <div
                className={styles.mask}
                style={{
                  top: cropPx.top + cropPx.height,
                  left: 0,
                  right: 0,
                  bottom: 0
                }}
              />
              <div
                className={`${styles.cropBox} ${inAnnoMode ? styles.cropBoxIdle : ""}`}
                style={{
                  left: cropPx.left,
                  top: cropPx.top,
                  width: cropPx.width,
                  height: cropPx.height
                }}
                onMouseDown={(e) => !inAnnoMode && handleMouseDown(e, "move")}>
                <div
                  className={`${styles.handle} ${styles.handleTL}`}
                  onMouseDown={(e) => !inAnnoMode && handleMouseDown(e, "tl")}
                />
                <div
                  className={`${styles.handle} ${styles.handleTR}`}
                  onMouseDown={(e) => !inAnnoMode && handleMouseDown(e, "tr")}
                />
                <div
                  className={`${styles.handle} ${styles.handleBL}`}
                  onMouseDown={(e) => !inAnnoMode && handleMouseDown(e, "bl")}
                />
                <div
                  className={`${styles.handle} ${styles.handleBR}`}
                  onMouseDown={(e) => !inAnnoMode && handleMouseDown(e, "br")}
                />
                <div
                  className={`${styles.handle} ${styles.handleT}`}
                  onMouseDown={(e) => !inAnnoMode && handleMouseDown(e, "t")}
                />
                <div
                  className={`${styles.handle} ${styles.handleB}`}
                  onMouseDown={(e) => !inAnnoMode && handleMouseDown(e, "b")}
                />
                <div
                  className={`${styles.handle} ${styles.handleL}`}
                  onMouseDown={(e) => !inAnnoMode && handleMouseDown(e, "l")}
                />
                <div
                  className={`${styles.handle} ${styles.handleR}`}
                  onMouseDown={(e) => !inAnnoMode && handleMouseDown(e, "r")}
                />
              </div>
            </div>
          )}

          {/* 标注层 SVG。viewBox 用自然像素，宽高用渲染像素 → 缩放自动适配。
              仅在非 crop 模式下接收指针事件。 */}
          {imgSize.w > 0 && (
            <svg
              className={`${styles.annoLayer} ${mode === "crop" ? styles.annoLayerCrop : ""}`}
              width={renderW}
              height={renderH}
              viewBox={`0 0 ${imgSize.w} ${imgSize.h}`}
              style={{ cursor: mode === "text" ? "text" : inAnnoMode ? "crosshair" : "default" }}
              onMouseDown={onAnnoDown}
              onMouseMove={onAnnoMove}
              onMouseUp={onAnnoUp}
              onMouseLeave={onAnnoUp}>
              {allAnnos.map((a) => {
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
                    dominantBaseline="hanging">
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
            </svg>
          )}
        </div>
      </div>
    </div>
  )
}

export default Editor
