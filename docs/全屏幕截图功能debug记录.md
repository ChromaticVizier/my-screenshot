# 「整个屏幕或应用窗口」截图功能开发实录

> 本文档详细记录该功能从零到可用的完整开发过程，包括每一次方案选型的取舍、遇到的具体问题、以及为什么走到了最终的实现。

---

## 1. 功能定义

| 项 | 说明 |
|---|---|
| 入口 | popup 截图面板「整个屏幕或应用窗口」按钮 |
| 预期交互 | 点击 → 弹出系统级共享选择器（"选择要分享什么 / 整个屏幕 / 窗口 / Chrome 标签页"）→ 用户选定 → 自动下载该屏幕/窗口的截图 |
| 关键约束 | 截图里不能包含我们扩展自己的 UI（popup、中转窗口等） |
| 参考实现 | Awesome Screenshot 等同类扩展 |

---

## 2. 技术选型推演

### 2.1 为什么是 `getDisplayMedia`

在调研报告（`技术调研.md`）里我对比过四种截图技术：`html2canvas` / WebRTC `getDisplayMedia` / CDP / `chrome.tabs.captureVisibleTab`。

对「整个屏幕或应用窗口」这个特定语义：

| 方案 | 是否适用 |
|---|---|
| `html2canvas` | 只能截 DOM，不能截浏览器外的应用窗口 |
| `chrome.tabs.captureVisibleTab` | 只能截当前标签页的可视区域 |
| CDP | 扩展环境受限，且会顶部弹"正在调试"横条 |
| `navigator.mediaDevices.getDisplayMedia` | 唯一能跨 Chrome 之外的应用窗口 / 整个屏幕的 Web API |

`getDisplayMedia` 是唯一能满足语义需求的方案，没有替代品。

### 2.2 `getDisplayMedia` 的硬性约束

参考 Chrome 官方文档（<https://developer.chrome.google.cn/docs/web-platform/screen-sharing-controls>），调用环境必须同时满足：

1. 持有用户手势（transient activation）
2. 拥有 DOM 上下文（不能在 service worker 里调）
3. 调用方必须可见 / 处于前台

这三个条件一起决定了"在哪里调它

---

## 3. 实施过程

下面按时间线复述每次的设计、遇到的问题、为什么必须换。

### 3.1 第一版：在 content script 中注入

直觉方案：用 `chrome.scripting.executeScript` 把 `getDisplayMedia` 注入到当前活动标签页执行 —— 这种模式我们之前在「选区截图」和「延迟截图」里已经成功用过。

```ts
// background/handlers/capture.ts (第一版)
const [{ result }] = await chrome.scripting.executeScript({
  target: { tabId },
  func: pickAndCaptureDesktop, // 内部调 getDisplayMedia
  args: [format, quality]
})
```

#### 现象
点击按钮后完全没反应。

#### 排查
直接打开页面 console，自己输入 `navigator.mediaDevices.getDisplayMedia(...)`，弹出选择器；但通过扩展注入的同样代码就静默失败。

#### 根因
`chrome.scripting.executeScript` 派发到 content script 执行时，用户手势已跨进程边界丢失。`getDisplayMedia` 没有手势就立即 reject，且 isolated world 里没有任何 UI 反馈，表现就是点了没反应。

#### 启示
"调用方必须自己持有用户手势" —— 注入脚本不行。

---

### 3.2 第二版：用 offscreen document

Chrome MV3 提供了 `chrome.offscreen` API，专门给 service worker 提供 DOM 上下文。

理论上的流程：
```
popup 点击 → background.createDocument("offscreen.html")
              → offscreen 文档里调 getDisplayMedia
              → 抓帧 → dataUrl 回传 → 下载
```

#### 现象
代码全部写好后无法构建：Plasmo 0.90.5 不支持自定义 HTML 入口，`tabs/offscreen.tsx` 不会被编译为 `tabs/offscreen.html`。

```bash
$ pnpm build
$ ls build/chrome-mv3-prod/
# 只有 popup.html / options.html，没有任何 offscreen 相关产物
```

#### 尝试的解决
- 写 `tabs/offscreen.tsx` —— 不被编译
- 写根目录 `offscreen.tsx` —— 不被识别（Plasmo 只识别 popup/options/background 等具名约定）
- 手写静态 `offscreen.html + offscreen.js` —— Plasmo 没有 postbuild 钩子，需要额外的复制脚本，工程上太重

#### 根因
Plasmo 0.90.5 不原生支持 offscreen document。这是较新版本（≥ 0.84 或某个分支）才加入的特性。当前版本下走 offscreen 路线意味着要么升级 Plasmo（连带破坏其它已工作的部分），要么手工拼装构建产物。

#### 决定
放弃 offscreen 路线，方案全部回滚。

---

### 3.3 第三版：用 `chrome.windows.create` 拉起"中转窗口"

观察 Awesome Screenshot 的行为：点击它的"屏幕"按钮后，桌面上先出现一个小窗口（标题栏写着 "Capture"），然后才弹出系统级共享选择器。

这给了我灵感：用 `chrome.windows.create` 打开一个独立的扩展窗口，在那里调 `getDisplayMedia`。这个窗口：
- 是真正的浏览器窗口，有完整 DOM 上下文
- 由用户的扩展点击派生，保留用户手势
- 是扩展自有 origin，权限稳定

#### 实现关键点

1. 复用已有的 `popup.html`：Plasmo 0.90 不支持新 HTML 入口，但 popup 已被构建。我让 popup 入口根据 URL query 参数分流：
   ```ts
   // src/popup/index.tsx
   const action = new URLSearchParams(window.location.search).get("action")
   if (action === "desktopCapture") return <DesktopCaptureWindow />
   return <MainPopup />
   ```

2. background 拉起中转窗口：
   ```ts
   const url = chrome.runtime.getURL("popup.html") + "?action=desktopCapture"
   await chrome.windows.create({ url, type: "popup", width: 480, height: 560 })
   ```

3. 中转窗口里的核心逻辑：`useEffect` 一加载就调 `captureDesktopFrame()`，拿到 dataUrl 后通过消息发给 background 下载。

成功打开了中转窗口、成功调起了系统级共享选择器。但接下来一连串新问题。

---

### 3.4 第三版踩到的子问题

#### 子问题 A：选择器里没有可分享的内容

现象：选择器弹出但 "Chrome 标签页" 那栏空空如也。

根因：Chrome 119+ 引入了几个新约束（[官方文档](https://developer.chrome.google.cn/docs/web-platform/screen-sharing-controls)）：

| 选项 | 默认值 | 影响 |
|---|---|---|
| `selfBrowserSurface` | `"exclude"` | 默认排除自己的浏览器窗口/标签 |
| `monitorTypeSurfaces` | `"include"` | 是否显示"整个屏幕"选项 |
| `surfaceSwitching` | （无） | 共享中切换源 |
| `systemAudio` | `"include"` | 系统音频 |

`selfBrowserSurface: "exclude"` 是默认值，导致"Chrome 标签页"列表为空。

修复：
```ts
stream = await navigator.mediaDevices.getDisplayMedia({
  video: { displaySurface: "monitor", width: { ideal: 7680 }, height: { ideal: 4320 } },
  audio: false,
  // 用类型断言绕过 TS lib 类型尚未收录的字段
  ...({
    monitorTypeSurfaces: "include",
    selfBrowserSurface: "include",
    surfaceSwitching: "exclude",
    systemAudio: "exclude"
  } as Record<string, string>)
} as DisplayMediaStreamOptions)
```

✅ 此时选择器内容齐全。

---

#### 子问题 B：截图里包含中转窗口

现象：用户选择"整个屏幕"截屏后，下载的图里有那个"My screenshot"中转小窗口。

根因：用户点"分享"的瞬间，中转窗口还在屏幕上。`getDisplayMedia` 拿到 stream 后，video 输出的"第一帧"就是含中转窗口的画面。

#### 修复尝试 1：拿到 stream 后最小化中转窗口

```ts
// 中转窗口里
const result = await captureDesktopFrame({
  beforeCapture: () => hideRelayWindow() // 让 background 调 chrome.windows.update({ state: "minimized" })
})
```

新现象：中转窗口最小化到任务栏，整个流程卡住。必须用户手动点回中转窗口才会触发下载。

新根因：Chrome 会冻结最小化窗口里的 JS 主循环 —— `setTimeout`、`requestAnimationFrame` 都被节流甚至完全暂停。我们用来等待"动画完成"的 `await new Promise(r => setTimeout(r, 350))` 在最小化窗口里永远不 resolve。

#### 修复尝试 2：用 `requestVideoFrameCallback` 替代 setTimeout

`rVFC` 由 GPU 视频管线驱动，理论上不受窗口可见性影响。

结果：仍然卡住。说明 Chrome 把最小化窗口的整个事件循环都暂停了，连 video 解码事件回调也不派发。

#### 修复尝试 3：把窗口移到屏幕外，而不是最小化

```ts
chrome.windows.update(winId, {
  left: -32000, top: -32000, width: 1, height: 1, focused: false
})
```

新现象：流程不再卡死，但下载的截图仍然带中转窗口。

新根因：Windows 的 `SetWindowPos` 行为：坐标完全越界时会把窗口"夹"回主屏幕的边缘。窗口实际还在屏幕角落里，被屏幕共享流捕获。

#### 修复尝试 4：用 `chrome.system.display` 计算"屏外坐标"

读取所有显示器的 bounds，把窗口放到所有显示器最低边的下方：
```ts
const displays = await chrome.system.display.getInfo()
const maxBottom = Math.max(...displays.map(d => d.bounds.top + d.bounds.height))
chrome.windows.update(winId, { top: maxBottom + 50, left: 0, width: 200, height: 200 })
```

结果：仍然能在截图里看到中转窗口。

根因猜测：Windows 11 的"防止丢失窗口"特性比想象中更激进，正方向越界依然会被夹回。或者 Windows DWM 的截屏管线对窗口可见性的判断与坐标无关，只看 z-order。

至此，第三版方案在 Windows 上无法清洁地隐藏中转窗口。

---

### 3.5 第四版（最终）：popup 直接调 `getDisplayMedia`

回头重新审视约束。

之前一直假设："popup 失焦会立即关闭，所以 popup 不能调需要等待用户操作的 API"。但实际上：

- `getDisplayMedia` 弹出系统级选择器期间，popup 不会失焦关闭 —— 因为系统选择器是 OS 级 modal，popup 仍然处于 Chrome 自己的"活跃"语义里
- popup 是 Chrome 浏览器 chrome 区的一部分（属于 toolbar 弹层），通常不会被屏幕共享流捕获为独立窗口
- popup 自身就持有用户手势（用户刚点了它的按钮），可以直接调 `getDisplayMedia`

#### 实现

直接在 `CapturePanel` 的 `case "desktop"` 里调用：

```ts
case "desktop": {
  setBusy(mode)
  try {
    const result = await captureDesktopFrame({ format: "png" })
    if (!result.ok) {
      if (!result.cancelled) setError(result.error ?? "屏幕截图失败")
      setBusy(null)
      if (result.cancelled) window.close()
      break
    }
    if (!result.dataUrl) throw new Error("返回数据为空")
    const res = await downloadDesktopImage({
      dataUrl: result.dataUrl, format: "png"
    })
    setBusy(null)
    if (res.ok) window.close()
    else setError(res.error ?? "下载失败")
  } catch (err) {
    setBusy(null)
    setError(err instanceof Error ? err.message : String(err))
  }
  break
}
```

关键点：
- popup 在"用户点击"那一刻持有手势，立即调 `getDisplayMedia`
- 选择器期间 popup 保持打开
- 选择器关闭、抓帧、下载完成后再 `window.close()`
- `downloadDesktopImage` 把 dataUrl 通过消息交给 background 走现有下载链路（service worker 持久，避免 popup 关闭后下载也被打断）

#### 中转窗口相关代码的命运

第三版里写的 `src/popup/desktop/`、`hideRelayWindow`、`closeRelayWindow`、`HIDE_RELAY_WINDOW` 等代码大部分变成了"不再使用"。但保留它们不引起任何运行时影响（query 参数不会被触发），后续可以一并清理或在新版本 Plasmo 升级时复用。

---

## 4. 最终架构

```
[popup CapturePanel]
   │
   ├─ captureDesktopFrame({ format: "png" })       ← popup 上下文里直接调用
   │     │
   │     ├─ navigator.mediaDevices.getDisplayMedia({
   │     │     video: { displaySurface: "monitor", ... },
   │     │     monitorTypeSurfaces: "include",
   │     │     selfBrowserSurface: "include",
   │     │     surfaceSwitching: "exclude",
   │     │     systemAudio: "exclude"
   │     │   })
   │     │   → 弹出系统级共享选择器
   │     │
   │     ├─ <video>.srcObject = stream
   │     ├─ 等首帧解码（loadeddata + rAF）
   │     ├─ <canvas>.drawImage → toDataURL("image/png")
   │     ├─ stream.getTracks().forEach(t.stop)    ← 释放屏幕共享
   │     └─ return { ok, dataUrl }
   │
   └─ downloadDesktopImage({ dataUrl, format })   ← 通过消息把图交给 background
         │
         ▼
[background handleDownloadDesktopImage]
   │
   ├─ fetch(dataUrl) → blob
   ├─ blob → base64 → dataUrl                    ← service worker 中无 createObjectURL
   └─ chrome.downloads.download({ url, filename })
```

文件位置：

```
src/
├── popup/
│   ├── desktop/
│   │   └── captureDesktop.ts          # captureDesktopFrame 核心实现
│   └── panels/
│       └── CapturePanel.tsx           # case "desktop" 直接调用
├── services/
│   └── desktopBridge.ts               # downloadDesktopImage（popup → background）
├── background/
│   └── handlers/
│       └── capture.ts                 # handleDownloadDesktopImage
└── shared/
    └── messages.ts                    # 消息类型定义
```

---

## 5. 经验小结

### 5.1 浏览器扩展环境的"约束矩阵"

| API | service worker | content script | popup | offscreen | 独立扩展窗口 |
|---|:---:|:---:|:---:|:---:|:---:|
| `chrome.tabs.captureVisibleTab` | ✅ | ❌ | ✅ | ❌ | ✅ |
| `chrome.scripting.executeScript` | ✅ | ❌ | ✅ | ❌ | ✅ |
| `getDisplayMedia` | ❌ | ❌ | ✅ | ✅ | ✅ |
| 持有用户手势 | ❌ | 跨边界丢失 | ✅ | 不持有 | 派生持有 |
| 屏幕共享被捕获 | n/a | n/a | 不会 | 不会 | 会 |

只有 popup 同时满足"能调 + 有手势 + 不被截入" —— 这正是最终方案。

### 5.2 不要预设"popup 一失焦就关"

Chrome 119+ 的 popup 在调用某些原生模态 API（如 `getDisplayMedia`、`chrome.fileSystem.chooseEntry`）时会保持打开。预设它会立刻关闭把方案推得过于复杂了。

### 5.3 `chrome.windows.update` 在 Windows 上的"夹回主屏"行为

任何依赖"把扩展窗口移到屏幕外"的方案在 Windows 上都不可靠。如果未来需要类似机制，可考虑：
- 把窗口缩到 1×1 + 透明 + 设 `alwaysOnTop: false`
- 或使用 sidepanel API（Chrome 114+）替代独立窗口

### 5.4 `getDisplayMedia` 的选项必须显式声明

`selfBrowserSurface`、`monitorTypeSurfaces` 等的默认值随 Chrome 版本变化，必须显式写才能保证选择器内容稳定。这些字段尚未进入 TS DOM 标准类型，需要用 `as Record<string, string>` 断言。

