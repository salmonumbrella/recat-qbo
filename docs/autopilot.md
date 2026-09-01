---
last_edited: 2026-09-01
---

# Autopilot shadow-provider boundary

The shadow decision core can ask OpenRouter or a custom OpenAI-compatible
endpoint to propose a categorization. In this release it is a pure library: it
has no scheduler, database, MCP, or QuickBooks write dependency, and nothing
invokes it automatically. Any caller that enables a real model sends the
bounded context below to that external provider.

## Classification-memory contract

Recat's classification-memory API is the canonical, company-scoped source for
verified decisions, vendor identities and aliases, active rule revisions, and
learned candidates. Its public DTOs are bounded and strict. A classification
action is one supported categorization line containing the QuickBooks category
ID, tax calculation, a tax-code ID for taxable actions (`NotApplicable`
requires `null`), and local transaction tag IDs. Display names
are preview context only; a commit must revalidate the current company's QBO
IDs and never substitute a name for an ID.

Every search result reports its effective `mode`, `degraded` flag and bounded
`degradedReason`, match reasons (`alias`, `rule`, `candidate`, `case`,
`lexical`, or `semantic`), stable source IDs, company relation, executable or
advisory status, evidence counts, conflicts, and provenance. A foreign-company
hit is always advisory and non-executable. It contains only a human-readable
action summary; its QBO category, tax-code, and tag IDs are stripped. No
evidence is an explicit
`status: "no_match"` result with `noMatch: true`; it is not silently treated
as a provider or database error. In `auto` mode, a missing embedding/vector
leg returns an explicitly degraded lexical result. Explicit `hybrid` or
`semantic` callers receive the safe `SEMANTIC_UNAVAILABLE` error instead of a
result that pretends semantic search ran.

The origin intents `apply_once`, `make_recurring`, and `auto_candidate` record
why evidence or a rule was proposed; they are not accounting actions.
New recurring and candidate-origin rules always start with `autoPost: false`.
Enabling auto-post later is a separate revision-bound, audited mutation. Rule
previews include the exact payee condition and
tax-aware action, current/proposed revision, category and tax labels plus QBO
IDs, priority, affected pending/posted counts, bounded samples, conflicts,
warnings, and the preparation digest. Safe error serialization returns only
an allowlisted code and fixed message—never provider messages, raw QBO data,
credentials, or private prompts.

### Deterministic local verification

The classification-memory end-to-end suite uses a local deterministic HTTP
embedding fixture and a disposable PostgreSQL/pgvector server. Fixed
accounting-purpose signals map to stable unit vectors, including separate
vector slots for a simulated model/generation cutover. Vendor/source words do
not choose an accounting topic: vendor-only Chevron documents map to the
neutral vector, while stored fuel and personal case documents map to distinct
literal topics. The fixture records only the test request method, path, input
type, input text, and resolved synthetic topic; it has no provider credential
and makes no outbound request.

Use an anchor database on a disposable server where the local role may
create/drop databases and install the already-available `vector` extension:

```bash
cd server
TEST_PGVECTOR_DATABASE_URL=postgresql://... npx vitest run \
  src/services/classification/search.e2e.test.ts
```

Each invocation creates a unique database, applies all migrations, installs
pgvector, truncates every disposable data table between cases, and force-drops
the database in final teardown without changing the configured anchor. The
suite verifies exact alias, distinct fuel/personal semantic queries, hybrid
RRF retrieval, edit/re-embed and atomic generation cutover without stale-vector
leakage, membership-derived cross-company redaction/authorization, and
labelled lexical degradation when the embedding endpoint is unavailable. Its
isolated Chevron scenario keeps recurring policy suggestion-only (`autoPost:
false`), snapshots the synthetic transactions and QBO-mutation-attempt count
before the rule operation, and requires both to remain deeply equal to those
snapshots after prepare, commit, endpoint calls, client replacement, and search
readback.

Fail-closed instrumentation wraps every QBO factory method, mutating real/mock
QBO client method, global fetch, and Node HTTP/HTTPS request path. Deliberate
denial probes prove those guards count and throw; the real Chevron flow must
then leave every counter at zero while only the exact loopback fixture origin
is allowed. Fault injection after each durable prepare/create write, both
occurrences of every changed reorder rule/revision/audit write, and each
applicable candidate activation/dismissal rule/candidate/revision/audit/receipt
write verifies exact rollback snapshots, reprepare, restart recovery,
idempotent replay, expiry retry, stale-revision and conflict rejection,
append-only history, unchanged candidate evidence, and absence of partial
priority or policy state. This is local test evidence only; it neither enables
semantic configuration nor deploys or restarts a running Recat service.

## Provider request

OpenRouter requests go to `https://openrouter.ai/api/v1/chat/completions`.
Custom-provider requests go to the configured HTTP(S) base URL with
`/chat/completions` appended. Review that provider's data-handling, retention,
training, residency, and deletion terms before configuring credentials. Recat
cannot control or verify what an external provider retains after a request.

Every request contains the configured model name, a versioned system
instruction, the structured-decision JSON Schema, the four fixed read-only tool
schemas, and one immutable transaction snapshot. Review requests also contain
the candidate structured decision. Later turns can repeat bounded assistant
tool calls and tool results derived only from that same snapshot.

The serialized snapshot contains exactly these fields:

- `schemaVersion`, `featureVersion`, and `configurationVersion`;
- transaction UUID and local revision;
- transaction date, signed amount in integer cents, and three-letter currency;
- source account display name and coarse type (`BANK`, `CREDIT_CARD`, `CASH`, or
  `OTHER`);
- normalized payee/vendor text and optional memo;
- candidate categories, each with its QuickBooks reference ID and display name;
- tax readiness status, supported calculation modes, and eligible tax-code
  reference IDs and labels;
- active tag UUIDs and names;
- applicable rules: rule UUID, priority, payee match text, category reference,
  tax calculation and tax-code reference, and tag UUIDs;
- up to 20 similar verified transactions: transaction UUID, date, signed cents,
  currency, payee, optional memo, tax calculation, tag UUIDs, verification
  timestamp, and up to 20 lines containing signed cents, category and tax-code
  references, optional memo, and tag UUIDs.

The provider can call four fixed tools:

- `search_categories` accepts `{query, limit}`, where `query` is 1–160
  characters and `limit` is an integer from 1–100, and returns matching
  candidate-category items;
- `list_tax_codes` accepts `{}` and returns eligible tax-reference items;
- `list_rules` accepts `{}` and returns applicable-rule items; and
- `find_similar_transactions` accepts the same bounded `{query, limit}` shape
  and returns matching verified-transaction items.

Each provider tool call exposes its call ID, tool name, and arguments. Its
result is returned in an `{items: [...]}` envelope containing an ordered subset
of the corresponding snapshot collection. Results contain at most 20 items and
cannot introduce a value that was not already in the snapshot, even when the
provider requests a larger limit.

## Explicit exclusions

The accounting context and tool results do not include OAuth tokens, session
tokens, provider API credentials, a dedicated bank or credit-card account-number
field, raw QuickBooks payloads, unrelated transactions, unbounded company
history, unrestricted database access, or any mutation tool. The destination
provider still receives its own credential in the request `Authorization`
header.

Snapshot free text is normalized and rejected if it contains an account-number
shaped sequence of eight or more digits, including digits separated by spaces
or hyphens. That heuristic does not guarantee removal of shorter or differently
formatted account numbers. Callers must sanitize source account display names,
payees, memos, rules, and verified-history text before building a snapshot.

This boundary reduces disclosure; it does not anonymize the request. Payee,
memo, account display name, transaction identifiers, category/tax references,
rules, tags, and verified history may still be sensitive bookkeeping data.

## Hard limits

- Snapshot: 64 KiB serialized maximum.
- Candidate categories, tax references, tags, rules, and similar history: at
  most 20 retained items each; nested lines and ID lists: at most 20.
- Provider history: at most 40 entries and 64 KiB.
- Review candidate and provider response: 32 KiB each.
- Default run: four turns, eight total tool calls, 64 KiB context, 32 KiB response,
  and 30 seconds wall-clock time.
- Tool search query: 160 characters; requested results are capped to 20 even
  when a provider asks for more.
- The provider adapter separately rejects a single response or assistant
  history entry containing more than 20 tool calls.

The adapter does not log or persist request bodies, prompt history, tool-result
bodies, or provider response bodies. It structurally validates the provider
response envelope and tool turns, then returns either raw decision JSON or a
tool turn plus bounded token-usage metadata when the provider supplies it. The
runner parses and validates decision JSON against the decision schema. The pure
core converts invalid, oversized, timed-out, cancelled, or ambiguous output
into a typed error or structured abstention and has no path to stage or write
accounting data.

## Verification boundary

Deterministic verification checks balances, active category/tag/tax references,
tax eligibility, and evidence references. The runner records the validated
snapshot transaction revision in its result metadata. An optional review model
receives the same sanitized snapshot and candidate decision. Same-model review
is labeled as such and is not independent verification. No model response is
authorization to write to QuickBooks.
