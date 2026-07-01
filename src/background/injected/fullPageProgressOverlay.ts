import {
  MessageType,
  type CaptureFullPageProgressState
} from "~src/shared/messages"

const ROOT_ID = "__my_screenshot_fullpage_progress__"

export function showFullPageProgressOverlay(
  progress: CaptureFullPageProgressState
): void {
  let root = document.getElementById(ROOT_ID)
  if (!root) {
    root = document.createElement("div")
    root.id = ROOT_ID
    root.style.cssText = [
      "position:fixed",
      "right:20px",
      "top:20px",
      "z-index:2147483647",
      "width:280px",
      "padding:16px",
      "border-radius:12px",
      "background:#fff",
      "color:#1f2937",
      "box-shadow:0 12px 32px rgba(0,0,0,.22)",
      "font-family:-apple-system,BlinkMacSystemFont,Segoe UI,PingFang SC,Microsoft YaHei,sans-serif",
      "box-sizing:border-box",
      "user-select:none"
    ].join(";")
    document.documentElement.appendChild(root)
  }

  const total = Math.max(1, progress.total || 1)
  const current = Math.max(0, Math.min(progress.current || 0, total))
  const percent = Math.round((current / total) * 100)
  const phase = progress.phase
  const title =
    phase === "stitching"
      ? "正在拼接"
      : phase === "cancelled"
        ? "已停止"
        : phase === "error"
          ? "截图失败"
          : phase === "done"
            ? "已完成"
            : "正在长截图"

  root.innerHTML = `
    <div style="font-size:15px;font-weight:600;margin-bottom:12px;">${escapeHtml(title)}</div>
    ${
      phase === "capturing"
        ? `<div style="display:flex;justify-content:space-between;gap:12px;color:#6b7280;font-size:12px;margin-bottom:8px;">
            <span>${escapeHtml(progress.message || "正在滚动并截图")}</span>
            <span>${percent}%</span>
          </div>
          <div style="height:8px;overflow:hidden;border-radius:999px;background:#e5e7eb;">
            <div style="height:100%;width:${percent}%;border-radius:inherit;background:linear-gradient(90deg,#1677ff,#69b1ff);transition:width 160ms ease;"></div>
          </div>
          <button type="button" data-stop="1" style="width:100%;margin-top:14px;border:0;border-radius:8px;padding:8px 12px;color:#fff;background:#ef4444;font-size:13px;cursor:pointer;">强制停止</button>`
        : `<div style="color:#6b7280;font-size:13px;line-height:1.6;">${escapeHtml(progress.error || progress.message || title)}</div>`
    }
  `

  root
    .querySelector<HTMLButtonElement>("[data-stop]")
    ?.addEventListener("click", (e) => {
      e.preventDefault()
      e.stopPropagation()
      chrome.runtime.sendMessage({ type: MessageType.CAPTURE_FULL_PAGE_CANCEL })
    })
}

export function removeFullPageProgressOverlay(): void {
  document.getElementById(ROOT_ID)?.remove()
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;"
      case "<":
        return "&lt;"
      case ">":
        return "&gt;"
      case '"':
        return "&quot;"
      default:
        return ch
    }
  })
}
