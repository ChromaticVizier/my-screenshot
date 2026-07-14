/**
 * 钉钉文档（docs.dingtalk.com/i/nodes/*）专用长截图。
 *
 * 结构（devtools 实测，同源可直接访问 iframe.contentDocument）：
 *   主 frame → iframe#wiki-doc-iframe (x=305,y=9) → 滚动容器 #layout_body
 *   （iframe 局部 0,97, w=1222, clientHeight=559, scrollHeight=2426）。
 *   正文列居中；容器内有 sticky 目录 / sticky 评论框 / fixed 字数统计（逐帧重复源）。
 *
 * 通用「子 iframe」自动流程在此站点会误判 scrollerIsSubFrame / frame 偏移，
 * 导致次帧左移 + 接缝重复。这里改为显式几何：
 *   - 主 frame 内直接拿 iframe 偏移与 #layout_body 度量（同源）；
 *   - 首帧整窗保留一次（含左侧导航 / 顶栏）；
 *   - 后续帧只裁切 scroller 在窗口中的矩形，drawX=iframeX、drawY=cropY+scrollTop，
 *     步长=可视高度（无重叠），与首帧无缝拼接，无重复无错位；
 *   - 截图前隐藏 iframe 内 fixed/sticky，避免吸顶元素逐帧重复。
 */
import {
  errorResponse,
  makeFullPageCapturingProgress,
  safeCaptureVisibleTab,
  sleep,
  type FullPageRouting
} from "~src/background/handlers/fullPageShared"
import { downloadImageBlob } from "~src/background/utils/download"
import {
  assertFullPageTaskNotCancelled,
  shouldStopFullPageCapture,
  updateFullPageTaskProgress
} from "~src/background/utils/fullPageTask"
import {
  dataUrlToBitmap,
  stitchToBlob,
  type CaptureSlice
} from "~src/background/utils/imaging"
import { getCapturableActiveTab } from "~src/background/utils/tabHelper"
import type {
  CaptureFullPageRequest,
  CaptureResponse
} from "~src/shared/messages"
import { getSettings } from "~src/shared/settings"

interface DingtalkPrep {
  found: boolean
  vw: number
  vh: number
  cropX: number
  cropY: number
  cropW: number
  cropH: number
  scrollHeight: number
  scrollTop: number
  devicePixelRatio: number
  backgroundColor: string
}

/* ===== 注入函数：均在主 frame 执行，经同源 iframe.contentDocument 访问正文 ===== */

function prepareDingtalk(): DingtalkPrep {
  const empty: DingtalkPrep = {
    found: false,
    vw: 0,
    vh: 0,
    cropX: 0,
    cropY: 0,
    cropW: 0,
    cropH: 0,
    scrollHeight: 0,
    scrollTop: 0,
    devicePixelRatio: window.devicePixelRatio || 1,
    backgroundColor: "#ffffff"
  }
  const found =
    (() => {
      const iframe =
        document.querySelector<HTMLIFrameElement>("iframe#wiki-doc-iframe") ||
        document.querySelector<HTMLIFrameElement>(
          "iframe[src*='dingtalk.com/note/edit']"
        )
      if (!iframe) return null
      let doc: Document | null = null
      try {
        doc = iframe.contentDocument
      } catch {
        doc = null
      }
      if (!doc) return null
      const sc = doc.querySelector<HTMLElement>("#layout_body")
      if (!sc) return null
      return { iframe, doc, sc }
    })()
  if (!found) return empty
  const { iframe, doc, sc } = found

  // 钉钉 iframe 内最外层应用容器。将其固定为完整视口高度，避免应用壳高度不足
  // 在 #layout_body 底边绘制分割线/遮挡带。只改 height/min-height/max-height，
  // 截图结束后恢复原 inline 样式。
  const dingapp = doc.querySelector<HTMLElement>("#dingapp")
  const DINGAPP_STYLE_ATTR = "data-my-ss-dt-dingapp-style"
  if (dingapp && !dingapp.hasAttribute(DINGAPP_STYLE_ATTR)) {
    dingapp.setAttribute(
      DINGAPP_STYLE_ATTR,
      JSON.stringify({
        height: dingapp.style.height,
        minHeight: dingapp.style.minHeight,
        maxHeight: dingapp.style.maxHeight
      })
    )
    dingapp.style.setProperty("height", "100vh", "important")
    dingapp.style.setProperty("min-height", "100vh", "important")
    dingapp.style.setProperty("max-height", "100vh", "important")
  }

  // 主 frame 的 iframe/正文壳本身带 border / box-shadow / outline，首帧整窗会把
  // 其底边截入接缝。截图期间只去视觉边框，不改 display/尺寸，避免布局回流。
  const FRAME_STYLE_ATTR = "data-my-ss-dt-frame-style"
  if (!iframe.hasAttribute(FRAME_STYLE_ATTR)) {
    iframe.setAttribute(
      FRAME_STYLE_ATTR,
      JSON.stringify({
        border: iframe.style.border,
        boxShadow: iframe.style.boxShadow,
        outline: iframe.style.outline
      })
    )
    iframe.style.setProperty("border", "0", "important")
    iframe.style.setProperty("box-shadow", "none", "important")
    iframe.style.setProperty("outline", "none", "important")
  }
  // iframe 的最近外层壳也可能绘制底边，记忆并清掉边框/阴影，保留占位和几何。
  const shell = iframe.parentElement
  const SHELL_STYLE_ATTR = "data-my-ss-dt-shell-style"
  if (shell && !shell.hasAttribute(SHELL_STYLE_ATTR)) {
    shell.setAttribute(
      SHELL_STYLE_ATTR,
      JSON.stringify({
        border: shell.style.border,
        boxShadow: shell.style.boxShadow,
        outline: shell.style.outline
      })
    )
    shell.style.setProperty("border", "0", "important")
    shell.style.setProperty("box-shadow", "none", "important")
    shell.style.setProperty("outline", "none", "important")
  }

  // 冻结 iframe 内动画/过渡
  const FREEZE_ID = "__my_ss_dingtalk_freeze__"
  if (!doc.getElementById(FREEZE_ID)) {
    const s = doc.createElement("style")
    s.id = FREEZE_ID
    s.textContent =
      "*,*::before,*::after{transition:none !important;animation:none !important;scroll-behavior:auto !important;}"
    ;(doc.head || doc.documentElement).appendChild(s)
  }

  // 隐藏 iframe 内 fixed/sticky（目录 / 评论框 / 字数统计等吸顶元素），标记以便还原
  const HIDE_ATTR = "data-my-ss-dt-hide"
  const win = iframe.contentWindow as Window
  sc.querySelectorAll<HTMLElement>("*").forEach((el) => {
    let cs: CSSStyleDeclaration
    try {
      cs = win.getComputedStyle(el)
    } catch {
      return
    }
    if (cs.position === "fixed" || cs.position === "sticky") {
      const r = el.getBoundingClientRect()
      // 跳过占满视口的大块（避免误伤主体）
      if (r.height >= sc.clientHeight * 0.9) return
      el.setAttribute(HIDE_ATTR, el.style.display || "")
      el.style.display = "none"
    }
  })
  // 文档区域外（iframe 内 body 直挂）的 fixed 也隐藏（如左下角字数统计）
  doc.querySelectorAll<HTMLElement>("body *").forEach((el) => {
    let cs: CSSStyleDeclaration
    try {
      cs = win.getComputedStyle(el)
    } catch {
      return
    }
    if (cs.position === "fixed") {
      const r = el.getBoundingClientRect()
      if (r.height >= doc.documentElement.clientHeight * 0.9) return
      if (el.hasAttribute(HIDE_ATTR)) return
      el.setAttribute(HIDE_ATTR, el.style.display || "")
      el.style.display = "none"
    }
  })

  sc.scrollTop = 0

  const vw = document.documentElement.clientWidth
  const vh = document.documentElement.clientHeight
  // iframe.getBoundingClientRect() 是窗口坐标；而 iframe 内元素的
  // getBoundingClientRect() 是「iframe 局部坐标」，必须叠加 iframe 偏移才是窗口坐标。
  const fr = iframe.getBoundingClientRect()
  const scr = sc.getBoundingClientRect()
  const cropX = Math.max(0, Math.round(fr.left + scr.left))
  const cropY = Math.max(0, Math.round(fr.top + scr.top))
  const cropW = Math.min(Math.round(scr.width), vw - cropX)
  const cropH = Math.min(sc.clientHeight, vh - cropY)

  // 取正文主背景色用于画布空白区（后续帧左侧侧栏槽）。优先 scroller，透明则 body/html。
  const pickBackground = (): string => {
    const candidates = [
      win.getComputedStyle(sc).backgroundColor,
      win.getComputedStyle(doc.body).backgroundColor,
      win.getComputedStyle(doc.documentElement).backgroundColor
    ]
    return (
      candidates.find(
        (c) => c && c !== "transparent" && c !== "rgba(0, 0, 0, 0)"
      ) || "#ffffff"
    )
  }

  return {
    found: true,
    vw,
    vh,
    cropX,
    cropY,
    cropW: Math.max(1, cropW),
    cropH: Math.max(1, cropH),
    scrollHeight: Math.max(sc.scrollHeight, sc.clientHeight),
    scrollTop: sc.scrollTop,
    devicePixelRatio: window.devicePixelRatio || 1,
    backgroundColor: pickBackground()
  }
}

function scrollDingtalk(y: number): { scrollTop: number; scrollHeight: number } {
  const iframe =
    document.querySelector<HTMLIFrameElement>("iframe#wiki-doc-iframe") ||
    document.querySelector<HTMLIFrameElement>(
      "iframe[src*='docs.dingtalk.com/note/edit']"
    )
  let doc: Document | null = null
  try {
    doc = iframe ? iframe.contentDocument : null
  } catch {
    doc = null
  }
  const sc = doc ? doc.querySelector<HTMLElement>("#layout_body") : null
  if (!sc) return { scrollTop: 0, scrollHeight: 0 }
  sc.scrollTop = y
  // 钉钉编辑器的布局/渲染会在下一帧才稳定；强制同步读取布局，调用方仍会额外等待。
  void sc.getBoundingClientRect()
  return {
    scrollTop: sc.scrollTop,
    scrollHeight: Math.max(sc.scrollHeight, sc.clientHeight)
  }
}

function restoreDingtalk(): void {
  const iframe =
    document.querySelector<HTMLIFrameElement>("iframe#wiki-doc-iframe") ||
    document.querySelector<HTMLIFrameElement>(
      "iframe[src*='dingtalk.com/note/edit']"
    )
  let doc: Document | null = null
  try {
    doc = iframe ? iframe.contentDocument : null
  } catch {
    doc = null
  }
  const restoreStyle = (el: HTMLElement, attr: string) => {
    try {
      const raw = el.getAttribute(attr)
      const saved = raw ? JSON.parse(raw) : null
      if (saved) {
        el.style.border = saved.border || ""
        el.style.boxShadow = saved.boxShadow || ""
        el.style.outline = saved.outline || ""
      }
    } catch {
      /* 忽略 */
    }
    el.removeAttribute(attr)
  }
  if (iframe) {
    restoreStyle(iframe, "data-my-ss-dt-frame-style")
    if (iframe.parentElement) {
      restoreStyle(iframe.parentElement, "data-my-ss-dt-shell-style")
    }
  }
  if (!doc) return
  // 还原 dingapp 原始高度
  const dingapp = doc.querySelector<HTMLElement>("#dingapp")
  const DINGAPP_STYLE_ATTR = "data-my-ss-dt-dingapp-style"
  if (dingapp?.hasAttribute(DINGAPP_STYLE_ATTR)) {
    try {
      const raw = dingapp.getAttribute(DINGAPP_STYLE_ATTR)
      const saved = raw ? JSON.parse(raw) : null
      if (saved) {
        dingapp.style.height = saved.height || ""
        dingapp.style.minHeight = saved.minHeight || ""
        dingapp.style.maxHeight = saved.maxHeight || ""
      }
    } catch {
      /* 忽略 */
    }
    dingapp.removeAttribute(DINGAPP_STYLE_ATTR)
  }
  doc.getElementById("__my_ss_dingtalk_freeze__")?.remove()
  const HIDE_ATTR = "data-my-ss-dt-hide"
  doc.querySelectorAll<HTMLElement>(`[${HIDE_ATTR}]`).forEach((el) => {
    el.style.display = el.getAttribute(HIDE_ATTR) || ""
    el.removeAttribute(HIDE_ATTR)
  })
}

export async function handleCaptureFullPageDingtalkDoc(
  _request: CaptureFullPageRequest,
  _routing?: FullPageRouting
): Promise<CaptureResponse> {
  const tabRes = await getCapturableActiveTab()
  if (!tabRes.ok) return { ok: false, error: tabRes.error }
  const tab = tabRes.tab
  const tabId = tab.id!

  const settings = await getSettings()
  const taskId = _request.payload?.taskId
  const format = _request.payload?.format ?? settings.imageFormat
  const quality = _request.payload?.quality ?? settings.imageQuality
  const fullPageRules = settings.fullPageRules
  const maxFullPageHeightPx = Math.max(
    0,
    Math.floor(fullPageRules.maxFullPageHeightPx ?? 0)
  )

  try {
    const [{ result: prep }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: prepareDingtalk
    })
    assertFullPageTaskNotCancelled(taskId)
    if (!prep || !prep.found) {
      return { ok: false, error: "未找到钉钉文档滚动容器" }
    }

    const dpr = prep.devicePixelRatio || 1
    const { vw, vh, cropX, cropY, cropW, cropH } = prep
    const contentOffsetY = cropY
    // #layout_body 可视区底部有边框/滚动槽，裁掉底部 4px；步长与实际绘制高度
    // 完全一致。不能用“完整 cropH + 重叠覆盖”——钉钉编辑器会把 scrollTop
    // 量化到约 30px 行高（MCP 实测 target=1222 → actual=1185.6），重叠覆盖会把
    // 不同行内容叠到一起，表现为大面积文字遮挡。
    const bottomTrim = Math.min(4, Math.max(0, cropH - 40))
    const sliceH = Math.max(40, cropH - bottomTrim)
    // 钉钉正文滚动存在行高吸附 + 异步排版，实际相邻帧推进量并不稳定。
    // 留出足够大的固定重叠（约 120px），覆盖 3~6 行；拼接时早帧在上，
    // 重叠内容不会重复显示，晚帧仅补充早帧未覆盖部分，从根本上避免跳行。
    const seamOverlap = Math.min(120, Math.max(24, Math.floor(sliceH * 0.2)))
    const step = Math.max(40, sliceH - seamOverlap)
    let scrollHeight = prep.scrollHeight

    updateFullPageTaskProgress(taskId, {
      phase: "capturing",
      current: 1,
      total: Math.max(1, scrollHeight),
      message: "正在滚动并截图"
    })

    const slices: CaptureSlice[] = []

    // 首帧前显式滚回顶部并等待稳定：用户可能在文档中间触发截图，
    // prepareDingtalk 的 scrollTop=0 之后需给虚拟化重绘留时间，否则首帧截到中部、截不全。
    let topStable = 0
    for (let i = 0; i < 12; i++) {
      const [{ result: s }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: scrollDingtalk,
        args: [0]
      })
      await sleep(150)
      if ((s?.scrollTop ?? 0) <= 1) {
        if (++topStable >= 2) break
      } else {
        topStable = 0
      }
    }
    assertFullPageTaskNotCancelled(taskId)

    // 首帧：整窗保留（左侧导航 / 顶栏只出现这一次）
    const firstUrl = await safeCaptureVisibleTab(tab.windowId, { format: "png" })
    assertFullPageTaskNotCancelled(taskId)
    if (!firstUrl) throw new Error("截图失败：返回数据为空")
    // 首帧保留窗口顶部至正文可绘制底边。#layout_body 下方仍有 iframe 外壳区域，
    // 若作为第二片上移拼接，会在 drawEarlierOnTop 模式下压住后续正文，形成横向遮挡带。
    // 后续帧从 contentOffsetY + scrollTop 放置，负责连续补齐正文。
    const firstBitmap = await dataUrlToBitmap(firstUrl)
    const firstFrameH = Math.max(1, cropY + sliceH)
    const firstSlice: CaptureSlice = {
      bitmap: firstBitmap,
      scrollY: 0,
      destX: 0,
      sourceX: 0,
      sourceY: 0,
      sourceWidth: vw,
      sourceHeight: firstFrameH
    }
    slices.push(firstSlice)

    // 后续帧按实际 scrollTop 放置。每帧只绘制到与下一帧重叠区的中点：
    // 钉钉滚动会吸附到段落位置，帧底常截断一行；若整块重叠并让早帧置顶，
    // 早帧的半行会覆盖晚帧中的完整行。中点切缝让每个文档坐标只来自一帧。
    let target = step
    let prevScrollTop = 0
    let stall = 0
    let contentBottom = contentOffsetY + sliceH
    let pendingSlice: CaptureSlice | null = null
    const MAX_FRAMES = 400

    const commitPendingSlice = (nextScrollTop?: number) => {
      if (!pendingSlice) return
      if (nextScrollTop != null) {
        const pendingTop = pendingSlice.scrollY - contentOffsetY
        const seam = Math.round((pendingTop + sliceH + nextScrollTop) / 2)
        pendingSlice.sourceHeight = Math.max(1, seam - pendingTop)
      }
      slices.push(pendingSlice)
      contentBottom = Math.max(
        contentBottom,
        pendingSlice.scrollY + (pendingSlice.sourceHeight ?? sliceH)
      )
      pendingSlice = null
    }

    for (let i = 0; i < MAX_FRAMES; i++) {
      if (shouldStopFullPageCapture(taskId)) break

      const [{ result: sres }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: scrollDingtalk,
        args: [target]
      })
      const scrollTop = sres?.scrollTop ?? prevScrollTop
      if (typeof sres?.scrollHeight === "number") {
        scrollHeight = Math.max(scrollHeight, sres.scrollHeight)
      }
      await sleep(160)

      if (scrollTop <= prevScrollTop + 1) {
        if (++stall >= 2) break
      } else {
        stall = 0
      }

      const url = await safeCaptureVisibleTab(tab.windowId, { format: "png" })
      if (!url) break
      const bitmap = await dataUrlToBitmap(url)
      if (!pendingSlice) {
        const seam = Math.round((sliceH + scrollTop) / 2)
        firstSlice.sourceHeight = Math.max(1, contentOffsetY + seam)
      }
      commitPendingSlice(scrollTop)
      const frameStart = contentOffsetY + scrollTop
      pendingSlice = {
        bitmap,
        scrollY: frameStart,
        destX: cropX,
        sourceX: cropX,
        sourceY: cropY,
        sourceWidth: cropW,
        sourceHeight: sliceH
      }
      const drawableH = sliceH

      updateFullPageTaskProgress(
        taskId,
        makeFullPageCapturingProgress(
          contentOffsetY + scrollTop,
          contentOffsetY + scrollHeight
        )
      )

      if (
        maxFullPageHeightPx > 0 &&
        contentOffsetY + scrollTop + drawableH >= maxFullPageHeightPx
      ) {
        break
      }
      // 触底：actual 已到最大 scrollTop。尾帧已经按回退量裁去重复内容。
      if (scrollTop + cropH >= scrollHeight - 1) break

      prevScrollTop = scrollTop
      target = scrollTop + step
    }
    commitPendingSlice()

    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: restoreDingtalk
      })
    } catch {
      /* 忽略 */
    }

    if (slices.length === 0) {
      assertFullPageTaskNotCancelled(taskId)
      throw new Error("未截取到任何内容")
    }

    updateFullPageTaskProgress(taskId, {
      phase: "stitching",
      current: 1,
      total: 1,
      message: "正在拼接"
    })

    const canvasHeight =
      maxFullPageHeightPx > 0
        ? Math.min(maxFullPageHeightPx, Math.max(contentBottom, vh))
        : Math.max(contentBottom, vh)
    const blob = await stitchToBlob({
      slices,
      viewportWidth: vw,
      totalHeight: canvasHeight,
      devicePixelRatio: dpr,
      format,
      quality,
      backgroundColor: prep.backgroundColor
    })
    slices.forEach((s) => s.bitmap.close())

    const downloadId = await downloadImageBlob({
      blob,
      // 钉钉文档标题常为零宽不可见字符，清洗后为空 → 文件名退化成 "png.png"。
      // 固定用「钉钉文档」作为标题，得到有意义的默认文件名。
      tabTitle: "钉钉文档",
      ext: format
    })
    return { ok: true, downloadId }
  } catch (err) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: restoreDingtalk
      })
    } catch {
      /* 忽略 */
    }
    return errorResponse(err)
  }
}
