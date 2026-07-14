import { handleCaptureFullPageAggressive } from "~src/background/handlers/captureFullPageAggressive"
import {
  detectCanvasGrid,
  handleCaptureFullPageCanvasGrid
} from "~src/background/handlers/captureFullPageCanvasGrid"
import {
  hostnameFromUrl,
  type FullPageRouting
} from "~src/background/handlers/fullPageShared"
import { getCapturableActiveTab } from "~src/background/utils/tabHelper"
import type {
  CaptureFullPageRequest,
  CaptureResponse
} from "~src/shared/messages"
import { getSettings, type SiteScrollRegionRule } from "~src/shared/settings"

/**
 * 飞书云文档（*.feishu.cn/wiki|docx）特殊处理。
 *
 * 页面结构（devtools 实测）：
 *  - window 不滚，正文主滚动容器是 `.bear-web-x-container`（sh≈6600）。
 *  - 容器内嵌 Bitable / 看板，其工具栏 + 列头是 position:sticky，会吸附在容器视口
 *    顶部；逐帧保留式截图会让它每帧重复出现，拼接后形成横向遮挡带。
 *
 * 处理：强制隔离主滚动容器（isolateMainScroller）——隔离 scroller 祖先链外的兄弟
 * （去掉左侧目录/侧栏），并一次性隐藏容器内 fixed/sticky（去掉吸顶工具栏/列头），
 * 再逐帧裁切 scroller，接缝无重复遮挡。
 */
export async function handleCaptureFullPageFeishuDoc(
  request: CaptureFullPageRequest,
  routing?: FullPageRouting
): Promise<CaptureResponse> {
  const tabRes = await getCapturableActiveTab()
  const settings = await getSettings()
  const tab = tabRes.ok ? tabRes.tab : null
  const hostname = hostnameFromUrl(tab?.url) ?? ""

  // 多维表格（Bitable）：正文是虚拟化 canvas，无原生滚动容器，
  // 交给 canvas grid 专用流程（wheel 驱动 + 冻结列头裁切）。
  if (tab?.id) {
    const grid = await detectCanvasGrid(tab.id)
    if (grid) {
      return handleCaptureFullPageCanvasGrid(request, routing, grid)
    }
  }

  const manual = settings.siteScrollRegions[hostname]
  const siteRule: SiteScrollRegionRule = {
    selector: manual?.selector || ".bear-web-x-container",
    hostname,
    createdAt: Date.now(),
    label: "feishu doc main scroller"
  }

  return handleCaptureFullPageAggressive(request, {
    ...routing,
    siteRuleOverride: siteRule,
    isolateMainScroller: true,
    stitchEarlierFrameOnTop: true
  })
}
