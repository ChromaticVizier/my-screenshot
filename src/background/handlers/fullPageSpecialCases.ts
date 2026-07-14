import { handleCaptureFullPageDingtalkDoc } from "~src/background/handlers/captureFullPageDingtalkDoc"
import { handleCaptureFullPageFeishuDoc } from "~src/background/handlers/captureFullPageFeishuDoc"
import { handleCaptureFullPageMail163Read } from "~src/background/handlers/captureFullPageMail163Read"
import { handleCaptureFullPagePopoDoc } from "~src/background/handlers/captureFullPagePopoDoc"
import { handleCaptureFullPageYoudaoOaPortal } from "~src/background/handlers/captureFullPageYoudaoOaPortal"
import type { FullPageRouting } from "~src/background/handlers/fullPageShared"
import type {
  CaptureFullPageRequest,
  CaptureResponse
} from "~src/shared/messages"
import type { FullPageExpert } from "~src/shared/settings"

import casesConfig from "./fullPageSpecialCases.json"

type UrlMatcher = string | RegExp | ((url: URL) => boolean)

type JsonSpecialCaseEntry = string | string[]

type JsonSpecialCaseConfig = Partial<
  Record<FullPageExpert, JsonSpecialCaseEntry[]>
>

export type FullPageSpecialCaseHandler = (
  request: CaptureFullPageRequest,
  routing?: FullPageRouting
) => Promise<CaptureResponse>

export interface FullPageSpecialCase {
  id: string
  label: string
  match: UrlMatcher | UrlMatcher[]
  handler: FullPageSpecialCaseHandler
}

const SPECIAL_CASE_HANDLERS: Partial<
  Record<FullPageExpert, Record<string, FullPageSpecialCaseHandler>>
> = {
  standard: {},
  isolate: {
    "feishu-doc": handleCaptureFullPageFeishuDoc,
    "popo-docs": handleCaptureFullPagePopoDoc,
    "youdao-oa-portal": handleCaptureFullPageYoudaoOaPortal
  },
  iframe: {
    "dingtalk-doc": handleCaptureFullPageDingtalkDoc,
    "mail-163-read": handleCaptureFullPageMail163Read
  },
  "spa-like": {},
  "embedded-doc": {},
  "legacy-frame": {},
  chat: {}
}

const SPECIAL_CASES = normalizeSpecialCases(
  casesConfig as JsonSpecialCaseConfig,
  SPECIAL_CASE_HANDLERS
)

export function matchFullPageSpecialCase(
  expert: FullPageExpert,
  pageUrl?: string
): FullPageSpecialCase | null {
  if (!pageUrl) return null

  let url: URL
  try {
    url = new URL(pageUrl)
  } catch {
    return null
  }

  return SPECIAL_CASES[expert].find((item) => matches(item.match, url)) ?? null
}

function normalizeSpecialCases(
  config: JsonSpecialCaseConfig,
  handlers: Partial<
    Record<FullPageExpert, Record<string, FullPageSpecialCaseHandler>>
  >
): Record<FullPageExpert, FullPageSpecialCase[]> {
  return {
    standard: normalizeExpertCases("standard", config, handlers),
    isolate: normalizeExpertCases("isolate", config, handlers),
    iframe: normalizeExpertCases("iframe", config, handlers),
    "spa-like": normalizeExpertCases("spa-like", config, handlers),
    "embedded-doc": normalizeExpertCases("embedded-doc", config, handlers),
    "legacy-frame": normalizeExpertCases("legacy-frame", config, handlers),
    chat: normalizeExpertCases("chat", config, handlers)
  }
}

function normalizeExpertCases(
  expert: FullPageExpert,
  config: JsonSpecialCaseConfig,
  handlers: Partial<
    Record<FullPageExpert, Record<string, FullPageSpecialCaseHandler>>
  >
): FullPageSpecialCase[] {
  return (config[expert] ?? [])
    .map((entry) => normalizeExpertCase(expert, entry, handlers))
    .filter((item): item is FullPageSpecialCase => item !== null)
}

function normalizeExpertCase(
  expert: FullPageExpert,
  entry: JsonSpecialCaseEntry,
  handlers: Partial<
    Record<FullPageExpert, Record<string, FullPageSpecialCaseHandler>>
  >
): FullPageSpecialCase | null {
  const list = Array.isArray(entry) ? entry : [entry]
  const id = list[0]
  if (!id) return null

  const handler = handlers[expert]?.[id]
  if (!handler) return null

  return {
    id,
    label: id,
    match: list,
    handler
  }
}

function matches(matchers: UrlMatcher | UrlMatcher[], url: URL): boolean {
  const list = Array.isArray(matchers) ? matchers : [matchers]
  return list.some((matcher) => matchesOne(matcher, url))
}

function matchesOne(matcher: UrlMatcher, url: URL): boolean {
  if (typeof matcher === "function") return matcher(url)
  if (matcher instanceof RegExp) return matcher.test(url.href)
  return matchString(matcher, url)
}

function matchString(pattern: string, url: URL): boolean {
  if (!pattern) return false
  if (pattern === url.href || pattern === url.hostname) return true

  const normalized = pattern.includes("://") ? pattern : `https://${pattern}`

  // 含通配符：直接对完整 href 做 glob。
  // 不能走 new URL() 再拆 host/path —— URL 解析会把 host 里的 `*` 编码成 `%2A`
  // （如 `*.feishu.cn` → `%2a.feishu.cn`），host 通配彻底失效；且 pathname 不含
  // hash，带 `#...` 的 pattern 也会漏配。glob 整个 href 同时覆盖 host / path / hash。
  if (pattern.includes("*")) {
    return (
      wildcardMatch(normalized, url.href) || wildcardMatch(pattern, url.href)
    )
  }

  try {
    const p = new URL(normalized)
    const sameHost = wildcardMatch(p.hostname, url.hostname)
    const samePath = wildcardMatch(p.pathname || "/", url.pathname)
    return sameHost && samePath
  } catch {
    return wildcardMatch(pattern, url.href)
  }
}

function wildcardMatch(pattern: string, value: string): boolean {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
  return new RegExp(`^${escaped}$`, "i").test(value)
}
