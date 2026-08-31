import { prisma } from '../lib/prisma.js';
import {
  persistProviderActionability,
  type PersistProviderActionabilityInput,
} from './providerActionability.js';
import {
  writeSafetyReads,
  type WriteSafetyReadOperations,
  type WriteSafetyReadResult,
} from './writeSafetyReads.js';

/** A refresh deliberately processes a small page. Callers resume with the
 * returned cursor instead of holding a request open over the whole queue. */
export const DEFAULT_ACTIONABILITY_REFRESH_LIMIT = 10;
export const MAX_ACTIONABILITY_REFRESH_LIMIT = 25;

export interface ActionabilityRefreshTransaction {
  id: string;
  companyId: string;
  revision: number;
  qboSyncToken: string;
  qboType: string;
  qboId: string;
  date: Date | string;
}

export interface ProviderActionabilityRefreshItem {
  transactionId: string;
  persisted: boolean;
  disposition: 'WRITABLE' | 'BLOCKED_CLEARED' | 'BLOCKED_RECONCILED' | 'BLOCKED_PERIOD_CLOSED' | 'UNAVAILABLE';
  errorCode: string | null;
}

export interface ProviderActionabilityRefreshResult {
  companyId: string;
  processed: number;
  persisted: number;
  failed: number;
  nextCursor: string | null;
  partial: boolean;
  complete: boolean;
  items: ProviderActionabilityRefreshItem[];
}

export interface ProviderActionabilityRefreshDeps {
  /** Must enforce the caller's company scope before returning rows. */
  listTransactions(
    userId: string,
    companyId: string,
    afterId: string | null,
    limit: number,
  ): Promise<ActionabilityRefreshTransaction[]>;
  readSafety(
    userId: string,
    companyId: string,
    transactionId: string,
  ): Promise<WriteSafetyReadResult>;
  persist(input: PersistProviderActionabilityInput): Promise<boolean>;
}

function boundedLimit(limit: number | undefined): number {
  const value = limit ?? DEFAULT_ACTIONABILITY_REFRESH_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > MAX_ACTIONABILITY_REFRESH_LIMIT) {
    throw new Error(`Actionability refresh limit must be between 1 and ${MAX_ACTIONABILITY_REFRESH_LIMIT}.`);
  }
  return value;
}

function boundedCursor(cursor: string | null | undefined): string | null {
  if (cursor === undefined || cursor === null || cursor === '') return null;
  if (cursor.length > 128) throw new Error('Actionability refresh cursor is too long.');
  return cursor;
}

function unavailableCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z0-9_]{1,64}$/u.test(code)) return code;
  }
  return 'QBO_WRITE_SAFETY_UNAVAILABLE';
}

function dispositionFromSafety(result: WriteSafetyReadResult): ProviderActionabilityRefreshItem['disposition'] {
  if (result.blockCode === 'QBO_PERIOD_CLOSED') return 'BLOCKED_PERIOD_CLOSED';
  if (result.blockCode === 'QBO_TRANSACTION_LOCKED') {
    return result.reconciled ? 'BLOCKED_RECONCILED' : 'BLOCKED_CLEARED';
  }
  return result.writable ? 'WRITABLE' : 'UNAVAILABLE';
}

function resultInput(
  companyId: string,
  result: WriteSafetyReadResult,
): PersistProviderActionabilityInput {
  return {
    id: result.transactionId,
    companyId,
    revision: result.revision,
    qboSyncToken: result.qboSyncToken,
    qboType: result.qboType,
    qboId: result.qboId,
    date: result.txnDate,
    checkedAt: new Date(),
    bankAccountQboId: result.bankAccountQboId,
    evidence: {
      bookCloseDate: result.bookCloseDate,
      cleared: result.cleared,
      reconciled: result.reconciled,
    },
  };
}

function unavailableInput(
  txn: ActionabilityRefreshTransaction,
  error: unknown,
): PersistProviderActionabilityInput {
  return {
    ...txn,
    disposition: 'UNAVAILABLE',
    checkedAt: new Date(),
    bankAccountQboId: null,
    unavailableCode: unavailableCode(error),
    unavailableReason: null,
  };
}

const defaultDeps: ProviderActionabilityRefreshDeps = {
  async listTransactions(userId, companyId, afterId, limit) {
    // The scoped company lookup is intentionally separate from the transaction
    // query: a guessed company ID must not become a cross-tenant cursor.
    const { getCompany } = await import('./companyReads.js');
    await getCompany(userId, companyId);
    return prisma.transaction.findMany({
      where: {
        companyId,
        status: { in: ['PENDING', 'ERROR'] },
        qboType: { in: ['Purchase', 'Deposit'] },
        ...(afterId ? { id: { gt: afterId } } : {}),
      },
      orderBy: { id: 'asc' },
      take: limit,
      select: {
        id: true,
        companyId: true,
        revision: true,
        qboSyncToken: true,
        qboType: true,
        qboId: true,
        date: true,
      },
    }) as Promise<ActionabilityRefreshTransaction[]>;
  },
  readSafety: (userId, companyId, transactionId) =>
    writeSafetyReads.getWriteSafety(userId, companyId, transactionId, { persist: false }),
  persist: persistProviderActionability,
};

/**
 * Read and persist at most one bounded page of provider safety observations.
 * Every QBO read goes through the same authorized get-write-safety operation
 * used by the MCP surface; this function itself never mutates QBO.
 */
export async function refreshProviderActionability(
  userId: string,
  companyId: string,
  options: { cursor?: string | null; limit?: number } = {},
  deps: ProviderActionabilityRefreshDeps = defaultDeps,
): Promise<ProviderActionabilityRefreshResult> {
  const limit = boundedLimit(options.limit);
  const cursor = boundedCursor(options.cursor);
  const rows = await deps.listTransactions(userId, companyId, cursor, limit);
  const items: ProviderActionabilityRefreshItem[] = [];
  let persisted = 0;
  let failed = 0;

  for (const txn of rows) {
    let item: ProviderActionabilityRefreshItem;
    try {
      const safety = await deps.readSafety(userId, companyId, txn.id);
      const didPersist = await deps.persist(resultInput(companyId, safety));
      if (didPersist) persisted += 1;
      item = {
        transactionId: txn.id,
        persisted: didPersist,
        disposition: dispositionFromSafety(safety),
        errorCode: null,
      };
    } catch (error) {
      failed += 1;
      let didPersist = false;
      try {
        didPersist = await deps.persist(unavailableInput(txn, error));
        if (didPersist) persisted += 1;
      } catch {
        // Keep the cursor moving even when the local index is unavailable.
      }
      item = {
        transactionId: txn.id,
        persisted: didPersist,
        disposition: 'UNAVAILABLE',
        errorCode: unavailableCode(error),
      };
    }
    items.push(item);
  }

  const nextCursor = rows.at(-1)?.id ?? null;
  const partial = rows.length === limit;
  return {
    companyId,
    processed: rows.length,
    persisted,
    failed,
    nextCursor: partial ? nextCursor : null,
    partial,
    complete: !partial,
    items,
  };
}

export function createProviderActionabilityRefresh(
  deps: Partial<ProviderActionabilityRefreshDeps> = {},
): (userId: string, companyId: string, options?: { cursor?: string | null; limit?: number }) => Promise<ProviderActionabilityRefreshResult> {
  const merged = { ...defaultDeps, ...deps };
  return (userId, companyId, options) => refreshProviderActionability(userId, companyId, options, merged);
}
