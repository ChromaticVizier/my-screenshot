/**
 * 录屏相关的 background 处理逻辑
 *
 * 设计：
 *   把 MediaRecorder 放到「中转扩展窗口」（屏幕外的 popup 类型 window）里，
 *   而不是目标页面的 content script —— 因为后者所在的网页进程产出的 webm
 *   缺 Duration、字节布局异常，导致下载文件无法播放。
 *
 *   流程：
 *     popup 用户手势同步栈里：
 *       chrome.tabs.query → chrome.tabCapture.getMediaStreamId({targetTabId})
 *       拿到 streamId → 消息 → 本 handler。
 *     本 handler：
 *       1. 把控制栏 UI 注入到目标 tab（仅 UI，不再做 MediaRecorder）
 *       2. 把 streamId / 选项 / tabTitle 暂存 storage
 *       3. chrome.windows.create 拉起中转窗口（popup.html?action=offscreenRecorder）
 *          屏幕外，方便不被用户察觉；窗口里读 storage 后立刻调 getUserMedia
 *          + MediaRecorder。
 *
 *   停止：popup 或控制栏「停止」→ 广播 RECORDER_STOP → 控制栏隐藏自己 +
 *         中转窗口里的 MediaRecorder.stop。
 *   下载：中转窗口直接用 ObjectURL + chrome.downloads.download 落盘。
 *   清理：下载完成后中转窗口发 RECORDER_FINISH → background 关闭中转窗口
 *         + 清理会话。
 */
import {
  injectRecorderControlBar,
  type InjectedControlBarArgs
} from "~src/background/injected/recorder"
import {
  MessageType,
  type RecorderFinishRequest,
  type RecorderStopRequest,
  type RecordStartCurrentTabRequest,
  type RecordStopRequest
} from "~src/shared/messages"
import { buildRecordingFilename } from "~src/shared/filename"
import {
  clearRecordSession,
  getRecordOptions,
  getRecordSession,
  setRecordSession
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
  filename: string
}

/* ============================================================
 * 1) 开始录制
 * ============================================================ */
export async function handleRecordStartCurrentTab(
  request: RecordStartCurrentTabRequest
): Promise<SimpleResponse> {
  try {
    const session = await getRecordSession()
    if (session.recording) return { ok: true }

    const { streamId, tabId } = request.payload

    // 拿 tab 信息（用于文件名 + 内部页校验）
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

    const opts = await getRecordOptions()
    const tabTitle = tab?.title ?? "tab"

    // 1.1 注入控制栏 UI 到目标 tab（不做录制，仅显示计时 + 暂停 + 停止）
    const controlBarArgs: InjectedControlBarArgs = {
      // 注入脚本里通过这个 token 校验自身实例（防重复注入）
      token: String(Date.now())
    }
    await chrome.scripting.executeScript({
      target: { tabId },
      func: injectRecorderControlBar,
      args: [controlBarArgs]
    })

    // 1.2 把启动配置写入 storage 供中转窗口读取
    const boot: RecorderBootConfig = {
      streamId,
      tabId,
      tabTitle,
      microphone: opts.microphone,
      systemAudio: opts.systemAudio,
      filename: buildRecordingFilename({ tabTitle, ext: "webm" })
    }
    await chrome.storage.local.set({
      [RECORDER_BOOT_KEY]: boot,
      [RECORDING_TAB_TITLE_KEY]: tabTitle
    })

    // 1.3 创建中转窗口（屏幕外，避免占视野）
    const recorderUrl =
      chrome.runtime.getURL("popup.html") + "?action=offscreenRecorder"
    const win = await chrome.windows.create({
      url: recorderUrl,
      type: "popup",
      width: 320,
      height: 200,
      // 屏幕外坐标：Windows 上 Chrome 会把负坐标夹回主屏，
      // 所以这里放到「最右下显示器底部以下 50px」的空旷处。
      left: 0,
      top: 0,
      focused: false
    })
    const recorderWindowId = win?.id

    // 把窗口移到屏幕外
    if (recorderWindowId != null) {
      await moveWindowOffscreen(recorderWindowId).catch(() => undefined)
    }

    await setRecordSession({
      recording: true,
      startedAt: Date.now(),
      recorderWindowId
    })

    return { ok: true }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

/** 把指定窗口挪到所有显示器并集之外，避免被用户看到 */
async function moveWindowOffscreen(windowId: number): Promise<void> {
  let outsideTop = 5000
  let safeLeft = 0
  try {
    const displays = await chrome.system.display.getInfo()
    let maxBottom = 0
    let minLeft = Number.POSITIVE_INFINITY
    for (const d of displays) {
      const bottom = d.bounds.top + d.bounds.height
      if (bottom > maxBottom) maxBottom = bottom
      if (d.bounds.left < minLeft) minLeft = d.bounds.left
    }
    outsideTop = maxBottom + 50
    safeLeft = Number.isFinite(minLeft) ? minLeft : 0
  } catch {
    /* 拿不到则用兜底正值 */
  }
  try {
    await chrome.windows.update(windowId, {
      left: safeLeft,
      top: outsideTop,
      width: 320,
      height: 200,
      focused: false
    })
  } catch {
    /* 忽略 */
  }
}

/* ============================================================
 * 2) 停止录制：通过广播消息让控制栏 + 中转窗口同时收到
 * ============================================================ */
export async function handleRecordStop(
  _request: RecordStopRequest
): Promise<SimpleResponse> {
  try {
    const stopMsg: RecorderStopRequest = { type: MessageType.RECORDER_STOP }
    // 广播给所有上下文，控制栏注入脚本 + 中转窗口都会收到
    await chrome.runtime.sendMessage(stopMsg).catch(() => undefined)
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

  // 清理控制栏：广播再播一次 RECORDER_STOP，让仍在 DOM 上的控制栏移除
  // （正常情况下控制栏在收到第一次 STOP 时已隐藏，这里是兜底）
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
