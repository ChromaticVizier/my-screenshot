# Tracking Review — my-screenshot-v1

**生成时间**: 2026-06-23  
**平台**: frontend / RLog  
**contract key**: my-screenshot-v1  
**baseline**: workspace snapshot  
**Bootstrap Mode**: true（首端契约种子，events 为空）  
**Plan Locked Mode**: false

---

## 概述

本项目为 Chrome 浏览器扩展，基于 Plasmo + React + TypeScript 构建，核心功能为截图与录屏。本报告识别 **14 个候选埋点事件**，覆盖 Popup 主界面展示、Tab 切换、6 种截图操作、可视区域截图结果、4 种录屏模式选择、录屏开始/停止、滚动区域选择/清除等关键用户行为节点。

所有事件均为首版契约草案（status: draft），待产品/数据/研发审批后升级为 approved 并同步回中心契约仓。

---

## 待追踪事件清单

| # | event_id | type | 触发时机 | 建议参数 | 文件位置 | 置信度 |
|---|----------|------|----------|----------|----------|--------|
| 1 | `screenshot_popup_show` | show | Popup 主界面加载完成，`MainPopup` 组件挂载时（`useEffect([], [])`） | `from`（来源，如 `toolbar_icon`） | `src/popup/index.tsx` MainPopup | HIGH |
| 2 | `screenshot_tab_switch` | action | 用户点击截图/录屏 Tab，`TabBar` `onChange` 回调 | `tab`（切换目标：`capture` / `record`） | `src/components/TabBar/index.tsx` `onClick` | HIGH |
| 3 | `screenshot_capture_visible_click` | action | 用户点击「可视区域」截图按钮 | `from`（`capture_panel`） | `src/popup/panels/CapturePanel.tsx` `handleAction` case `visible` | HIGH |
| 4 | `screenshot_capture_fullpage_click` | action | 用户点击「整个页面」截图按钮 | `from`（`capture_panel`） | `src/popup/panels/CapturePanel.tsx` `handleAction` case `fullPage` | HIGH |
| 5 | `screenshot_capture_selection_click` | action | 用户点击「选择区域」截图按钮 | `from`（`capture_panel`） | `src/popup/panels/CapturePanel.tsx` `handleAction` case `selection` | HIGH |
| 6 | `screenshot_capture_delayed_click` | action | 用户点击「延迟截取可视区域」 | `from`（`capture_panel`） | `src/popup/panels/CapturePanel.tsx` `handleAction` case `delayed` | HIGH |
| 7 | `screenshot_capture_desktop_click` | action | 用户点击「整个屏幕或应用窗口」 | `from`（`capture_panel`） | `src/popup/panels/CapturePanel.tsx` `handleAction` case `desktop` | HIGH |
| 8 | `screenshot_capture_annotate_click` | action | 用户点击「标注本地或剪贴板图片」 | `from`（`capture_panel`） | `src/popup/panels/CapturePanel.tsx` `handleAction` case `annotate`（当前 TODO，代码进 default 分支） | MEDIUM |
| 9 | `screenshot_capture_visible_result` | other | 可视区域截图完成（popup 内可感知结果，异步回调）| `result`（`success` / `fail`）、`error_code`（失败时） | `src/popup/panels/CapturePanel.tsx` `handleAction` case `visible` await 后 | HIGH |
| 10 | `screenshot_scroll_region_select_click` | action | 用户点击「选择滚动区域」按钮 | `from`（`capture_panel`） | `src/popup/panels/CapturePanel.tsx` `handleSelectScrollRegion` | HIGH |
| 11 | `screenshot_scroll_region_clear_click` | action | 用户点击「清除本网站区域」按钮 | `from`（`capture_panel`） | `src/popup/panels/CapturePanel.tsx` `handleClearScrollRegion` | HIGH |
| 12 | `screenshot_record_mode_select` | action | 用户在录屏面板点击模式卡片切换录屏模式 | `mode`（`desktop` / `camera` / `currentTab` / `regionTab`） | `src/popup/panels/RecordPanel.tsx` modeGrid `onClick` | HIGH |
| 13 | `screenshot_record_start_click` | action | 用户点击「开始录制」按钮 | `mode`（当前选中录屏模式：`currentTab` / `regionTab`） | `src/popup/panels/RecordPanel.tsx` `handleToggleRecording`（`!session.recording` 分支） | HIGH |
| 14 | `screenshot_record_stop_click` | action | 用户点击「结束录制」按钮（含 popup 重开时的结束场景）| `from`（`popup`） | `src/popup/panels/RecordPanel.tsx` `handleToggleRecording`（`session.recording` 分支） | HIGH |

---

## 参数采集合理性

| event_id | 场景类型 | 参数 | 来源 | 侵入等级 | 处理结论 | 原因 |
|----------|----------|------|------|----------|----------|------|
| `screenshot_popup_show` | 页面曝光 | `from` | 规范默认 | low | 可选采集 | popup 通过 toolbar icon 触发，`from` 值可从 URL query 参数读取；若无则默认 `toolbar_icon` |
| `screenshot_capture_visible_result` | 异步结果 | `error_code` | 通用推断 | low | 失败时采集 `res.error` 字符串前 50 字符 | 错误信息由 chrome API 返回，非用户内容，低侵入 |
| `screenshot_record_start_click` | 点击 | `mode` | 通用推断 | low | 采集 | `activeMode` 状态在点击时已天然持有，无需额外查询 |
| `screenshot_capture_annotate_click` | 点击 | `from` | 规范默认 | low | 采集 | 当前 annotate 进 default 分支（TODO），建议在实现时同步落代码；现阶段仍可在 default 分支入口埋 action |
| 录屏结果（成功/失败）| 异步结果 | result | - | high | **不采集（本轮）** | 录屏结果发生在 `offscreenRecorder`（中转窗口），popup 已关闭，无法在同一上下文感知；后台结果通过 `recorder/finish` 消息通知 background，需要额外增加 background 层消息监听和上报逻辑，属于中-高侵入，不在本次 UI 层埋点范围内 |

---

## 跳过的位置

| 文件 | 位置 | 原因 |
|------|------|------|
| `src/popup/offscreenRecorder/index.tsx` | `mediaRecorder.onstop` 成功/失败分支 | 中转窗口，popup 已关闭；录制成功/失败需通过 background 层上报，超出本次 UI 层埋点范围 |
| `src/popup/desktop/index.tsx` | `captureDesktopFrame` 结果回调 | 中转窗口，popup 已关闭；结果通过 background 处理，同上 |
| `src/services/capture.ts` | `send()` 回调 | 服务层/工具函数，非 UI 代码，埋点在调用方 UI 组件处落 |
| `src/services/record.ts` | callback 链 | 服务层，同上 |
| `RecordPanel` 音频/分辨率/格式 Select | `updateOption` 调用 | 配置型操作，非关键业务路径；如产品有分析需求可后续扩展 |
| OCR 截屏（`key: "ocr"`）| `disabled: true` | 按项目背景要求不埋点 |

---

## 需要确认的问题

1. **产品前缀确认**：项目 `package.json` 中 `name` 为 `my-screenshot`，埋点前缀推断为 `screenshot_`。请确认是否与 RLog `_setAccount` 的 product_name 一致，或是否需要更改为 `my_screenshot_`。

2. **annotate 按钮是否现阶段埋点**：当前代码中 `annotate` 进入 `default` 分支（未实现），点击不触发任何异步操作。建议在功能实现时同步落代码；也可以先在 default 分支入口加 action 埋点（有助于统计用户点击需求），请产品/研发确认。

3. **录屏结果埋点需求**：录屏成功/失败发生在 offscreenRecorder 中转窗口，需要在 background 层增加消息监听和 RLog 上报。如有数据需求，需要独立排期；本次 UI 层埋点暂不覆盖。

4. **`screenshot_capture_visible_result` 的 `error_code` 字段**：`res.error` 为 chrome API 返回的英文错误消息，非用户 PII 数据，可安全上报前 50 字符；请确认是否需要。

5. **录屏模式 desktop/camera 埋点时机**：`desktop` 和 `camera` 模式卡片当前未实现（点击后会命中 `activeMode !== 'currentTab' && activeMode !== 'regionTab'` 的 unsupported 分支），所以 `screenshot_record_start_click` 实际只在选中 `currentTab` / `regionTab` 后触发成功。`screenshot_record_mode_select` 可以记录用户点击 desktop/camera 卡片的意图，请确认是否需要这个数据点。

---

## RLog 初始化检查

项目中未发现 `window._rlog.push(['_setAccount', ...])` 调用。**在正式插桩前，需要在入口文件（`popup.html` 的 `<head>` 脚本或 Plasmo 的入口点）中添加 RLog SDK 初始化代码**，否则所有 `window._rlog.push` 调用将无效。

```html
<script>
  var _rlog = window._rlog || [];
  _rlog.push(['_setAccount', 'screenshot']);
  window._rlog = _rlog;
</script>
```

---

## 下一步

本报告为产品预审报告，**本轮不插入任何业务代码**。请产品/数据/研发审核上述事件清单后：

- 确认 event_id 命名、参数口径和触发时机
- 回复本报告中"需要确认"的 5 个问题
- 确认 RLog SDK 初始化方案
- 审批通过后，执行 tracking-implementer 第二轮插桩（mode=full），将 draft 事件写入业务代码并同步契约仓
