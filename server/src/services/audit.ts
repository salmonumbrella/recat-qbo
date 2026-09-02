// Append-only audit service. Every QBO write (real or dry-run) records an
// AuditEntry; callers pass their Prisma transaction client so the audit row
// commits atomically with the status change (CLAUDE.md requirement).
// There is intentionally no update or delete API for this table.

import type { AuditEntry, Prisma, PrismaClient } from '@prisma/client';
import type { AuditAction, AuditEntryDto } from '@recat/shared';
import { prisma } from '../lib/prisma.js';

/** Either the root client or an interactive-transaction client. */
export type PrismaTransactionClientOrPrisma = PrismaClient | Prisma.TransactionClient;

export type MutationAuditOutcome =
  | 'DRY_RUN'
  | 'VERIFIED'
  | 'UNCERTAIN'
  | 'UNCHANGED'
  | 'RETRYABLE';

export interface MutationAuditInput {
  requestId: string;
  outcome: MutationAuditOutcome;
  references: {
    operation: 'recategorize' | 'restore' | 'transfer';
    qboType: string;
    qboId: string;
    accountQboIds: string[];
    taxCodeQboIds: string[];
  };
  mcp?: {
    sourceOperationId: string;
    operationId: string;
    tokenPrefix: string;
  };
}

export interface AttachmentAuditInput {
  attachmentCount: number;
  totalBytes: number;
  sourceKinds: readonly (
    | 'LOCAL_UPLOAD'
    | 'HTTPS_IMPORT'
    | 'QBO_EXTERNAL'
  )[];
  state:
    | 'PREPARED'
    | 'COMMITTING'
    | 'PARTIAL'
    | 'VERIFIED'
    | 'FAILED'
    | 'UNCERTAIN'
    | 'DELETING'
    | 'DELETED';
}

export function normalizeAttachmentAuditMetadata(
  input: AttachmentAuditInput,
): {
  attachmentCount: number;
  sizeBucket: 'UNDER_1MB' | '1MB_TO_10MB' | '10MB_TO_100MB';
  sourceKinds: AttachmentAuditInput['sourceKinds'][number][];
  state: AttachmentAuditInput['state'];
} {
  const sizeBucket = input.totalBytes < 1_000_000
    ? 'UNDER_1MB'
    : input.totalBytes < 10_000_000
      ? '1MB_TO_10MB'
      : '10MB_TO_100MB';
  return {
    attachmentCount: Math.max(0, Math.min(20, input.attachmentCount)),
    sizeBucket,
    sourceKinds: [...new Set(input.sourceKinds)].sort(),
    state: input.state,
  };
}

export interface AuditInput {
  companyId: string;
  /** userId, or null/undefined for system actions */
  actorId?: string | null;
  /** display name or 'system' */
  actorLabel: string;
  txnId?: string;
  payee: string;
  amount: number | Prisma.Decimal;
  action: AuditAction;
  /** holding account */
  before: string;
  /** full category path, or split summary */
  after: string;
  /** exact QBO request body (dry-run keeps it too) */
  payload?: unknown;
  /**
   * Tax-aware durable writes use a strict metadata allowlist. When present,
   * legacy `payload` is ignored so prepared bodies, snapshots, SyncTokens,
   * credentials, and raw errors cannot enter the audit log.
   */
  mutation?: MutationAuditInput;
}

const MAX_AUDIT_REFERENCE_LENGTH = 128;
const MAX_AUDIT_REFERENCES = 50;
const MAX_TOKEN_PREFIX_LENGTH = 12;

function boundedReference(
  value: string,
  maximum = MAX_AUDIT_REFERENCE_LENGTH,
): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/gu, '')
    .trim()
    .slice(0, maximum);
}

function normalizedReferences(values: string[]): string[] {
  return [...new Set(
    values
      .map((value) => boundedReference(value))
      .filter((value) => value !== ''),
  )]
    .sort()
    .slice(0, MAX_AUDIT_REFERENCES);
}

export function normalizeMutationAuditMetadata(entry: MutationAuditInput): {
  requestId: string;
  outcome: MutationAuditOutcome;
  references: MutationAuditInput['references'];
  mcp?: NonNullable<MutationAuditInput['mcp']>;
} {
  return {
    requestId: boundedReference(entry.requestId),
    outcome: entry.outcome,
    references: {
      operation: entry.references.operation,
      qboType: boundedReference(entry.references.qboType),
      qboId: boundedReference(entry.references.qboId),
      accountQboIds: normalizedReferences(entry.references.accountQboIds),
      taxCodeQboIds: normalizedReferences(entry.references.taxCodeQboIds),
    },
    ...(entry.mcp === undefined
      ? {}
      : {
          mcp: {
            sourceOperationId: boundedReference(entry.mcp.sourceOperationId),
            operationId: boundedReference(entry.mcp.operationId),
            tokenPrefix: boundedReference(
              entry.mcp.tokenPrefix,
              MAX_TOKEN_PREFIX_LENGTH,
            ),
          },
        }),
  };
}

export async function writeAudit(tx: PrismaTransactionClientOrPrisma, entry: AuditInput): Promise<void> {
  const payload = entry.mutation === undefined
    ? entry.payload
    : normalizeMutationAuditMetadata(entry.mutation);
  await tx.auditEntry.create({
    data: {
      companyId: entry.companyId,
      actorId: entry.actorId ?? null,
      actorLabel: entry.actorLabel,
      txnId: entry.txnId ?? null,
      payee: entry.payee,
      amount: entry.amount,
      action: entry.action,
      before: entry.before,
      after: entry.after,
      payload: payload === undefined ? undefined : (payload as Prisma.InputJsonValue),
    },
  });
}

export interface ListAuditOptions {
  search?: string;
  cursor?: string;
  limit?: number;
}

export interface AuditPage {
  entries: AuditEntryDto[];
  nextCursor: string | null;
}

function toAuditDto(row: AuditEntry): AuditEntryDto {
  const dto: AuditEntryDto = {
    id: row.id,
    companyId: row.companyId,
    at: row.at.toISOString(),
    actor: row.actorLabel,
    payee: row.payee,
    amount: Number(row.amount),
    action: row.action as AuditAction,
    before: row.before,
    after: row.after,
  };
  if (row.txnId !== null) dto.transactionId = row.txnId;
  if (row.payload !== null) dto.payload = row.payload;
  return dto;
}

interface AuditUndoTransactionState {
  id: string;
  status: string;
  postedAt: Date | null;
}

interface LatestPostedAuditState {
  id: string;
  txnId: string | null;
  payload: unknown;
}

const UNDO_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function isVerifiedCategorizationPayload(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false;
  const record = payload as Record<string, unknown>;
  if (record.outcome !== 'VERIFIED') return false;
  const references = record.references;
  return typeof references === 'object'
    && references !== null
    && (references as Record<string, unknown>).operation === 'recategorize';
}

export function decorateAuditEntriesWithUndo(
  entries: AuditEntryDto[],
  transactions: AuditUndoTransactionState[],
  latestPostedEntries: LatestPostedAuditState[],
  now = new Date(),
): AuditEntryDto[] {
  const transactionById = new Map(transactions.map((txn) => [txn.id, txn]));
  const latestByTransactionId = new Map<string, LatestPostedAuditState>();
  const transactionIdByLatestEntryId = new Map<string, string>();
  for (const row of latestPostedEntries) {
    if (row.txnId === null || latestByTransactionId.has(row.txnId)) continue;
    latestByTransactionId.set(row.txnId, row);
    transactionIdByLatestEntryId.set(row.id, row.txnId);
  }

  return entries.map((entry) => {
    const transactionId = entry.transactionId ?? transactionIdByLatestEntryId.get(entry.id);
    if (transactionId === undefined) return entry;
    const withTransaction = { ...entry, transactionId };
    const txn = transactionById.get(transactionId);
    const latest = latestByTransactionId.get(transactionId);
    const postedAt = txn?.postedAt?.getTime();
    const elapsed = postedAt === undefined ? Number.POSITIVE_INFINITY : now.getTime() - postedAt;
    if (
      txn?.status !== 'POSTED'
      || latest?.id !== entry.id
      || (entry.action !== 'posted' && entry.action !== 'auto-posted')
      || elapsed < 0
      || elapsed > UNDO_WINDOW_MS
    ) {
      return withTransaction;
    }
    return {
      ...withTransaction,
      undo: {
        kind: isVerifiedCategorizationPayload(latest.payload)
          ? 'categorization'
          : 'legacy',
      },
    };
  });
}

async function decoratePageWithUndo(
  companyId: string,
  entries: AuditEntryDto[],
): Promise<AuditEntryDto[]> {
  const transactionIds = [...new Set(
    entries.flatMap((entry) => entry.transactionId === undefined ? [] : [entry.transactionId]),
  )];
  if (transactionIds.length === 0) return entries;
  const [transactions, postedEntries] = await Promise.all([
    prisma.transaction.findMany({
      where: { companyId, id: { in: transactionIds } },
      select: { id: true, status: true, postedAt: true },
    }),
    prisma.auditEntry.findMany({
      where: {
        companyId,
        txnId: { in: transactionIds },
        action: { in: ['posted', 'auto-posted'] },
      },
      select: { id: true, txnId: true, payload: true },
      orderBy: [{ at: 'desc' }, { id: 'desc' }],
    }),
  ]);
  return decorateAuditEntriesWithUndo(entries, transactions, postedEntries);
}

/** Does the entry match the free-text search across when/who/payee/amount/action/before/after? */
function matchesSearch(dto: AuditEntryDto, q: string): boolean {
  const haystacks = [
    dto.at,
    dto.actor,
    dto.payee,
    String(dto.amount),
    dto.amount.toFixed(2),
    dto.action,
    dto.before,
    dto.after,
  ];
  return haystacks.some((h) => h.toLowerCase().includes(q));
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function listAudit(companyId: string, opts: ListAuditOptions = {}): Promise<AuditPage> {
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const search = opts.search?.trim().toLowerCase() ?? '';

  if (search !== '') {
    // Search spans formatted fields (timestamps, amounts) that SQL contains()
    // can't express against Decimal/DateTime columns; audit volume per company
    // is small in a self-hosted install, so filter in memory.
    const rows = await prisma.auditEntry.findMany({
      where: { companyId },
      orderBy: [{ at: 'desc' }, { id: 'desc' }],
    });
    const matched = rows.map(toAuditDto).filter((d) => matchesSearch(d, search));
    let start = 0;
    if (opts.cursor) {
      const idx = matched.findIndex((d) => d.id === opts.cursor);
      start = idx >= 0 ? idx + 1 : 0;
    }
    const entries = await decoratePageWithUndo(companyId, matched.slice(start, start + limit));
    const last = entries[entries.length - 1];
    const nextCursor = last !== undefined && matched.length > start + limit ? last.id : null;
    return { entries, nextCursor };
  }

  const rows = await prisma.auditEntry.findMany({
    where: { companyId },
    orderBy: [{ at: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
  });
  const hasMore = rows.length > limit;
  const entries = await decoratePageWithUndo(companyId, rows.slice(0, limit).map(toAuditDto));
  const last = entries[entries.length - 1];
  const nextCursor = hasMore && last !== undefined ? last.id : null;
  return { entries, nextCursor };
}

// ---- CSV export ----

/** RFC-4180 escaping: quote when the value contains a comma, quote, or newline. */
export function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export const AUDIT_CSV_HEADER = 'When,Who,Transaction,Amount,Action,Before,After';

/** Pure CSV builder (unit-testable without a database). */
export function buildAuditCsv(entries: AuditEntryDto[]): string {
  const lines = entries.map((e) =>
    [e.at, e.actor, e.payee, e.amount.toFixed(2), e.action, e.before, e.after].map(csvEscape).join(','),
  );
  return [AUDIT_CSV_HEADER, ...lines].join('\n') + '\n';
}

export async function auditCsv(companyId: string): Promise<string> {
  const rows = await prisma.auditEntry.findMany({
    where: { companyId },
    orderBy: [{ at: 'desc' }, { id: 'desc' }],
  });
  return buildAuditCsv(rows.map(toAuditDto));
}
