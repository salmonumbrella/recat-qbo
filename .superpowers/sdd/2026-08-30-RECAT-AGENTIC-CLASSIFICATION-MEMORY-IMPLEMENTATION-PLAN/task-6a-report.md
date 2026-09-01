---
last_edited: 2026-08-31
---

# Task 6A report — session-auth REST adapters for classification memory

## Status

Complete locally through independent review fix round 6, on top of integrated
commit `6244b40`. Browser rule operations now use
the same immutable, company-scoped, two-phase lifecycle as MCP with a real
session principal. Classification and canonical rule reads are available to
the browser without adding a policy store, fake MCP token, or one-call write.

No external provider, production database, QBO, deployment, push, or PR was
used. Verification used an isolated disposable PostgreSQL 16 + pgvector
container on localhost. Fix-round-5 verification used PostgreSQL 16 on port
55434; credential-bearing connection strings are not retained.

Commands below use `TASK6A_DATABASE_URL` and `TASK6A_SHADOW_DATABASE_URL` for
the disposable local test and shadow database URLs. Credential-bearing URLs
are intentionally not retained in this report.

## Implemented behavior

- Generalized `McpRuleOperation` additively with an `authKind` discriminator,
  nullable MCP token attribution, nullable session attribution, exact-one-kind
  database enforcement, session-scoped idempotency, and immutable session
  provenance. There is intentionally no `Session` foreign key.
- Preserved old MCP writers through the default `authKind='mcp'`, preserved
  existing MCP rows, and accepts the legacy pre-migration MCP integrity hash.
- Added a discriminated `RuleOperationPrincipal` (`mcp` or `session`) and a
  neutral `prepareRuleChange` / `commitRuleChange` core. Existing MCP exports
  are compatibility wrappers over that same core.
- Revalidates and locks the exact session/token, user, actual company
  membership, role, company connection, company mutation scope, and operation
  at both prepare and commit. Another browser session for the same user cannot
  use the envelope. Instance-admin status does not substitute for an actual
  membership for these browser policy writes.
- Bound session operation integrity, ownership, idempotency, retry lineage,
  expiry, resource, revision, proposed snapshot, and canonical receipt to the
  same immutable envelope. Session attribution survives logout/cleanup.
- Added strict browser-origin enforcement for rule preparation and commit.
  The safe session ID is attached to Express requests; cookie material and the
  stored token hash are never exposed to the operation service.
- Added session-auth classification search, exact case detail, and current
  active/non-invalidated verified case reads. Optional transaction context is
  derived from a company-owned transaction, including direction, supported
  QBO type, account name, currency, period, and transaction revision; the
  browser cannot submit executable QBO context.
- Added canonical rule detail and signed-cursor revision history. Historical
  legacy actions remain readable as non-executable with `action: null` and
  bounded reasons rather than being coerced into executable policy.
- Added shared browser contracts for canonical rule detail, lifecycle state,
  nullable historical revision actions, and revision pages.
- Added strict two-phase REST prepare/commit routes supporting update, enable,
  disable, reorder, retire, candidate activation/dismissal, and standalone
  `autoPost` elevation. The route company is authoritative; strict schemas
  reject body company IDs and generic create.
- Added specialized make-recurring preparation from an active verified case.
  The server derives action/provenance, forces `autoPost=false`, and the shared
  core revalidates the source case at commit.
- Changed the legacy rule create/patch/delete/order and candidate
  activate/dismiss endpoints to the stable `RULE_OPERATION_REQUIRED` response.
  Safe reads remain available for disconnected companies; every rule prepare
  and commit requires a connected company.

## Strict TDD evidence

### 1. Real session principal in the immutable envelope

Production break named: the Task 6 envelope required MCP token fields, so a
browser session could only write by manufacturing fake token provenance.

RED:

```bash
npm run test:server:unit -- services/mcp/rules.test.ts
```

Exit 1. The new session-principal preparation test failed with `Invalid MCP
operation input.` because token ID/prefix were mandatory and there was no
session-scoped operation ownership.

GREEN:

```bash
npm run test:server:unit -- services/mcp/rules.test.ts
```

Exit 0: 1 file, 4 tests passed. The prepared record has `authKind=session`, an
exact session ID, null token fields, a session-bound integrity hash, and no MCP
compatibility regression.

### 2. Session authority, ownership, and immutable attribution in PostgreSQL

Production break named: route-time cookie authentication alone does not prove
that the preparing session, user, membership, role, or company authority is
still live at commit.

RED:

```bash
DATABASE_URL="$TASK6A_DATABASE_URL" \
TEST_DATABASE_URL="$TASK6A_DATABASE_URL" \
npm run test:server:pg -- services/ruleChanges.pg.test.ts
```

Exit 1 before the dual-principal persistence/core existed. The browser
envelope could not be persisted or loaded by session ownership.

GREEN after the first implementation:

```bash
DATABASE_URL="$TASK6A_DATABASE_URL" \
TEST_DATABASE_URL="$TASK6A_DATABASE_URL" \
npm run test:server:pg -- services/ruleChanges.pg.test.ts
```

Exit 0: initially 3/3. It proves cross-session commit rejection, canonical
commit/readback, logout rejection, role-drift rejection with no rule write,
and immutable attribution after the source session is deleted.

A final security self-review found that the generic instance-admin shortcut
did not satisfy Task 6A's explicit actual-membership requirement.

Fresh RED:

```bash
cd server
DATABASE_URL="$TASK6A_DATABASE_URL" \
TEST_DATABASE_URL="$TASK6A_DATABASE_URL" \
npx vitest run --config vitest.pg.config.ts \
  src/services/ruleChanges.pg.test.ts \
  -t 'requires an actual current company membership'
```

Exit 1: the promise resolved to a PREPARED operation instead of rejecting and
the failure printed the prepared envelope.

GREEN after requiring a live categorizer/admin membership for every session
principal:

```bash
cd server
DATABASE_URL="$TASK6A_DATABASE_URL" \
TEST_DATABASE_URL="$TASK6A_DATABASE_URL" \
npx vitest run --config vitest.pg.config.ts \
  src/services/ruleChanges.pg.test.ts \
  -t 'requires an actual current company membership'
```

Exit 0: 1 passed, 3 skipped. The complete focused file later passed 4/4.

### 3. Session-auth classification reads

Production break named: browser clients had no company-scoped adapter for
classification search, canonical case detail, or current verified case state.

RED:

```bash
npm run test:server:unit -- routes/classification.test.ts
```

Exit 1 during collection: `Cannot find module './classification.js'`.

GREEN:

```bash
npm run test:server:unit -- routes/classification.test.ts
```

Exit 0: 2/2. Tests cover server-derived transaction context routing,
company/user scope, disconnected read availability, exact case detail, and the
current verified-case adapter. Existing classification search PostgreSQL
coverage remained green, including tenant fences, cursor population binding,
health/backfill/degraded mode, and the complete embedding corpus.

### 4. Browser two-phase mutation and governed make-recurring

Production break named: browser REST could mutate policy in one request and
had no way to use Task 6 preparation, preview, hash, retry, or commit receipts.

RED:

```bash
npm run test:server:unit -- routes/ruleOperations.test.ts
```

Exit 1 during collection: `Cannot find module './ruleOperations.js'`.

GREEN:

```bash
npm run test:server:unit -- routes/ruleOperations.test.ts
```

Exit 0: 3/3. Tests prove exact session and route-company binding at both
phases, required allowed Origin, rejection of generic create, and the
specialized server-derived case preparation.

Task 6's real PostgreSQL lifecycle tests remain the behavior authority for
concurrent prepare/commit, replay, expiry and retry, candidate reconciliation,
source-case invalidation, truthful uncapped pending/posted counts with bounded
samples, standalone `autoPost`, legacy disable/retire/dismiss, canonical
revision/audit/readback, and reconciliation liveness. They passed 17/17.

### 5. Canonical rule detail/history and legacy safety

Production break named: browser rule reads lacked current lifecycle revision
state and signed-cursor history, and legacy nullable actions could be mistaken
for executable current policy.

RED:

```bash
npm run test:server:unit -- routes/rules.test.ts
```

Exit 1: five focused route expectations failed before canonical detail/history
and governed-write routing existed.

GREEN:

```bash
npm run test:server:unit -- routes/rules.test.ts
```

Exit 0: 5/5. Company-read tests also stayed green at 39/39, including current
reference readiness and non-executable legacy historical readback.

### 6. Close the legacy one-call policy-write bypass

Production break named: old REST create/update/order/retire and candidate
activate/dismiss endpoints bypassed the two-phase envelope.

RED:

```bash
npm run test:server:unit -- routes/rules.test.ts routes/ruleCandidates.test.ts
```

Exit 1: legacy endpoints returned success instead of
`RULE_OPERATION_REQUIRED`; candidate activate/dismiss still performed direct
writes.

GREEN:

```bash
npm run test:server:unit -- routes/rules.test.ts routes/ruleCandidates.test.ts
```

Exit 0: 2 files, 9 tests passed. Superseded history/retirement route fixtures
were reduced to assert the migration response and absence of writes; no client
code was changed.

### 7. Strict browser-origin enforcement

Production break named: the global origin middleware intentionally accepts an
absent Origin for curl compatibility, which is too permissive for new
cookie-authenticated policy mutations.

RED:

```bash
npm run test:server:unit -- middleware/originCheck.test.ts
```

Exit 1 because `requireBrowserMutationOrigin` did not exist.

GREEN:

```bash
npm run test:server:unit -- middleware/originCheck.test.ts
```

Exit 0: 9/9. New mutation routes reject absent, malformed, and unapproved
origins while the existing global middleware remains curl compatible.

## Independent review fix round 1

### Bidirectional rolling MCP compatibility

Production break named: Task 6A initially emitted a discriminator-aware MCP
`inputHash`; a base `149749d` committer only knows the legacy token-bound hash
and would reject that new preparation as corrupt during rolling deployment.

RED:

```bash
npm run test:server:unit -- services/mcp/rules.test.ts
```

Exit 1: 1 failed, 4 passed. The executable validator copied from base computed
`8de937...`, while the new writer emitted `741da9...`.

GREEN:

```bash
npm run test:server:unit -- services/mcp/rules.test.ts
```

Exit 0: 5/5. MCP writers now continue emitting the exact legacy hash until old
instances drain; session rows use the discriminator-aware hash. New readers
accept legacy MCP rows and the discriminator-aware MCP rows emitted by the
initial Task 6A build. The test executes the complete base integrity decision,
not a source-text assertion.

### Viewer canonical rule detail and history

Production break named: a router-wide categorizer gate and duplicate service
gate prevented viewers from reading lifecycle state and history even though
these are company-scoped read models.

RED:

```bash
npm run test:server:unit -- routes/rules.test.ts services/companyReads.test.ts
```

Exit 1: the disconnected viewer route returned 403 instead of 200, and both
viewer detail tests failed at the service categorizer gate. A separate focused
history RED returned `FORBIDDEN` instead of an empty bounded history page.

The first route split still loaded a guessed company before the membership
gate. A tenant-oracle RED proved a missing guessed company returned 404 while
an existing inaccessible company returned 403. The route now checks membership
before loading the disconnected-readable company, so both guesses fail with
the same 403 response.

GREEN:

```bash
npm run test:server:unit -- routes/rules.test.ts services/companyReads.test.ts
```

Exit 0: 48/48 after the final history and tenant-oracle cases. Detail/history now require viewer;
list, test, and every legacy write migration response remain categorizer-only.
Tenant IDs remain in the canonical queries, foreign rule IDs return scoped
404, and disconnected-company reads remain available.

### Stable REST operation-envelope errors

Production break named: `McpOperationError` thrown by operation create/load
bypassed `RuleChangeError` mapping and reached the generic HTTP 500 adapter.

RED:

```bash
npm run test:server:unit -- routes/ruleOperations.test.ts
```

Exit 1: four authored cases returned 500 rather than 400/404/409.

GREEN:

```bash
npm run test:server:unit -- routes/ruleOperations.test.ts
```

Exit 0: 8/8. `OPERATION_INVALID_INPUT` maps to 400 `INVALID_INPUT`,
`OPERATION_NOT_FOUND` to 404 `NOT_FOUND`, idempotency conflict to 409
`IDEMPOTENCY_CONFLICT`, and concurrent store conflict to 409 `CONFLICT`.
Focused HTTP cases cover wrong-session commit lookup and an oversized nested
proposal without leaking an unhandled error.

### Exact auto-post final-winner impact

Production break named: standalone auto-post preview counted every substring
match, including transactions won by a higher-priority enabled rule.

RED:

```bash
cd server
DATABASE_URL="$TASK6A_DATABASE_URL" TEST_DATABASE_URL="$TASK6A_DATABASE_URL" \
npx vitest run --config vitest.pg.config.ts \
  src/services/mcp/rules.pg.test.ts -t 'makes false-to-true autoPost'
```

Exit 1: preview returned two affected pending rows; only one was won by the
target rule after considering a higher-priority Vancouver rule and a
lower-priority Victoria rule.

GREEN with the same command: 1/1 passed. Counts now use an uncapped PostgreSQL
winner predicate over the target's final condition and priority, excluding any
matching enabled/nonretired rule that wins by priority and creation tiebreak.
Only true winning pending/posted rows are counted; only the newest 20 winners
are returned as samples. Conflict cards remain independently bounded.

### Additional session-specific PostgreSQL evidence

```bash
cd server
DATABASE_URL="$TASK6A_DATABASE_URL" TEST_DATABASE_URL="$TASK6A_DATABASE_URL" \
npx vitest run --config vitest.pg.config.ts src/services/ruleChanges.pg.test.ts
```

Exit 0: 7/7. In addition to exact-session ownership, logout, role drift,
membership, canonical readback, and immutable attribution, coverage now proves
foreign route-company rejection, disconnect drift, session-expiry drift,
same-session concurrent prepare/commit (one envelope, one rule, one replay),
and expired-create retry with the exact parent resource identity.

Focused fix-round aggregate:

```bash
npm run test:server:unit -- services/mcp/rules.test.ts routes/rules.test.ts \
  services/companyReads.test.ts routes/ruleOperations.test.ts

cd server
DATABASE_URL="$TASK6A_DATABASE_URL" TEST_DATABASE_URL="$TASK6A_DATABASE_URL" \
npx vitest run --config vitest.pg.config.ts \
  src/services/ruleChanges.pg.test.ts src/services/mcp/rules.pg.test.ts
```

Exit 0: 61/61 focused unit tests and 24/24 focused PostgreSQL tests.

## Independent review fix round 2

### Additive rule lifecycle collection

Production break named: the browser's only rule collection used the legacy
active-rule query, so disabling or retiring a rule made it undiscoverable after
reload even though its canonical revision and immutable history still existed.

RED:

```bash
cd server
DATABASE_URL="$TASK6A_DATABASE_URL" TEST_DATABASE_URL="$TASK6A_DATABASE_URL" \
npx vitest run --config vitest.pg.config.ts \
  src/services/companyReads.rules.pg.test.ts
```

Exit 1: the new real PostgreSQL read expected the enabled page but received
`undefined` because no lifecycle collection existed.

GREEN after the minimal collection: 1/1. The same disconnected company read
returned canonical `RuleDetailDto` items for `enabled`, `disabled`, `retired`,
and `all`; disabled and retired items remained readable, inactive, and
non-executable. A foreign-company rule was absent from every page.

### Signed deterministic pagination and drift fence

Production break named: the first minimal collection returned `nextCursor=null`
after the first of three matching rules and had no replay/drift fence.

RED with the PostgreSQL command above: 1 failed, 1 passed. The first bounded
page returned the correct newest equal-priority rule, but did not return the
required signed cursor.

GREEN: 2/2. Ordering is `(priority ASC, createdAt DESC, id ASC)`. The cursor
binds the exact user, company, state filter, limit, mixed-direction position,
and an HMAC fingerprint of every matching rule's ID, current revision,
lifecycle, order, and review fields. The service recomputes that fingerprint
after canonical detail/readiness enrichment, rejecting a mutation racing the
read. Tests reject signature tampering, state or limit reuse, another user,
another company, and drift in a rule outside the current page.

Production break named: a runtime caller could bypass the TypeScript filter and
an unknown state widened silently to `all`.

RED with the focused pagination test: the promise resolved with a page instead
of rejecting. GREEN: the shared service now rejects unknown state with authored
`BAD_REQUEST`; the HTTP schema rejects it with `VALIDATION` before service use.

### Compatible browser route

Production break named: `/rules/lifecycle` fell through to `/:id`, returning a
single detail object, while an invalid state also widened to that detail route.

RED:

```bash
npm run test:server:unit -- routes/rules.test.ts
```

Exit 1: 2 failed, 7 passed. The lifecycle request returned the mocked detail
object rather than a page, and `state=unknown` returned 200 instead of 400.

GREEN: 10/10. `GET /rules/lifecycle` is categorizer-only, permits disconnected
company reads, validates `state`, `limit`, and `cursor`, and returns the bounded
page. A role-gate mutation to viewer produced the expected 200-vs-403 RED before
the categorizer gate was restored. The same test reads legacy `GET /rules` and
proves its response remains the original active `RuleDto[]` array.

Focused fix-round aggregate:

```bash
npm run test:server:unit -- routes/rules.test.ts services/companyReads.test.ts

cd server
DATABASE_URL="$TASK6A_DATABASE_URL" TEST_DATABASE_URL="$TASK6A_DATABASE_URL" \
npx vitest run --config vitest.pg.config.ts \
  src/services/companyReads.rules.pg.test.ts
```

Exit 0: 51/51 focused unit tests and 2/2 focused PostgreSQL tests.

No schema or migration changed. The already-deployed append-only
rule/revision state is sufficient to derive the signed population fingerprint;
no second policy store or new mutable epoch row was introduced.

## Independent review fix round 3

### Bounded lifecycle fingerprint and set-based detail hydration

Production break named: the lifecycle collection loaded the complete matching
rule population into application memory twice, then called canonical rule
detail separately for every returned item. A 100-item page performed roughly
300–400 queries and population memory grew without a bound.

RED:

```bash
TEST_DATABASE_URL="$TASK6A_DATABASE_URL" \
npm run test:pg -w server -- --run \
  src/services/companyReads.rules.pg.test.ts \
  -t "keeps lifecycle reads bounded"
```

Exit 1 against 2,000 real rules. A one-item page performed 9 queries and a
100-item page performed 306; the invariant assertion failed with
`expected 306 to be 9`.

GREEN:

```bash
TEST_DATABASE_URL="$TASK6A_DATABASE_URL" \
npm run test:pg -w server -- --run \
  src/services/companyReads.rules.pg.test.ts
```

Exit 0: 5/5. The lifecycle read now runs in one `RepeatableRead` transaction.
PostgreSQL returns one SHA-256 fingerprint for the exact state-filtered
population, ordered over each rule's ID, current revision, lifecycle, priority,
creation time, and review fields; no population rows cross into application
memory. The service fetches only `limit + 1` live rows, then batch-loads exact
current revision pairs, category accounts, tags, and transaction-local tax
readiness before applying the unchanged canonical `RuleDetailDto` mapper.

The real Prisma query-event regression proves exactly 10 queries for both a
one-rule and 2,000-rule matching population, and for page limits 1 and 100.
The returned page remains capped at 100 and under the explicit serialized
result bound. Updating a rule outside the page still changes the fingerprint
and rejects the old cursor. Equal priority and equal `createdAt` rows paginate
by `id ASC`, and isolated lifecycle-only and review-only changes both reject
the cursor.

The apparent `companyReads.ts` churn was audited line-by-line. It is the
minimal semantic extraction required to share the byte-equivalent canonical
rule-detail mapper between single reads and batch hydration, plus the database
fingerprint and transaction boundary. There is no formatter-only or unrelated
change.

### Canonical base64url cursor text

Production break named: Node's permissive base64url decoder accepted multiple
text strings for the same payload or MAC bytes, so a cursor did not have one
canonical signed representation.

RED:

```bash
npm run test:unit -w server -- --run \
  src/services/companyReads.test.ts \
  -t "textually noncanonical"
```

Exit 1. An alternate last signature character decoded to the same MAC bytes,
passed `timingSafeEqual`, and the request resolved instead of rejecting. The
test also creates an equivalently decoded padded body and signs that exact text
with the test secret.

GREEN with the same command: 1/1. The decoder now round-trips and compares the
base64url text of both decoded components before HMAC verification. Alternate
signature sextets and padded/re-signed payload text both return the authored
`INVALID_CURSOR` response.

### Fix-round-3 focused and full proof

```bash
npm run test:unit -w server -- --run src/services/companyReads.test.ts

TEST_DATABASE_URL="$TASK6A_DATABASE_URL" \
npm run test:pg -w server -- --run \
  src/services/companyReads.rules.pg.test.ts
```

Exit 0: 42/42 unit and 5/5 PostgreSQL tests.

```bash
DATABASE_URL="$TASK6A_DATABASE_URL" \
TEST_DATABASE_URL="$TASK6A_DATABASE_URL" \
npm test
```

Exit 0 on PostgreSQL 16: package-script contract 1/1; server unit 133 files,
2,241/2,241; server PostgreSQL 36 files, 336 passed and 20 intentional skips;
client 21 files, 207/207, including `Queue.tax.test.tsx` 66/66.

```bash
npm run typecheck
npm run build
DATABASE_URL="$TASK6A_DATABASE_URL" npx prisma validate
DATABASE_URL="$TASK6A_DATABASE_URL" npx prisma generate
DATABASE_URL="$TASK6A_DATABASE_URL" npx prisma migrate status
```

All exited 0. Fresh PostgreSQL 16 migration also applied all 35 migrations.
The MCP authored-schema startup and mutation-tool gate passed 7/7. The Prisma
datamodel diff remains limited to the same three inherited long-name index
renames documented below; this fix adds no schema or migration.

An initial disposable PostgreSQL 17 Alpine run timed out only in the unrelated
pre-existing 10,000-row classification corpus test. The exact isolated test
passed 1/1 in 3.1 seconds on the repository's established PostgreSQL 16
baseline, and the complete root gate then passed there. No unrelated timeout
or classification-search test was changed.

## Migration reasoning and proof

The migration is additive and rolling-compatible:

- `authKind` is non-null with default `mcp`, so all existing rows and an older
  application writer are classified correctly without changing their INSERT.
- token ID/prefix become nullable only to permit a session principal; an
  exact-one-kind CHECK prevents empty, mixed, or malformed attribution.
- session idempotency uses its own nullable-column unique index, while the
  existing MCP uniqueness/indexes remain unchanged.
- no session/token/user/company/resource foreign key was added, so provenance
  is neither cascaded away nor allowed to block source cleanup.
- the immutable trigger now includes the new discriminator and attribution.
  Its only legal update remains the first complete commit receipt.
- integrity verification recognizes both the new discriminator-aware hash and
  the exact legacy MCP hash for rows prepared before deployment.

Fresh database proof:

```bash
DATABASE_URL="$TASK6A_DATABASE_URL" \
npx prisma migrate deploy
```

Exit 0: all 35 migrations applied from an empty PostgreSQL database.

Rolling proof used a temporary migration tree containing the first 34
migrations, inserted an old-format MCP row, applied only the Task 6A SQL, then
performed another old-format INSERT without the new columns. Both queries
returned `authKind=mcp`, the original token ID, and `sessionId=NULL`. The
temporary database and files were removed afterward.

## Files changed

- `prisma/schema.prisma`
- `prisma/migrations/20260831050000_generalize_rule_operation_principal/migration.sql`
- `shared/src/index.ts`
- `server/src/types/express.d.ts`
- `server/src/middleware/auth.ts`
- `server/src/middleware/originCheck.test.ts`
- `server/src/services/mcp/operations.ts`
- `server/src/services/mcp/rules.ts`
- `server/src/services/mcp/rules.test.ts`
- `server/src/services/mcp/rules.pg.test.ts`
- `server/src/services/ruleChanges.ts`
- `server/src/services/ruleChanges.pg.test.ts`
- `server/src/services/companyReads.ts`
- `server/src/services/companyReads.test.ts`
- `server/src/services/companyReads.rules.pg.test.ts`
- `server/src/routes/classification.ts`
- `server/src/routes/classification.test.ts`
- `server/src/routes/ruleOperations.ts`
- `server/src/routes/ruleOperations.test.ts`
- `server/src/routes/rules.ts`
- `server/src/routes/rules.test.ts`
- `server/src/routes/rules.history.test.ts`
- `server/src/routes/rules.retirement.test.ts`
- `server/src/routes/ruleCandidates.ts`
- `server/src/routes/ruleCandidates.test.ts`
- `server/src/index.ts`

## Full verification

Focused browser/MCP authored-schema unit gate:

```bash
npm run test:server:unit -- routes/classification.test.ts \
  routes/ruleOperations.test.ts routes/rules.test.ts \
  routes/ruleCandidates.test.ts services/mcp/rules.test.ts \
  mcp/mutationTools.test.ts mcp/readTools.startup.test.ts
```

Exit 0: 7 files, 25 tests passed.

Focused session and unchanged MCP PostgreSQL gates:

```bash
DATABASE_URL="$TASK6A_DATABASE_URL" \
TEST_DATABASE_URL="$TASK6A_DATABASE_URL" \
npm run test:server:pg -- services/ruleChanges.pg.test.ts

DATABASE_URL="$TASK6A_DATABASE_URL" \
TEST_DATABASE_URL="$TASK6A_DATABASE_URL" \
npm run test:server:pg -- services/mcp/rules.pg.test.ts
```

Exit 0 after the review round: 7/7 session tests and 17/17 MCP lifecycle tests.

Full root test gate:

```bash
DATABASE_URL="$TASK6A_DATABASE_URL" \
TEST_DATABASE_URL="$TASK6A_DATABASE_URL" \
npm test
```

Exit 0:

- package-script contract: 1/1 passed;
- server unit: 133 files, 2,240/2,240 passed;
- server PostgreSQL: 36 files, 333 passed, 20 intentionally skipped;
- client: 21 files, 207/207 passed, including `Queue.tax.test.tsx` 66/66.

The PostgreSQL package has a pre-existing environment forwarding quirk. This
command is insufficient for a full run:

```bash
TEST_DATABASE_URL="$TASK6A_DATABASE_URL" \
npm run test:server:pg
```

It expands through root `test:server:pg` (`npm run test:pg -w server`) to server
`test:pg` (`vitest run --config vitest.pg.config.ts`). Five legacy files used a
module-level Prisma client configured only from `DATABASE_URL`, producing 58
failures such as:

```text
error: Environment variable not found: DATABASE_URL.
--> schema.prisma:7
Test Files 5 failed | 30 passed (35)
Tests 58 failed | 251 passed | 38 skipped (347)
```

Setting both variables to the same disposable database produced the green full
result above. No package script was changed.

Prisma/type/build gates:

```bash
DATABASE_URL="$TASK6A_DATABASE_URL" npx prisma validate
DATABASE_URL="$TASK6A_DATABASE_URL" npx prisma generate
npm run typecheck
npm run build
```

All exited 0. Prisma reported a valid schema and generated client v6.19.3;
shared/server/client typechecks passed; the production Vite build completed.

Migration status and datamodel diff:

```bash
DATABASE_URL="$TASK6A_DATABASE_URL" \
npx prisma migrate status

npx prisma migrate diff --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url "$TASK6A_SHADOW_DATABASE_URL" \
  --exit-code
```

Migration status exited 0: 35 migrations, database up to date. The diff
reported only three inherited long-name index renames on
`AutopilotRuleCandidate` and `QboTransferOperation`; it reported no Task 6A
table, column, constraint, or index difference. Those unrelated historical
names were not changed.

Final hygiene:

```bash
git diff --check
git diff | betterleaks stdin --no-banner --redact=100
git status --short
```

Both diff checks exited 0, and betterleaks reported no leaks. The Prisma
schema diff contains only eight lines
for the new discriminator/nullability/session indexes; there is no formatter
churn. The rule/candidate route deletions are intentional removal of direct
write implementations and now-unused schemas/imports, not formatting churn.

## Independent review fix round 4 — constant-state lifecycle fence

### Production break and chosen boundary

The fix-round-3 database fingerprint was query-bounded but not work-bounded:
PostgreSQL still constructed a `jsonb_agg` over every matching Rule before
hashing it. A page read therefore retained population-sized database memory and
CPU even though the application received only one digest and `limit + 1` rows.

Fix round 4 replaces that aggregate with one `RuleLifecycleRevision` row per
Company. Its BIGINT revision is incremented transactionally by database
triggers for every lifecycle-visible Rule mutation and every RuleRevision
mutation, including rolling old binaries and direct SQL. The signed cursor now
contains `rule-lifecycle-fence-v1:<revision>`. It remains bound to resource,
user, company, state filter, limit, and page position. A fix-round-3 SHA cursor
is intentionally rejected after cutover; clients restart pagination. All state
filters conservatively share the company fence, so an unrelated lifecycle
change may invalidate a page but can never make a stale page executable.

The migration takes `SHARE ROW EXCLUSIVE` locks on Company, Rule, and
RuleRevision inside one explicit transaction before table creation, trigger
installation, and backfill. That closes the install/backfill missed-write gap.
Backfill is one row per Company and does not scan Rule or RuleRevision. A
Company INSERT trigger creates revision zero. The bump helper uses a sorted,
distinct company-ID array and one UPSERT per affected company; it checks that
the Company still exists so Company cascades cannot resurrect a fence. Missing
zero-state rows self-heal on the next old/direct mutation.

Rule INSERT/DELETE and RuleRevision INSERT/DELETE triggers use transition
tables and bump each affected company once per statement. Rule UPDATE uses an
exact no-op guard over ID, company, current revision, enabled, retiredAt,
priority, createdAt, reviewRequiredAt, and reviewReason. RuleRevision UPDATE
uses `OLD.* IS DISTINCT FROM NEW.*`, since every immutable historical field is
part of lifecycle/history pagination. Old and new ownership are sorted before
row locking, so reversed cross-company writers do not deadlock. Canonical
writers retain Task 6's existing company mutation serialization; the trigger
adds no global/advisory mutation lock. Counter gaps are harmless freshness
tokens.

### RED evidence

Fresh schema / zero-state fence:

```bash
TEST_DATABASE_URL="$TASK6A_DATABASE_URL" \
npm --workspace server run test:pg -- \
  src/services/ruleLifecycleRevision.pg.test.ts
```

Before the migration, the first real PostgreSQL test failed as expected:

```text
1 failed
Raw query failed. Code: 42P01.
relation "RuleLifecycleRevision" does not exist
```

After adding only the table/backfill/Company trigger, the rolling-old-writer
test failed because a direct legacy Rule insert left the fence unchanged:

```text
1 failed | 1 passed
expected 0 to be greater than 0
```

After INSERT coverage, exact lifecycle UPDATE coverage failed first on
priority drift:

```text
1 failed | 2 passed
expected 2n to be 3n
```

After Rule UPDATE coverage, immutable-history UPDATE/delete coverage failed on
a direct RuleRevision change:

```text
1 failed | 4 passed
expected [ { revision: 3n } ] to deeply equal [ { revision: 4n } ]
```

The service-boundary RED used an appended non-current RuleRevision that did
not modify Rule. The old population aggregate accepted the stale cursor:

```bash
TEST_DATABASE_URL="$TASK6A_DATABASE_URL" \
npm --workspace server run test:pg -- \
  src/services/companyReads.rules.pg.test.ts \
  -t 'immutable RuleRevision history'
```

```text
1 failed | 5 skipped
promise resolved ... instead of rejecting
```

The first full PostgreSQL run also exposed a test-fixture-only issue: under
parallel suite load, the 10,000-row seed exceeded Prisma's default five-second
interactive transaction timeout. No lifecycle read timed out. The fixture
transaction alone now has a 30-second timeout; production transaction settings
were not changed.

### GREEN evidence and scale proof

```bash
TEST_DATABASE_URL="$TASK6A_DATABASE_URL" \
npm --workspace server run test:pg -- \
  src/services/ruleLifecycleRevision.pg.test.ts \
  src/services/companyReads.rules.pg.test.ts
```

Exit 0: 2 files, 14/14 tests passed. The trigger suite covers fresh zero state,
backfill-compatible raw old-writer Rule insertion, deferred revision-zero
capture, all exact Rule fields, unrelated/no-op Rule writes, RuleRevision
insert/update/no-op/delete, direct Rule delete with the existing immutability
guards disabled transactionally only for the test, Company cascade cleanup,
missing-row self-healing, old+new company ownership, Rule ID drift, concurrent
increments, and reversed company ordering.

The real 10,001-rule test compares one-rule and large populations through the
actual service. Both used exactly 10 database queries; limit 100 returned 100
items and stayed below the 250 KB response bound. A representative focused run
reported:

```text
[rule-lifecycle-scale] {
  rules: 10001,
  smallElapsedMs: 24.08,
  largeElapsedMs: 7.92,
  queryCounts: [ 10, 10, 10 ],
  fenceNodeTypes: [ 'Seq Scan' ],
  pageRoot: 'Limit',
  pageRows: 101
}
```

The fence table contained one row in that test, so PostgreSQL rationally chose
a one-row sequential scan rather than its primary-key index. Real `EXPLAIN
(ANALYZE, BUFFERS, FORMAT JSON)` assertions prove the fence plan touches only
RuleLifecycleRevision, returns one row, and contains no Aggregate. The page
plan is rooted at Limit, returns 101 rows, and contains no Aggregate. This
proves the removed full-population fingerprint is not hidden in either query.
The existing state/order page query may still inspect matching Rule rows; that
explicitly accepted fix-round limitation was not widened with a denormalized
index or second lifecycle store.

### Fresh and rolling migration evidence

Fresh PostgreSQL 16 reset/deploy applied all 36 migrations, generated Prisma
Client 6.19.3, and passed the zero-state/trigger suite.

For the rolling test, a second disposable database received only the first 35
migrations, then an existing Company and an old-shape raw Rule. The new
migration was added to that migration set and deployed with `prisma migrate
deploy`. The existing company was backfilled at revision zero. A second
old-shape Rule insert after cutover produced:

```text
before old-writer insert: rolling-company | 0
after transaction commit: rolling-company | 2
fallback history: rolling-after-rule | revision 0
```

One increment came from Rule INSERT and one from the deferred compatibility
RuleRevision INSERT. This proves a new database reader observes writes from an
old binary after cutover. Old binaries ignore the additive table and triggers,
so their read/write schema remains compatible. Company cascade removes the
single fence row; no separate cleanup job or retained population artifact is
required.

### Files changed in fix round 4

- `prisma/schema.prisma` — one Company relation and the three-field
  RuleLifecycleRevision model only; no formatter churn.
- `prisma/migrations/20260831060000_add_rule_lifecycle_revision/migration.sql`
  — additive table, bounded backfill, bump helper, and transactional triggers.
- `server/src/services/companyReads.ts` — removes the `jsonb_agg`/SHA scan and
  reads the one-row version fence inside the existing repeatable-read snapshot.
- `server/src/services/companyReads.rules.pg.test.ts` — non-current-history
  drift plus 10,001-rule query-count/EXPLAIN/latency/result-bound proof.
- `server/src/services/ruleLifecycleRevision.pg.test.ts` — focused real
  PostgreSQL migration, trigger, ownership, concurrency, no-op, and cleanup
  behavior.
- this report.

### Full fix-round-4 verification

```bash
DATABASE_URL="$TASK6A_DATABASE_URL" \
TEST_DATABASE_URL="$TASK6A_DATABASE_URL" npm test
```

Exit 0 after the fixture-timeout correction:

- package-script contract: 1/1 passed;
- server unit: 133 files, 2,241/2,241 passed;
- server PostgreSQL: 37 files, 345 passed, 20 intentionally skipped;
- client: 21 files, 207/207 passed, including `Queue.tax.test.tsx` 66/66.

Additional gates:

```bash
npm run test:server:unit -- mcp/mutationTools.test.ts \
  mcp/readTools.startup.test.ts mcp/readTools.test.ts
npm run typecheck
DATABASE_URL="$TASK6A_DATABASE_URL" npm run build
DATABASE_URL="$TASK6A_DATABASE_URL" npx prisma validate
DATABASE_URL="$TASK6A_DATABASE_URL" npx prisma generate
DATABASE_URL="$TASK6A_DATABASE_URL" npx prisma migrate status
```

All exited 0. MCP authored-schema/startup coverage passed 3 files / 27 tests;
shared/server/client typechecks passed; the server and production client build
passed; Prisma validate/generate/status reported a valid schema, generated
client, 36 migrations, and an up-to-date database. The datamodel diff still
reports only the same three inherited long-name index renames on
AutopilotRuleCandidate and QboTransferOperation, with no RuleLifecycleRevision
drift.

### Fix-round-4 self-review

- No Rule or RuleRevision population is materialized or aggregated to validate
  a lifecycle cursor. The application reads one BIGINT and at most `limit + 1`
  Rule rows before bounded batch hydration.
- All trigger invalidation is transactionally visible with the changed rule or
  history. Rollback also rolls back the increment; concurrent UPSERT increments
  cannot be lost.
- No-op guards prevent unrelated Rule edits from invalidating pagination. The
  conservative shared company fence intentionally invalidates every state
  filter on a relevant lifecycle/history change.
- Both OLD and NEW company owners are bumped in stable order. Company deletion
  cannot recreate a fence because the bump helper requires a live Company.
- Immutable provenance triggers remain enabled and unchanged in production;
  tests disable them only inside transactions to exercise otherwise unreachable
  direct-delete/update trigger paths, then restore them before commit.
- No REST, MCP, client, auth, shared-contract, policy, provider, QBO, deployment,
  push, or production behavior changed in this round.

## Independent review fix round 5 — non-reused generations and statement triggers

### Production breaks and strict RED evidence

#### 1. Fence deletion/recreation could reproduce a stale cursor generation

Production break named: the per-company counter restarted from zero whenever a
`RuleLifecycleRevision` row was absent. Deleting that row, or deleting and
recreating a Company with the same ID, could therefore reproduce the exact
generation embedded in an old signed cursor.

The service-level standalone-delete test prepares a cursor at generation six,
deletes only the fence row, confirms reads fail closed while the row is absent,
then performs six real Rule priority updates. Against the fix-round-4 schema:

```bash
TEST_DATABASE_URL="$TASK6A_ROUND4_DATABASE_URL" \
npm --workspace server run test:pg -- \
  src/services/companyReads.rules.pg.test.ts -t 'deleted lifecycle fence'
```

Exit 1:

```text
AssertionError: expected 6 to be greater than 6
```

The same-company-ID recreation test deletes a Company (cascading the fence),
recreates its user, membership, account, Company, and equivalent Rules under
the identical IDs, then presents the old cursor. Against the old schema:

```bash
TEST_DATABASE_URL="$TASK6A_ROUND4_DATABASE_URL" \
npm --workspace server run test:pg -- \
  src/services/companyReads.rules.pg.test.ts -t 'same company ID'
```

Exit 1:

```text
AssertionError: expected 6 to be greater than 6
```

A focused trigger test also proved that direct fence INSERT/UPDATE could still
write an arbitrary/reused value before the stamp trigger existed:

```text
AssertionError: expected 0 to be greater than 0
```

GREEN after the sequence/stamp migration:

```bash
TEST_DATABASE_URL="$TASK6A_DATABASE_URL" \
npm --workspace server run test:pg -- \
  src/services/companyReads.rules.pg.test.ts \
  src/services/ruleLifecycleRevision.pg.test.ts
```

Exit 0: 2 files, 20/20 passed. Both delete/recreate paths receive a strictly
larger global generation and reject the stale cursor with `INVALID_CURSOR`.
Missing fences remain fail-closed on reads until a genuine lifecycle mutation
self-heals them. Direct INSERT/UPDATE values are also replaced by fresh
sequence generations.

#### 2. Row UPDATE triggers could lock multiple company fences inconsistently

Production break named: the Rule and RuleRevision UPDATE triggers ran once per
row. Two bulk statements touching the same companies in reversed row order
could acquire company fence row locks in opposite orders. They also advanced a
company fence once per changed row instead of once per changed statement.

The exact same-company multirow assertions were RED on the old schema:

```text
Rule:         expected 38n to be 37n
RuleRevision: expected 13n to be 12n
```

Both show a two-row statement advancing the company twice rather than once.
The adversarial tests install a test-only AFTER ROW barrier backed by a
nontransactional sequence, start two transactions, and update disjoint Rule or
RuleRevision rows belonging to the same two companies in reversed order. This
drives the real production UPDATE trigger path rather than calling the bump
helper directly. Against the row-trigger schema both tests were RED:

```text
Rule lifecycle test barrier timed out (SQLSTATE P0001)
RuleRevision lifecycle test barrier timed out (SQLSTATE P0001)
```

After replacing the two UPDATE triggers with AFTER UPDATE statement triggers
and OLD/NEW transition tables, the focused trigger suite is GREEN:

```bash
TEST_DATABASE_URL="$TASK6A_DATABASE_URL" \
npm --workspace server run test:pg -- \
  src/services/ruleLifecycleRevision.pg.test.ts
```

Exit 0: 1 file, 12/12 passed. Both transactions reach the row barrier before
any lifecycle fence is locked, then each statement unions OLD and NEW company
owners, sorts the distinct company IDs once, and advances both companies
without a deadlock or timeout. Each two-row/same-company statement advances
the fence once. Rule comparison is restricted to the cursor projection
(`id`, company, revision, enabled, retiredAt, priority, createdAt,
reviewRequiredAt, reviewReason); RuleRevision comparison is full-row and
bidirectional. No-op updates do not bump either fence.

### Migration and rolling/restore reasoning

Migration `20260831070000_harden_rule_lifecycle_generation` is additive and
rolling-compatible:

- creates a standalone `BIGINT NO CYCLE CACHE 1` PostgreSQL sequence above the
  largest legacy per-company counter;
- adds a BEFORE INSERT/UPDATE stamp trigger, drops the old Prisma default, and
  rebases every existing fence through `nextval`, invalidating all pre-cutover
  cursors exactly once;
- keeps deletion and Company cascade behavior unchanged. A missing fence is
  inserted with a placeholder that the stamp trigger replaces; the sequence is
  global and is neither deleted with a Company nor rolled back, so self-heal
  and same-ID recreation cannot reuse the old token;
- updates the existing sorted bump helper so existing rows advance through a
  harmless `revision = revision` write and concurrent missing-row creation is
  resolved by `ON CONFLICT DO UPDATE`, with the stamp trigger assigning the
  winner a new generation;
- replaces only the Rule and RuleRevision UPDATE row triggers. Existing INSERT
  and DELETE statement triggers and old-writer fallback history behavior are
  retained.

A fresh reset applied all 37 migrations and passed the full trigger suite. A
rolling database first applied 36 migrations and held legacy fence values 50
and 100. Deploying the new migration rebased them to 101 and 102. An old-shape
raw Rule insert after cutover advanced the first company to 104 and created the
expected fallback RuleRevision at revision zero, proving an old binary remains
compatible with the new database.

Standard `pg_dump -Fc` / `pg_restore --exit-on-error` testing preserved both
the fence row and standalone sequence state at 214. A post-restore old-shape
Rule insert advanced the fence to 216 and created fallback history. Thus the
sequence state survives normal backup/restore, while sequence gaps caused by
rollback or contention remain intentionally harmless and prevent reuse.

### Files changed in fix round 5

- `prisma/schema.prisma` — removes only the obsolete zero default from the
  lifecycle generation; no formatter churn.
- `prisma/migrations/20260831070000_harden_rule_lifecycle_generation/migration.sql`
  — global generation sequence, mandatory stamp trigger, cutover rebase,
  race-safe bump helper, and transition-table UPDATE triggers.
- `server/src/services/companyReads.rules.pg.test.ts` — real service tests for
  standalone fence deletion/self-heal and same-ID Company recreation.
- `server/src/services/ruleLifecycleRevision.pg.test.ts` — sequence stamping,
  multirow no-op/material semantics, and deterministic real-trigger concurrency
  coverage for Rule and RuleRevision.
- this report.

No REST, MCP, client, npm-script, application service, policy, provider, QBO,
deployment, push, or production code changed in this round.

### Full fix-round-5 verification

```bash
DATABASE_URL="$TASK6A_DATABASE_URL" \
TEST_DATABASE_URL="$TASK6A_DATABASE_URL" npm test
```

Exit 0:

- package-script contract: 1/1 passed;
- server unit: 133 files, 2,241/2,241 passed;
- server PostgreSQL: 37 files, 351 passed, 20 intentionally skipped;
- client: 21 files, 207/207 passed, including `Queue.tax.test.tsx` 66/66.

The first full rerun encountered one `ECONNRESET` in the unrelated
`transactions.categorization` live-recheck unit test. Its exact isolated rerun
passed 1/1 without code changes, and the fresh complete root rerun above passed
all 2,241 unit tests; this was recorded as transient test infrastructure, not
masked or changed.

```bash
npm run typecheck
npm run build
DATABASE_URL="$TASK6A_DATABASE_URL" npx prisma validate
DATABASE_URL="$TASK6A_DATABASE_URL" npx prisma generate
DATABASE_URL="$TASK6A_DATABASE_URL" npx prisma migrate status
```

All exited 0: shared/server/client typechecks and builds passed; Vite built 84
modules; Prisma validated and generated client 6.19.3; all 37 migrations are
applied. Fresh migration reset, rolling migration, MCP authored-schema startup,
package-script contract, and diff checks passed. Prisma datamodel diff still
contains only the same three inherited long-name index renames and no lifecycle
schema drift.

The 10,001-rule lifecycle read remains constant-query and bounded in returned
materialization after this hardening. The final full PG run reported 10 queries
for each measured page, returned only `limit + 1` Rule rows, and contained no
population aggregate in the fence or page plan.

### Fix-round-5 self-review

- Generations are globally unique for the lifetime of the sequence, not merely
  monotonic within a company row. PostgreSQL sequences are deliberately
  nontransactional, so aborted transactions consume rather than reuse values.
- Every initialization and bump is stamped. There is no writable/default zero
  path after cutover, including explicit INSERT/UPDATE statements.
- Direct fence deletion remains allowed as approved; reads fail closed while
  absent, and the next legitimate mutation self-heals with a strictly new
  generation. Company cascade still removes its fence without special guards.
- UPDATE transition-table triggers compare OLD and NEW projections in both
  directions, capturing company/ID moves and material value changes while
  ignoring order-only transition-table presentation and exact no-ops.
- The helper sorts distinct company IDs before locking. Statement triggers
  call it once, avoiding row-order lock inversion across concurrent bulk
  updates.
- The migration locks Company, Rule, RuleRevision, and the fence only during
  the cutover; ordinary lifecycle writes retain the existing company-scoped
  transaction policy and do not introduce a global runtime lock.
- SECURITY DEFINER functions retain a fixed `pg_catalog, public` search path.
- Sequence exhaustion is fail-closed. At BIGINT scale it is not an operational
  concern for this workload; sequence monitoring can be added without changing
  the cursor contract.

## Independent review fix round 6 — ownership ABA, observed lock order, and helper ACLs

### Production breaks and strict RED evidence

#### 1. A companyId-only fence move preserved the old owner's generation

Production break named: the generation trigger was declared `UPDATE OF
revision`. Directly changing only `RuleLifecycleRevision.companyId` moved the
old owner's signed-cursor generation to another Company and back unchanged.

The service-level test prepares a real company-A lifecycle cursor, deletes the
otherwise-conflicting company-B fence, moves A's fence to B and back by changing
only `companyId`, then presents the old cursor. Before the fix:

```bash
TEST_DATABASE_URL="$TASK6A_DATABASE_URL" \
npm --workspace server run test:pg -- \
  src/services/companyReads.rules.pg.test.ts -t 'fence is moved'
```

Exit 1:

```text
AssertionError: expected 182 to be greater than 182
```

The independent direct-fence test failed for the same exact reason:

```text
AssertionError: expected 184 to be greater than 184
```

Migration `20260831080000_harden_rule_lifecycle_ownership` recreates the stamp
trigger as `BEFORE INSERT OR UPDATE`, which covers every writable column and
future ownership projection. GREEN:

```bash
TEST_DATABASE_URL="$TASK6A_DATABASE_URL" \
npm --workspace server run test:pg -- \
  src/services/ruleLifecycleRevision.pg.test.ts \
  src/services/companyReads.rules.pg.test.ts
```

Exit 0: 2 files, 23/23 passed. Both ownership moves receive strictly increasing
global generations, and the original company-A cursor is rejected with
`INVALID_CURSOR` after the fence returns.

#### 2. Prior concurrency coverage did not observe actual fence acquisition

Production evidence gap named: the prior barrier proved overlapping Rule and
RuleRevision statements completed, but neither controlled/observed their
source-row order nor recorded the actual `RuleLifecycleRevision` UPDATE order
for each transaction.

The replacement tests install test-only row audit triggers on the real source
table and the real fence table. Each transaction sets its own local writer ID.
Fixtures and IDs make writer A's observed source order A→B and writer B's
observed source order B→A. The existing bounded barrier keeps both real bulk
statements in flight concurrently; lock and statement timeouts remain three and
five seconds. Audit rows then prove both production statement-trigger paths
update fences in sorted company-ID order for each transaction. The global
sequence must advance exactly four times: two statements times two companies.

Because the canonical helper was already sorted, meaningful RED was established
with a disposable-database mutation that iterated its received company array in
reverse. No repository production file was changed for the mutation. Both
tests failed on their recorded fence rows:

```bash
TEST_DATABASE_URL="$TASK6A_DATABASE_URL" \
npm --workspace server run test:pg -- \
  src/services/ruleLifecycleRevision.pg.test.ts \
  -t 'lifecycle fences in sorted order'
```

Exit 1: 2 failed. Each diff showed expected sorted A→B but received B→A for the
actual fence surface. A fresh migration reset restored the canonical helper;
both tests then passed. The tests also assert the deliberately opposed source
orders, so a planner/fixture change cannot make the evidence silently vacuous.

#### 3. SECURITY DEFINER lifecycle helpers were PUBLIC-executable

Production break named: PostgreSQL grants function EXECUTE to PUBLIC by
default. The central lifecycle bump was SECURITY DEFINER, so an unintended role
could call it directly rather than reaching it only through governed table
triggers. Initial privilege RED returned `true` for all four fix-round-5
definer helpers where the test expected `false`.

The first revoke exposed a second, useful RED: old-style Rule INSERT uses an
invoker-security trigger wrapper around the central helper. A restricted
application role with ordinary schema/table/sequence DML but no direct function
grant failed its real Rule INSERT:

```text
ERROR: permission denied for function rule_lifecycle_bump_company_ids
SQLSTATE 42501
```

The final migration makes all five insert/delete lifecycle wrappers
SECURITY DEFINER with the same fixed `pg_catalog, public` search path, then
revokes PUBLIC EXECUTE from those wrappers and the four existing definers. The
restricted-role test now proves a real Rule UPDATE and old-shape Rule INSERT
both succeed through triggers, all nine lifecycle definers report no EXECUTE,
and a direct bump call fails with the authored PostgreSQL permission denial.

### Fresh, rolling, and restore evidence

Fresh PostgreSQL reset applied all 38 migrations. Focused trigger/service tests
passed 23/23, including ownership ABA, actual lock-order audits, restricted-role
old-writer insertion, direct-call denial, and the existing 10,001-rule bounded
read.

For rolling evidence, a database at migration 37 held an A fence at generation
108. CompanyId-only A→B→A moves remained 108 before deploy, reproducing the
legacy ABA. Deploying migration 38 changed the next two ownership moves to 109
and 110. Catalog inspection found all nine lifecycle SECURITY DEFINER helpers
owner-only. This migration changes no table/model shape and old binaries keep
using the same Rule, RuleRevision, Company, and fence triggers.

Standard `pg_dump -Fc` / `pg_restore --exit-on-error` preserved the source
fence at generation 7 and sequence state 8. After restore, an ownership move
received 9; moving back and performing an old-shape Rule insert advanced the
fence to 12 and created fallback history. All nine function ACLs survived the
restore.

The migration takes a SHARE ROW EXCLUSIVE lock only on the one-row-per-company
fence table while the stamp trigger is replaced and helper attributes/ACLs are
changed. Any concurrent Company/Rule/RuleRevision path that reaches a fence
write waits through this short transaction, closing the drop/recreate rolling
gap without a new global runtime serialization point.

### Files changed in fix round 6

- `prisma/migrations/20260831080000_harden_rule_lifecycle_ownership/migration.sql`
  — all-update generation stamping, fixed-path trigger-wrapper ownership, and
  owner-only execution ACLs.
- `server/src/services/companyReads.rules.pg.test.ts` — real stale-cursor
  ownership ABA coverage.
- `server/src/services/ruleLifecycleRevision.pg.test.ts` — direct ownership
  stamping, restricted-role trigger/direct-call ACL behavior, controlled
  opposing source order, actual per-transaction fence audit, bounded overlap,
  and exact generation counts.
- this report.

No Prisma model, REST, MCP, client, npm script, application service, policy,
provider, QBO, deployment, push, or production data changed in this round.

### Full fix-round-6 verification

```bash
DATABASE_URL="$TASK6A_DATABASE_URL" \
TEST_DATABASE_URL="$TASK6A_DATABASE_URL" npm test
```

Exit 0:

- package-script contract: 1/1 passed;
- server unit: 133 files, 2,241/2,241 passed;
- server PostgreSQL: 37 files, 354 passed, 20 intentionally skipped;
- client: 21 files, 207/207 passed, including `Queue.tax.test.tsx` 66/66.

Additional gates:

```bash
npm run typecheck
npm run build
npm --workspace server run test:unit -- \
  src/mcp/readTools.startup.test.ts \
  src/mcp/mutationTools.test.ts \
  src/mcp/readTools.test.ts
DATABASE_URL="$TASK6A_DATABASE_URL" npx prisma validate
DATABASE_URL="$TASK6A_DATABASE_URL" npx prisma generate
DATABASE_URL="$TASK6A_DATABASE_URL" npx prisma migrate status
```

All exited 0. Shared/server/client typechecks and builds passed; Vite built 84
modules; MCP authored-schema/startup coverage passed 3 files / 27 tests; Prisma
validated, generated client 6.19.3, and reported all 38 migrations applied.
Fresh reset, rolling deploy, dump/restore, package-script, diff, and leak checks
passed. Datamodel diff still contains only the same three inherited long-name
index renames and no lifecycle drift.

### Fix-round-6 self-review

- Every fence INSERT and UPDATE now consumes `nextval`, including a pure
  companyId move, a same-value revision update, a cascade, and a central-helper
  bump. Deletes remain allowed and do not reset the standalone sequence.
- Actual source and fence rows—not helper inputs or mocks—are audited. The test
  records opposed source orders, requires sorted fence orders per transaction,
  forces concurrent overlap, retains timeouts, and checks the exact sequence
  delta.
- The test-only audit table, functions, triggers, barrier sequence, and
  restricted role are removed in `finally` paths. PostgreSQL PG suites remain
  file-serial, so temporary global DDL cannot overlap another test file.
- All nine lifecycle SECURITY DEFINER functions have a fixed search path and no
  PUBLIC EXECUTE. Trigger invocation remains available without function grants;
  nested central-helper calls run as the migration owner. Application roles do
  not need, and cannot use, a direct definer entry point.
- The migration intentionally does not grant a guessed application role. The
  repository has no stable deployment role name, and normal application code
  never calls these helpers directly; granting one would recreate the bypass.
- The sequence, trigger events, transition-table ordering, cursor contract, and
  company-scoped fence lookup remain unchanged outside the reviewed hardening.

## Security and self-review

- Confirmed no raw cookie, cookie hash, fake token, provider credential, or QBO
  identifier supplied by the browser enters principal attribution.
- Confirmed both phases authorize outside and again inside the company-locked
  transaction, with authority rows locked before the final decision.
- Confirmed exact operation ownership includes auth kind, credential ID, user,
  company, resource, idempotency, revision, hashes, expiry, and retry lineage.
- Confirmed session rows have no foreign key and database immutability rejects
  attribution updates/deletes after logout.
- Confirmed direct REST policy mutations cannot bypass preparation/commit and
  disconnected companies cannot prepare or commit.
- Confirmed generic create is absent from the browser schema; make-recurring
  accepts only match text, priority, idempotency, and retry lineage and forces
  `autoPost=false`.
- Confirmed current reference readiness remains mandatory for create/update/
  enable/activate, while Task 6's legacy disable/retire/dismiss safety paths
  remain action-independent.
- Confirmed MCP schemas, routing, authored startup, legacy integrity hashes,
  and all 17 real PostgreSQL lifecycle tests remain unchanged and green.
- Confirmed lifecycle pagination transfers only one fixed-size population
  fingerprint plus `limit + 1` rows, hydrates current revisions and references
  in set-based queries, and observes all of them in one repeatable-read snapshot.
- Confirmed the cursor MAC remains the authority boundary: the database
  fingerprint is not independently trusted, and both cursor components must
  use their one canonical base64url spelling before the MAC is compared.
- Confirmed no client or npm script file appears in the diff.

## Concerns

No open Task 6A implementation concern. Two inherited repository quirks remain
out of scope: the full PostgreSQL script needs both database environment
variables, and Prisma diff proposes only three long-name index renames on
pre-Task-6A tables. Neither package scripts nor unrelated migrations were
changed.
