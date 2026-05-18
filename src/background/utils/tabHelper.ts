/**
 * 标签页工具：获取活动 tab、校验是否允许截图
 */

const FORBIDDEN_PREFIXES = [
  "chrome://",
  "edge://",
  "about:",
  "chrome-extension://",
  "https://chrome.google.com/webstore",
  "https://chromewebstore.google.com"
]

export interface ActiveTabResult {
  tab: chrome.tabs.Tab
}

/** 获取当前活动标签页，并校验是否允许截图 */
export async function getCapturableActiveTab(): Promise<
  | { ok: true; tab: chrome.tabs.Tab }
  | { ok: false; error: string }
> {
  const [tab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true
  })

  if (!tab || tab.id == null) {
    return { ok: false, error: "未找到活动标签页" }
  }

  const url = tab.url ?? ""
  if (FORBIDDEN_PREFIXES.some((p) => url.startsWith(p))) {
    return {
      ok: false,
      error: "当前页面不允许截图（浏览器内部页面或商店页）"
    }
  }

  return { ok: true, tab }
}
