import {
  DesktopIcon,
  PersonIcon,
  RegionIcon,
  TabIcon
} from "~src/components/icons"
import type { RecordAction } from "~src/types/popup"

export const RECORD_MODE_ACTIONS: RecordAction[] = [
  {
    key: "desktop",
    label: "桌面",
    icon: <DesktopIcon />
  },
  {
    key: "camera",
    label: "摄像头",
    icon: <PersonIcon />
  },
  {
    key: "currentTab",
    label: "当前标签页",
    icon: <TabIcon />
  },
  {
    key: "regionTab",
    label: "区域录制(当前标签页)",
    icon: <RegionIcon />
  }
]
