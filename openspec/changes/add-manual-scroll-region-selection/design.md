## Context

Full-page capture currently relies on automatic scroll-container detection. The detector now handles many full-screen SPA and multi-pane layouts, but it remains heuristic and cannot always infer which scrollable pane the user intends to capture. Some pages expose several scrollable regions with similar geometry or misleading class names.

The extension already has page-injected helpers, popup actions, background routing, and `chrome.storage.sync` settings. Manual region selection should reuse these patterns: popup asks background to inject an overlay, the overlay returns plain serializable metadata, background stores it by domain, and full-page capture prefers the stored rule before automatic detection.

## Goals / Non-Goals

**Goals:**

- Let the user manually pick a scrollable region on the current page.
- Remember the chosen region by domain so future full-page captures on the same site use it automatically.
- Provide a way to clear the remembered region for the current domain.
- Keep automatic scroll-container scoring as fallback if no rule exists or the saved selector no longer matches.
- Avoid external dependencies and keep injected functions self-contained.

**Non-Goals:**

- Cross-origin iframe inner-region selection.
- Perfect selector generation for every possible DOM mutation.
- Multi-region stitching. This change stores one scroll target/capture target per domain.
- A full visual editor for site rules.

## Decisions

1. **Store site rules by hostname**

   Use `settings.siteScrollRegions[hostname]` rather than full URL. Hostname-level memory matches user expectations for apps whose routes change often, and keeps storage small.

   Alternative: full URL or path prefix. Rejected for first version because many SPA routes include volatile IDs and query strings.

2. **Save both selector and fallback metadata**

   The picker returns a generated CSS selector plus metadata (`tag`, `id`, `className`, `rect`, `scrollHeight`, `clientHeight`). Full-page capture first tries the selector; if it fails, it falls back to automatic detection.

   Alternative: store only an element index/path. Rejected because DOM index paths are brittle across page updates.

3. **Picker highlights native scroll containers**

   The overlay scans elements with `overflow-y: auto|scroll` and `scrollHeight > clientHeight`, ranks them similarly to automatic detection, and highlights hovered candidates. User click chooses the candidate under pointer.

   Alternative: allow any element. Rejected for first version because non-scrollable elements cannot drive `scrollTop` capture.

4. **Capture uses saved selector before scoring**

   `preparePage(rules, siteRule)` first tries `document.querySelector(siteRule.selector)`. It validates that the matched element is scrollable and visible before marking it as `data-my-screenshot-scroller="1"`. If invalid, auto detection continues.

5. **Popup controls start/clear selection**

   Add buttons in the capture panel: "选择滚动区域" and "清除滚动区域". Selection starts an injected overlay in the active tab. Clear removes the current hostname's saved rule.

## Risks / Trade-offs

- Saved selector becomes stale after site DOM changes → fallback to automatic detection and allow user to reselect.
- Generated selector may match multiple elements → prefer selector that includes id when available; otherwise use stable class path with `:nth-of-type` as needed.
- Overlay could be captured if user triggers screenshot while selecting → picker removes itself before resolving and selection is a separate action from capture.
- Hostname-level memory may be too broad for sites with different layouts per path → acceptable for first version; future settings can support path-scoped rules.
