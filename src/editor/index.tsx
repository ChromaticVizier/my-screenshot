/**
 * 截图裁剪编辑器
 *
 * 流程：
 *  1. 从 background 获取待编辑图片
 *  2. 展示图片 + 可拖拽裁剪框
 *  3. 用户确认裁剪 → canvas 裁切 → 发消息给 background 下载
 *  4. 或直接下载原图
 */
import { useCallback, useEffect, useRef, useState } from "react"

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

function Editor() {
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [filename, setFilename] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [imgSize, setImgSize] = useState({ w: 0, h: 0 })
  const [crop, setCrop] = useState<CropRect | null>(null)
  // JPEG 重编码质量（裁剪导出时用）；从用户设置读取，默认 92
  const [quality, setQuality] = useState(92)
  const [dragging, setDragging] = useState<string | null>(null)
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 })
  const [cropStart, setCropStart] = useState<CropRect>({ x: 0, y: 0, w: 0, h: 0 })
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

  const doCrop = useCallback(async () => {
    if (!dataUrl || !crop) return
    const img = new Image()
    img.src = dataUrl
    await new Promise<void>((r) => { img.onload = () => r() })
    const canvas = document.createElement("canvas")
    canvas.width = Math.round(crop.w)
    canvas.height = Math.round(crop.h)
    const ctx = canvas.getContext("2d")!
    ctx.drawImage(
      img,
      Math.round(crop.x),
      Math.round(crop.y),
      Math.round(crop.w),
      Math.round(crop.h),
      0,
      0,
      Math.round(crop.w),
      Math.round(crop.h)
    )
    // 按文件名后缀决定重编码格式，与捕获时选定的格式保持一致；
    // jpeg 时套用用户设置的质量，避免裁剪路径恒输出 png 让格式设置失效。
    const isJpeg = /\.jpe?g$/i.test(filename)
    const croppedUrl = isJpeg
      ? canvas.toDataURL("image/jpeg", quality / 100)
      : canvas.toDataURL("image/png")
    chrome.runtime.sendMessage(
      {
        type: MessageType.EDITOR_DOWNLOAD,
        payload: { dataUrl: croppedUrl, filename }
      },
      () => {
        closeEditorTab()
      }
    )
  }, [dataUrl, crop, filename, quality])

  const doDownloadOriginal = useCallback(() => {
    if (!dataUrl) return
    chrome.runtime.sendMessage(
      {
        type: MessageType.EDITOR_DOWNLOAD,
        payload: { dataUrl, filename }
      },
      () => {
        closeEditorTab()
      }
    )
  }, [dataUrl, filename])

  const doDiscard = useCallback(() => {
    chrome.runtime.sendMessage(
      { type: MessageType.EDITOR_DISCARD },
      () => {
        closeEditorTab()
      }
    )
  }, [])

  if (error) {
    return (
      <div className={styles.page}>
        <div className={styles.error}>{error}</div>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.btnDanger}
            onClick={doDiscard}>
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
  const cropPx = crop
    ? {
        left: crop.x * scale,
        top: crop.y * scale,
        width: crop.w * scale,
        height: crop.h * scale
      }
    : null

  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
        <span className={styles.info}>
          {imgSize.w} x {imgSize.h}
          {crop && ` → ${Math.round(crop.w)} x ${Math.round(crop.h)}`}
        </span>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.btnDanger}
            onClick={doDiscard}>
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
          {cropPx && (
            <div className={styles.overlay}>
              {/* dark masks */}
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
              {/* crop border */}
              <div
                className={styles.cropBox}
                style={{
                  left: cropPx.left,
                  top: cropPx.top,
                  width: cropPx.width,
                  height: cropPx.height
                }}
                onMouseDown={(e) => handleMouseDown(e, "move")}>
                {/* corner handles */}
                <div
                  className={`${styles.handle} ${styles.handleTL}`}
                  onMouseDown={(e) => handleMouseDown(e, "tl")}
                />
                <div
                  className={`${styles.handle} ${styles.handleTR}`}
                  onMouseDown={(e) => handleMouseDown(e, "tr")}
                />
                <div
                  className={`${styles.handle} ${styles.handleBL}`}
                  onMouseDown={(e) => handleMouseDown(e, "bl")}
                />
                <div
                  className={`${styles.handle} ${styles.handleBR}`}
                  onMouseDown={(e) => handleMouseDown(e, "br")}
                />
                {/* edge handles */}
                <div
                  className={`${styles.handle} ${styles.handleT}`}
                  onMouseDown={(e) => handleMouseDown(e, "t")}
                />
                <div
                  className={`${styles.handle} ${styles.handleB}`}
                  onMouseDown={(e) => handleMouseDown(e, "b")}
                />
                <div
                  className={`${styles.handle} ${styles.handleL}`}
                  onMouseDown={(e) => handleMouseDown(e, "l")}
                />
                <div
                  className={`${styles.handle} ${styles.handleR}`}
                  onMouseDown={(e) => handleMouseDown(e, "r")}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default Editor
