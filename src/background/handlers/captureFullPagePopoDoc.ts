import { handleCaptureFullPageAggressive } from "~src/background/handlers/captureFullPageAggressive"
import {
  detectCanvasGrid,
  handleCaptureFullPageCanvasGrid
} from "~src/background/handlers/captureFullPageCanvasGrid"
import type { FullPageRouting } from "~src/background/handlers/fullPageShared"
import { hostnameFromUrl } from "~src/background/handlers/fullPageShared"
import { getCapturableActiveTab } from "~src/background/utils/tabHelper"
import type {
  CaptureFullPageRequest,
  CaptureResponse
} from "~src/shared/messages"
import { getSettings, type SiteScrollRegionRule } from "~src/shared/settings"

export async function handleCaptureFullPagePopoDoc(
  request: CaptureFullPageRequest,
  routing?: FullPageRouting
): Promise<CaptureResponse> {
  const tabRes = await getCapturableActiveTab()
  const settings = await getSettings()
  const tab = tabRes.ok ? tabRes.tab : null
  const hostname = hostnameFromUrl(tab?.url) ?? "docs.popo.netease.com"
  const selectedRule =
    routing?.siteRuleOverride ?? settings.siteScrollRegions[hostname]
  const iframeRule: SiteScrollRegionRule = {
    selector: selectedRule?.selector ?? "",
    hostname,
    createdAt: Date.now(),
    frameUrl: selectedRule?.frameUrl,
    label: "popo docs iframe"
  }

  if (!iframeRule.frameUrl && tab?.id) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () =>
          document.querySelector<HTMLIFrameElement>("iframe#lingxi-iframe")
            ?.src ??
          document.querySelector<HTMLIFrameElement>(
            "iframe[src*='office.netease.com/app/open']"
          )?.src ??
          ""
      })
      if (result) iframeRule.frameUrl = result
    } catch {
      /* 沿用主 frame */
    }
  }

  // POPo 可能内嵌网易灵犀「表格」(SpreadJS canvas，如 docType=2)。
  // 这类正文是虚拟化 canvas + 自定义滚动条，需专用 canvas grid 流程
  // （拖动滚动条把手滚动），而非文档 scroller。命中则委托处理。
  if (tab?.id && iframeRule.frameUrl) {
    const grid = await detectCanvasGrid(
      tab.id,
      iframeRule.selector,
      iframeRule.frameUrl
    )
    if (grid) {
      return handleCaptureFullPageCanvasGrid(
        request,
        { ...routing, siteRuleOverride: iframeRule },
        grid
      )
    }
  }

  return handleCaptureFullPageAggressive(request, {
    ...routing,
    siteRuleOverride: iframeRule,
    preserveFirstFrameForSubFrame: true,
    hideChromeBeforeFirstFrame: true
  })
}
