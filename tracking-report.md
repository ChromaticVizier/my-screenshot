# Tracking Report — my-screenshot-v1

**生成时间**: 2026-06-23T00:00:00+08:00
**功能标识**: my-screenshot-v1
**平台**: frontend / RLog
**Baseline Mode**: snapshot
**变更来源**: workspace snapshot（src/popup 全量）
**基准分支**: none（snapshot 模式）
**HEAD**: 8dced65
**埋点规范**: frontend-rlog
**PRD**: 无
**参照报告**: 无
**Tracking Plan**: .forge/external-tracking/plans/my-screenshot-v1/tracking-plan.yaml
**Tracking Registry**: 无
**Contracts Repo**: 无
**Contracts Branch**: 无
**Bootstrap Mode**: true
**Plan Locked Mode**: false（Bootstrap 阶段）
**Scope Filter**: auto（my-screenshot 全量）
**模式**: full

---

## 1. 插桩摘要

- 事件总数: 14
- 插入文件: 3
- RLog 初始化: 已添加（`src/popup/index.tsx` Popup 组件 useEffect，第 26 行）
- 所有 tracking-plan.yaml 事件状态: `draft` → `approved`

---

## 2. 产品视角事件总览

| # | 业务场景 | 用户行为 / 触发条件 | event_id | 类型 |
|---|----------|----------------------|----------|------|
| 1 | Popup 主界面 | 用户打开扩展 popup | screenshot_popup_show | show |
| 2 | Popup 主界面 | 用户切换截图/录屏 Tab | screenshot_tab_switch | action |
| 3 | 截图面板 | 点击「可视区域」 | screenshot_capture_visible_click | action |
| 4 | 截图面板 | 可视区域截图完成 | screenshot_capture_visible_result | other |
| 5 | 截图面板 | 点击「整个页面」 | screenshot_capture_fullpage_click | action |
| 6 | 截图面板 | 点击「选择区域」 | screenshot_capture_selection_click | action |
| 7 | 截图面板 | 点击「延迟截图」 | screenshot_capture_delayed_click | action |
| 8 | 截图面板 | 点击「桌面截图」 | screenshot_capture_desktop_click | action |
| 9 | 截图面板 | 点击「标注图片」（TODO 功能） | screenshot_capture_annotate_click | action |
| 10 | 截图面板 | 点击「选择滚动区域」 | screenshot_scroll_region_select_click | action |
| 11 | 截图面板 | 点击「清除本网站区域」 | screenshot_scroll_region_clear_click | action |
| 12 | 录屏面板 | 点击录制模式卡片 | screenshot_record_mode_select | action |
| 13 | 录屏面板 | 点击「开始录制」 | screenshot_record_start_click | action |
| 14 | 录屏面板 | 点击「结束录制」 | screenshot_record_stop_click | action |

---

## 3. 事件清单（含代码位置）

| event_id | type | 文件 | 行号 | 参数 | 验证状态 |
|----------|------|------|------|------|----------|
| screenshot_popup_show | show | src/popup/index.tsx | 47 | from=toolbar_icon | PASS |
| screenshot_tab_switch | action | src/popup/index.tsx | 56 | tab=\<key\> | PASS |
| screenshot_capture_visible_click | action | src/popup/panels/CapturePanel.tsx | 64 | from=capture_panel | PASS |
| screenshot_capture_visible_result | other (承载为 action) | src/popup/panels/CapturePanel.tsx | 67 | result=success\|fail, error_code（失败时） | PASS |
| screenshot_capture_fullpage_click | action | src/popup/panels/CapturePanel.tsx | 75 | from=capture_panel | PASS |
| screenshot_capture_selection_click | action | src/popup/panels/CapturePanel.tsx | 87 | from=capture_panel | PASS |
| screenshot_capture_delayed_click | action | src/popup/panels/CapturePanel.tsx | 98 | from=capture_panel | PASS |
| screenshot_capture_desktop_click | action | src/popup/panels/CapturePanel.tsx | 109 | from=capture_panel | PASS |
| screenshot_capture_annotate_click | action | src/popup/panels/CapturePanel.tsx | 119 | from=capture_panel | PASS |
| screenshot_scroll_region_select_click | action | src/popup/panels/CapturePanel.tsx | 36 | from=capture_panel | PASS |
| screenshot_scroll_region_clear_click | action | src/popup/panels/CapturePanel.tsx | 50 | from=capture_panel | PASS |
| screenshot_record_mode_select | action | src/popup/panels/RecordPanel.tsx | 133 | mode=\<action.key\> | PASS |
| screenshot_record_start_click | action | src/popup/panels/RecordPanel.tsx | 105 | mode=\<activeMode\> | PASS |
| screenshot_record_stop_click | action | src/popup/panels/RecordPanel.tsx | 86 | from=popup | PASS |

---

## 4. 数据口径明细

| event_id | 必填参数 | 可选参数 | 枚举口径 | 契约来源 |
|----------|----------|----------|----------|----------|
| screenshot_popup_show | 无 | from | — | Plan（approved） |
| screenshot_tab_switch | tab | 无 | tab=capture\|record | Plan（approved） |
| screenshot_capture_visible_click | 无 | from | — | Plan（approved） |
| screenshot_capture_visible_result | result | error_code | result=success\|fail | Plan（approved） |
| screenshot_capture_fullpage_click | 无 | from | — | Plan（approved） |
| screenshot_capture_selection_click | 无 | from | — | Plan（approved） |
| screenshot_capture_delayed_click | 无 | from | — | Plan（approved） |
| screenshot_capture_desktop_click | 无 | from | — | Plan（approved） |
| screenshot_capture_annotate_click | 无 | from | — | Plan（approved） |
| screenshot_scroll_region_select_click | 无 | from | — | Plan（approved） |
| screenshot_scroll_region_clear_click | 无 | from | — | Plan（approved） |
| screenshot_record_mode_select | mode | 无 | mode=desktop\|camera\|currentTab\|regionTab | Plan（approved） |
| screenshot_record_start_click | mode | 无 | mode=currentTab\|regionTab\|desktop\|camera | Plan（approved） |
| screenshot_record_stop_click | 无 | from | — | Plan（approved） |

备注：`screenshot_capture_visible_result` 契约 type 为 `other`；前端 RLog SDK 无独立 other 调用类型，用 `action` 字段承载，契约 type 不变。

---

## 5. 验证规则检查（frontend-rlog 规范）

| # | 验证规则 | 结果 |
|---|----------|------|
| 1 | event_id 格式匹配 `^[a-z][a-z0-9_]*$` | PASS — 所有 14 个 event_id 均小写字母+数字+下划线 |
| 2 | event_id 长度 ≤ 64 字符 | PASS — 最长 `screenshot_scroll_region_select_click`（38 字符） |
| 3 | event_id 和参数 key 无中文字符 | PASS |
| 4 | action 类型事件含 `from` 或业务标识参数 | PASS — 截图类含 `from`；录屏类含 `mode`；tab_switch 含 `tab` |
| 5 | 契约 required_params 全部上报 | PASS — `tab`（tab_switch）、`result`（visible_result）、`mode`（record_mode_select、record_start）均已上报 |
| 6 | 事件类型与契约 type 一致（SDK 字段差异除外） | PASS — visible_result SDK 用 action 承载 other 已在契约 platform_bindings 注明 |
| 7 | API 为推荐 `_trackCustom` 调用格式，非禁止 API | PASS |
| 8 | RLog SDK 初始化 `_setAccount` 在页面入口调用 | PASS — Popup 组件 useEffect 第 26 行 |
| 9 | 参数值为 String 或可 toString() 的类型 | PASS — key 为字符串；error_code 已 `String(...).slice(0, 50)` 处理 |
| 10 | 不在测试文件中插入埋点 | PASS — 无测试文件修改 |
| 11 | 不重复已有埋点 | PASS — 插入前项目无 _trackCustom 调用 |
| 12 | 不修改已有业务逻辑 | PASS — 只在函数入口/结果后追加 push 调用 |

所有 14 个事件全部通过验证，无 ERROR，无 WARNING。

---

## 6. 跳过的位置

| 文件 | 位置 | 原因 |
|------|------|------|
| src/popup/offscreenRecorder.tsx | 全文 | 非用户交互 UI；录屏中转窗口，用户不可见，无埋点需求 |
| src/popup/desktop.tsx | 全文 | 非用户交互 UI；桌面截图中转窗口，popup 立即关闭 |
| src/editor/\* | 全文 | 编辑器模块非本期需求范围 |
| src/background/\* | 全文 | background 脚本无 window._rlog 上下文 |
| src/services/\* | 全文 | 纯服务层，非 UI 交互点 |
| src/shared/\* | 全文 | 工具/共享层，非 UI 交互点 |
| RecordPanel 音频/控制栏切换 | ToggleIconButton onClick | 非本期契约事件；plan 无对应 event_id |
| RecordPanel 分辨率/格式选择 | SelectButton onChange | 非本期契约事件；plan 无对应 event_id |

---

## 7. 参数采集合理性说明

无高侵入参数，无冗余参数未采集项。

`error_code` 参数在 `screenshot_capture_visible_result` 失败分支上报，来源为 chrome API 返回的 `res.error`（非用户内容），已做 `String(...).slice(0, 50)` 长度截断，符合规范要求。

---

## 8. 契约同步结果

| 资产 | 路径 | 结果 | 说明 |
|------|------|------|------|
| tracking-plan | .forge/external-tracking/plans/my-screenshot-v1/tracking-plan.yaml | UPDATED | 14 个事件 status draft → approved；insert_at 补充实际行号 |
| tracking-registry | 无 | SKIPPED | 本项目未配置 registry |
| contracts sync-back | 无 | PENDING | 等待命令层选择是否回推契约仓 |

---

## 9. 汇总

| 指标 | 数量 |
|------|------|
| Show 事件 | 1 |
| Action 事件 | 12 |
| Other 事件（SDK 用 action 承载） | 1 |
| **总计插入** | **14** |
| RLog 初始化 | 1 处（Popup 组件） |
| 跳过（非本契约范围） | 若干模块（见第 6 节） |
| 高侵入/冗余参数未采集 | 0 |
| 待补契约事件 | 0 |

---

## 10. 下一步

- **本地验证**: 运行 `pnpm dev` 加载扩展，打开 DevTools Console，点击各按钮确认 `window._rlog` 中有对应 `_trackCustom` push 调用。
- **代码审核**: 走团队正常 MR / CR 流程（当前为 standalone 模式）。
- **契约仓同步**: tracking-plan.yaml 已更新为 approved 状态。若需回推中心契约仓，等待命令层（forge-track）选择"审核通过并回推契约仓"；如暂缓，可后续执行 `forge-track --mode sync-only --key my-screenshot-v1`。
