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
 *       4. 注册 webNavigation 监听器：录制中目标 tab 跳转后自动重注控制栏，
 *          保证「页面只有一份控制栏 + 跳转后仍在」。
 *
 *   停止：
 *     - popup / 控制栏「停止」→ background 广播 RECORDER_STOP
 *     - 同时 background 主动 executeScript 移除控制栏 DOM（无需依赖控制栏
 *       自身的 listener，避免新文档 listener 还没建上的窗口期）
 *     - 中转窗口里的 MediaRecorder.stop → 下载 → 发 RECORDER_FINISH
 *     - background 关闭中转窗口、解绑 webNavigation 监听、清理会话
 */
import {
  injectRecorderControlBar,
  removeRecorderControlBar,
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
 * 跨调用状态：录制中目标 tab 的 webNavigation 监听器
 *
 * 监听器**顶层注册一次**，永久挂住；内部根据 storage / 内存中的
 * activeTargetTabId 判断是否要重注控制栏。这样即便 service worker
 * 因空闲被回收又被事件唤醒，也能继续工作。
 * ============================================================ */
let activeTargetTabId: number | null = null
let recordingStartTime = 0

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
    } catch {
      return
    }
  }

  if (details.tabId !== activeTargetTabId) return

  // 跳转完成后控制栏 DOM 必然已被销毁，重新注入一份
  void reinjectControlBar(details.tabId)
})

async function reinjectControlBar(tabId: number): Promise<void> {
  if (recordingStartTime === 0) return
  const args: InjectedControlBarArgs = { startTime: recordingStartTime }
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: injectRecorderControlBar,
      args: [args]
    })
  } catch {
    /* 浏览器内部页 / 已关闭等情况，忽略 */
  }
}

function setActiveTab(tabId: number, startTime: number): void {
  activeTargetTabId = tabId
  recordingStartTime = startTime
}

function clearActiveTab(): void {
  activeTargetTabId = null
  recordingStartTime = 0
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

    const startedAt = Date.now()
    recordingStartTime = startedAt

    // 1.1 注入控制栏 UI 到目标 tab（不做录制，仅显示计时 + 暂停 + 停止）
    const controlBarArgs: InjectedControlBarArgs = { startTime: startedAt }
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
      startedAt,
      recorderWindowId
    })

    // 1.4 标记当前活跃目标 tab（webNavigation 监听器永久挂在顶层）
    setActiveTab(tabId, startedAt)

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
 * 2) 停止录制：广播消息 + 主动清理目标 tab 控制栏
 * ============================================================ */
export async function handleRecordStop(
  _request: RecordStopRequest
): Promise<SimpleResponse> {
  try {
    const stopMsg: RecorderStopRequest = { type: MessageType.RECORDER_STOP }
    // 广播给所有上下文：中转窗口收到后停 MediaRecorder
    await chrome.runtime.sendMessage(stopMsg).catch(() => undefined)

    // 同时主动清理目标 tab 上的控制栏 DOM —— 不依赖控制栏自身 listener，
    // 因为页面跳转过程中 listener 可能未及时建立。
    if (activeTargetTabId != null) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: activeTargetTabId },
          func: removeRecorderControlBar
        })
      } catch {
        /* tab 已关闭等情况，忽略 */
      }
    }

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

  // 兜底再清一次目标 tab 的控制栏（handleRecordStop 通常已清，但 stop 链路
  // 可能由其它路径触发，例如用户点 Chrome 共享栏的「停止共享」按钮）
  if (activeTargetTabId != null) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: activeTargetTabId },
        func: removeRecorderControlBar
      })
    } catch {
      /* 忽略 */
    }
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
