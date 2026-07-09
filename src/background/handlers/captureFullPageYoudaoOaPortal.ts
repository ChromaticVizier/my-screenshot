import { handleCaptureFullPageAggressive } from "~src/background/handlers/captureFullPageAggressive"
import type { FullPageRouting } from "~src/background/handlers/fullPageShared"
import type {
  CaptureFullPageRequest,
  CaptureResponse
} from "~src/shared/messages"
import type { SiteScrollRegionRule } from "~src/shared/settings"

export async function handleCaptureFullPageYoudaoOaPortal(
  request: CaptureFullPageRequest,
  routing?: FullPageRouting
): Promise<CaptureResponse> {
  const siteRule: SiteScrollRegionRule = {
    selector: ".homepage",
    hostname: "oa.corp.youdao.com",
    createdAt: Date.now(),
    label: "youdao oa portal homepage scroller"
  }

  return handleCaptureFullPageAggressive(request, {
    ...routing,
    siteRuleOverride: siteRule,
    skipFrameChromeHiding: true
  })
}
