/**
 * 整页截图 MoE 路由调试浮层（在页面上下文执行，需自包含）。
 *
 * 由 fullPageRouter 在 settings.showPageTypeToast 开启时调用：截图前注入一个
 * 顶部居中的浮层，显示当前页面被判定成哪种页面类型，展示一两秒后由
 * removePageTypeToast 移除——务必在真正 captureVisibleTab 之前移除，避免浮层
 * 本身进入截图。
 *
 * 通过 chrome.scripting.executeScript({ func }) 序列化注入，因此：
 *  - 不依赖任何外部 import / 模块级变量（序列化只带函数体，外部引用在页面里会
 *    变成 ReferenceError）——id 字符串在每个函数内各自内联
 *  - 参数必须可结构化克隆（只收一个字符串）
 */

/** 注入/更新调试浮层。text 支持 \n 多行（white-space: pre-line）。 */
export function showPageTypeToast(text: string): void {
  const ID = "__my_screenshot_pagetype_toast__"
  document.getElementById(ID)?.remove()

  const el = document.createElement("div")
  el.id = ID
  el.textContent = text
  el.style.cssText = [
    "position:fixed",
    "top:16px",
    "left:50%",
    "transform:translateX(-50%)",
    "z-index:2147483647",
    "max-width:80vw",
    "padding:10px 16px",
    "border-radius:10px",
    "background:rgba(17,17,17,0.92)",
    "color:#fff",
    "font:13px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
    "white-space:pre-line",
    "text-align:center",
    "box-shadow:0 6px 24px rgba(0,0,0,0.35)",
    "pointer-events:none",
    "border:1px solid rgba(255,255,255,0.15)"
  ].join(";")

  // documentElement 而非 body：极少数页面 body 尚未就绪/被替换。
  // 直接以最终样式插入（不做 rAF 淡入）——后台/节流标签页里 requestAnimationFrame
  // 会被暂停，若靠 rAF 改 opacity 会卡在初始值导致浮层"隐形"。
  document.documentElement.appendChild(el)
}

/** 移除调试浮层（截图前调用，确保不进入截图）。 */
export function removePageTypeToast(): void {
  document.getElementById("__my_screenshot_pagetype_toast__")?.remove()
}
