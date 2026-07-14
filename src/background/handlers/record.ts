/**
 * 录屏相关的 background 处理逻辑
 *
 * 设计：
 *   把 MediaRecorder 放到「中转扩展窗口」（屏幕外的 popup 类型 window）里，
 *   而不是目标页面的 content script —— 因为后者所在的网页进程产出的 webm
 *   缺 Duration、字节布局异常，导致下载文件无法播放。
 *
 *   录制模式：
 *     - 当前标签页（整个视口）：handleRecordStartCurrentTab
 *     - 区域录制（当前标签页）：handleRecordStartRegionTab
 *         · 在目标 tab 注入选区 picker 等用户拖出 rect
 *         · 松手后保留一个红色边框 div 标记「正在录的区域」
 *         · rect 写入 RECORDER_BOOT.region；中转窗口里把视频流接到 canvas
 *           按 rect 裁剪后再喂给 MediaRecorder
 *         · 跳转后由 webNavigation 监听器同时重注「控制栏 + 边框」
 *
 *   流程（共通）：
 *     popup 用户手势同步栈里申请 streamId → 消息 → 本 handler。
 *     handler：
 *       1. 把控制栏 UI 注入到目标 tab（仅 UI，不再做 MediaRecorder）
 *       2. 把 streamId / 选项 / tabTitle / region 暂存 storage
 *       3. chrome.windows.create 拉起中转窗口（popup.html?action=offscreenRecorder）
 *       4. 通过顶层注册的 webNavigation 监听器跟踪目标 tab 的跳转
 *
 *   停止：
 *     - popup / 控制栏「停止」→ background 广播 RECORDER_STOP
 *     - background 主动 executeScript 移除控制栏 + 区域边框 DOM
 *     - 中转窗口里的 MediaRecorder.stop → 下载 → 发 RECORDER_FINISH
 *     - background 关闭中转窗口、清除活跃 tab 标记、清理会话
 */
import {
  injectRegionFrame,
  pickSelection,
  removeRegionFrame,
  type SelectionResult
} from "~src/background/injected/selection"
import {
  MessageType,
  type RecorderFinishRequest,
  type RecorderStartedRequest,
  type RecorderStopRequest,
  type RecordStartCurrentTabRequest,
  type RecordStartRegionTabRequest,
  type RecordStopRequest
} from "~src/shared/messages"
import { buildRecordingFilename } from "~src/shared/filename"
import {
  clearRecordSession,
  getRecordOptions,
  getRecordSession,
  setRecordSession,
  type RecordResolution
} from "~src/shared/recordOptions"

interface SimpleResponse {
  ok: boolean
  error?: string
  cancelled?: boolean
}

/** storage key：临时录制配置（中转窗口启动时读） */
const RECORDER_BOOT_KEY = "__recorderBoot"
/** storage key：录制中目标 tab 的标题（用于生成文件名） */
const RECORDING_TAB_TITLE_KEY = "__recordingTabTitle"

interface RecorderBootConfig {
  streamId: string
  tabId: number
  tabTitle: string
  microphone: boolean
  systemAudio: boolean
  /** 录制分辨率档位（影响 getUserMedia 的 maxWidth/maxHeight 约束） */
  resolution: RecordResolution
  filename: string
  /** 区域录制：裁剪矩形（CSS 像素 + dpr）；省略 = 录整个视口 */
  region?: SelectionResult
}

/* ============================================================
 * 跨调用状态：录制中目标 tab 的 webNavigation 监听器
 *
 * 监听器**顶层注册一次**，永久挂住；内部根据 storage / 内存中的
 * activeTargetTabId 判断是否要重注控制栏。这样即便 service worker
 * 因空闲被回收又被事件唤醒，也能继续工作。
 * ============================================================ */
let activeTargetTabId: number | null = null
let recordingStartTime = 0
let activeRegion: SelectionResult | null = null

chrome.webNavigation.onCommitted.addListener(async (details) => {
  // 仅响应主框架导航
  if (details.frameId !== 0) return

  // 内存里没有目标 tab，说明 SW 刚被唤醒；从 storage 兜底恢复
  if (activeTargetTabId == null || recordingStartTime === 0) {
    try {
      const session = await getRecordSession()
      if (!session.recording || session.startedAt == null) return
      const store = await chrome.storage.local.get(RECORDER_BOOT_KEY)
      const boot = store[RECORDER_BOOT_KEY] as RecorderBootConfig | undefined
      if (!boot) return
      activeTargetTabId = boot.tabId
      recordingStartTime = session.startedAt
      activeRegion = boot.region ?? null
    } catch {
      return
    }
  }

  if (details.tabId !== activeTargetTabId) return

  // 控制栏已移到悬浮窗口，无需重注；仅区域边框需随页面导航重注
  if (activeRegion) {
    void reinjectRegionFrame(details.tabId, activeRegion)
  }
})

async function reinjectRegionFrame(
  tabId: number,
  region: SelectionResult
): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: injectRegionFrame,
      args: [region]
    })
  } catch {
    /* 忽略 */
  }
}

function setActiveTab(
  tabId: number,
  startTime: number,
  region: SelectionResult | null
): void {
  activeTargetTabId = tabId
  recordingStartTime = startTime
  activeRegion = region
}

function clearActiveTab(): void {
  activeTargetTabId = null
  recordingStartTime = 0
  activeRegion = null
}

/* ============================================================
 * 通用：校验目标 tab + 拿 tabTitle / opts
 * ============================================================ */
async function validateTargetTab(tabId: number): Promise<
  | { ok: true; tab: chrome.tabs.Tab; tabTitle: string }
  | { ok: false; error: string }
> {
  let tab: chrome.tabs.Tab | null = null
  try {
    tab = await chrome.tabs.get(tabId)
  } catch {
    return { ok: false, error: "目标标签页不可访问" }
  }
  const url = tab?.url ?? ""
  if (
    url.startsWith("chrome://") ||
    url.startsWith("edge://") ||
    url.startsWith("chrome-extension://")
  ) {
    return { ok: false, error: "当前页面不允许录制（浏览器内部页）" }
  }
  return { ok: true, tab, tabTitle: tab?.title ?? "tab" }
}

/* ============================================================
 * 通用：录制启动主流程
 *   - 注入控制栏
 *   - 写入 RECORDER_BOOT
 *   - 拉起中转窗口
 *   - 设会话 + 活跃 tab 标记
 * ============================================================ */
async function bootstrapRecorder(params: {
  streamId: string
  tabId: number
  tabTitle: string
  microphone: boolean
  systemAudio: boolean
  resolution: RecordResolution
  region: SelectionResult | null
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const {
    streamId,
    tabId,
    tabTitle,
    microphone,
    systemAudio,
    resolution,
    region
  } = params

  const startedAt = Date.now()

  // 1) 写 storage
  const boot: RecorderBootConfig = {
    streamId,
    tabId,
    tabTitle,
    microphone,
    systemAudio,
    resolution,
    filename: await buildRecordingFilename({ tabTitle, ext: "webm" }),
    ...(region ? { region } : {})
  }
  await chrome.storage.local.set({
    [RECORDER_BOOT_KEY]: boot,
    [RECORDING_TAB_TITLE_KEY]: tabTitle
  })

  // 2) 中转窗口：作为悬浮录屏控制窗，可见并置于屏幕右上角供用户操作
  const recorderUrl =
    chrome.runtime.getURL("popup.html") + "?action=offscreenRecorder"
  const RECORDER_W = 320
  const RECORDER_H = 200
  const pos = await computeFloatingWindowPos(RECORDER_W, RECORDER_H)
  let recorderWindowId: number | undefined
  try {
    const win = await chrome.windows.create({
      url: recorderUrl,
      type: "popup",
      width: RECORDER_W,
      height: RECORDER_H,
      left: pos.left,
      top: pos.top,
      focused: true
    })
    recorderWindowId = win?.id
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }

  await setRecordSession({
    recording: true,
    startedAt,
    recorderWindowId
  })
  setActiveTab(tabId, startedAt, region)

  return { ok: true }
}

/* ============================================================
 * 1) 开始录制（整个 tab）
 * ============================================================ */
export async function handleRecordStartCurrentTab(
  request: RecordStartCurrentTabRequest
): Promise<SimpleResponse> {
  try {
    const session = await getRecordSession()
    if (session.recording) return { ok: true }

    const { streamId, tabId } = request.payload
    const v = await validateTargetTab(tabId)
    if (!v.ok) return v

    const opts = await getRecordOptions()
    return await bootstrapRecorder({
      streamId,
      tabId,
      tabTitle: v.tabTitle,
      microphone: opts.microphone,
      systemAudio: opts.systemAudio,
      resolution: opts.resolution,
      region: null
    })
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

/* ============================================================
 * 1') 区域录制（当前标签页）
 *
 * 流程：
 *   1. 在目标 tab 注入选区 picker（保留松手后的红色边框 div）
 *   2. 等用户拖完拿 rect；取消则放行 streamId 不做任何事
 *   3. 复用 bootstrapRecorder 启动录制，把 rect 写到 boot.region
 * ============================================================ */
export async function handleRecordStartRegionTab(
  request: RecordStartRegionTabRequest
): Promise<SimpleResponse> {
  try {
    const session = await getRecordSession()
    if (session.recording) return { ok: true }

    const { streamId, tabId } = request.payload
    const v = await validateTargetTab(tabId)
    if (!v.ok) return v

    // 注入选区 picker 等用户拖拽
    let selection: SelectionResult | null = null
    try {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId },
        func: pickSelection,
        args: [{ keepFrameAfterPick: true }]
      })
      selection = (result?.result as SelectionResult | null) ?? null
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err)
      }
    }

    if (!selection) {
      // 用户取消（按 Esc 或拖拽过小）
      return { ok: false, cancelled: true, error: "已取消" }
    }

    const opts = await getRecordOptions()
    return await bootstrapRecorder({
      streamId,
      tabId,
      tabTitle: v.tabTitle,
      microphone: opts.microphone,
      systemAudio: opts.systemAudio,
      resolution: opts.resolution,
      region: selection
    })
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

/** 计算悬浮录屏控制窗的位置：放在主显示器工作区右上角 */
async function computeFloatingWindowPos(
  width: number,
  height: number
): Promise<{ left: number; top: number }> {
  const margin = 20
  try {
    const displays = await chrome.system.display.getInfo()
    const primary = displays.find((d) => d.isPrimary) ?? displays[0]
    if (primary) {
      const wa = primary.workArea
      return {
        left: Math.max(wa.left, wa.left + wa.width - width - margin),
        top: wa.top + margin
      }
    }
  } catch {
    /* 拿不到显示器信息则用兜底位置 */
  }
  return { left: margin, top: margin }
}

/* ============================================================
 * 2) 停止录制：广播 + 主动清理目标 tab 控制栏 / 边框
 * ============================================================ */
export async function handleRecordStop(
  _request: RecordStopRequest
): Promise<SimpleResponse> {
  try {
    const stopMsg: RecorderStopRequest = { type: MessageType.RECORDER_STOP }
    await chrome.runtime.sendMessage(stopMsg).catch(() => undefined)

    if (activeTargetTabId != null) {
      await cleanupTargetTab(activeTargetTabId)
    }
    return { ok: true }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

/** 主动清理目标 tab 上的区域边框（控制栏已移至悬浮窗口，无需清理） */
async function cleanupTargetTab(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: removeRegionFrame
    })
  } catch {
    /* 忽略 */
  }
}

/* ============================================================
 * 2.5) 中转窗口回传：MediaRecorder 真正 start 的瞬间
 *
 * 用这个时间覆盖 bootstrap 时设的 startedAt（后者包含约 1s 准备时间），
 * 然后用新起点重注控制栏，让计时与实际视频时长对齐。
 * ============================================================ */
export async function handleRecorderStarted(
  request: RecorderStartedRequest
): Promise<SimpleResponse> {
  try {
    const { startedAt } = request.payload
    if (!Number.isFinite(startedAt) || startedAt <= 0) {
      return { ok: false, error: "invalid startedAt" }
    }

    const session = await getRecordSession()
    if (!session.recording) return { ok: true }

    recordingStartTime = startedAt
    await setRecordSession({ startedAt })

    // 控制栏计时已由悬浮窗口自行维护，无需回注目标 tab
    return { ok: true }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

/* ============================================================
 * 3) 中转窗口提交：下载已由窗口自行完成，本 handler 只负责清理
 * ============================================================ */
export async function handleRecorderFinish(
  request: RecorderFinishRequest,
  _sender: chrome.runtime.MessageSender
): Promise<SimpleResponse> {
  const { cancelled, error } = request.payload

  // 关闭中转窗口
  const session = await getRecordSession()
  if (session.recorderWindowId != null) {
    try {
      await chrome.windows.remove(session.recorderWindowId)
    } catch {
      /* 窗口可能已被用户/扩展自身关闭 */
    }
  }

  // 兜底再清一次目标 tab 上的覆盖物（handleRecordStop 通常已清，但 stop 链路
  // 可能由其它路径触发，例如用户点 Chrome 共享栏的「停止共享」按钮）
  if (activeTargetTabId != null) {
    await cleanupTargetTab(activeTargetTabId)
  }

  // 解绑活跃 tab 标记 + 清理会话状态
  clearActiveTab()
  await chrome.storage.local.remove([
    RECORDER_BOOT_KEY,
    RECORDING_TAB_TITLE_KEY
  ])
  await clearRecordSession()

  if (cancelled) {
    return { ok: false, cancelled: true, error: error ?? "已取消" }
  }
  if (error) {
    return { ok: false, error }
  }
  return { ok: true }
}
