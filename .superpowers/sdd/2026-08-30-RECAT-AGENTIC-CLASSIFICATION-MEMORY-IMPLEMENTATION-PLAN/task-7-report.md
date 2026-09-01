---
last_edited: 2026-09-01
---

# Task 7 report — classification-memory review UI

## Status

Complete locally, including independent-review fix round 1, on top of original
Task 7 commit `da07032`. Rules now browses the
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

- Added auto, exact, lexical, hybrid, and semantic knowledge search with explicit
  requested/effective mode, degradation reason, semantic configuration,
  backfill progress, no-match, and unavailable states.
- Bounded search pages at 20 and rendered search results at 100, conflicts at
  10 per hit, preview samples at 20,
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
- Confirmation dialogs use a labelled `role=dialog`, `aria-modal`, initial
  focus, a focus trap, and opener-focus restoration. Escape, backdrop, and
  Cancel cannot dismiss an in-flight commit.

## Changed files

- `client/src/lib/api.ts`
- `client/src/components/ClassificationMemoryPanel.tsx`
- `client/src/components/ClassificationMemoryPanel.test.tsx`
- `client/src/components/ConfirmDialog.tsx`
- `client/src/components/ConfirmDialog.test.tsx`
- `client/src/pages/Queue.tsx`
- `client/src/pages/Queue.tax.test.tsx`
- `client/src/pages/Rules.tsx`
- `client/src/pages/Rules.candidates.test.tsx`
- `client/src/pages/Rules.tax.test.tsx`
- this report

## Verification

- Focused Task 7: 5 files, 100 tests passed.
- Full client: 23 files, 233 tests passed.
- Task 6A route contracts: 4 files, 23 tests passed.
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

## Independent review fix round 1

### Search mode, navigation, and bounded pagination

RED: the new search regressions first exposed four failures: the panel still
defaulted to strict hybrid, auto fallback was represented with an impossible
requested mode, no Load more path existed, and vendor identities received a
false Rules link.

GREEN: the panel now defaults to server-supported `auto`. Only auto may report
lexical degradation; explicit hybrid rejection remains an unavailable alert.
Load more reuses the exact company/query/mode/transaction context and signed
cursor, deduplicates by hit ID, renders at most 100 hits, and fences late work
on query, mode, company, transaction, or unmount changes. Changing query or
mode also clears the old page and cursor. Links exist only for canonical case,
rule, and candidate sources. Focused panel tests pass 7/7.

### Complete ordering, lifecycle recovery, and operation intent

RED: seven focused Rules cases failed against the review findings: a 101-rule
enabled set was truncated to the visible all-state page, old-company pages
could race the snapshot, committed deep links stayed actionable, initial
collection failures disappeared into toasts, prepare double-clicks minted two
intents, and revision history omitted its action/provenance/validity context.

GREEN: reorder stays disabled until every signed enabled page is drained with
a 20-page/2,000-rule fail-closed ceiling, cursor-repeat detection, deduplication,
and company/request fencing. The exact complete order is prepared. Successful
retire/activate/dismiss commits clear deep-link overlays and reload lifecycle,
ordering, and candidates. Rules and candidates expose independent persistent
alerts and retries. One user intent keeps one idempotency key through prepare
transport failure and retry, while synchronous busy guards reject repeated
clicks. History now shows nullable legacy action, category/tax/tags/priority/
auto-post, lifecycle changes, source case/candidate, actor, origin intent, and
validity reasons. Focused Rules tests pass 22/22 plus Rules tax 1/1.

### Modal safety and recurring commit

RED: dedicated dialog tests could not find an accessible dialog and proved
Cancel remained active while busy; Queue's page-level Escape handler could
also erase an in-flight recurring commit.

GREEN: `ConfirmDialog` now has modal/name semantics, initial focus, a bounded
focus trap, and focus restoration. Both the component and Queue page ignore
Escape/backdrop/Cancel while commit is in flight. The recurring operation
remains visible until its authoritative commit resolves. Dialog tests pass
2/2 and the full Queue tax boundary passes 68/68. Queue production churn for
this fix is only two guarded lines (+2/-2).

### Fix-round verification

```text
Focused Task 7: 5 files, 100/100
Full client: 23 files, 233/233
Task 6A HTTP contracts: 4 files, 23/23
Server unit: 133 files, 2,241/2,241
Package-script contract: 1/1
Root shared/server/client typecheck: passed
Root shared/server/client production build: passed (Vite 84 modules)
git diff --check: passed
```

No PostgreSQL suite was rerun because no disposable test database URL was
provided. The approved Task 6A PostgreSQL evidence remains authoritative; this
fix round changed only client files and this report.

## Independent review fix round 2

### Bounded, truthful revision history

RED: the focused history regressions exposed four failures. The UI still
requested 20 revisions and offered to append hidden pages, treated the oldest
row on a partial page as the initial revision, and missed material changes to
canonical QBO identifiers, tax calculation, tag order, validity, and
provenance.

GREEN: history now makes one request for the newest 100 revisions and never
drains or retains an invisible older page. A signed `nextCursor` produces a
visible `Showing 100 newest revisions; older history exists` status, no Load
more control, and an explicit unavailable/truncated comparison on the oldest
visible row. `Initial recorded revision` appears only when the canonical page
proves there is no older cursor. Summaries compare category name and QBO ID,
tax calculation, tax-code name and QBO ID, ordered tag IDs, priority,
auto-post, lifecycle state/retirement, validity and reasons, origin intent,
source case/candidate, and actor. Legacy null actions remain visibly advisory.

### Bounded lifecycle and candidate collections

RED: lifecycle and candidate pagination grew retained state and the DOM without
an explicit ceiling. Dedicated over-cap tests failed because a third lifecycle
page and sixth candidate page remained reachable with no truncation message.

GREEN: visible lifecycle results retain at most 200 deduplicated rules and
candidate review retains at most 100 deduplicated candidates. Reaching either
cap removes Load more, shows a truthful accessible truncation status, and
guards against any later request. Company-switch request fencing prevents old
pages from entering either collection. The separate non-rendered enabled-rule
drain for exact reordering remains unchanged, signed-cursor fenced, and
fail-closed at its existing 2,000-rule ceiling.

### Fix-round-2 verification

```text
Focused history regressions: 5/5
Focused collection cap/fencing regressions: 3/3
Rules candidate/lifecycle/history file: 28/28
Focused Task 7: 5 files, 106/106
Full client: 23 files, 239/239
Task 6A HTTP contracts: 4 files, 23/23
Server unit: 133 files, 2,241/2,241
Package-script contract: 1/1
Root shared/server/client typecheck: passed
Root shared/server/client production build: passed (Vite 84 modules)
git diff --check: passed
```

This round changes only `Rules.tsx`, its candidate/lifecycle/history test, and
this report. No PostgreSQL suite was rerun because the client-only change has no
database path and no disposable test database URL was provided.

## Concerns

- PostgreSQL behavior was not rerun against a disposable database in this
  client-only task; Task 6A's approved PostgreSQL evidence remains authoritative.
- Root tests emit pre-existing expected stderr from failure fixtures and React
  Router future warnings; the command exited successfully.
