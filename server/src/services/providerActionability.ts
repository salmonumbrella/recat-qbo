import type { ProviderActionabilityDisposition, ProviderActionabilityDto } from '@recat/shared';
import { QboWriteSafetyError, type QboWriteSafetyEvidence } from '../lib/qbo/writeSafety.js';
import { prisma } from '../lib/prisma.js';

/** Keep the cache short: a bank-feed reconciliation can change without a
 * transaction SyncToken changing.  The cache only guides reads; it never
 * grants QBO write authority. */
export const PROVIDER_ACTIONABILITY_TTL_MS = 15 * 60 * 1000;

export const PROVIDER_ACTIONABILITY_DISPOSITIONS: readonly ProviderActionabilityDisposition[] = [
  'UNKNOWN',
  'WRITABLE',
  'BLOCKED_CLEARED',
  'BLOCKED_RECONCILED',
  'BLOCKED_PERIOD_CLOSED',
  'UNAVAILABLE',
];

/** Prisma relation predicate for a disposition read. Provider observations
 * are only trusted while their safety read remains inside the bounded TTL;
 * UNKNOWN is the migration/default state and has no checkedAt requirement. */
export function providerActionabilityWhere(
  disposition: ProviderActionabilityDisposition,
  now = new Date(),
): Record<string, unknown> {
  if (disposition === 'UNKNOWN') return { is: { disposition } };
  return {
    is: {
      disposition,
      checkedAt: { gte: new Date(now.getTime() - PROVIDER_ACTIONABILITY_TTL_MS) },
    },
  };
}

export type ProviderActionabilityDispositionLike = ProviderActionabilityDisposition;

export interface ProviderActionabilityObservation {
  id?: string;
  companyId: string;
  transactionId: string;
  disposition: ProviderActionabilityDisposition;
  checkedAt: Date | null;
  revision: number;
  qboSyncToken: string;
  qboType: string;
  qboId: string;
  txnDate: Date | string;
  bankAccountQboId: string | null;
  bookCloseDate: Date | string | null;
  cleared: boolean | null;
  reconciled: boolean | null;
  unavailableCode: string | null;
  unavailableReason: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface ActionabilityTransactionIdentity {
  id: string;
  companyId: string;
  revision: number;
  qboSyncToken: string;
  qboType: string;
  qboId: string;
  date: Date | string;
}

interface ActionabilityModel {
  findUnique(args: Record<string, unknown>): Promise<ProviderActionabilityObservation | null>;
  findMany(args: Record<string, unknown>): Promise<ProviderActionabilityObservation[]>;
  count(args: Record<string, unknown>): Promise<number>;
  updateMany(args: Record<string, unknown>): Promise<{ count: number }>;
  upsert(args: Record<string, unknown>): Promise<ProviderActionabilityObservation>;
  create?(args: Record<string, unknown>): Promise<ProviderActionabilityObservation>;
}

interface ActionabilityTransactionModel {
  findFirst(args: Record<string, unknown>): Promise<ActionabilityTransactionIdentity | null>;
}

export interface ProviderActionabilityDb {
  /** Optional so legacy unit-test stores and older deployments can continue
   * to use the read paths while the migration is rolling out.  The real
   * Prisma client exposes this delegate once the migration is applied. */
  transactionActionability?: ActionabilityModel;
  transaction: ActionabilityTransactionModel;
  $transaction?<T>(callback: (tx: ProviderActionabilityDb) => Promise<T>): Promise<T>;
  $queryRawUnsafe?<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

const defaultDb = prisma as unknown as ProviderActionabilityDb;

function dateOnly(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }
  const candidate = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(candidate)) return null;
  const parsed = new Date(`${candidate}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== candidate
    ? null
    : candidate;
}

function isoOrNull(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function validDisposition(value: unknown): value is ProviderActionabilityDisposition {
  return typeof value === 'string'
    && (PROVIDER_ACTIONABILITY_DISPOSITIONS as readonly string[]).includes(value);
}

/** Map exact write-safety evidence to the most specific provider disposition. */
export function dispositionFromWriteSafety(
  target: { txnDate: string },
  evidence: QboWriteSafetyEvidence,
): ProviderActionabilityDisposition {
  if (
    evidence.bookCloseDate !== null
    && target.txnDate <= evidence.bookCloseDate
  ) return 'BLOCKED_PERIOD_CLOSED';
  if (evidence.reconciled) return 'BLOCKED_RECONCILED';
  if (evidence.cleared) return 'BLOCKED_CLEARED';
  return 'WRITABLE';
}

/** Convert a model row into the safe shared read DTO. */
export function providerActionabilityDto(
  row: ProviderActionabilityObservation | null | undefined,
): ProviderActionabilityDto | null {
  if (row === null || row === undefined || !validDisposition(row.disposition)) return null;
  return {
    disposition: row.disposition,
    checkedAt: isoOrNull(row.checkedAt),
    revision: Number(row.revision),
    qboSyncToken: String(row.qboSyncToken),
    qboType:
      row.qboType === 'Deposit' || row.qboType === 'JournalEntry'
        ? row.qboType
        : 'Purchase',
    qboId: String(row.qboId),
    txnDate: `${dateOnly(row.txnDate) ?? ''}T00:00:00.000Z`,
    bankAccountQboId: typeof row.bankAccountQboId === 'string' ? row.bankAccountQboId : null,
    bookCloseDate: dateOnly(row.bookCloseDate),
    cleared: typeof row.cleared === 'boolean' ? row.cleared : null,
    reconciled: typeof row.reconciled === 'boolean' ? row.reconciled : null,
    unavailableCode: typeof row.unavailableCode === 'string' ? row.unavailableCode : null,
    unavailableReason: typeof row.unavailableReason === 'string' ? row.unavailableReason : null,
  };
}

type BindingLike = Pick<
  ProviderActionabilityObservation,
  'companyId' | 'revision' | 'qboSyncToken' | 'qboType' | 'qboId'
> & { txnDate?: Date | string; date?: Date | string };

function sameBinding(row: BindingLike, txn: BindingLike): boolean {
  const rowDate = dateOnly(row.txnDate ?? row.date);
  const txnDate = dateOnly(txn.txnDate ?? txn.date);
  return row.companyId === txn.companyId
    && Number(row.revision) === Number(txn.revision)
    && row.qboSyncToken === txn.qboSyncToken
    && row.qboType === txn.qboType
    && row.qboId === txn.qboId
    && rowDate !== null
    && rowDate === txnDate;
}

/** A cached observation is useful only while its full transaction binding is
 * still current and its evidence has not exceeded the TTL. */
export function isFreshProviderActionability(
  row: ProviderActionabilityObservation | null | undefined,
  txn: ActionabilityTransactionIdentity,
  now = new Date(),
  ttlMs = PROVIDER_ACTIONABILITY_TTL_MS,
): boolean {
  if (!row || !validDisposition(row.disposition) || !sameBinding(row, txn)) return false;
  if (row.checkedAt === null || !Number.isFinite(row.checkedAt.getTime())) return false;
  const age = now.getTime() - row.checkedAt.getTime();
  return age >= 0 && age <= ttlMs;
}

/** Resolve a row for selection. Missing, malformed, mismatched, or stale
 * observations fail closed as UNKNOWN. */
export function effectiveProviderDisposition(
  row: ProviderActionabilityObservation | null | undefined,
  txn: ActionabilityTransactionIdentity,
  now = new Date(),
  ttlMs = PROVIDER_ACTIONABILITY_TTL_MS,
): ProviderActionabilityDisposition {
  return isFreshProviderActionability(row, txn, now, ttlMs)
    ? row!.disposition
    : 'UNKNOWN';
}

function unknownData(txn: ActionabilityTransactionIdentity): Record<string, unknown> {
  return {
    companyId: txn.companyId,
    transactionId: txn.id,
    disposition: 'UNKNOWN',
    checkedAt: null,
    revision: txn.revision,
    qboSyncToken: txn.qboSyncToken,
    qboType: txn.qboType,
    qboId: txn.qboId,
    txnDate: toDateOnlyValue(txn.date),
    bankAccountQboId: null,
    bookCloseDate: null,
    cleared: null,
    reconciled: null,
    unavailableCode: null,
    unavailableReason: null,
  };
}

/** Prisma DateTime fields require Date values.  Keeping this conversion in
 * one place also ensures a date-only accounting field never shifts timezone. */
function toDateOnlyValue(value: Date | string | null | undefined): Date | null {
  const date = dateOnly(value);
  return date === null ? null : new Date(`${date}T00:00:00.000Z`);
}

/** Create or invalidate a provider index row when a new mirror enters Recat. */
export async function ensureUnknownProviderActionability(
  txn: ActionabilityTransactionIdentity,
  db: ProviderActionabilityDb = defaultDb,
): Promise<boolean> {
  if (!db.transactionActionability) return false;
  const prior = await db.transactionActionability.findUnique({
    where: { transactionId: txn.id },
  });
  if (prior && sameBinding(prior, txn)) return false;
  if (prior) {
    const result = await db.transactionActionability.updateMany({
      where: {
        transactionId: txn.id,
        companyId: txn.companyId,
        OR: [
          { revision: { not: txn.revision } },
          { qboSyncToken: { not: txn.qboSyncToken } },
        ],
      },
      data: unknownData(txn),
    });
    return result.count === 1;
  }
  if (!db.transactionActionability.create) {
    await db.transactionActionability.upsert({
      where: { transactionId: txn.id },
      create: { ...unknownData(txn) },
      update: unknownData(txn),
    });
    return true;
  }
  try {
    await db.transactionActionability.create({ data: unknownData(txn) });
    return true;
  } catch {
    // A concurrent sync may have won the unique transactionId insert.  Never
    // overwrite its newer observation; the next sync/read will reconcile it.
    return false;
  }
}

/** Invalidate an existing row after a local revision or provider SyncToken
 * changes.  The conditional update is the bounded CAS fence. */
export async function invalidateProviderActionability(
  txn: ActionabilityTransactionIdentity,
  db: ProviderActionabilityDb = defaultDb,
): Promise<boolean> {
  if (!db.transactionActionability) return false;
  const result = await db.transactionActionability.updateMany({
    where: {
      transactionId: txn.id,
      companyId: txn.companyId,
      OR: [
        { revision: { not: txn.revision } },
        { qboSyncToken: { not: txn.qboSyncToken } },
        { qboId: { not: txn.qboId } },
        { qboType: { not: txn.qboType } },
      ],
    },
    data: unknownData(txn),
  });
  return result.count === 1;
}

export interface PersistProviderActionabilityInput extends ActionabilityTransactionIdentity {
  checkedAt?: Date;
  evidence?: QboWriteSafetyEvidence;
  disposition?: ProviderActionabilityDisposition;
  bankAccountQboId?: string | null;
  unavailableCode?: string | null;
  unavailableReason?: string | null;
}

function persistedData(input: PersistProviderActionabilityInput): Record<string, unknown> {
  const evidence = input.evidence;
  const disposition = input.disposition
    ?? (evidence === undefined
      ? 'UNKNOWN'
      : dispositionFromWriteSafety({ txnDate: dateOnly(input.date) ?? '' }, evidence));
  return {
    companyId: input.companyId,
    transactionId: input.id,
    disposition,
    checkedAt: input.checkedAt ?? new Date(),
    revision: input.revision,
    qboSyncToken: input.qboSyncToken,
    qboType: input.qboType,
    qboId: input.qboId,
    txnDate: toDateOnlyValue(input.date),
    bankAccountQboId: input.bankAccountQboId ?? null,
    bookCloseDate: toDateOnlyValue(evidence?.bookCloseDate),
    cleared: evidence?.cleared ?? null,
    reconciled: evidence?.reconciled ?? null,
    unavailableCode: input.unavailableCode ?? null,
    unavailableReason: input.unavailableReason ?? null,
  };
}

/**
 * Persist an observation only while the source transaction still has the
 * revision and SyncToken read by the refresh.  A stale refresh returns false
 * and never overwrites a newer observation.
 */
export async function persistProviderActionability(
  input: PersistProviderActionabilityInput,
  db: ProviderActionabilityDb = defaultDb,
): Promise<boolean> {
  if (!db.transactionActionability) return false;
  const source = await db.transaction.findFirst({
    where: {
      id: input.id,
      companyId: input.companyId,
      revision: input.revision,
      qboSyncToken: input.qboSyncToken,
    },
    select: {
      id: true,
      companyId: true,
      revision: true,
      qboSyncToken: true,
      qboType: true,
      qboId: true,
      date: true,
    },
  });
  if (source === null || !sameBinding(source, input)) return false;

  const data = persistedData(input);
  // The source identity is also the optimistic-concurrency fence.  An
  // updateMany with the complete binding is atomic in the database, so a
  // refresh that loses a revision/SyncToken race cannot overwrite evidence
  // from a newer mirror.  Do not replace this with an unconditional upsert.
  const updated = await db.transactionActionability.updateMany({
    where: {
      transactionId: input.id,
      companyId: input.companyId,
      revision: input.revision,
      qboSyncToken: input.qboSyncToken,
      qboType: input.qboType,
      qboId: input.qboId,
      txnDate: toDateOnlyValue(input.date),
    },
    data,
  });
  if (updated.count === 1) return true;

  const existing = await db.transactionActionability.findUnique({
    where: { transactionId: input.id },
  });
  if (existing) {
    // The provider mirror moved while this refresh was in flight.  Do not
    // clobber the new binding (or an observation another refresh just wrote);
    // its next bounded refresh will establish state.
    return false;
  }
  if (!db.transactionActionability.create) return false;
  try {
    await db.transactionActionability.create({ data });
    return true;
  } catch {
    // A concurrent refresh won the unique transactionId insert.  The caller
    // can checkpoint and retry; no stale evidence is allowed through.
    return false;
  }
}

export function providerDispositionIsBlocked(
  disposition: ProviderActionabilityDisposition,
): boolean {
  return disposition === 'BLOCKED_CLEARED'
    || disposition === 'BLOCKED_RECONCILED'
    || disposition === 'BLOCKED_PERIOD_CLOSED';
}

/** Gate a new prepare using only a fresh cached observation.  This is an
 * optimization/safety UX gate; commit still calls the provider's fresh exact
 * safety check. */
export function assertProviderActionabilityAllowsPrepare(
  row: ProviderActionabilityObservation | null | undefined,
  txn: ActionabilityTransactionIdentity,
  now = new Date(),
): void {
  const disposition = effectiveProviderDisposition(row, txn, now);
  switch (disposition) {
    case 'WRITABLE':
      return;
    case 'BLOCKED_PERIOD_CLOSED':
      throw new QboWriteSafetyError('QBO_PERIOD_CLOSED');
    case 'BLOCKED_CLEARED':
    case 'BLOCKED_RECONCILED':
      throw new QboWriteSafetyError('QBO_TRANSACTION_LOCKED');
    case 'UNKNOWN':
    case 'UNAVAILABLE':
    default:
      throw new QboWriteSafetyError('QBO_WRITE_SAFETY_UNAVAILABLE');
  }
}

export function actionabilityObservationFromRow(
  row: unknown,
): ProviderActionabilityObservation | null {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return null;
  const value = row as Record<string, unknown>;
  if (!validDisposition(value.disposition)) return null;
  const checkedAt = value.checkedAt instanceof Date
    ? value.checkedAt
    : value.checkedAt === null || value.checkedAt === undefined
      ? null
      : new Date(String(value.checkedAt));
  return {
    id: typeof value.id === 'string' ? value.id : undefined,
    companyId: String(value.companyId ?? ''),
    transactionId: String(value.transactionId ?? ''),
    disposition: value.disposition,
    checkedAt: checkedAt && Number.isFinite(checkedAt.getTime()) ? checkedAt : null,
    revision: Number(value.revision),
    qboSyncToken: String(value.qboSyncToken ?? ''),
    qboType: String(value.qboType ?? ''),
    qboId: String(value.qboId ?? ''),
    txnDate: value.txnDate instanceof Date ? value.txnDate : String(value.txnDate ?? ''),
    bankAccountQboId: typeof value.bankAccountQboId === 'string' ? value.bankAccountQboId : null,
    bookCloseDate:
      value.bookCloseDate instanceof Date
        ? value.bookCloseDate
        : typeof value.bookCloseDate === 'string'
          ? value.bookCloseDate
          : null,
    cleared: typeof value.cleared === 'boolean' ? value.cleared : null,
    reconciled: typeof value.reconciled === 'boolean' ? value.reconciled : null,
    unavailableCode: typeof value.unavailableCode === 'string' ? value.unavailableCode : null,
    unavailableReason: typeof value.unavailableReason === 'string' ? value.unavailableReason : null,
  };
}

export function transactionIdentityFromRow(row: {
  id: string;
  companyId: string;
  revision: number;
  qboSyncToken: string;
  qboType: string;
  qboId: string;
  date: Date | string;
}): ActionabilityTransactionIdentity {
  return row;
}
