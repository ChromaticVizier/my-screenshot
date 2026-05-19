/**
 * 录屏：popup 端调用层（封装消息收发）
 *
 * 关键：startCurrentTabRecording 必须在用户手势的同步栈中被调用
 *   （也就是直接在 onClick 里 await 它），中间不能有任何前置 await。
 *
 *   chrome.tabCapture.getMediaStreamId 在 popup 上下文有效，
 *   且能拿到当前活动 tab 的 streamId 同时指定 consumerTabId 让目标 tab
 *   的 content / 注入脚本合法消费。
 */
import {
  MessageType,
  type RecordStartCurrentTabRequest,
  type RecordStopRequest
} from "~src/shared/messages"

interface SimpleResponse {
  ok: boolean
  error?: string
  cancelled?: boolean
}

/**
 * 在 popup 同步上下文中申请 streamId，再请求 background 注入录制脚本。
 *
 * 这里**不能**先 await 拿 tabId 再申请 streamId —— 那样会脱离手势上下文。
 * 我们改成：让 background 异步查 tab，popup 这边只负责把 streamId 传过去。
 *
 * 但 getMediaStreamId 需要 targetTabId / consumerTabId —— 不传时
 * 默认走"调用方所在的 tab" 在 popup 里就是当前活动 tab。这刚好满足
 * 「录制当前标签页」的语义。
 */
export function startCurrentTabRecording(): Promise<SimpleResponse> {
  return new Promise((resolve) => {
    // 同步调用：保留用户手势
    try {
      chrome.tabCapture.getMediaStreamId(
        // 不传参数：targetTabId 与 consumerTabId 都默认为当前活动 tab，
        // 注入到该 tab 的脚本可以合法消费这个 streamId
        async (streamId: string) => {
          const lastError = chrome.runtime.lastError
          if (lastError || !streamId) {
            resolve({
              ok: false,
              error: lastError?.message ?? "无法获取 streamId"
            })
            return
          }
          // 把 streamId 通过消息交给 background，由它注入脚本到当前 tab
          const req: RecordStartCurrentTabRequest = {
            type: MessageType.RECORD_START_CURRENT_TAB,
            payload: { streamId }
          }
          chrome.runtime.sendMessage(req, (res: SimpleResponse) => {
            const err = chrome.runtime.lastError
            if (err) {
              resolve({ ok: false, error: err.message ?? "消息通道异常" })
              return
            }
            resolve(res)
          })
        }
      )
    } catch (err) {
      resolve({
        ok: false,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  })
}

export function stopRecording(): Promise<SimpleResponse> {
  const req: RecordStopRequest = { type: MessageType.RECORD_STOP }
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(req, (res: SimpleResponse) => {
      const err = chrome.runtime.lastError
      if (err) {
        resolve({ ok: false, error: err.message ?? "消息通道异常" })
        return
      }
      resolve(res)
    })
  })
}
