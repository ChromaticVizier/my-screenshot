/**
 * 整页（长截图）MoE 路由器。
 *
 * 借鉴混合专家系统：截图前先用 probePageType 采集页面特征信号，再由纯函数
 * classifyPageType 判别页面类型，最后路由到对应"专家"流程。替代旧版靠用户
 * 手动切换的全局开关（aggressiveHideMode）。
 *
 * 专家（当前三类，复用 master 分支已验证的细分逻辑）：
 *   - standard  → handleCaptureFullPage          （首帧保留顶栏 + 逐帧隐藏补偿；
 *                                                   window 滚动 / 内容分散页面最稳，默认兜底）
 *   - isolate   → handleCaptureFullPageAggressive （隔离主滚动容器、隐藏容器外元素；
 *                                                   SPA 单主滚动容器页面）
 *   - iframe    → handleCaptureFullPageAggressive + 合成 siteRule（内容主体在某大 iframe 内）
 *
 * 用户可在设置里把 fullPageMode 设为 "standard" / "isolate" 强制覆盖路由（手动挡）。
 * 用户用 picker 手动选过的站点滚动区（siteScrollRegions[hostname]）优先级最高，
 * 直接沿用，不再自动判别。
 */
import { handleCaptureFullPage } from "~src/background/handlers/capture"
import { handleCaptureFullPageAggressive } from "~src/background/handlers/captureFullPageAggressive"
import { handleCaptureFullPageEmbeddedDoc } from "~src/background/handlers/captureFullPageEmbeddedDoc"
import {
  errorResponse,
  hostnameFromUrl,
  sleep,
  type FullPageRouting
} from "~src/background/handlers/fullPageShared"
import {
  removePageTypeToast,
  showPageTypeToast
} from "~src/background/injected/pageTypeToast"
import {
  probePageType,
  type PageTypeProbe
} from "~src/background/injected/probePageType"
import { getCapturableActiveTab } from "~src/background/utils/tabHelper"
import type { CaptureFullPageRequest, CaptureResponse } from "~src/shared/messages"
import { appendRouteLog } from "~src/shared/routeLog"
import {
  getSettings,
  type FullPageExpert,
  type SiteScrollRegionRule
} from "~src/shared/settings"

/** 打开后在 console 打印分类决策 + 信号，便于用逆向样本集校准路由 */
const DEBUG_ROUTE = true

/** 调试浮层展示时长（ms），到点后移除再开始截图，避免浮层进入截图 */
const TOAST_DURATION = 2000

/** 专家 → 给人看的中文标签（调试浮层用） */
const EXPERT_LABELS: Record<FullPageExpert, string> = {
  standard: "标准（纯内容 / window 滚动）",
  isolate: "隔离（SPA 单主滚动容器）",
  iframe: "内嵌 iframe（内容主体在 iframe 内）",
  "spa-like": "类 SPA（window 可滚 + 固定顶栏 / 大侧边栏）",
  "embedded-doc": "内嵌文档/表格（canvas 自定义滚动，如网易灵犀）"
}

export interface RouteDecision {
  expert: FullPageExpert
  reason: string
}

/**
 * 纯函数分类：把页面特征信号映射到专家。
 *
 * 设计原则——"默认安全"：
 *   standard 是兜底（与 MoE 化之前的唯一默认流程一致），只在高置信时才升级到
 *   isolate / iframe，避免误判把"原本能正常截"的页面改坏。
 */
export function classifyPageType(p: PageTypeProbe): RouteDecision {
  // 1) 主体 iframe：一个大 iframe 占据视口主体 → 内容多半在 iframe 内。
  //    要求有可用的 http(s) src 才能做 frame 定位，否则回退后续判据。
  if (
    p.dominantIframe &&
    p.dominantIframe.areaRatio >= 0.6 &&
    /^https?:/i.test(p.dominantIframe.src)
  ) {
    return {
      expert: "iframe",
      reason: `dominant iframe areaRatio=${p.dominantIframe.areaRatio.toFixed(2)}`
    }
  }

  // 2) SPA 单主滚动容器：window 不可滚 + 存在占视口主体的内部滚动容器。
  //    这是旧版需要用户手动开"激进隐藏"的典型场景，现自动升级到 isolate。
  if (
    !p.windowScrollable &&
    p.bestScrollerCoversViewport &&
    p.scrollerCandidateCount >= 1
  ) {
    return {
      expert: "isolate",
      reason: `spa dominant scroller (windowScrollable=false, score=${p.bestScrollerScore.toFixed(
        2
      )}, shRatio=${p.bestScrollerScrollHeightRatio.toFixed(2)})`
    }
  }

  // 3) body/html 锁滚 + 存在占主体的内部滚动容器（同 2 的更宽兜底）。
  if (p.bodyScrollLocked && p.bestScrollerCoversViewport) {
    return {
      expert: "isolate",
      reason: "body scroll locked + dominant scroller"
    }
  }

  // 4) 类 SPA：带贯穿全高的大侧边栏（gitlab / confluence 等导航壳）。这类页面
  //    无论 window 滚动还是内部容器滚动，侧栏 / 顶栏都会逐帧重复；交给 spa-like：
  //    首帧整窗保留 chrome，后续帧把顶栏 + 侧边栏排除（裁切区外 / 激进隐藏）。
  //    放在 isolate 之后：isolate 已接走「window 不可滚 + 主体滚动容器」的纯 SPA。
  if (p.hasSidebar && (p.windowScrollable || p.scrollerCandidateCount >= 1)) {
    return {
      expert: "spa-like",
      reason: `sidebar shell (windowScrollable=${p.windowScrollable}, scrollers=${
        p.scrollerCandidateCount
      }${p.hasTopBar ? ", topbar" : ""})`
    }
  }

  // 5) 默认：标准流程。window 可滚的传统页面、内容分散 / 多并列容器页面在此最稳，
  //    隔离反而可能漏截非容器内容。
  return { expert: "standard", reason: "default (static / window-scroll / spread)" }
}

/**
 * 探测页面类型（注入主 frame）。失败时返回 null，调用方按 standard 兜底。
 */
async function probe(tabId: number): Promise<PageTypeProbe | null> {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: probePageType
    })
    return (result as PageTypeProbe) ?? null
  } catch (err) {
    console.warn("[fullPage][router] probe failed", err)
    return null
  }
}

/**
 * 调试：在页面上短暂弹出 MoE 判定的页面类型。
 * 务必在真正截图之前展示并移除——展示 TOAST_DURATION 毫秒后立刻移除浮层，
 * 确保它不会进入截图。注入失败（如受限页面）静默忽略，不阻断截图。
 */
async function maybeShowDebugToast(
  tabId: number,
  decision: RouteDecision
): Promise<void> {
  const text = `整页截图 · MoE 判定\n${EXPERT_LABELS[decision.expert]}\n${decision.reason}`
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: showPageTypeToast,
      args: [text]
    })
    if (DEBUG_ROUTE) console.log("[fullPage][router] debug toast shown", { tabId })
    await sleep(TOAST_DURATION)
    await chrome.scripting.executeScript({
      target: { tabId },
      func: removePageTypeToast
    })
  } catch (err) {
    console.warn("[fullPage][router] debug toast failed", err)
  }
}

/**
 * 整页截图统一入口：判别页面类型并路由到对应专家。
 * 由 background/index.ts 在收到 CAPTURE_FULL_PAGE 时调用。
 */
export async function handleCaptureFullPageRouted(
  request: CaptureFullPageRequest
): Promise<CaptureResponse> {
  const settings = await getSettings()
  const mode = settings.fullPageMode

  // 取标签页：探测、调试浮层都需要 tabId（具体专家内部会再取一次，开销可忽略）
  const tabRes = await getCapturableActiveTab()
  if (!tabRes.ok) return { ok: false, error: tabRes.error }
  const tab = tabRes.tab
  const tabId = tab.id!
  const hostname = hostnameFromUrl(tab.url) ?? ""

  // ===== 1) 确定专家决策 =====
  let decision: RouteDecision
  let routing: FullPageRouting | undefined
  // auto 模式下的探测信号（手动模式为 null），用于写入路由日志
  let signals: PageTypeProbe | null = null

  if (mode === "standard") {
    decision = { expert: "standard", reason: "手动指定模式 = standard" }
  } else if (mode === "isolate") {
    decision = { expert: "isolate", reason: "手动指定模式 = isolate" }
  } else if (mode === "spa-like") {
    decision = { expert: "spa-like", reason: "手动指定模式 = spa-like" }
    routing = { hideStructuralChrome: true }
  } else if (mode === "embedded-doc") {
    // 手动：探测主体 iframe 作为内嵌文档目标，交给 embedded-doc 专家（内部再判是否
    // 自定义滚动文档，不是则回退）。
    decision = { expert: "embedded-doc", reason: "手动指定模式 = embedded-doc" }
    signals = await probe(tabId)
    if (signals?.dominantIframe && /^https?:/i.test(signals.dominantIframe.src)) {
      routing = {
        siteRuleOverride: {
          selector: "",
          hostname,
          createdAt: Date.now(),
          frameUrl: signals.dominantIframe.src,
          label: "manual embedded-doc iframe"
        }
      }
    }
  } else {
    // auto：先探测页面特征
    signals = await probe(tabId)
    const manualSiteRule = settings.siteScrollRegions[hostname]
    if (DEBUG_ROUTE) {
      console.log("[fullPage][router] signals", { hostname, signals })
    }
    if (
      signals?.dominantIframe &&
      signals.dominantIframe.areaRatio >= 0.6 &&
      /^https?:/i.test(signals.dominantIframe.src)
    ) {
      // 主体 iframe（如内嵌灵犀表格 / 文档）→ embedded-doc 专家（内部判 canvas
      // 自定义滚动，不是则回退 iframe 隔离）。无论是否有手动选区都优先——内容在
      // iframe 内，手动选区在主 frame 只能选到 iframe 本身。
      decision = {
        expert: "embedded-doc",
        reason: `dominant iframe ${signals.dominantIframe.areaRatio.toFixed(2)}`
      }
      routing = {
        siteRuleOverride: {
          selector: "",
          hostname,
          createdAt: Date.now(),
          frameUrl: signals.dominantIframe.src,
          label: "auto dominant iframe"
        }
      }
    } else if (manualSiteRule) {
      decision = { expert: "standard", reason: "站点手动滚动区，沿用标准流程" }
    } else if (!signals) {
      decision = { expert: "standard", reason: "页面探测失败，兜底标准流程" }
    } else {
      decision = classifyPageType(signals)
      if (decision.expert === "spa-like") {
        // 走隔离 handler 的「首帧保留」流程，激进隐藏结构性 chrome（顶栏 + 大侧边栏）
        routing = { hideStructuralChrome: true }
      }
    }
  }

  if (DEBUG_ROUTE) {
    console.log("[fullPage][router] decision", {
      hostname,
      mode,
      expert: decision.expert,
      reason: decision.reason
    })
  }

  // ===== 2) 写入路由日志（网址 + 判定类型），并按需弹出调试浮层 =====
  await appendRouteLog({
    t: Date.now(),
    url: tab.url ?? "",
    hostname,
    expert: decision.expert,
    mode,
    reason: decision.reason,
    signals: signals ? { ...signals } : undefined
  })

  // 调试浮层（展示后移除，再进入截图）。
  // DEBUG_ROUTE 期间无条件展示，避免被存储里的旧设置（如曾被写入 false）盖掉；
  // 上线前把 DEBUG_ROUTE 置 false 后，由 settings.showPageTypeToast 决定。
  if (DEBUG_ROUTE || settings.showPageTypeToast) {
    await maybeShowDebugToast(tabId, decision)
  }

  // ===== 3) 分派到对应专家 =====
  try {
    switch (decision.expert) {
      case "isolate":
        return await handleCaptureFullPageAggressive(request)
      case "iframe":
        // 内嵌 iframe：先交 embedded-doc 专家（它会判定是否 canvas 自定义滚动文档，
        // 如网易灵犀表格；不是则内部回退到隔离/iframe 处理）。
        return await handleCaptureFullPageEmbeddedDoc(request, routing)
      case "embedded-doc":
        return await handleCaptureFullPageEmbeddedDoc(request, routing)
      case "spa-like":
        // 类 SPA：走隔离 handler 的「首帧整窗保留」流程——首帧含顶栏/侧栏，
        // 后续帧裁切主滚动容器（侧栏在裁切区外自动排除）或整窗 + 激进隐藏 chrome。
        return await handleCaptureFullPageAggressive(request, routing)
      case "standard":
      default:
        return await handleCaptureFullPage(request)
    }
  } catch (err) {
    return errorResponse(err)
  }
}
