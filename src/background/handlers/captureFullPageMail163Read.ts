import { handleCaptureFullPageAggressive } from "~src/background/handlers/captureFullPageAggressive"
import type { FullPageRouting } from "~src/background/handlers/fullPageShared"
import type {
  CaptureFullPageRequest,
  CaptureResponse
} from "~src/shared/messages"
import type { SiteScrollRegionRule } from "~src/shared/settings"

export async function handleCaptureFullPageMail163Read(
  request: CaptureFullPageRequest,
  routing?: FullPageRouting
): Promise<CaptureResponse> {
  const siteRule: SiteScrollRegionRule = {
    selector: 'div.frame-main-cont-body.nui-scroll[id$="_ScrollDiv"]',
    hostname: "mail.163.com",
    createdAt: Date.now(),
    label: "163 mail read content scroller"
  }

  return handleCaptureFullPageAggressive(request, {
    ...routing,
    siteRuleOverride: siteRule
  })
}
