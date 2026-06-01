## Why

Automatic scroll-container detection is heuristic and cannot reliably infer user intent on every site, especially multi-pane apps, document viewers, and pages with several scrollable regions. Users need a deterministic fallback to choose the desired scroll region once and have the extension remember it for that domain.

## What Changes

- Add a manual scroll-region picker that overlays the current page, highlights scrollable candidate elements, and lets the user click the desired region.
- Persist the selected scroll region per domain in extension settings.
- Prefer the saved domain rule during full-page capture before automatic scroll-container scoring.
- Allow users to clear or replace the saved region for the current domain.
- Keep automatic detection as fallback when no saved selector exists or the saved selector no longer matches.

## Capabilities

### New Capabilities
- `manual-scroll-region-selection`: Users can manually select and remember a scrollable region for full-page capture on a per-domain basis.

### Modified Capabilities

## Impact

- `src/shared/settings.ts`: add per-domain scroll-region rule storage.
- `src/shared/messages.ts` / popup service layer: add messages for starting selection and clearing site rule.
- `src/background/handlers/capture.ts`: route selection requests and pass saved site rule into full-page preparation.
- `src/background/injected/fullPage.ts`: prefer saved selector when detecting the main scroll container.
- New/updated injected picker code: render overlay, highlight scrollable candidates, return selector metadata.
- Popup UI: add controls to choose or clear the scroll region for the current site.
