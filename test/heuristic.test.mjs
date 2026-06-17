import { test } from 'node:test';
import assert from 'node:assert/strict';

// The function is exported from supervisor.ts but since it's TypeScript and tests
// run as ESM, we use a dynamic import trick. For now, replicate the pure function
// logic here (it has zero dependencies) to test the regex matching in isolation.
// The actual integration is tested via npm run eval.

/**
 * Replicated from opencode/supervisor.ts detectStoppedWithTodos for unit testing.
 */
function detectStoppedWithTodos(lastAssistantText) {
  if (!lastAssistantText || lastAssistantText.length < 50) return { detected: false }

  const headerPattern = /^#{1,3}\s*(Next\s+Steps?|Remaining\s+(Tasks?|Work|Items?)|TODO|Still\s+TODO|What(?:'s|\s+is)\s+(?:Left|Remaining|Next)|Outstanding\s+(?:Tasks?|Work|Items?))/im
  const headerMatch = lastAssistantText.match(headerPattern)
  if (!headerMatch) return { detected: false }

  const headerIdx = headerMatch.index
  const afterHeader = lastAssistantText.slice(headerIdx + headerMatch[0].length)

  const numberedItems = afterHeader.match(/\n\s*\d+\.\s+\S/g)
  const bulletItems = afterHeader.match(/\n\s*[-*]\s+\S/g)
  const itemCount = (numberedItems?.length || 0) + (bulletItems?.length || 0)

  if (itemCount < 2) return { detected: false }

  const textLength = lastAssistantText.length
  const positionRatio = headerIdx / textLength
  if (positionRatio < 0.4) return { detected: false }

  return { detected: true, header: headerMatch[1], itemCount }
}

// --- Test cases ---

test('detectStoppedWithTodos: classic "## Next Steps" with numbered items', () => {
  const text = `I've completed the initial setup and configured the database connection.

## Summary
- Set up PostgreSQL connection
- Created migration files
- Added seed data

## Next Steps
1. Run the migration against staging
2. Verify the seed data loaded correctly
3. Update the CI pipeline to include migration step
4. Write integration tests for the new endpoints
5. Create PR with all changes`

  const result = detectStoppedWithTodos(text)
  assert.equal(result.detected, true)
  assert.equal(result.header, 'Next Steps')
  assert.equal(result.itemCount, 5)
})

test('detectStoppedWithTodos: "## Remaining Tasks" with bullet items', () => {
  const text = `Here's what I accomplished in this session. I fixed the auth middleware and added rate limiting. The middleware now properly validates JWT tokens on every request and rejects expired sessions with a 401 status code. I also added sliding-window rate limiting using Redis, configured at 100 requests per minute per user with a 429 response and Retry-After header when exceeded. All existing tests continue to pass after these changes.

## Remaining Tasks
- Deploy the updated middleware to staging
- Run load tests to validate rate limits
- Update documentation with new rate limit headers
- Notify the frontend team about the new response headers`

  const result = detectStoppedWithTodos(text)
  assert.equal(result.detected, true)
  assert.equal(result.header, 'Remaining Tasks')
  assert.equal(result.itemCount, 4)
})

test('detectStoppedWithTodos: returns false when no header present', () => {
  const text = `I've completed the implementation. All tests pass and the PR is ready for review.

The changes include:
1. Added the new API endpoint
2. Updated the schema
3. Added comprehensive tests

Everything is working as expected.`

  const result = detectStoppedWithTodos(text)
  assert.equal(result.detected, false)
})

test('detectStoppedWithTodos: returns false when header is in first 40% (progress report)', () => {
  // Header at position 10 out of ~500 chars = 2% position ratio
  const text = `## Next Steps
1. Run tests
2. Deploy
3. Validate

But first, let me explain what I already did. I refactored the entire authentication system to use JWT tokens instead of sessions. The migration was complex because we had to maintain backward compatibility with existing sessions while gradually transitioning users to the new token-based approach. I also updated all the middleware components and added proper error handling throughout the authentication flow. The rate limiting was implemented using a sliding window algorithm that properly handles distributed deployments.`

  const result = detectStoppedWithTodos(text)
  assert.equal(result.detected, false)
})

test('detectStoppedWithTodos: returns false when fewer than 2 items', () => {
  const text = `I've done most of the work. Here's a summary of what was accomplished and what remains.

## Next Steps
1. Just run the final test`

  const result = detectStoppedWithTodos(text)
  assert.equal(result.detected, false)
})

test('detectStoppedWithTodos: returns false for empty/short text', () => {
  assert.equal(detectStoppedWithTodos('').detected, false)
  assert.equal(detectStoppedWithTodos('short').detected, false)
  assert.equal(detectStoppedWithTodos(null).detected, false)
  assert.equal(detectStoppedWithTodos(undefined).detected, false)
})

test('detectStoppedWithTodos: handles "### Still TODO" variant', () => {
  const text = `Session progress has been good. I managed to set up the CI pipeline and configure the deployment scripts. The Docker images are building correctly now.

### Still TODO
1. Add health check endpoints
2. Configure alerting rules
3. Set up log aggregation`

  const result = detectStoppedWithTodos(text)
  assert.equal(result.detected, true)
  assert.equal(result.header, 'Still TODO')
  assert.equal(result.itemCount, 3)
})

test('detectStoppedWithTodos: handles "## Outstanding Work" variant', () => {
  const text = `The refactoring is progressing well. Core modules have been updated to the new pattern. Type safety is much improved.

## Outstanding Work
- Migrate the legacy API handlers
- Update the test fixtures
- Run the full regression suite`

  const result = detectStoppedWithTodos(text)
  assert.equal(result.detected, true)
  assert.equal(result.header, 'Outstanding Work')
  assert.equal(result.itemCount, 3)
})

test('detectStoppedWithTodos: real dataset example (ses_12bf76354ffe)', () => {
  // Modeled after actual antipattern from the dataset
  const text = `## Session Summary

### Done
- Investigated CI failure on main branch caused by commit da3fdad16e113f43d244bca5d37b73ea6f97db4c
- Identified that the commit changed the model routing table in litellm/config.yaml from gpt-4o to gpt-5.4 without updating the integration test fixtures which still assert on the old model name string
- Analyzed test output — 3 integration tests failing: test_model_routing, test_fallback_chain, test_provider_selection
- Verified the failure is deterministic (not flaky) by re-running CI three times with identical red results
- Checked git blame and found the commit was part of a larger provider-migration PR that was merged without running the full test suite

### In Progress
- None (blocked on decision below — need to decide between fix-forward and revert)

## Next Steps
1. Look at commit da3fdad16e113f43d244bca5d37b73ea6f97db4c to understand what changed
2. Check CI logs / test output to identify which tests are failing
3. Determine if CI failure is real regression or flaky infra
4. Fix-forward with PR or revert da3fdad if it truly broke main
5. Find where gpt-5.4 model is referenced and update
6. Validate fixes properly before shipping`

  const result = detectStoppedWithTodos(text)
  assert.equal(result.detected, true)
  assert.equal(result.header, 'Next Steps')
  assert.equal(result.itemCount, 6)
})
