import type { LivePauseStateDto } from '@recat/shared';

export type LivePauseCode =
  | 'READBACK_MISMATCH'
  | 'UNCERTAIN_MUTATION'
  | 'MANUAL_PAUSE'
  | 'QBO_ERROR_BURST'
  | 'PROVIDER_ERROR_BURST'
  | 'TAX_REFERENCE_STALE'
  | 'LEASE_HEALTH_FAILED'
  | 'VERIFIER_NOT_DISTINCT'
  | 'POLICY_CONFIG_CHANGED'
  | 'SHADOW_DISAGREEMENT_DEGRADED'
  | 'SHADOW_ABSTENTION_DEGRADED'
  | 'BREAKER_EVIDENCE_INVALID'
  | 'SHADOW_MODE_UNHEALTHY'
  | 'EVIDENCE_INSUFFICIENT'
  | 'SHADOW_AGREEMENT_INSUFFICIENT'
  | 'SHADOW_ABSTENTION_EXCESSIVE'
  | 'SHADOW_ERROR_RATE_EXCESSIVE'
  | 'PROVIDER_UNHEALTHY'
  | 'QBO_DISCONNECTED'
  | 'WRITEBACK_DISABLED'
  | 'UNRESOLVED_MUTATION'
  | 'WORKER_UNHEALTHY'
  | 'LIVE_POLICY_NOT_ACCEPTED';

export const LIVE_PAUSE_PRIORITY: readonly LivePauseCode[] = [
  'READBACK_MISMATCH',
  'UNCERTAIN_MUTATION',
  'MANUAL_PAUSE',
  'QBO_ERROR_BURST',
  'PROVIDER_ERROR_BURST',
  'TAX_REFERENCE_STALE',
  'LEASE_HEALTH_FAILED',
  'VERIFIER_NOT_DISTINCT',
  'POLICY_CONFIG_CHANGED',
  'SHADOW_DISAGREEMENT_DEGRADED',
  'SHADOW_ABSTENTION_DEGRADED',
  'BREAKER_EVIDENCE_INVALID',
  'QBO_DISCONNECTED',
  'WRITEBACK_DISABLED',
  'UNRESOLVED_MUTATION',
  'WORKER_UNHEALTHY',
  'PROVIDER_UNHEALTHY',
  'LIVE_POLICY_NOT_ACCEPTED',
  'SHADOW_MODE_UNHEALTHY',
  'EVIDENCE_INSUFFICIENT',
  'SHADOW_AGREEMENT_INSUFFICIENT',
  'SHADOW_ABSTENTION_EXCESSIVE',
  'SHADOW_ERROR_RATE_EXCESSIVE',
];

const SAFE_PAUSE_MESSAGES: Readonly<Record<LivePauseCode, string>> = {
  READBACK_MISMATCH: 'A live mutation readback did not match durable intent.',
  UNCERTAIN_MUTATION: 'A live mutation requires reconciliation.',
  MANUAL_PAUSE: 'Live mode is paused by a company administrator.',
  QBO_ERROR_BURST: 'QuickBooks live operation health degraded.',
  PROVIDER_ERROR_BURST: 'Agent provider health degraded.',
  TAX_REFERENCE_STALE: 'Tax references are not ready or are stale.',
  LEASE_HEALTH_FAILED: 'Live worker lease health degraded.',
  VERIFIER_NOT_DISTINCT: 'Decision and verification identities are not distinct.',
  POLICY_CONFIG_CHANGED: 'The accepted live policy or configuration changed.',
  SHADOW_DISAGREEMENT_DEGRADED: 'Shadow agreement fell below the live policy minimum.',
  SHADOW_ABSTENTION_DEGRADED: 'Shadow abstention exceeded the live policy maximum.',
  BREAKER_EVIDENCE_INVALID: 'Live safety evidence is unavailable or invalid.',
  SHADOW_MODE_UNHEALTHY: 'Shadow mode must be healthy before live mode can be enabled.',
  EVIDENCE_INSUFFICIENT: 'Eligible shadow evidence is below the configured threshold.',
  SHADOW_AGREEMENT_INSUFFICIENT: 'Shadow agreement is below the live policy minimum.',
  SHADOW_ABSTENTION_EXCESSIVE: 'Shadow abstention is above the live policy maximum.',
  SHADOW_ERROR_RATE_EXCESSIVE: 'Shadow error rate is above the live policy maximum.',
  PROVIDER_UNHEALTHY: 'Configured model health checks have not passed.',
  QBO_DISCONNECTED: 'QuickBooks is disconnected.',
  WRITEBACK_DISABLED: 'QuickBooks writeback is disabled.',
  UNRESOLVED_MUTATION: 'Unresolved QuickBooks mutations must be reconciled.',
  WORKER_UNHEALTHY: 'Autopilot worker health is not ready.',
  LIVE_POLICY_NOT_ACCEPTED: 'The current live policy must be accepted.',
};

export interface LivePauseConfig {
  readonly liveRequested: boolean;
  readonly liveEnabledAt: Date | null;
  readonly livePausedAt: Date | null;
  readonly livePauseCode: string | null;
  readonly livePauseMessage: string | null;
}

interface LivePausePersistence<T extends LivePauseConfig> {
  getConfig(companyId: string): Promise<T | null>;
  updateConfig(
    companyId: string,
    update: {
      livePausedAt: Date;
      livePauseCode: LivePauseCode;
      livePauseMessage: string;
    },
  ): Promise<T>;
}

export function canonicalLivePauseMessage(code: LivePauseCode): string {
  return code === 'MANUAL_PAUSE'
    ? SAFE_PAUSE_MESSAGES[code]
    : `Live mode is paused: ${SAFE_PAUSE_MESSAGES[code]}`;
}

export function safeLivePauseState(
  config: LivePauseConfig | null,
): LivePauseStateDto {
  const liveRequested = config?.liveRequested === true;
  const paused = liveRequested && config?.livePausedAt != null;
  if (!paused) {
    return {
      liveRequested,
      enabled:
        liveRequested
        && config?.liveEnabledAt != null
        && config.livePausedAt == null,
      paused: false,
      pauseCode: null,
      pauseMessage: null,
    };
  }
  const code = config.livePauseCode;
  if (!isLivePauseCode(code)) {
    return {
      liveRequested: true,
      enabled: false,
      paused: true,
      pauseCode: 'UNAVAILABLE',
      pauseMessage: 'Live mode is paused because safety status is unavailable.',
    };
  }
  return {
    liveRequested: true,
    enabled: false,
    paused: true,
    pauseCode: code,
    pauseMessage: canonicalLivePauseMessage(code),
  };
}

export async function persistStrongestLivePause<T extends LivePauseConfig>(
  deps: LivePausePersistence<T>,
  companyId: string,
  code: LivePauseCode,
  now: Date,
): Promise<LivePauseStateDto> {
  const current = await deps.getConfig(companyId);
  if (current === null || current.liveRequested !== true) {
    return safeLivePauseState(current);
  }
  if (
    current.livePausedAt !== null
    && pausePriority(current.livePauseCode) <= pausePriority(code)
  ) {
    return safeLivePauseState(current);
  }
  const updated = await deps.updateConfig(companyId, {
    livePausedAt: now,
    livePauseCode: code,
    livePauseMessage: canonicalLivePauseMessage(code),
  });
  return safeLivePauseState(updated);
}

function isLivePauseCode(value: string | null): value is LivePauseCode {
  return value !== null
    && Object.prototype.hasOwnProperty.call(SAFE_PAUSE_MESSAGES, value);
}

function pausePriority(code: string | null): number {
  const index = LIVE_PAUSE_PRIORITY.indexOf(code as LivePauseCode);
  // Unknown persisted reasons are fail-closed and cannot be silently erased.
  return index === -1 ? -1 : index;
}
