/**
 * 录屏：popup 端调用层（封装消息收发）
 *
 * 关键约束（多次踩坑后总结）：
 *
 * 1. chrome.tabCapture.getMediaStreamId 必须在用户手势的同步栈里调用，
 *    任何 await 都会让微任务队列离开手势上下文，导致 callback 永不触发。
 *
 * 2. consumerTabId 取舍：
 *      - 旧实现把 streamId 传到目标 tab 的注入脚本里消费，consumerTabId
 *        必须 = 目标 tabId。但目标 tab 是普通网页进程，跑出来的 webm
 *        Duration 缺失且字节布局疑似异常，导致下载文件无法播放。
 *      - 新实现把 MediaRecorder 搬到「扩展自己的中转窗口」（屏幕外的 popup
 *        类型 window）—— 这是扩展自有 origin 的 DOM 上下文，输出的 webm
 *        与社区主流录屏扩展一致，可被 Chrome 内置播放器正常播放。
 *      - 中转窗口的 tabId 在用户点击的同步栈里**未知**（窗口异步创建），
 *        因此申请 streamId 时**不传 consumerTabId**，让 streamId 可被
 *        任意扩展上下文消费。
 *
 * 3. 由于 (2) 我们仍需先拿到目标 tabId，但 chrome.tabs.query 是异步的；
 *    为了保留手势，这里采取「先用 chrome.tabs.query 同步发起 → callback
 *    内立即调 getMediaStreamId」的链式 callback 风格，全程不 await。
 */
import {
  MessageType,
  type RecordStartCurrentTabRequest,
  type RecordStartDesktopRequest,
  type RecordStartRegionTabRequest,
  type RecordStopRequest
} from "~src/shared/messages"

interface SimpleResponse {
  ok: boolean
  error?: string
  cancelled?: boolean
}

export function startDesktopRecording(): Promise<SimpleResponse> {
  const req: RecordStartDesktopRequest = { type: MessageType.RECORD_START_DESKTOP }
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

/**
 * 在 popup 同步上下文中：查询当前活动 tab → 申请 streamId → 通知 background。
 * 全程使用 callback，不引入 await，保留用户手势。
 */
export function startCurrentTabRecording(): Promise<SimpleResponse> {
  return new Promise((resolve) => {
    try {
      // 第 1 步：查询当前活动 tab（callback 内手势仍然有效）
      chrome.tabs.query(
        { active: true, currentWindow: true },
        (tabs) => {
          const lastErr1 = chrome.runtime.lastError
          if (lastErr1) {
            resolve({ ok: false, error: lastErr1.message ?? "无法查询标签页" })
            return
          }
          const tab = tabs[0]
          if (!tab?.id) {
            resolve({ ok: false, error: "未找到活动标签页" })
            return
          }
          const tabId = tab.id

          // 第 2 步：申请 streamId
          //   targetTabId  = 要捕获的 tab
          //   不传 consumerTabId → streamId 可被任意扩展上下文消费
          //                       （后续在中转窗口里调 getUserMedia）
          chrome.tabCapture.getMediaStreamId(
            { targetTabId: tabId },
            (streamId: string) => {
              const lastErr2 = chrome.runtime.lastError
              if (lastErr2 || !streamId) {
                resolve({
                  ok: false,
                  error: lastErr2?.message ?? "无法获取 streamId"
                })
                return
              }
              // 第 3 步：把 streamId + tabId 交给 background 创建中转窗口
              const req: RecordStartCurrentTabRequest = {
                type: MessageType.RECORD_START_CURRENT_TAB,
                payload: { streamId, tabId }
              }
              chrome.runtime.sendMessage(req, (res: SimpleResponse) => {
                const lastErr3 = chrome.runtime.lastError
                if (lastErr3) {
                  resolve({
                    ok: false,
                    error: lastErr3.message ?? "消息通道异常"
                  })
                  return
                }
                resolve(res)
              })
            }
          )
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

/**
 * 开始「区域录制（当前标签页）」。
 *
 * 与 startCurrentTabRecording 共用 streamId 申请逻辑（不传 consumerTabId）；
 * 区别仅在于：发送给 background 的消息类型不同，由 background 在 handler
 * 里负责注入选区遮罩、等待用户松手、把 rect 写入 RECORDER_BOOT 配置。
 *
 * 用户手势链同样需要保留：popup 在「同步申请 streamId 阶段」必须保持手势，
 * 之后 popup 关闭、background 异步注入 picker 由用户继续完成拖拽 —— picker
 * 内的鼠标交互不需要也无法继承 popup 的手势，但 streamId 的有效期 10s 已足
 * 够用户完成几秒的拖拽。
 */
export function startRegionTabRecording(): Promise<SimpleResponse> {
  return new Promise((resolve) => {
    try {
      chrome.tabs.query(
        { active: true, currentWindow: true },
        (tabs) => {
          const lastErr1 = chrome.runtime.lastError
          if (lastErr1) {
            resolve({ ok: false, error: lastErr1.message ?? "无法查询标签页" })
            return
          }
          const tab = tabs[0]
          if (!tab?.id) {
            resolve({ ok: false, error: "未找到活动标签页" })
            return
          }
          const tabId = tab.id

          chrome.tabCapture.getMediaStreamId(
            { targetTabId: tabId },
            (streamId: string) => {
              const lastErr2 = chrome.runtime.lastError
              if (lastErr2 || !streamId) {
                resolve({
                  ok: false,
                  error: lastErr2?.message ?? "无法获取 streamId"
                })
                return
              }
              const req: RecordStartRegionTabRequest = {
                type: MessageType.RECORD_START_REGION_TAB,
                payload: { streamId, tabId }
              }
              chrome.runtime.sendMessage(req, (res: SimpleResponse) => {
                const lastErr3 = chrome.runtime.lastError
                if (lastErr3) {
                  resolve({
                    ok: false,
                    error: lastErr3.message ?? "消息通道异常"
                  })
                  return
                }
                resolve(res)
              })
            }
          )
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
