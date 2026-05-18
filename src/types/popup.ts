/** Popup 相关的公共类型 */

export type TabKey = "capture" | "record"

export interface TabItem {
  key: TabKey
  label: string
  icon: React.ReactNode
}

/** 截图模式 */
export type CaptureMode =
  | "visible" // 可视区域
  | "fullPage" // 整个页面
  | "selection" // 选择区域
  | "delayed" // 延迟截取
  | "desktop" // 整个屏幕或应用窗口
  | "annotate" // 标注本地或剪贴板图片
  | "ocr" // 截图提取文本

export interface CaptureAction {
  key: CaptureMode
  label: string
  icon: React.ReactNode
  /** true: 大卡片样式; false: 列表样式 */
  variant: "card" | "list"
  disabled?: boolean
}

/** 录屏模式 */
export type RecordMode =
  | "desktop" // 桌面
  | "camera" // 摄像头
  | "currentTab" // 当前标签页
  | "regionTab" // 区域录制（当前标签页）

export interface RecordAction {
  key: RecordMode
  label: string
  icon: React.ReactNode
  disabled?: boolean
}
