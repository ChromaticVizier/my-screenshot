## ADDED Requirements

### Requirement: Manual scroll region selection
The system SHALL allow a user to select one native scrollable region on the active page for use by full-page capture.

#### Scenario: User selects a scrollable region
- **WHEN** the user starts scroll-region selection and clicks a highlighted scrollable region
- **THEN** the system records that region as the selected scroll target for the current domain

#### Scenario: User cancels selection
- **WHEN** the user presses Escape or clicks the cancel control while selection is active
- **THEN** the system SHALL exit selection mode without changing the saved region

### Requirement: Domain-level persistence
The system SHALL remember the selected scroll region per hostname and reuse it for future captures on that hostname.

#### Scenario: Saved region exists and matches
- **WHEN** full-page capture starts on a hostname with a saved scroll-region selector that matches a visible scrollable element
- **THEN** the system SHALL use that element as the scroll target before automatic detection

#### Scenario: Saved region is stale
- **WHEN** full-page capture starts and the saved selector does not match a visible scrollable element
- **THEN** the system SHALL fall back to automatic scroll-container detection

### Requirement: Clear saved scroll region
The system SHALL allow the user to clear the saved scroll region for the current hostname.

#### Scenario: User clears saved region
- **WHEN** the user triggers clear scroll-region for the current hostname
- **THEN** the system SHALL remove the domain rule and future captures SHALL use automatic detection unless a new region is selected

### Requirement: Selection overlay safety
The selection overlay SHALL be removed before returning a successful or cancelled result.

#### Scenario: Selection finishes
- **WHEN** selection resolves successfully or is cancelled
- **THEN** no picker overlay DOM SHALL remain on the page
