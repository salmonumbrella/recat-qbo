---
last_edited: 2026-09-01
---

# Task 7 report — classification-memory review UI

## Status

Complete locally on top of Task 6A commit `c87ca8a`. Rules now browses the
canonical durable lifecycle and searchable provenance, while Queue shows
transaction-aware similar decisions and offers recurring intent only after a
verified case is read back from the server. Every policy change uses the
Task 6A prepare/preview/commit envelope; the client no longer exports or calls
the retired one-call rule mutation helpers.

No provider, production database, Recat/QBO write, deployment, push, or PR was
used. The root PostgreSQL suite was discovered but skipped its 374 tests
because no disposable database URL was configured; the client-only Task 7
work and all relevant Task 6A unit route contracts passed.

## Implemented behavior

- Added exact, lexical, hybrid, and semantic knowledge search with explicit
  requested/effective mode, degradation reason, semantic configuration,
  backfill progress, no-match, and unavailable states.
- Bounded results at 20 hits, conflicts at 10 per hit, preview samples at 20,
  lifecycle pages at 100, and revision pages at 20.
- Displays company, match reason, category, tax treatment/code, rationale,
  evidence and conflict counts, conflict reasons, verification time,
  executable/advisory status, and source navigation. Linked rule sources are
  rehydrated by canonical detail even when outside the current lifecycle page;
  linked cases use the exact case adapter.
- Added transaction-aware `Similar Decisions` in Queue. Company and
  transaction context are supplied to the search adapter; executable context
  remains server-derived.
- Replaced inferred rule creation with explicit `Apply once` and
  `Make recurring suggestion` actions after a verified categorization. The
  recurring path reads the active current case, calls the governed from-case
  prepare endpoint, previews category/tax and truthful affected counts, and
  commits the same operation with the same stable user-intent idempotency key.
  The server-derived rule remains suggestion-only with `autoPost=false`.
- Replaced the active-only Rules screen with canonical signed-cursor lifecycle
  browsing for enabled, disabled, retired, and all states. Historical invalid
  actions remain visible and advisory rather than being coerced into policy.
- Added rule testing, enable/disable, retirement, complete-set reordering,
  candidate activation/dismissal, review-required state, invalid-reference
  reasons, and bounded revision history.
- Added a standalone auto-post operation. Enabling it submits only
  `{autoPost:true}`, then requires a dedicated preview showing uncapped server
  pending/posted counts, bounded samples, conflicts, and warnings before
  commit.
- Preserved holding-account exclusions and stale/conflicting candidate safety.
  Every mutation keeps the prepare idempotency key through commit and ignores
  late results after a company switch.

## Strict TDD evidence

### Search and provenance panel

RED: `npm test -w client -- ClassificationMemoryPanel.test.tsx` failed during
collection because `ClassificationMemoryPanel.tsx` did not exist.

GREEN: 3/3 initial provenance/degradation/state tests passed. A later
company-switch regression was first RED (the second company never searched
while the first request was in flight), then GREEN after context changes began
invalidating requests and clearing stale state: 4/4.

### Queue similar decisions and recurring intent

RED: two focused `Queue.tax.test.tsx` cases failed because Queue had neither
transaction-aware Similar Decisions nor distinct recurring-intent controls.

GREEN: both focused cases passed, then the complete Queue tax boundary stayed
green at 68/68. Tests prove the transaction ID reaches search, ordinary
categorization does not prepare a rule, the verified current case is required,
from-case prepare forces review, preview counts are rendered, and the same
idempotency key commits the prepared operation.

### Canonical lifecycle and two-phase rule changes

RED: `npm test -w client -- Rules.candidates.test.tsx Rules.tax.test.tsx`
failed 12/12 because legacy Rules called the removed `rules.list` mock and had
no lifecycle browser or operation previews.

GREEN: the focused Rules files initially passed 12/12. Added lifecycle
coverage then reached 15 candidate tests plus the tax test. A fresh reorder
test was RED because the client sent forbidden `ruleId`; GREEN removed that
selector and uses the highest revision among every rule whose priority changes.
A fresh source-navigation test was RED until canonical detail rehydration was
implemented for records outside the visible page.

Final focused Task 7 command:

```text
npm test -w client -- Rules.candidates.test.tsx ClassificationMemoryPanel.test.tsx Queue.tax.test.tsx Rules.tax.test.tsx
4 files passed, 88 tests passed
```

## UX and accessibility choices

- Search input and both mode/lifecycle selectors have explicit accessible
  labels; search progress, loading, no-match, previews, and failures use
  status/alert semantics.
- Recurring intent uses two separately named buttons. `Apply once` dismisses
  the prompt; it never creates policy. Destructive retirement/dismissal uses a
  danger confirmation, while other prepared changes use a primary confirmation.
- Every rule/candidate action has a stable, descriptive accessible name that
  includes the relevant match text. Disabled ordering controls communicate
  list boundaries without issuing requests.
- Advisory, executable, enabled, disabled, and retired states are text labels,
  not color-only signals. Conflicts, warnings, invalid references, and review
  requirements remain visible as text.
- Rendering and navigation are bounded. Disabled/retired rules remain
  rediscoverable through lifecycle filters and signed-cursor pagination.

## Changed files

- `client/src/lib/api.ts`
- `client/src/components/ClassificationMemoryPanel.tsx`
- `client/src/components/ClassificationMemoryPanel.test.tsx`
- `client/src/pages/Queue.tsx`
- `client/src/pages/Queue.tax.test.tsx`
- `client/src/pages/Rules.tsx`
- `client/src/pages/Rules.candidates.test.tsx`
- `client/src/pages/Rules.tax.test.tsx`
- this report

## Verification

- Focused Task 7: 4 files, 88 tests passed.
- Full client: 22 files, 221 tests passed.
- Task 6A route contracts: 4 files, 24 tests passed.
- Root unit suite: 133 files, 2,241 tests passed.
- Root PostgreSQL discovery: 37 files / 374 tests skipped because no test
  database URL was configured.
- Shared build, client production build, and root shared/server/client
  typecheck passed.
- `git diff --check` passed.
- Queue churn audit reduced the implementation diff from +175/-42 to +155/-44
  by consolidating verified-case reads, removing unused prompt fields, and
  using a shared button style. The Rules rewrite reduced the production file
  from 857 removed lines to 460 added lines while adding durable lifecycle
  scope.

## Concerns

- PostgreSQL behavior was not rerun against a disposable database in this
  client-only task; Task 6A's approved PostgreSQL evidence remains authoritative.
- Root tests emit pre-existing expected stderr from failure fixtures and React
  Router future warnings; the command exited successfully.
