<!-- forge:start -->
# Organization Standards (Forge Plugin)

## Coding Standards
- Use meaningful variable and function names
- Follow the project's existing naming conventions (camelCase, snake_case, etc.)
- Keep functions focused — one function, one responsibility
- Maximum file length: 500 lines (split if larger)

## Architecture Constraints
- Follow the project's established architecture patterns
- New dependencies require team lead approval
- No direct database access outside the data layer
- All external API calls must go through a service layer

## Security Requirements
- Validate all user input at system boundaries
- Never log sensitive data (tokens, passwords, PII)
- Use parameterized queries for database access
- Follow least-privilege principle for permissions

## Testing Requirements
- All new code must have tests
- Minimum coverage: 80% for new files
- Required test types: unit tests for business logic, integration tests for API endpoints
- Tests must be deterministic — no flaky tests

## Git Workflow
- Branch naming: `feature/`, `fix/`, `refactor/`, `docs/` prefixes
- Commit format: `type(scope): description` (e.g., `feat(auth): add login endpoint`)
- PR requirements: description, test plan, at least one reviewer
- Squash merge to main

## Forge Workflow
- Run `/forge-plugin:design` before implementing any non-trivial feature
- Design documents must be approved before coding begins
- Run `/forge-plugin:ship` before merging to verify checklist
- Use `/forge-plugin:learn` after completing work to capture insights
<!-- forge:end -->
