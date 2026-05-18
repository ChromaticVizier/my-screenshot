import {
  BrowserIcon,
  ClockIcon,
  FullPageIcon,
  ImageIcon,
  ScreenIcon,
  SelectionIcon,
  TextIcon
} from "~src/components/icons"
import type { CaptureAction } from "~src/types/popup"

/** 顶部三个大卡片 */
export const CAPTURE_CARD_ACTIONS: CaptureAction[] = [
  {
    key: "visible",
    label: "可视区域",
    icon: <BrowserIcon />,
    variant: "card"
  },
  {
    key: "fullPage",
    label: "整个页面",
    icon: <FullPageIcon />,
    variant: "card",
    disabled: true
  },
  {
    key: "selection",
    label: "选择区域",
    icon: <SelectionIcon />,
    variant: "card",
    disabled: true
  }
]

/** 下方列表项 */
export const CAPTURE_LIST_ACTIONS: CaptureAction[] = [
  {
    key: "delayed",
    label: "延迟截取可视区域",
    icon: <ClockIcon />,
    variant: "list"
  },
  {
    key: "desktop",
    label: "整个屏幕或应用窗口",
    icon: <ScreenIcon />,
    variant: "list"
  },
  {
    key: "annotate",
    label: "标注本地或剪贴板图片",
    icon: <ImageIcon />,
    variant: "list"
  },
  {
    key: "ocr",
    label: "截屏提取文本",
    icon: <TextIcon />,
    variant: "list",
    disabled: true
  }
]
