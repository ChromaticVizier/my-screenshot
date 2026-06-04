/**
 * 用户设置：基于 chrome.storage.sync 的轻量封装
 *
 * 设计：
 * - 单一 key "settings" 存储整个对象，避免逐字段 IO
 * - 提供 getSettings / setSettings / onSettingsChanged 三个原语
 * - 默认值集中维护，缺省字段自动补齐（向后兼容）
 */

/**
 * 整页截图判别规则（用户可调）
 *
 * 注入函数 recordAnchors / hideStickyForFrame 会以参数形式收到这套规则，
 * 用它决定"哪些跟随视口的元素该隐藏 / 该保留"。所有阈值都对应代码里的
 * 几何启发，调小=更激进隐藏，调大=更保守保留。
 *
 * 字段顺序在 options 页 UI 中也按这个顺序展示，便于排查。
 */
export interface FullPageRuleSet {
  /** 总开关：关掉则后续帧不做任何隐藏（等同首帧策略） */
  enabled: boolean

  /* ---- 1. 行为判别 ---- */
  /** 绝对位置漂移阈值（px）：超过此值视为"跟着视口走" */
  followThresholdPx: number
  /** 视口位置稳定阈值（px）：当前 rect 与首帧 rect 的偏差小于此值才视为稳定 */
  viewportStableThresholdPx: number

  /* ---- 2. 内容容器豁免 ---- */
  /** 子树高度占文档高度比例 ≥ 此值视为主内容容器 */
  contentRatio: number
  /** 元素 innerText 长度 ≥ 此值视为内容容器 */
  contentText: number

  /* ---- 3. 背景层豁免 ---- */
  /** 占视口面积 ≥ 此值才有资格被判为背景 */
  backgroundArea: number
  /** 背景层最大文本量（用于排除"大面积但有大量文字"的内容容器） */
  backgroundText: number
  /** 水印类元素最低面积（pointer-events:none 且面积 ≥ 此值即保留） */
  watermarkAreaMin: number

  /* ---- 4. 浮层硬命中 ---- */
  /** ≥ 此值视为高 z-index 浮层候选 */
  highZIndex: number
  /** 距视口任一边 ≤ 此像素即视为"贴边" */
  nearEdgePx: number
  /** 占视口面积 ≥ 此值视为"视口级大块"，不当作浮层处理 */
  viewportSizedRatio: number

  /* ---- 5. 角色识别 ---- */
  /** 主内容容器的 id/class 正则字符串（默认覆盖 main/content/article/post 等） */
  semanticMainRegex: string
  /** 命中即认为是扩展浮层（按子串小写匹配 id/class/tag/role） */
  extensionOverlayKeywords: string[]

  /* ---- 6. 用户自定义选择器（最高优先级）---- */
  /** 永远保留：匹配的元素无论什么规则都不会被隐藏 */
  customKeepSelectors: string[]
  /** 永远隐藏：匹配的元素在每一帧（含首帧）都隐藏 */
  customHideSelectors: string[]

  /* ---- 7. 主滚动容器识别 ---- */
  /** 自动检测内部主滚动容器（SPA 常见：window 不滚，主体 div 滚） */
  detectScrollContainer: boolean
  /** 滚动容器最小 scrollHeight/clientHeight 比例 */
  scrollContainerMinRatio: number
  /** 滚动容器最小可滚动距离（px） */
  scrollContainerMinOverflowPx: number
  /** 视口覆盖面积权重：越高越偏向全屏容器 */
  scrollContainerAreaWeight: number
  /** 文本量权重：越高越偏向正文区域 */
  scrollContainerTextWeight: number
  /** 语义命中权重：越高越偏向 main/content/chat/list 等类名 */
  scrollContainerSemanticWeight: number
  /** 识别候选容器的 id/class 正则 */
  scrollContainerRegex: string

  /** 内部滚动容器底部安全裕量（px）。仅在选用内部滚动容器时生效，
   *  普通整页（window 滚动）不受影响。
   *  适配 vue-recycle-scroller 等虚拟列表内部 item 渲染溢出 overflow:hidden 边界、
   *  以及紧邻 scroller 的输入框/工具栏 box-shadow 上溢导致每屏底部多切一条白底
   *  的问题。代价是长图末尾会有等高的小空白条。 */
  scrollerBottomSafetyPx: number

  /* ---- 8. 模式开关 ---- */
  /** 兜底：剩余跟随视口元素是否一律隐藏（关闭后只隐藏明确命中浮层规则的） */
  hideAllFixedFallback: boolean
}

export interface SiteScrollRegionRule {
  /** 目标元素 CSS selector */
  selector: string
  /** 记录时的 hostname，便于导出阅读 */
  hostname: string
  /** 记录时间 */
  createdAt: number
  /** 调试信息 */
  label?: string
  tag?: string
  id?: string
  className?: string
  rect?: { top: number; left: number; width: number; height: number }
  scrollHeight?: number
  clientHeight?: number
}

export interface AppSettings {
  /** 延迟截图的等待秒数，默认 3 */
  delaySeconds: number
  /** 整页截图判别规则 */
  fullPageRules: FullPageRuleSet
  /** 按 hostname 记忆的手动滚动区域 */
  siteScrollRegions: Record<string, SiteScrollRegionRule>
}

/** 整页规则默认值。也作为"恢复默认"按钮的回填来源 */
export const DEFAULT_FULL_PAGE_RULES: FullPageRuleSet = {
  enabled: true,

  followThresholdPx: 3,
  viewportStableThresholdPx: 8,

  contentRatio: 0.45,
  contentText: 500,

  backgroundArea: 0.6,
  backgroundText: 20,
  watermarkAreaMin: 0.25,

  highZIndex: 100,
  nearEdgePx: 32,
  viewportSizedRatio: 0.5,

  semanticMainRegex: "(^|[-_\\s])(main|content|article|post|page-content)([-_\\s]|$)",
  extensionOverlayKeywords: [
    "immersive",
    "translation",
    "translator",
    "translate",
    "extension",
    "plasmo",
    "crx",
    "chrome-extension"
  ],

  customKeepSelectors: [],
  customHideSelectors: [],

  detectScrollContainer: true,
  scrollContainerMinRatio: 1.05,
  scrollContainerMinOverflowPx: 80,
  scrollContainerAreaWeight: 0.35,
  scrollContainerTextWeight: 0.3,
  scrollContainerSemanticWeight: 0.35,
  scrollContainerRegex:
    "(^|[-_\\s])(main|content|body|center|middle|scroll|scroller|container|workspace|chat|conversation|message|article|detail|panel|pane)([-_\\s]|$)",

  scrollerBottomSafetyPx: 20,

  hideAllFixedFallback: true
}

export const DEFAULT_SETTINGS: AppSettings = {
  delaySeconds: 3,
  fullPageRules: DEFAULT_FULL_PAGE_RULES,
  siteScrollRegions: {}
}

const KEY = "settings"

/** 深合并整页规则字段，确保旧用户加载到新增字段时能拿到默认值 */
function mergeFullPageRules(
  stored: Partial<FullPageRuleSet> | undefined
): FullPageRuleSet {
  return { ...DEFAULT_FULL_PAGE_RULES, ...(stored ?? {}) }
}

/** 读取设置（自动用默认值补齐缺失字段） */
export async function getSettings(): Promise<AppSettings> {
  const raw = await chrome.storage.sync.get(KEY)
  const stored = (raw[KEY] as Partial<AppSettings> | undefined) ?? {}
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    fullPageRules: mergeFullPageRules(stored.fullPageRules),
    siteScrollRegions: stored.siteScrollRegions ?? {}
  }
}

/** 部分更新设置 */
export async function setSettings(patch: Partial<AppSettings>): Promise<void> {
  const current = await getSettings()
  const next: AppSettings = {
    ...current,
    ...patch,
    fullPageRules: patch.fullPageRules
      ? mergeFullPageRules({ ...current.fullPageRules, ...patch.fullPageRules })
      : current.fullPageRules,
    siteScrollRegions: patch.siteScrollRegions ?? current.siteScrollRegions
  }
  await chrome.storage.sync.set({ [KEY]: next })
}

/** 订阅设置变更（返回取消监听的函数） */
export function onSettingsChanged(
  cb: (settings: AppSettings) => void
): () => void {
  const listener = (
    changes: { [key: string]: chrome.storage.StorageChange },
    areaName: string
  ) => {
    if (areaName !== "sync" || !changes[KEY]) return
    const stored = (changes[KEY].newValue as Partial<AppSettings>) ?? {}
    cb({
      ...DEFAULT_SETTINGS,
      ...stored,
      fullPageRules: mergeFullPageRules(stored.fullPageRules),
      siteScrollRegions: stored.siteScrollRegions ?? {}
    })
  }
  chrome.storage.onChanged.addListener(listener)
  return () => chrome.storage.onChanged.removeListener(listener)
}
