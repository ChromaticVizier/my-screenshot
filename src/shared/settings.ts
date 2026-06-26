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
/**
 * 整页截图规则（精简后）。
 *
 * 历史上这里有大量"页面类型判别阈值"（fixed/sticky 漂移阈值、背景层面积、
 * 高 z-index、滚动容器评分权重等），用于让用户手动调参来适配各类页面。
 * 引入 MoE 页面类型路由（src/background/handlers/fullPageRouter.ts）后，
 * "该用哪套策略"由路由器在截图前自动判别，这些判别阈值不再需要暴露给用户，
 * 已固化为各注入函数内部常量并从设置中移除。
 *
 * 这里只保留与"判别"无关的纯操作项：隐藏总开关、用户自定义选择器、
 * 帧重叠比例、长图高度上限。
 */
export interface FullPageRuleSet {
  /** 总开关：关掉则后续帧不做任何隐藏（等同首帧策略） */
  enabled: boolean

  /* ---- 用户自定义选择器（最高优先级）---- */
  /** 永远保留：匹配的元素无论什么规则都不会被隐藏 */
  customKeepSelectors: string[]
  /** 永远隐藏：匹配的元素在每一帧（含首帧）都隐藏 */
  customHideSelectors: string[]

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

/**
 * 整页（长截图）专家路由模式。
 *  - "auto"：截图前自动探测页面类型并路由到对应专家（默认，推荐）
 *  - "standard"：强制走标准流程（首帧保留顶栏 + 逐帧隐藏补偿，window 滚动友好）
 *  - "isolate"：强制走隔离流程（隔离主滚动容器、隐藏容器外所有元素）
 *  - "spa-like"：强制走「类 SPA」流程（window 可滚但有固定顶栏 / 大侧边栏，
 *     首帧保留 chrome，后续帧把顶栏 + 侧边栏一并隐藏）
 * 详见 src/background/handlers/fullPageRouter.ts。
 */
export type FullPageMode = "auto" | "standard" | "isolate" | "spa-like"

/**
 * 长截图「专家」标识（MoE 路由的输出）：
 *  - "standard"：标准流程（首帧保留 + 逐帧补偿）
 *  - "isolate"：隔离主滚动容器流程
 *  - "iframe"：内容主体在某大 iframe 内
 *  - "spa-like"：window 可滚但带固定顶栏 / 大侧边栏的「类 SPA」页面
 * 与 fullPageRouter / routeLog 共用。
 */
export type FullPageExpert = "standard" | "isolate" | "iframe" | "spa-like"

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
  /** 长截图专家路由模式。默认 "auto"：截图前自动判别页面类型并选用对应专家。
   *  "standard" / "isolate" 为手动覆盖（强制使用某一专家）。 */
  fullPageMode: FullPageMode
  /** 调试：整页截图前在页面上短暂弹出 MoE 判定的页面类型（展示后立即移除，
   *  不会进入截图）。feat/MoE 调试阶段默认开启，便于核对路由；可在设置页关闭。 */
  showPageTypeToast: boolean
}

/** 整页规则默认值。也作为"恢复默认"按钮的回填来源 */
export const DEFAULT_FULL_PAGE_RULES: FullPageRuleSet = {
  enabled: true,

  customKeepSelectors: [],
  customHideSelectors: [],

  fullPageOverlapRatio: 0.05,

  maxFullPageHeightPx: 20000
}

export const DEFAULT_SETTINGS: AppSettings = {
  delaySeconds: 3,
  imageFormat: "png",
  imageQuality: 92,
  fullPageRules: DEFAULT_FULL_PAGE_RULES,
  siteScrollRegions: {},
  cropBeforeDownload: true,
  fullPageMode: "auto",
  showPageTypeToast: true
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
  // 旧版本用布尔 aggressiveHideMode 表达模式；迁移为新的 fullPageMode：
  //   aggressiveHideMode=true → "isolate"，false / 未设置 → "auto"。
  const legacyAggressive = (stored as { aggressiveHideMode?: boolean })
    .aggressiveHideMode
  const fullPageMode: FullPageMode =
    stored.fullPageMode ??
    (legacyAggressive === true ? "isolate" : DEFAULT_SETTINGS.fullPageMode)

  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    fullPageRules: mergeFullPageRules(stored.fullPageRules),
    siteScrollRegions: stored.siteScrollRegions ?? {},
    imageFormat: stored.imageFormat ?? DEFAULT_SETTINGS.imageFormat,
    imageQuality: stored.imageQuality ?? DEFAULT_SETTINGS.imageQuality,
    cropBeforeDownload:
      stored.cropBeforeDownload ?? DEFAULT_SETTINGS.cropBeforeDownload,
    fullPageMode,
    showPageTypeToast:
      stored.showPageTypeToast ?? DEFAULT_SETTINGS.showPageTypeToast
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
