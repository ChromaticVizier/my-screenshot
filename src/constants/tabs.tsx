import { CameraIcon, VideoIcon } from "~src/components/icons"
import type { TabItem } from "~src/types/popup"

export const TAB_ITEMS: TabItem[] = [
  {
    key: "capture",
    label: "截图",
    icon: <CameraIcon />
  },
  {
    key: "record",
    label: "录屏",
    icon: <VideoIcon />
  }
]
