/**
 * 用户设置：基于 chrome.storage.local 的轻量封装
 *
 * 设计：
 * - 单一 key "settings" 存储整个对象，避免逐字段 IO
 * - 用 local 而非 sync：sync 有 8192B/item 单 key 上限，自定义选择器 / 站点滚动区域
 *   累积后极易超限导致 set 静默失败、数据丢失；local 无单项上限、总额约 10MB
 * - 旧用户数据在 sync，getSettings 首次读取时自动迁移到 local
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

  /** 长截图相邻帧重叠比例（0~0.5）。
   *  scroller 底部常因 padding / box-shadow / mask 不渲染内容；按完整 viewport
   *  推进会让这段在长图衔接处变成白条 / 截断文字。
   *  本配置让滚动步长 = viewport × (1 - overlap)，相邻帧重叠该比例。
   *  默认 0.05；遇到衔接错位严重的站点（编辑器类）调到 0.1~0.2；
   *  普通静态页可调到 0 提速。 */
  fullPageOverlapRatio: number

  /** 长截图最终图片高度上限（CSS 像素，0 = 不限制）。
   *  无限滚动页面（信息流 / 评论流）scrollHeight 会随滚动持续增长，
   *  原有「滚到底」终止条件永远无法满足 → 长截图停不下来。
   *  达到此高度后立即停止滚动并以该高度封顶拼接。
   *  同时也规避超大画布（OffscreenCanvas 超过浏览器尺寸上限会静默失败）。 */
  maxFullPageHeightPx: number

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
  /** 选取时所在 frame 的 location.href。
   *  undefined 或与主 frame 一致时表示主 frame；
   *  否则截图流程会用它定位到对应子 frame 再注入逻辑。 */
  frameUrl?: string
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
  /** 截图保存格式：png（无损、体积大）/ jpeg（有损、可降质压缩）。默认 png */
  imageFormat: "png" | "jpeg"
  /** jpeg 质量（1~100），仅在 imageFormat=jpeg 时生效。默认 92 */
  imageQuality: number
  /** 整页截图判别规则 */
  fullPageRules: FullPageRuleSet
  /** 按 hostname 记忆的手动滚动区域 */
  siteScrollRegions: Record<string, SiteScrollRegionRule>
  /** 截图后先打开裁剪编辑器，确认后再下载 */
  cropBeforeDownload: boolean
  /** 长截图「激进隐藏模式」。
   *  开启后整页滚动拼接走「先隔离主滚动容器、把容器外所有元素隐藏」的流程，
   *  彻底消除顶栏 / 侧栏 / 弹窗逐帧重复；代价是词典官网等「内容分散在多个并列
   *  容器」的页面可能漏截非滚动容器内的元素。默认关闭，保留旧的首帧保留 +
   *  逐帧补偿流程。 */
  aggressiveHideMode: boolean
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

  scrollerBottomSafetyPx: 0,

  fullPageOverlapRatio: 0.05,

  maxFullPageHeightPx: 20000,

  hideAllFixedFallback: true
}

export const DEFAULT_SETTINGS: AppSettings = {
  delaySeconds: 3,
  imageFormat: "png",
  imageQuality: 92,
  fullPageRules: DEFAULT_FULL_PAGE_RULES,
  siteScrollRegions: {},
  cropBeforeDownload: true,
  aggressiveHideMode: false
}

const KEY = "settings"

/** 深合并整页规则字段，确保旧用户加载到新增字段时能拿到默认值 */
function mergeFullPageRules(
  stored: Partial<FullPageRuleSet> | undefined
): FullPageRuleSet {
  return { ...DEFAULT_FULL_PAGE_RULES, ...(stored ?? {}) }
}

/** 把存储里的原始对象补齐默认值，得到完整 AppSettings */
function normalizeSettings(stored: Partial<AppSettings>): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    fullPageRules: mergeFullPageRules(stored.fullPageRules),
    siteScrollRegions: stored.siteScrollRegions ?? {},
    imageFormat: stored.imageFormat ?? DEFAULT_SETTINGS.imageFormat,
    imageQuality: stored.imageQuality ?? DEFAULT_SETTINGS.imageQuality,
    cropBeforeDownload:
      stored.cropBeforeDownload ?? DEFAULT_SETTINGS.cropBeforeDownload,
    aggressiveHideMode:
      stored.aggressiveHideMode ?? DEFAULT_SETTINGS.aggressiveHideMode
  }
}

/**
 * 读取设置（自动用默认值补齐缺失字段）。
 *
 * 存储位置已从 chrome.storage.sync 迁移到 chrome.storage.local：
 *   sync 有 QUOTA_BYTES_PER_ITEM=8192 的单 key 上限，所有设置塞进一个 key 时，
 *   粘贴大量自定义选择器 / 长期累积很多站点滚动区域都会超限，set 静默失败、数据丢失。
 *   local 无单项上限、总额约 10MB，足够容纳。
 *
 * 兼容旧用户：local 没数据但 sync 有时，一次性把 sync 的值搬到 local。
 */
export async function getSettings(): Promise<AppSettings> {
  const localRaw = await chrome.storage.local.get(KEY)
  let stored = localRaw[KEY] as Partial<AppSettings> | undefined

  if (stored === undefined) {
    // 一次性迁移：旧版本存于 storage.sync
    try {
      const syncRaw = await chrome.storage.sync.get(KEY)
      const legacy = syncRaw[KEY] as Partial<AppSettings> | undefined
      if (legacy !== undefined) {
        stored = legacy
        await chrome.storage.local.set({ [KEY]: legacy })
      }
    } catch {
      /* 迁移失败则按默认值处理 */
    }
  }

  return normalizeSettings(stored ?? {})
}

/**
 * 部分更新设置。
 * 写入失败（如超出 local 总配额）会抛出带可读信息的错误，调用方应捕获并提示用户，
 * 避免「静默失败 + 数据丢失」。
 */
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
  try {
    await chrome.storage.local.set({ [KEY]: next })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`设置保存失败：${msg}`)
  }
}

/** 订阅设置变更（返回取消监听的函数） */
export function onSettingsChanged(
  cb: (settings: AppSettings) => void
): () => void {
  const listener = (
    changes: { [key: string]: chrome.storage.StorageChange },
    areaName: string
  ) => {
    if (areaName !== "local" || !changes[KEY]) return
    const stored = (changes[KEY].newValue as Partial<AppSettings>) ?? {}
    cb(normalizeSettings(stored))
  }
  chrome.storage.onChanged.addListener(listener)
  return () => chrome.storage.onChanged.removeListener(listener)
}
