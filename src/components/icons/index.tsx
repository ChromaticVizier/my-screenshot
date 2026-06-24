/**
 * 图标库：统一管理所有 SVG 图标
 * 全部使用 currentColor，便于通过 CSS 控制颜色
 */
import type { SVGProps } from "react"

type IconProps = SVGProps<SVGSVGElement>

const baseProps: IconProps = {
  width: 20,
  height: 20,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round",
  strokeLinejoin: "round"
}

export const CameraIcon = (props: IconProps) => (
  <svg {...baseProps} {...props}>
    <path d="M3 7h4l2-2h6l2 2h4v12H3z" />
    <circle cx="12" cy="13" r="3.5" />
  </svg>
)

export const VideoIcon = (props: IconProps) => (
  <svg {...baseProps} {...props}>
    <rect x="2.5" y="6" width="13" height="12" rx="1.5" />
    <path d="M15.5 10.5l5-2.5v8l-5-2.5z" />
  </svg>
)

export const BrowserIcon = (props: IconProps) => (
  <svg {...baseProps} {...props}>
    <rect x="3" y="4.5" width="18" height="15" rx="1.5" />
    <path d="M3 9h18" />
    <circle cx="6" cy="6.8" r="0.6" fill="currentColor" />
    <circle cx="8.2" cy="6.8" r="0.6" fill="currentColor" />
  </svg>
)

export const FullPageIcon = (props: IconProps) => (
  <svg {...baseProps} {...props}>
    <rect x="5" y="3" width="14" height="18" rx="1.5" />
    <path d="M8 7h8M8 11h8M8 15h5" />
  </svg>
)

export const SelectionIcon = (props: IconProps) => (
  <svg {...baseProps} {...props}>
    <path d="M4 8V5h3M20 8V5h-3M4 16v3h3M20 16v3h-3" />
    <path d="M9 5h6M9 19h6M4 10v4M20 10v4" strokeDasharray="2 2" />
  </svg>
)

export const ClockIcon = (props: IconProps) => (
  <svg {...baseProps} {...props}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </svg>
)

export const ScreenIcon = (props: IconProps) => (
  <svg {...baseProps} {...props}>
    <rect x="2.5" y="4" width="19" height="13" rx="1.5" />
    <path d="M9 20h6M12 17v3" />
  </svg>
)

export const ImageIcon = (props: IconProps) => (
  <svg {...baseProps} {...props}>
    <rect x="3" y="4.5" width="18" height="15" rx="1.5" />
    <circle cx="8.5" cy="10" r="1.5" />
    <path d="M21 16l-5-5-9 8.5" />
  </svg>
)

export const TextIcon = (props: IconProps) => (
  <svg {...baseProps} {...props}>
    <path d="M4 5V3h6M20 5V3h-6M4 19v2h6M20 19v2h-6" />
    <path d="M8 9h8M8 13h6" />
  </svg>
)

export const CloudIcon = (props: IconProps) => (
  <svg {...baseProps} {...props}>
    <path d="M7 17h10a4 4 0 0 0 .5-7.97 6 6 0 0 0-11.6 1.5A3.5 3.5 0 0 0 7 17z" />
  </svg>
)

export const DesktopIcon = (props: IconProps) => (
  <svg {...baseProps} {...props}>
    <rect x="2.5" y="4" width="19" height="13" rx="1.5" />
    <path d="M9 20h6M12 17v3" />
  </svg>
)

export const PersonIcon = (props: IconProps) => (
  <svg {...baseProps} {...props}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8" />
  </svg>
)

export const TabIcon = (props: IconProps) => (
  <svg {...baseProps} {...props}>
    <path d="M3 8.5h6l1.5-2H21V19H3z" />
  </svg>
)

export const RegionIcon = (props: IconProps) => (
  <svg {...baseProps} {...props}>
    <rect
      x="3.5"
      y="5"
      width="17"
      height="14"
      rx="1.5"
      strokeDasharray="3 2"
    />
    <circle cx="17" cy="17" r="2.5" />
  </svg>
)

export const MicMutedIcon = (props: IconProps) => (
  <svg {...baseProps} {...props}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3M4 4l16 16" />
  </svg>
)

export const MicOnIcon = (props: IconProps) => (
  <svg {...baseProps} {...props}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" />
  </svg>
)

export const SoundOffIcon = (props: IconProps) => (
  <svg {...baseProps} {...props}>
    <path d="M4 9v6h4l5 4V5L8 9zM16 9l5 6M21 9l-5 6" />
  </svg>
)

export const SoundOnIcon = (props: IconProps) => (
  <svg {...baseProps} {...props}>
    <path d="M4 9v6h4l5 4V5L8 9z" />
    <path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8 8 0 0 1 0 12" />
  </svg>
)

export const ToolbarIcon = (props: IconProps) => (
  <svg {...baseProps} {...props}>
    <path d="M3 7h13M19 7h2M3 17h2M8 17h13" />
    <circle cx="17.5" cy="7" r="2" />
    <circle cx="6.5" cy="17" r="2" />
  </svg>
)

export const HDIcon = (props: IconProps) => (
  <svg {...baseProps} {...props} viewBox="0 0 24 16">
    <rect x="1" y="1" width="22" height="14" rx="2" />
    <path
      d="M5 5v6M5 8h3V5M8 11V5M12 5h2a3 3 0 0 1 0 6h-2V5z"
      strokeWidth="1.6"
    />
  </svg>
)

export const ChevronDownIcon = (props: IconProps) => (
  <svg {...baseProps} {...props}>
    <path d="M6 9l6 6 6-6" />
  </svg>
)

export const ChevronRightIcon = (props: IconProps) => (
  <svg {...baseProps} {...props}>
    <path d="M9 6l6 6-6 6" />
  </svg>
)

export const RecordDotIcon = (props: IconProps) => (
  <svg {...baseProps} {...props} fill="currentColor" stroke="none">
    <circle cx="12" cy="12" r="6" />
  </svg>
)
