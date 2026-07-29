// @recat/shared — API contract types shared by server and client.
// Mirrors "Recat Handoff.md" §1 (data model) and §4 (API surface).

export type Role = 'admin' | 'categorizer' | 'viewer';

/** How a QuickBooks connection is made: the real Intuit OAuth flow, or the
 * built-in demo (mock QuickBooks with sample companies). A user choice made
 * per connection — never a deployment-wide mode. */
export type ConnectMode = 'real' | 'demo';

/** Realm ids of the two built-in demo companies (Harbor & Main / Bluebird).
 * A Company row with one of these realm ids IS a demo company — client and
 * server both dispatch on this, independent of any env var. */
export const MOCK_REALM_IDS = ['9341002287640001', '4471889011230002'] as const;

export function isDemoRealmId(realmId: string): boolean {
  return (MOCK_REALM_IDS as readonly string[]).includes(realmId);
}

export type TxnStatus =
  | 'PENDING'
  | 'POSTING'
  | 'POSTED'
  | 'DRY_RUN'
  | 'ERROR'
  | 'SUPERSEDED'
  | 'REVERTED';

export type SyncMode = 'polling' | 'webhook';
export type QboEnv = 'sandbox' | 'production';
export type TaxCalculation = 'TaxInclusive' | 'TaxExcluded' | 'NotApplicable';
export type TaxSupportStatus = 'unsupported' | 'needs_setup' | 'ready';

export interface TaxCodeDto {
  qboId: string;
  name: string;
  active: boolean;
  taxable: boolean | null;
  combinedPurchaseRate: number | null;
}

export function isUsableTaxCodeDto(code: TaxCodeDto): boolean {
  return (
    code.active &&
    (
      (code.taxable === true &&
        code.combinedPurchaseRate !== null &&
        Number.isFinite(code.combinedPurchaseRate) &&
        code.combinedPurchaseRate >= 0 &&
        code.combinedPurchaseRate <= 999.999999) ||
      (code.taxable === false && code.combinedPurchaseRate === null)
    )
  );
}

export interface TaxReadinessDto {
  status: TaxSupportStatus;
  reason: string | null;
  usingSalesTax: boolean | null;
  refreshedAt: string | null;
  taxCodes: TaxCodeDto[];
}

export interface CategorizationProposalLine {
  /** Signed cents matching the transaction direction. */
  grossCents: number;
  categoryQboId: string;
  /** Required for taxable staging and omitted for NotApplicable. */
  taxCodeQboId?: string | null;
  memo?: string;
  tagIds: string[];
}

/** A normalized, client-authored categorization proposal.
 * Tax totals are deliberately absent: the server calculates them. */
export interface CategorizationProposal {
  taxCalculation: TaxCalculation;
  lines: CategorizationProposalLine[];
  tagIds: string[];
}

export interface StageCategorizationInput {
  transactionId: string;
  companyId: string;
  expectedRevision: number;
  proposal: CategorizationProposal;
}

export interface StagedCategorizationLine {
  idx: number;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  categoryQboId: string;
  taxCodeQboId: string | null;
  memo: string | null;
  /** Present on stage responses; optional for older internal prepared-write fixtures. */
  tagIds?: string[];
}

export interface StagedCategorization {
  transactionId: string;
  revision: number;
  taxCalculation: TaxCalculation;
  totals: {
    subtotalCents: number;
    taxCents: number;
    totalCents: number;
  };
  lines: StagedCategorizationLine[];
  tagIds: string[];
}

/** Largest revision that can be atomically incremented into a Prisma Int. */
export const MAX_EXPECTED_TRANSACTION_REVISION = 2_147_483_646;

/** Strict POST /api/transactions/:id/categorization/stage request body. */
export interface StageCategorizationBody {
  expectedRevision: number;
  taxCalculation: TaxCalculation;
  lines: Array<{
    grossCents: number;
    categoryQboId: string;
    taxCodeQboId: string | null;
    memo?: string;
    tagIds: string[];
  }>;
  tagIds: string[];
}

/** Strict POST /api/transactions/:id/categorization/commit request body. */
export interface CommitCategorizationBody {
  expectedRevision: number;
  requestId: string;
}

/** Reconciliation and reconciliation-only retry reuse the original request ID. */
export interface ReconcileCategorizationBody {
  requestId: string;
}

/** Undo starts a distinct durable mutation attempt. */
export interface UndoCategorizationBody {
  requestId: string;
}

export type CategorizationMutationOutcome =
  | 'VERIFIED'
  | 'UNCERTAIN'
  | 'IN_PROGRESS'
  | 'UNCHANGED'
  | 'DRY_RUN'
  | 'RETRYABLE';

export interface CategorizationMutationResult {
  transactionId: string;
  requestId: string;
  ok: boolean;
  status: TxnStatus;
  outcome: CategorizationMutationOutcome;
  error?: { code: string; message: string };
}

export interface ActiveCategorizationAttemptDto {
  requestId: string;
  operation: 'recategorize' | 'restore';
  status: 'PREPARED' | 'COMMITTING' | 'UNCERTAIN';
}

export type QboDiagnosticCode =
  | 'INVALID_CLIENT_CREDENTIALS'
  | 'REDIRECT_URI_MISMATCH'
  | 'AUTHORIZATION_EXPIRED'
  | 'ACCESS_DENIED'
  | 'STATE_EXPIRED'
  | 'INTUIT_UNAVAILABLE'
  | 'COMPANY_INFO_FAILED'
  | 'COMPANY_DISCONNECTED'
  | 'QBO_CONNECTION_FAILED';
export type PollInterval = 5 | 10 | 30 | 60;
export type SuggestionSource = 'rule' | 'history' | 'ai';
export type SuggestionSetting = 'builtin' | 'ai' | 'off';
export type SuggestionProvider = 'custom' | 'openrouter';

export type AgentMode = 'off' | 'shadow';
export type AgentJobStatus = 'queued' | 'running' | 'retry' | 'completed' | 'cancelled' | 'terminal';
export type AgentRunStatus = 'running' | 'verified' | 'abstain' | 'failed';

export interface AgentLimitsDto {
  maxToolCalls: number;
  maxTurns: number;
  maxContextBytes: number;
  maxResponseBytes: number;
  timeoutMs: number;
}

/** Company-scoped shadow configuration. Provider credentials are never included. */
export interface AgentCompanySettingsDto {
  mode: AgentMode;
  provider: SuggestionProvider;
  decisionModel: string;
  verifierModel: string;
  scheduleMinutes: number;
  companyConcurrency: number;
  evidenceThreshold: number;
  limits: AgentLimitsDto;
  configVersion: string;
}
export type AuditAction =
  | 'posted'
  | 'dry-run'
  | 'error'
  | 'reverted'
  | 'superseded'
  | 'transfer'
  | 'auto-posted';

export interface MembershipDto {
  companyId: string;
  role: Role;
}

export interface UserDto {
  id: string;
  email: string;
  name: string | null;
  /** Instance admins manage settings/users/connections and are admin in every company. */
  isInstanceAdmin: boolean;
  invitePending: boolean;
  /** Per-company roles (handoff §5 matrix, scoped per company). */
  memberships: MembershipDto[];
}

/** Effective role for a company: instance admins are admin everywhere. */
export function roleFor(user: UserDto, companyId: string | null): Role | null {
  if (user.isInstanceAdmin) return 'admin';
  if (companyId === null) return null;
  return user.memberships.find((m) => m.companyId === companyId)?.role ?? null;
}

/** One row of a company's Team card: the member's role IN THAT COMPANY. */
export interface TeamMemberDto {
  id: string;
  email: string;
  name: string | null;
  /** Effective role in the company ('admin' for instance admins). */
  role: Role;
  invitePending: boolean;
  /** True when access comes from instance adminship, not a Membership row. */
  isInstanceAdmin: boolean;
}

export interface CompanyDto {
  id: string;
  realmId: string;
  legalName: string;
  nickname: string;
  env: QboEnv;
  syncMode: SyncMode;
  pollIntervalMin: PollInterval;
  holdingAccountIds: string[];
  dryRun: boolean;
  tagsRequired: boolean;
  connectedAt: string;
  disconnectedAt: string | null;
  lastSyncedAt: string | null;
}

export interface QboPreflightDto {
  ok: boolean;
  clientIdConfigured: boolean;
  clientSecretConfigured: boolean;
  environment: QboEnv;
  redirectUri: string;
  requiresOAuth: true;
}

export interface QboConnectionTestDto {
  ok: true;
  companyId: string;
  legalName: string;
  environment: QboEnv;
  mode: 'quickbooks' | 'demo';
  checkedAt: string;
}

export interface SplitDto {
  amount: number; // splits must sum to Transaction.amount (absolute value semantics: signed like txn)
  category: string; // display name
  categoryQboId?: string;
  taxCode?: string | null;
  taxCodeQboId?: string | null;
  tagIds: string[];
  memo?: string;
}

export interface SuggestionDto {
  category: string;
  categoryQboId?: string;
  source: SuggestionSource;
  ruleId?: string;
  /** Total rules matching the payee (set when source = 'rule'). */
  matchedRules?: number;
  /** matchText of the winning (topmost) rule (set when source = 'rule'). */
  winnerMatchText?: string;
}

export interface TransactionDto {
  id: string;
  companyId: string;
  qboId: string;
  qboType: 'Purchase' | 'Deposit' | 'JournalEntry';
  date: string; // ISO
  payee: string;
  memo: string | null;
  amount: number; // signed; + = money in
  bankAccount: string;
  status: TxnStatus;
  /** Current local staging revision; tax-aware staging must send this exact value. */
  revision: number;
  category: string | null;
  categoryQboId: string | null;
  taxCalculation: TaxCalculation | null;
  taxCode: string | null;
  taxCodeQboId: string | null;
  splits: SplitDto[] | null;
  tagIds: string[];
  suggestion: SuggestionDto | null;
  error: { code: string; message: string } | null;
  postedAt: string | null;
  postedBy: string | null;
  /** Latest unresolved durable write attempt, reduced to reconciliation-safe fields. */
  activeCategorizationAttempt: ActiveCategorizationAttemptDto | null;
  /** id of a detected transfer counterpart (equal |amount|, opposite sign, different account, ≤3 days) */
  transferCandidateId?: string | null;
}

export interface TagDto {
  id: string;
  companyId: string;
  name: string;
  color: string;
  usageCount?: number;
}

/** One transaction hit by a draft rule tested via POST /rules/test. */
export interface RuleTestMatch {
  txnId: string;
  payee: string;
  date: string; // ISO
  amount: number;
  status: TxnStatus;
  /** Would the draft rule win against the existing rules for this payee? */
  wouldWin: boolean;
  /** matchText of the existing winning rule for this payee (null if none). */
  currentWinner: string | null;
}

/** Existing rule that also matches at least one of the tested payees. */
export interface RuleTestConflict {
  ruleId: string;
  matchText: string;
  category: string;
  priority: number;
}

export interface RuleTestResult {
  matches: RuleTestMatch[];
  pendingCount: number;
  postedCount: number;
  conflicts: RuleTestConflict[];
}

export interface RuleDto {
  id: string;
  companyId: string;
  /** Match order — lowest number wins when several rules match a payee. */
  priority: number;
  matchField: 'payee';
  matchText: string;
  category: string;
  categoryQboId: string | null;
  taxCalculation: TaxCalculation | null;
  taxCode: string | null;
  taxCodeQboId: string | null;
  tagIds: string[];
  autoPost: boolean;
  createdAt: string;
}

export interface SavedReportConfig {
  range: string; // 'all' | 'YYYY-MM'
  flow: 'in' | 'out' | 'both';
  account: string; // 'all' | bank account name
  groupBy: 'tag' | 'cat' | 'acct';
  tagIds: string[];
}

export interface SavedReportDto {
  id: string;
  companyId: string;
  name: string;
  config: SavedReportConfig;
}

export interface AuditEntryDto {
  id: string;
  companyId: string;
  at: string;
  actor: string; // display name or 'system'
  payee: string;
  amount: number;
  action: AuditAction;
  before: string;
  after: string;
  payload?: unknown;
}

export interface QboAccountDto {
  id: string;
  qboId: string;
  name: string;
  fullName: string;
  classification: string; // Income | COGS | Expenses | ...
  active: boolean;
}

export interface SyncLogDto {
  id: string;
  kind: 'poll' | 'webhook' | 'manual' | 'nightly' | 'initial';
  ok: boolean;
  message: string;
  at: string;
}

export interface InstanceSettingsDto {
  intuitClientId: string; // masked when read
  intuitClientSecretSet: boolean;
  redirectUri: string;
  webhookVerifierTokenSet: boolean;
  suggestionSource: SuggestionSetting;
  suggestionProvider: SuggestionProvider;
  suggestionModel: string;
  agentDecisionModel: string;
  agentVerifierModel: string;
  aiEndpoint: string | null;
  aiKeySet: boolean;
  openrouterKeySet: boolean;
  openrouterReferer: string;
  openrouterTitle: string;
  needsSetup: boolean; // true until an admin user exists
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpFrom: string;
  smtpPassSet: boolean;
  smtpConfigured: boolean; // an SMTP host is present (env var or DB)
  smtpFromEnv: boolean; // true → SMTP managed by env vars; DB values ignored
}

export interface SessionDto {
  user: UserDto;
}

export interface AuthMethodsDto {
  localAdmin: boolean;
}

// ---- Report payloads ----

export interface StatementCell {
  value: number;
  text: string; // formatted, negatives in parentheses
}

export interface StatementRow {
  label: string;
  kind: 'head' | 'line' | 'total' | 'grand';
  indent: boolean;
  cells: StatementCell[];
  /** present on account 'line' rows — enables transaction drill-down */
  accountQboId?: string;
}

export interface StatementDto {
  title: string;
  subtitle: string;
  columns: { label: string }[];
  rows: StatementRow[];
  basisLabel: string;
  /** primary column's date range (YYYY-MM-DD) — the drill-down window */
  period?: { start: string; end: string };
}

export interface StatementDrilldownRow {
  date: string; // YYYY-MM-DD
  payee: string;
  memo?: string;
  /** signed; + = money in */
  amount: number;
  txnType: string;
}

export interface StatementDrilldownDto {
  accountName: string;
  rows: StatementDrilldownRow[];
}

/** One row of the whole-company transaction log (read straight from QuickBooks). */
export interface TransactionLogRowDto {
  date: string; // YYYY-MM-DD
  txnType: string;
  docNum?: string;
  payee: string;
  memo?: string;
  /** the account the transaction is entered against (bank / credit card) */
  account: string;
  /** QBO's Split column — the categorization; multi-line entities read '- Split -' */
  category: string;
  /** signed; + = money in */
  amount: number;
  /** stable entity key ("<qboType>:<qboId>") — present when the row is taggable */
  qboKey?: string;
  /** Recat tags on this transaction (queue tags and log tags merged) */
  tagIds: string[];
}

export interface TransactionLogDto {
  start: string;
  end: string;
  rows: TransactionLogRowDto[];
}

/** PUT /reports/transaction-log/tags */
export interface LogTagsBody {
  qboKey: string;
  tagIds: string[];
}

export interface CustomReportRow {
  name: string;
  color: string | null;
  count: number;
  total: number;
}

export interface CustomReportDto {
  rows: CustomReportRow[];
  count: number;
  total: number;
}

// ---- Dashboard ----

export type WidgetType = 'rev' | 'exp' | 'net' | 'uncat' | 'chart' | 'break' | 'pl';

export interface DashboardWidget {
  t: WidgetType;
  sp: 1 | 2 | 3 | 4;
}

export interface DashboardDataDto {
  months: string[];
  rev: number[];
  exp: number[];
  breakdown: { name: string; amount: number }[];
  pl: { income: number; cogs: number; expenses: number };
  pendingCount: number;
  pendingTotal: number;
}

// ---- Request bodies ----

export interface CategorizeBody {
  category?: string | null;
  categoryQboId?: string | null;
  splits?: SplitDto[] | null;
  tagIds?: string[];
}

export interface CompanyPatchBody {
  nickname?: string;
  syncMode?: SyncMode;
  pollIntervalMin?: PollInterval;
  holdingAccountIds?: string[];
  dryRun?: boolean;
  tagsRequired?: boolean;
}

export interface ApiError {
  error: string;
  code?: string;
}
