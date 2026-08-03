import { createHash } from 'node:crypto';
import {
  parseAgentDecision,
  type AgentDecision,
} from './core/decision.js';
import type {
  AgentModel,
  AgentModelIdentity,
} from './core/model.js';
import {
  serializeAgentSnapshot,
  type AgentTransactionSnapshot,
} from './core/snapshot.js';
import {
  parseAgentLiveReview,
  verifyAgentDecision,
  type AgentVerification,
} from './core/verifier.js';

const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_REVIEW_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 20_000;
const MAX_SUCCESS_TTL_MS = 5 * 60_000;
const MAX_CACHE_ENTRIES = 128;
const MAX_LIVE_SNAPSHOT_BYTES = 64 * 1024;

export interface LiveModelProbe {
  readonly identity: AgentModelIdentity;
}

export interface LiveModelReviewResponse {
  readonly identity: AgentModelIdentity;
  readonly rawReview: unknown;
}

export interface LiveAgentModel extends AgentModel {
  /** Opaque digest of provider, endpoint, requested model, and credentials. */
  readonly healthAuthority: string;
  probe(signal: AbortSignal): Promise<LiveModelProbe>;
  reviewLiveDecision(
    input: {
      readonly snapshot: AgentTransactionSnapshot;
      readonly candidateDecision: AgentDecision;
    },
    signal: AbortSignal,
  ): Promise<LiveModelReviewResponse>;
}

export interface ProbeAgentModelOptions {
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly successTtlMs?: number;
  /** Opaque digest binding health to the current company configuration version. */
  readonly authorityContext?: string;
  /** Ignore a completed success cache entry while still sharing an in-flight probe. */
  readonly bypassSuccessCache?: boolean;
}

export interface LiveVerificationInput {
  readonly snapshot: AgentTransactionSnapshot;
  readonly decision: AgentDecision;
}

export interface LiveVerifierDeps {
  readonly decisionModel: LiveAgentModel;
  readonly verifierModel: LiveAgentModel;
  readonly timeoutMs?: number;
  readonly now?: () => number;
  readonly authorityContext?: string;
}

export type LiveAgentVerification = AgentVerification & {
  readonly liveIdentityProof?: {
    readonly version: 1;
    readonly providerBinding: string;
    readonly decisionIdentity: string;
    readonly verifierIdentity: string;
  };
};

export type LiveVerifierErrorCode =
  | 'MODEL_HEALTH_UNAVAILABLE'
  | 'VERIFIER_NOT_DISTINCT'
  | 'LIVE_VERIFIER_TIMEOUT'
  | 'LIVE_VERIFICATION_INPUT_INVALID'
  | 'LIVE_VERIFIER_RESPONSE_INVALID'
  | 'LIVE_VERIFIER_IDENTITY_MISMATCH'
  | 'LIVE_VERIFIER_UNAVAILABLE';

const ERROR_MESSAGES: Readonly<Record<LiveVerifierErrorCode, string>> = {
  MODEL_HEALTH_UNAVAILABLE: 'Configured agent model health check failed.',
  VERIFIER_NOT_DISTINCT: 'Live verifier model must be distinct.',
  LIVE_VERIFIER_TIMEOUT: 'Live verifier request timed out.',
  LIVE_VERIFICATION_INPUT_INVALID: 'Live verification input is invalid.',
  LIVE_VERIFIER_RESPONSE_INVALID: 'Live verifier returned an invalid response.',
  LIVE_VERIFIER_IDENTITY_MISMATCH: 'Live verifier identity changed during review.',
  LIVE_VERIFIER_UNAVAILABLE: 'Live verifier request failed.',
};

export class LiveVerifierError extends Error {
  constructor(readonly code: LiveVerifierErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'LiveVerifierError';
  }
}

interface CachedProbe {
  readonly expiresAt: number;
  readonly probe: LiveModelProbe;
}

const successfulProbes = new Map<string, CachedProbe>();
const inFlightProbes = new Map<string, Promise<LiveModelProbe>>();

export function modelIdentity(model: Pick<AgentModel, 'identity'>): string {
  return canonicalIdentity(model.identity);
}

export async function probeAgentModel(
  model: LiveAgentModel,
  options: ProbeAgentModelOptions = {},
): Promise<LiveModelProbe> {
  const now = checkedNow(options.now?.() ?? Date.now());
  const timeoutMs = checkedDuration(options.timeoutMs, DEFAULT_PROBE_TIMEOUT_MS);
  const successTtlMs = Math.min(
    checkedDuration(options.successTtlMs, MAX_SUCCESS_TTL_MS),
    MAX_SUCCESS_TTL_MS,
  );
  const cacheKey = probeCacheKey(model, options.authorityContext);
  const inFlightKey = `${cacheKey}:${timeoutMs}`;
  pruneProbeCache(now);
  const cached = successfulProbes.get(cacheKey);
  if (
    options.bypassSuccessCache !== true
    && cached !== undefined
    && cached.expiresAt > now
  ) return cached.probe;
  successfulProbes.delete(cacheKey);

  const existing = inFlightProbes.get(inFlightKey);
  if (existing !== undefined) return existing;

  const operation = runProbe(model, timeoutMs)
    .then((probe) => {
      const completedAt = checkedNow(options.now?.() ?? Date.now());
      successfulProbes.set(cacheKey, {
        expiresAt: completedAt + successTtlMs,
        probe,
      });
      pruneProbeCache(completedAt);
      return probe;
    })
    .finally(() => {
      inFlightProbes.delete(inFlightKey);
    });
  inFlightProbes.set(inFlightKey, operation);
  return operation;
}

export async function verifyLiveDecision(
  input: LiveVerificationInput,
  deps: LiveVerifierDeps,
): Promise<LiveAgentVerification> {
  let immutableSnapshot: AgentTransactionSnapshot;
  let immutableDecision: AgentDecision;
  try {
    immutableSnapshot = deepFreeze(
      JSON.parse(serializeAgentSnapshot(
        input.snapshot,
        MAX_LIVE_SNAPSHOT_BYTES,
      )),
    ) as AgentTransactionSnapshot;
    immutableDecision = parseAgentDecision({ decision: input.decision });
  } catch {
    throw new LiveVerifierError('LIVE_VERIFICATION_INPUT_INVALID');
  }
  const deterministic = verifyAgentDecision(immutableSnapshot, immutableDecision);
  if (!deterministic.ok) return deterministic;

  const probeOptions = {
    now: deps.now,
    timeoutMs: deps.timeoutMs,
    authorityContext: deps.authorityContext,
  };
  const [decisionProbe, verifierProbe] = await Promise.all([
    probeAgentModel(deps.decisionModel, probeOptions),
    probeAgentModel(deps.verifierModel, probeOptions),
  ]);
  const decisionIdentity = canonicalIdentity(decisionProbe.identity);
  const verifierIdentity = canonicalIdentity(verifierProbe.identity);
  if (decisionIdentity === verifierIdentity) {
    throw new LiveVerifierError('VERIFIER_NOT_DISTINCT');
  }

  const timeoutMs = checkedDuration(deps.timeoutMs, DEFAULT_REVIEW_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: LiveModelReviewResponse;
  try {
    response = await raceAbort(
      deps.verifierModel.reviewLiveDecision({
        snapshot: immutableSnapshot,
        candidateDecision: deterministic.decision as AgentDecision,
      }, controller.signal),
      controller.signal,
    );
  } catch {
    if (controller.signal.aborted) {
      throw new LiveVerifierError('LIVE_VERIFIER_TIMEOUT');
    }
    throw new LiveVerifierError('LIVE_VERIFIER_UNAVAILABLE');
  } finally {
    clearTimeout(timer);
  }

  let responseIdentity: string;
  try {
    responseIdentity = canonicalIdentity(response.identity);
  } catch {
    throw new LiveVerifierError('LIVE_VERIFIER_RESPONSE_INVALID');
  }
  if (responseIdentity !== verifierIdentity) {
    throw new LiveVerifierError('LIVE_VERIFIER_IDENTITY_MISMATCH');
  }

  let review;
  try {
    review = parseAgentLiveReview(response.rawReview);
  } catch {
    throw new LiveVerifierError('LIVE_VERIFIER_RESPONSE_INVALID');
  }
  if (!review.approved) {
    return Object.freeze({
      ok: false,
      code: 'AGENT_DISTINCT_REVIEW_REJECTED',
      message: 'Distinct live review did not approve the proposal.',
    });
  }
  if (
    typeof deps.authorityContext !== 'string'
    || deps.authorityContext.trim() === ''
  ) {
    return deterministic;
  }
  return Object.freeze({
    ...deterministic,
    liveIdentityProof: Object.freeze({
      version: 1 as const,
      providerBinding: deps.authorityContext,
      decisionIdentity,
      verifierIdentity,
    }),
  });
}

async function runProbe(
  model: LiveAgentModel,
  timeoutMs: number,
): Promise<LiveModelProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const raw = await raceAbort(model.probe(controller.signal), controller.signal);
    const returned = canonicalIdentity(raw.identity);
    const requestedProvider = canonicalProvider(model.identity.provider);
    if (!returned.startsWith(`${requestedProvider}:`)) {
      throw new LiveVerifierError('MODEL_HEALTH_UNAVAILABLE');
    }
    return Object.freeze({
      identity: Object.freeze({
        provider: raw.identity.provider,
        model: raw.identity.model.trim().toLowerCase(),
      }),
    });
  } catch {
    throw new LiveVerifierError('MODEL_HEALTH_UNAVAILABLE');
  } finally {
    clearTimeout(timer);
  }
}

function canonicalIdentity(identity: AgentModelIdentity): string {
  const provider = canonicalProvider(identity.provider);
  if (
    typeof identity.model !== 'string'
    || identity.model.length > 200
    || identity.model.trim() === ''
    || /[\u0000-\u001f\u007f]/.test(identity.model)
  ) {
    throw new LiveVerifierError('MODEL_HEALTH_UNAVAILABLE');
  }
  return `${provider}:${identity.model.trim().toLowerCase()}`;
}

function canonicalProvider(provider: AgentModelIdentity['provider']): string {
  if (provider !== 'openrouter' && provider !== 'custom' && provider !== 'fake') {
    throw new LiveVerifierError('MODEL_HEALTH_UNAVAILABLE');
  }
  return provider;
}

function probeCacheKey(
  model: LiveAgentModel,
  authorityContext: string | undefined,
): string {
  if (
    typeof model.healthAuthority !== 'string'
    || model.healthAuthority.trim() === ''
    || model.healthAuthority.length > 512
  ) {
    throw new LiveVerifierError('MODEL_HEALTH_UNAVAILABLE');
  }
  if (
    authorityContext !== undefined
    && (
      typeof authorityContext !== 'string'
      || authorityContext.trim() === ''
      || authorityContext.length > 512
    )
  ) {
    throw new LiveVerifierError('MODEL_HEALTH_UNAVAILABLE');
  }
  const authority = JSON.stringify({
    version: 1,
    healthAuthority: model.healthAuthority,
    requestedIdentity: modelIdentity(model),
    authorityContext: authorityContext ?? null,
  });
  return createHash('sha256').update(authority, 'utf8').digest('hex');
}

function pruneProbeCache(now: number): void {
  for (const [key, value] of successfulProbes) {
    if (value.expiresAt <= now) successfulProbes.delete(key);
  }
  while (successfulProbes.size > MAX_CACHE_ENTRIES) {
    const oldest = successfulProbes.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    successfulProbes.delete(oldest);
  }
}

function checkedNow(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new LiveVerifierError('MODEL_HEALTH_UNAVAILABLE');
  }
  return value;
}

function checkedDuration(value: number | undefined, fallback: number): number {
  const duration = value ?? fallback;
  if (!Number.isInteger(duration) || duration < 1) {
    throw new LiveVerifierError('MODEL_HEALTH_UNAVAILABLE');
  }
  return Math.min(duration, MAX_TIMEOUT_MS);
}

async function raceAbort<Value>(
  operation: Promise<Value>,
  signal: AbortSignal,
): Promise<Value> {
  if (signal.aborted) throw new Error('aborted');
  let abortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abortListener = () => reject(new Error('aborted'));
    signal.addEventListener('abort', abortListener, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (abortListener !== undefined) signal.removeEventListener('abort', abortListener);
  }
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
