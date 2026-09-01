---
last_edited: 2026-08-31
---

# Task 6A report — session-auth REST adapters for classification memory

## Status

Complete locally on top of Task 6 fix-round-2 commit
`149749d9be571d2dcd276aa8ba533f5511b3fedf`. Browser rule operations now use
the same immutable, company-scoped, two-phase lifecycle as MCP with a real
session principal. Classification and canonical rule reads are available to
the browser without adding a policy store, fake MCP token, or one-call write.

No external provider, production database, QBO, deployment, push, or PR was
used. Verification used an isolated disposable PostgreSQL 16 + pgvector
container on localhost port 55439.

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
- server unit: 133 files, 2,237/2,237 passed;
- server PostgreSQL: 35 files, 331 passed, 20 intentionally skipped;
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
- Confirmed no client or npm script file appears in the diff.

## Concerns

No open Task 6A implementation concern. Two inherited repository quirks remain
out of scope: the full PostgreSQL script needs both database environment
variables, and Prisma diff proposes only three long-name index renames on
pre-Task-6A tables. Neither package scripts nor unrelated migrations were
changed.
