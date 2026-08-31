import type { TransactionDto } from '@recat/shared';

/**
 * Client-side view of the provider actionability contract.
 *
 * The server exposes this additive field in the shared DTO. Keep the
 * compatibility boundary here because older responses (and malformed
 * responses) can still omit the observation; those must fail closed.
 */
export type ProviderActionabilityDisposition =
  | 'UNKNOWN'
  | 'WRITABLE'
  | 'BLOCKED_CLEARED'
  | 'BLOCKED_RECONCILED'
  | 'BLOCKED_PERIOD_CLOSED'
  | 'UNAVAILABLE';

export type QueueActionabilityView = 'actionable' | 'blocked' | 'safety';

export interface QueueActionability {
  disposition: ProviderActionabilityDisposition;
  view: QueueActionabilityView;
  /** Human-readable provider reason shown beside blocked/safety rows. */
  reason: string;
}

type ProviderActionabilityRecord = {
  disposition?: unknown;
  status?: unknown;
  state?: unknown;
  reason?: unknown;
  reasonCode?: unknown;
  unavailableReason?: unknown;
  unavailableCode?: unknown;
};

type TransactionWithProviderActionability = TransactionDto & {
  /** Runtime-compatible view for legacy/malformed API responses. */
  providerActionability?: unknown;
};

const DISPOSITIONS = new Set<ProviderActionabilityDisposition>([
  'UNKNOWN',
  'WRITABLE',
  'BLOCKED_CLEARED',
  'BLOCKED_RECONCILED',
  'BLOCKED_PERIOD_CLOSED',
  'UNAVAILABLE',
]);

const DEFAULT_REASON: Record<ProviderActionabilityDisposition, string> = {
  UNKNOWN: 'Actionability unknown',
  WRITABLE: 'Writable',
  BLOCKED_CLEARED: 'Cleared',
  BLOCKED_RECONCILED: 'Reconciled',
  BLOCKED_PERIOD_CLOSED: 'Closed period',
  UNAVAILABLE: 'Unavailable',
};

const REASON_LABELS: Record<string, string> = {
  CLEARED: 'Cleared',
  QBO_CLEARED: 'Cleared',
  RECONCILED: 'Reconciled',
  QBO_RECONCILED: 'Reconciled',
  CLOSED: 'Closed period',
  PERIOD_CLOSED: 'Closed period',
  QBO_PERIOD_CLOSED: 'Closed period',
  UNAVAILABLE: 'Unavailable',
};

function recordOf(value: unknown): ProviderActionabilityRecord | null {
  return typeof value === 'object' && value !== null
    ? value as ProviderActionabilityRecord
    : null;
}

function dispositionOf(value: unknown): ProviderActionabilityDisposition {
  if (typeof value !== 'string') return 'UNKNOWN';
  const normalized = value.toUpperCase().replace(/[- ]/g, '_');
  return DISPOSITIONS.has(normalized as ProviderActionabilityDisposition)
    ? normalized as ProviderActionabilityDisposition
    : 'UNKNOWN';
}

function reasonOf(
  disposition: ProviderActionabilityDisposition,
  record: ProviderActionabilityRecord | null,
): string {
  const reason = record?.reason
    ?? record?.reasonCode
    ?? record?.unavailableReason
    ?? record?.unavailableCode;
  if (typeof reason === 'string' && reason.trim()) {
    const normalized = reason.trim().toUpperCase().replace(/[- ]/g, '_');
    return REASON_LABELS[normalized] ?? reason.trim();
  }
  return DEFAULT_REASON[disposition]!;
}

/**
 * Normalize the additive server observation into the three queue surfaces.
 * Missing/invalid observations intentionally land in Needs safety check.
 */
export function queueActionabilityOf(t: TransactionDto): QueueActionability {
  const raw = (t as TransactionWithProviderActionability).providerActionability;
  const record = recordOf(raw);
  const disposition = dispositionOf(
    typeof raw === 'string' ? raw : record?.disposition ?? record?.status ?? record?.state,
  );
  const view: QueueActionabilityView = disposition === 'WRITABLE'
    ? 'actionable'
    : disposition === 'BLOCKED_CLEARED'
      || disposition === 'BLOCKED_RECONCILED'
      || disposition === 'BLOCKED_PERIOD_CLOSED'
      ? 'blocked'
      : 'safety';
  return { disposition, view, reason: reasonOf(disposition, record) };
}

export function isQueueActionable(t: TransactionDto): boolean {
  return queueActionabilityOf(t).disposition === 'WRITABLE';
}

export function queueViewLabel(view: QueueActionabilityView): string {
  switch (view) {
    case 'actionable': return 'Queue';
    case 'blocked': return 'Blocked in QuickBooks';
    case 'safety': return 'Needs safety check';
  }
}
