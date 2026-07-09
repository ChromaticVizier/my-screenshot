/**
 * 整页截图 MoE 路由日志。
 *
 * 每次整页截图，路由器判别出页面类型后会追加一条记录（网址 + 类型 + 依据 + 时间），
 * 持久化到 chrome.storage.local 的独立 key，便于事后核对路由是否符合预期、
 * 用真实站点积累一个"页面类型 → 专家"的样本集（可在设置页导出 JSON）。
 *
 * 独立于 AppSettings 存储：日志会持续增长，混进 settings 会拖慢每次 getSettings；
 * 故单独 key + 上限裁剪。
 */
import type { FullPageExpert, FullPageMode } from "~src/shared/settings"

const LOG_KEY = "moeRouteLog"
/** 最多保留的记录条数（超出丢弃最旧的），避免无限增长 */
const MAX_ENTRIES = 1000

export interface RouteLogEntry {
  /** 记录时间（epoch ms） */
  t: number
  /** 完整网址 */
  url: string
  /** 主机名（便于聚合阅读） */
  hostname: string
  /** 判定出的专家类型 */
  expert: FullPageExpert
  /** 当时的路由模式（auto / 手动覆盖） */
  mode: FullPageMode
  /** 判定依据（含关键信号值的可读字符串） */
  reason: string
  /** 关键判别信号快照（auto 模式下有；手动模式为空） */
  signals?: Record<string, unknown>
}

/** 追加一条路由日志。失败只告警，绝不阻断截图。 */
export async function appendRouteLog(entry: RouteLogEntry): Promise<void> {
  try {
    const existing = await getRouteLog()
    existing.push(entry)
    // 只保留最近 MAX_ENTRIES 条
    const trimmed =
      existing.length > MAX_ENTRIES
        ? existing.slice(existing.length - MAX_ENTRIES)
        : existing
    await chrome.storage.local.set({ [LOG_KEY]: trimmed })
  } catch (err) {
    console.warn("[fullPage][router] append route log failed", err)
  }
}

/** 读取全部路由日志（时间升序）。 */
export async function getRouteLog(): Promise<RouteLogEntry[]> {
  try {
    const raw = await chrome.storage.local.get(LOG_KEY)
    const list = raw[LOG_KEY]
    return Array.isArray(list) ? (list as RouteLogEntry[]) : []
  } catch {
    return []
  }
}

/** 清空路由日志。 */
export async function clearRouteLog(): Promise<void> {
  try {
    await chrome.storage.local.remove(LOG_KEY)
  } catch (err) {
    console.warn("[fullPage][router] clear route log failed", err)
  }
}
