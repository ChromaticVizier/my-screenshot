## 1. Data Model and Messaging

- [x] 1.1 Add domain scroll-region types and default storage fields to `src/shared/settings.ts`
- [x] 1.2 Add message types and payload/response types for selecting and clearing current-site scroll regions
- [x] 1.3 Add popup service wrappers for selection and clearing actions

## 2. Selection Overlay

- [x] 2.1 Create self-contained injected picker that scans native scrollable elements
- [x] 2.2 Render overlay/highlight/cancel UI and resolve selected element metadata
- [x] 2.3 Generate a reusable CSS selector for the selected element
- [x] 2.4 Ensure overlay cleanup on success, cancel, and error

## 3. Background Integration

- [x] 3.1 Add background handlers for select and clear scroll-region messages
- [x] 3.2 Persist selected region by active tab hostname
- [x] 3.3 Pass current hostname saved rule into full-page capture preparation

## 4. Capture Integration

- [x] 4.1 Update `preparePage` to prefer a saved selector before automatic scoring
- [x] 4.2 Validate saved selector matches a visible native scrollable element
- [x] 4.3 Fall back to automatic detection if saved selector is stale

## 5. UI and Verification

- [x] 5.1 Add popup buttons for selecting and clearing the current-site scroll region
- [x] 5.2 Show basic success/cancel/error state for selection actions
- [x] 5.3 Build and test on a multi-pane page and a window-scrolling page
