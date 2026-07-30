import { types as nodeTypes } from 'node:util';
import {
  agentDecisionSchemaVersion,
  parseAgentDecision,
  type AgentDecision,
} from './core/decision.js';
import {
  AGENT_MODEL_PROMPT_VERSION,
  type AgentModelProvider,
} from './core/model.js';
import type {
  AgentRunResult,
  AgentVerificationMode,
} from './core/runner.js';
import {
  serializeAgentSnapshot,
  type AgentTransactionSnapshot,
} from './core/snapshot.js';
import {
  verifyAgentDecision,
  type AgentVerification,
} from './core/verifier.js';

/** Bump when a previously denied mutation shape becomes eligible. */
export const LIVE_ELIGIBILITY_VERSION = 'purchase-negative-v1';

export type LiveEligibilityCode =
  | 'ELIGIBLE'
  | 'INPUT_INVALID'
  | 'ENTITY_UNSUPPORTED'
  | 'REFUND_REVIEW_REQUIRED'
  | 'MULTI_CURRENCY_REVIEW_REQUIRED'
  | 'QBO_STATE_DRIFT'
  | 'FRESHNESS_REQUIRED'
  | 'HUMAN_STAGING_PRESENT'
  | 'ACTIVE_RULE_PRESENT'
  | 'RULE_CONFLICT'
  | 'WRITE_LEASE_CONFLICT'
  | 'DECISION_ABSTAINED'
  | 'VERIFICATION_REQUIRED'
  | 'CONFIDENCE_LOW'
  | 'PROPOSAL_WARNING'
  | 'PROPOSAL_INVALID';

export type LiveEligibilityResult = Readonly<{
  eligible: boolean;
  code: LiveEligibilityCode;
  policyVersion: typeof LIVE_ELIGIBILITY_VERSION;
}>;

/**
 * The current transaction authority. Expected QBO fields come from the
 * transaction projection; current fields come from the fresh provider read.
 */
export interface LiveTransactionState {
  readonly id: string;
  readonly qboType: string;
  readonly expectedQboId: string;
  readonly currentQboId: string;
  readonly expectedSyncToken: string;
  readonly currentSyncToken: string;
  readonly revision: number;
  readonly status: string;
  readonly amountCents: number;
  readonly currency: string;
  readonly qboState: 'current' | 'drifted';
}

/** Current company and code identities loaded with the transaction authority. */
export interface LivePolicyConfig {
  readonly companyCurrency: string;
  readonly minimumConfidence: number;
  readonly configVersion: string;
  readonly provider: AgentModelProvider;
  readonly decisionModel: string;
  readonly verifierModel: string;
}

/**
 * Exact PR6 run output and deterministic proof, plus the durable AgentRun
 * identities PR6 persists separately from AgentRunResult.
 */
export interface LiveReviewedRun {
  readonly transactionId: string;
  readonly configVersion: string;
  readonly verifierModel: string;
  readonly result: AgentRunResult;
  readonly verification: AgentVerification;
}

export interface LiveCoordinationState {
  readonly humanStagingPresent: boolean;
  readonly activeRuleCount: number;
  readonly ruleConflict: boolean;
  readonly writeLeaseConflict: boolean;
}

export interface LiveEligibilityInput {
  readonly snapshot: AgentTransactionSnapshot;
  readonly transaction: LiveTransactionState;
  readonly config: LivePolicyConfig;
  readonly reviewedRun: LiveReviewedRun;
  readonly coordination: LiveCoordinationState;
  /** Opaque operational warnings; policy intentionally never returns them. */
  readonly warnings: readonly string[];
}

interface CanonicalRunResult {
  readonly status: 'verified' | 'abstain';
  readonly decision: AgentDecision;
  readonly snapshotRevision: number;
  readonly decisionProvider: string;
  readonly decisionModel: string;
  readonly promptVersion: string;
  readonly schemaVersion: number;
  readonly durationMs: number;
  readonly turns: number;
  readonly toolCalls: number;
  readonly verificationMode: AgentVerificationMode;
  readonly diagnosticCode: string;
  readonly usage?: Readonly<{
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  }>;
  readonly providerFailure?: Readonly<{
    code: string;
    classification: 'retryable' | 'terminal';
  }>;
}

type CanonicalVerification =
  | Readonly<{
    ok: true;
    code: string;
    message: string;
    decision: AgentDecision;
  }>
  | Readonly<{
    ok: false;
    code: string;
    message: string;
  }>;

interface CanonicalInput {
  readonly snapshot: AgentTransactionSnapshot;
  readonly transaction: LiveTransactionState;
  readonly config: LivePolicyConfig;
  readonly reviewedRun: Omit<LiveReviewedRun, 'result' | 'verification'> & {
    readonly result: CanonicalRunResult;
    readonly verification: CanonicalVerification;
  };
  readonly coordination: LiveCoordinationState;
  readonly warnings: readonly string[];
}

const MAX_IDENTIFIER_LENGTH = 200;
const CURRENT_SNAPSHOT_FEATURE_VERSION = 'shadow-core.1';
const MAX_WARNING_LENGTH = 2_000;
const MAX_CANONICAL_DEPTH = 32;
const MAX_CANONICAL_NODES = 10_000;
const MAX_RECORD_KEYS = 100;
const MAX_ARRAY_ITEMS = 100;
const MAX_STRING_LENGTH = 8_000;
const QBO_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CURRENCY = /^[A-Z]{3}$/;

const ROOT_KEYS = [
  'snapshot',
  'transaction',
  'config',
  'reviewedRun',
  'coordination',
  'warnings',
] as const;
const TRANSACTION_KEYS = [
  'id',
  'qboType',
  'expectedQboId',
  'currentQboId',
  'expectedSyncToken',
  'currentSyncToken',
  'revision',
  'status',
  'amountCents',
  'currency',
  'qboState',
] as const;
const CONFIG_KEYS = [
  'companyCurrency',
  'minimumConfidence',
  'configVersion',
  'provider',
  'decisionModel',
  'verifierModel',
] as const;
const REVIEWED_RUN_KEYS = [
  'transactionId',
  'configVersion',
  'verifierModel',
  'result',
  'verification',
] as const;
const RESULT_KEYS = [
  'status',
  'decision',
  'snapshotRevision',
  'decisionProvider',
  'decisionModel',
  'promptVersion',
  'schemaVersion',
  'durationMs',
  'turns',
  'toolCalls',
  'verificationMode',
  'diagnosticCode',
] as const;
const COORDINATION_KEYS = [
  'humanStagingPresent',
  'activeRuleCount',
  'ruleConflict',
  'writeLeaseConflict',
] as const;

class LiveInputError extends Error {}
class LiveProposalError extends Error {}

const eligible = (): LiveEligibilityResult => ({
  eligible: true,
  code: 'ELIGIBLE',
  policyVersion: LIVE_ELIGIBILITY_VERSION,
});

const denied = (code: Exclude<LiveEligibilityCode, 'ELIGIBLE'>): LiveEligibilityResult => ({
  eligible: false,
  code,
  policyVersion: LIVE_ELIGIBILITY_VERSION,
});

/**
 * Evaluates one detached, deeply frozen canonical value. Caller-owned input is
 * never read again after canonicalization. The policy does not calculate tax,
 * perform I/O, read model prose, or return a proposal.
 */
export function evaluateLiveEligibility(input: LiveEligibilityInput): LiveEligibilityResult {
  let canonical: CanonicalInput;
  try {
    canonical = canonicalInput(input);
  } catch (error) {
    return denied(error instanceof LiveProposalError ? 'PROPOSAL_INVALID' : 'INPUT_INVALID');
  }

  const {
    snapshot,
    transaction,
    config,
    reviewedRun,
    coordination,
    warnings,
  } = canonical;
  const result = reviewedRun.result;
  const decision = result.decision;

  if (transaction.qboType !== 'Purchase') return denied('ENTITY_UNSUPPORTED');
  if (transaction.amountCents >= 0) return denied('REFUND_REVIEW_REQUIRED');
  if (
    transaction.currency !== config.companyCurrency
    || snapshot.currency !== transaction.currency
  ) return denied('MULTI_CURRENCY_REVIEW_REQUIRED');
  if (
    transaction.qboState !== 'current'
    || transaction.expectedQboId !== transaction.currentQboId
    || transaction.expectedSyncToken !== transaction.currentSyncToken
  ) return denied('QBO_STATE_DRIFT');
  if (
    transaction.status !== 'PENDING'
    || snapshot.transaction.id !== transaction.id
    || snapshot.transaction.revision !== transaction.revision
    || snapshot.signedAmountCents !== transaction.amountCents
    || snapshot.configurationVersion !== config.configVersion
    || snapshot.featureVersion !== CURRENT_SNAPSHOT_FEATURE_VERSION
  ) return denied('FRESHNESS_REQUIRED');

  if (coordination.humanStagingPresent) return denied('HUMAN_STAGING_PRESENT');
  if (snapshot.rules.length > 0 || coordination.activeRuleCount > 0) {
    return denied('ACTIVE_RULE_PRESENT');
  }
  if (coordination.ruleConflict) return denied('RULE_CONFLICT');
  if (coordination.writeLeaseConflict) return denied('WRITE_LEASE_CONFLICT');
  if (warnings.length > 0) return denied('PROPOSAL_WARNING');
  if (decision.kind === 'abstain') return denied('DECISION_ABSTAINED');
  if (decision.confidence < config.minimumConfidence) return denied('CONFIDENCE_LOW');

  const deterministic = verifyAgentDecision(snapshot, decision);
  if (!deterministic.ok) return denied('PROPOSAL_INVALID');
  if (
    result.status !== 'verified'
    || reviewedRun.transactionId !== snapshot.transaction.id
    || reviewedRun.configVersion !== snapshot.configurationVersion
    || result.snapshotRevision !== snapshot.transaction.revision
    || result.decisionProvider !== config.provider
    || result.decisionModel !== config.decisionModel
    || reviewedRun.verifierModel !== config.verifierModel
    || config.decisionModel === config.verifierModel
    || result.promptVersion !== AGENT_MODEL_PROMPT_VERSION
    || result.schemaVersion !== agentDecisionSchemaVersion
    || result.verificationMode !== 'distinct_model'
    || result.diagnosticCode !== 'AGENT_RUN_VERIFIED'
    || result.providerFailure !== undefined
    || canonicalJson(reviewedRun.verification) !== canonicalJson(deterministic)
  ) return denied('VERIFICATION_REQUIRED');

  return eligible();
}

function canonicalInput(input: unknown): CanonicalInput {
  const detached = clonePlainData(input, { nodes: 0 }, 0);
  const root = exactRecord(detached, ROOT_KEYS);
  return deepFreeze({
    snapshot: snapshot(root.snapshot),
    transaction: transaction(root.transaction),
    config: config(root.config),
    reviewedRun: reviewedRun(root.reviewedRun),
    coordination: coordination(root.coordination),
    warnings: warnings(root.warnings),
  });
}

function transaction(value: unknown): LiveTransactionState {
  const record = exactRecord(value, TRANSACTION_KEYS);
  const qboState = record.qboState;
  if (qboState !== 'current' && qboState !== 'drifted') invalid();
  return {
    id: uuid(record.id),
    qboType: opaqueText(record.qboType),
    expectedQboId: reference(record.expectedQboId),
    currentQboId: reference(record.currentQboId),
    expectedSyncToken: reference(record.expectedSyncToken),
    currentSyncToken: reference(record.currentSyncToken),
    revision: nonnegativeInteger(record.revision),
    status: opaqueText(record.status),
    amountCents: safeInteger(record.amountCents),
    currency: currency(record.currency),
    qboState,
  };
}

function config(value: unknown): CanonicalInput['config'] {
  const record = exactRecord(value, CONFIG_KEYS);
  const minimumConfidence = record.minimumConfidence;
  if (
    typeof minimumConfidence !== 'number'
    || !Number.isFinite(minimumConfidence)
    || minimumConfidence < 0
    || minimumConfidence > 1
  ) invalid();
  return {
    companyCurrency: currency(record.companyCurrency),
    minimumConfidence,
    configVersion: version(record.configVersion),
    provider: provider(record.provider),
    decisionModel: opaqueText(record.decisionModel),
    verifierModel: opaqueText(record.verifierModel),
  };
}

function reviewedRun(value: unknown): CanonicalInput['reviewedRun'] {
  const record = exactRecord(value, REVIEWED_RUN_KEYS);
  return {
    transactionId: uuid(record.transactionId),
    configVersion: version(record.configVersion),
    verifierModel: opaqueText(record.verifierModel),
    result: runResult(record.result),
    verification: verification(record.verification),
  };
}

function runResult(value: unknown): CanonicalRunResult {
  const record = exactRecord(value, RESULT_KEYS, ['usage', 'providerFailure']);
  const status = record.status;
  if (status !== 'verified' && status !== 'abstain') invalid();
  const verificationMode = record.verificationMode;
  if (
    verificationMode !== 'deterministic'
    && verificationMode !== 'same_model'
    && verificationMode !== 'distinct_model'
  ) invalid();
  return {
    status,
    decision: decision(record.decision),
    snapshotRevision: nonnegativeInteger(record.snapshotRevision),
    decisionProvider: opaqueText(record.decisionProvider),
    decisionModel: opaqueText(record.decisionModel),
    promptVersion: version(record.promptVersion),
    schemaVersion: nonnegativeInteger(record.schemaVersion),
    ...(record.usage === undefined ? {} : { usage: usage(record.usage) }),
    durationMs: nonnegativeInteger(record.durationMs),
    turns: nonnegativeInteger(record.turns),
    toolCalls: nonnegativeInteger(record.toolCalls),
    verificationMode,
    diagnosticCode: opaqueText(record.diagnosticCode),
    ...(record.providerFailure === undefined
      ? {}
      : { providerFailure: providerFailure(record.providerFailure) }),
  };
}

function verification(value: unknown): CanonicalVerification {
  const record = recordOf(value);
  if (record.ok === true) {
    exactKeys(record, ['ok', 'code', 'message', 'decision']);
    return {
      ok: true,
      code: opaqueText(record.code),
      message: boundedText(record.message, 500),
      decision: decision(record.decision),
    };
  }
  if (record.ok === false) {
    exactKeys(record, ['ok', 'code', 'message']);
    return {
      ok: false,
      code: opaqueText(record.code),
      message: boundedText(record.message, 500),
    };
  }
  invalid();
}

function usage(value: unknown): NonNullable<CanonicalRunResult['usage']> {
  const record = recordOf(value);
  const keys = Object.keys(record);
  if (
    keys.length === 0
    || keys.some((key) =>
      key !== 'inputTokens'
      && key !== 'outputTokens'
      && key !== 'totalTokens')
  ) invalid();
  return {
    ...(record.inputTokens === undefined
      ? {}
      : { inputTokens: nonnegativeInteger(record.inputTokens) }),
    ...(record.outputTokens === undefined
      ? {}
      : { outputTokens: nonnegativeInteger(record.outputTokens) }),
    ...(record.totalTokens === undefined
      ? {}
      : { totalTokens: nonnegativeInteger(record.totalTokens) }),
  };
}

function providerFailure(
  value: unknown,
): NonNullable<CanonicalRunResult['providerFailure']> {
  const record = exactRecord(value, ['code', 'classification']);
  const classification = record.classification;
  if (classification !== 'retryable' && classification !== 'terminal') invalid();
  return { code: opaqueText(record.code), classification };
}

function coordination(value: unknown): LiveCoordinationState {
  const record = exactRecord(value, COORDINATION_KEYS);
  return {
    humanStagingPresent: boolean(record.humanStagingPresent),
    activeRuleCount: nonnegativeInteger(record.activeRuleCount),
    ruleConflict: boolean(record.ruleConflict),
    writeLeaseConflict: boolean(record.writeLeaseConflict),
  };
}

function warnings(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 20) invalid();
  return value.map((entry) => boundedText(entry, MAX_WARNING_LENGTH));
}

function snapshot(value: unknown): AgentTransactionSnapshot {
  try {
    const serialized = serializeAgentSnapshot(
      value as AgentTransactionSnapshot,
      64 * 1024,
    );
    return deepFreeze(JSON.parse(serialized) as AgentTransactionSnapshot);
  } catch {
    invalid();
  }
}

function decision(value: unknown): AgentDecision {
  try {
    return parseAgentDecision({ decision: value });
  } catch {
    throw new LiveProposalError();
  }
}

function clonePlainData(
  value: unknown,
  budget: { nodes: number },
  depth: number,
): unknown {
  budget.nodes += 1;
  if (budget.nodes > MAX_CANONICAL_NODES || depth > MAX_CANONICAL_DEPTH) invalid();
  if (
    value === null
    || typeof value === 'boolean'
  ) return value;
  if (typeof value === 'string') {
    if (value.length > MAX_STRING_LENGTH) invalid();
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid();
    return value;
  }
  if (typeof value !== 'object' || nodeTypes.isProxy(value)) invalid();

  if (Array.isArray(value)) {
    if (
      Object.getPrototypeOf(value) !== Array.prototype
      || value.length > MAX_ARRAY_ITEMS
    ) invalid();
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== value.length + 1
      || keys.some((key) =>
        key !== 'length'
        && (typeof key !== 'string' || !arrayIndex(key, value.length)))
    ) invalid();
    const copy: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined
        || !descriptor.enumerable
        || !('value' in descriptor)
      ) invalid();
      copy.push(clonePlainData(descriptor.value, budget, depth + 1));
    }
    return copy;
  }

  if (Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length > MAX_RECORD_KEYS
    || keys.some((key) => typeof key !== 'string')
  ) invalid();
  const copy: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !('value' in descriptor)
    ) invalid();
    copy[key] = clonePlainData(descriptor.value, budget, depth + 1);
  }
  return copy;
}

function exactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  const record = recordOf(value);
  exactKeys(record, required, optional);
  return record;
}

function exactKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(record);
  if (
    required.some((key) => !Object.hasOwn(record, key))
    || keys.some((key) => !allowed.has(key))
  ) invalid();
}

function recordOf(value: unknown): Record<string, unknown> {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) invalid();
  return value as Record<string, unknown>;
}

function provider(value: unknown): AgentModelProvider {
  if (value === 'openrouter' || value === 'custom' || value === 'fake') return value;
  invalid();
}

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) invalid();
  return value.toLowerCase();
}

function reference(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length > MAX_IDENTIFIER_LENGTH
    || !QBO_REFERENCE.test(value)
  ) invalid();
  return value;
}

function opaqueText(value: unknown): string {
  return boundedText(value, MAX_IDENTIFIER_LENGTH);
}

function version(value: unknown): string {
  const result = boundedText(value, 80);
  if (!VERSION.test(result)) invalid();
  return result;
}

function boundedText(value: unknown, maximum: number): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > maximum
  ) invalid();
  return value;
}

function currency(value: unknown): string {
  if (typeof value !== 'string' || !CURRENCY.test(value)) invalid();
  return value;
}

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') invalid();
  return value;
}

function safeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) invalid();
  return value;
}

function nonnegativeInteger(value: unknown): number {
  const result = safeInteger(value);
  if (result < 0) invalid();
  return result;
}

function arrayIndex(key: string, length: number): boolean {
  if (!/^(0|[1-9]\d*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}

function invalid(): never {
  throw new LiveInputError();
}
