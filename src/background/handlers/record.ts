/**
 * 录屏相关的 background 处理逻辑
 *
 * 设计：
 *   不依赖任何扩展窗口或 getDisplayMedia 选择器。
 *   通过 chrome.tabCapture.getMediaStreamId 拿到当前标签页的 streamId，
 *   再用 chrome.scripting.executeScript 把「录制 + 控制栏 UI」一起注入
 *   到目标页面里执行。
 *
 *   优点：
 *     - 完全无授权弹窗（与 Awesome Screenshot 行为一致）
 *     - 控制栏直接显示在用户当前页面上，符合参考截图
 *     - 录制完成后，注入脚本通过 chrome.runtime.sendMessage 把 dataUrl
 *       发回 background → 走现有下载链路
 */
import {
  injectRecorderUI,
  type InjectedRecorderConfig,
  type InjectedStartArgs
} from "~src/background/injected/recorder"
import { downloadRecordingDataUrl } from "~src/background/utils/download"
import { getCapturableActiveTab } from "~src/background/utils/tabHelper"
import {
  MessageType,
  type RecorderFinishRequest,
  type RecorderStopRequest,
  type RecordStartCurrentTabRequest,
  type RecordStopRequest
} from "~src/shared/messages"
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

/* ============================================================
 * 1) 开始录制：把 popup 已申请好的 streamId 注入到当前 tab 消费
 *
 * 关于「streamId 必须就地消费」：
 *   chrome.tabCapture.getMediaStreamId 申请的 streamId 只能由
 *   `consumerTabId` 指定的 tab 消费。未传时默认 = 调用方所在 tab，
 *   所以由 popup 申请、并交给目标 tab 的注入脚本使用，恰好满足该规则。
 * ============================================================ */
export async function handleRecordStartCurrentTab(
  request: RecordStartCurrentTabRequest
): Promise<SimpleResponse> {
  try {
    const session = await getRecordSession()
    if (session.recording) return { ok: true }

    const tabRes = await getCapturableActiveTab()
    if (!tabRes.ok) return { ok: false, error: tabRes.error }
    const tab = tabRes.tab
    const tabId = tab.id!

    const opts = await getRecordOptions()

    // 注入录制脚本到目标 tab。脚本会在页面里启动 MediaRecorder + 渲染控制栏
    const config: InjectedRecorderConfig = {
      streamId: request.payload.streamId,
      microphone: opts.microphone,
      systemAudio: opts.systemAudio
    }
    const args: InjectedStartArgs = { config }

    await chrome.scripting.executeScript({
      target: { tabId },
      func: injectRecorderUI,
      args: [args]
    })

    await setRecordSession({
      recording: true,
      startedAt: Date.now()
    })
    await chrome.storage.local.set({
      __recordingTabTitle: tab.title ?? null
    })

    return { ok: true }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

/* ============================================================
 * 2) 停止录制：通过广播消息让注入脚本里的 listener 触发 stop
 * ============================================================ */
export async function handleRecordStop(
  _request: RecordStopRequest
): Promise<SimpleResponse> {
  try {
    const stopMsg: RecorderStopRequest = { type: MessageType.RECORDER_STOP }
    // 广播给所有上下文，注入脚本的 listener 会响应
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
 * 3) 注入脚本提交：下载视频
 * ============================================================ */
export async function handleRecorderFinish(
  request: RecorderFinishRequest,
  _sender: chrome.runtime.MessageSender
): Promise<SimpleResponse> {
  const { dataUrl, ext, cancelled, error } = request.payload

  // 清理会话（无论成功失败都要清）
  await clearRecordSession()

  if (cancelled) {
    return { ok: false, cancelled: true, error: error ?? "已取消" }
  }
  if (error || !dataUrl) {
    return { ok: false, error: error ?? "录制失败：无视频数据" }
  }

  try {
    const titleStore = await chrome.storage.local.get("__recordingTabTitle")
    const tabTitle =
      (titleStore.__recordingTabTitle as string | null | undefined) ?? "tab"

    await downloadRecordingDataUrl({ dataUrl, tabTitle, ext })
    return { ok: true }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}
