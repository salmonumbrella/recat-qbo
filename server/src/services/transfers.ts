// Transfer detection + recording.
//
// Detection (handoff §2): among uncategorized PENDING txns, a pair with equal
// |amount|, opposite sign, different bank accounts, and dates ≤ 3 days apart is
// presented as a transfer candidate.
//
// Recording (v1 decision): rather than creating a separate QBO Transfer entity
// AND leaving the two source txns in the holding account (which would double
// the books), we recategorize each txn's holding line to the OTHER txn's bank
// account — which is exactly what a transfer is in double-entry: the checking
// withdrawal's line posts to the credit-card account and vice versa. The two
// existing entities become the two legs; no extra Transfer entity is created.

import { createHash } from 'node:crypto';
import type { TxnStatus } from '@recat/shared';
import { prisma } from '../lib/prisma.js';
import type { Actor } from './writeback.js';
import {
  commitTransfer,
  getTransferOperation,
  retryTransferOperation,
  type RetryTransferOperationDto,
  type TransferOperationDto,
} from './transferExecution.js';
import {
  prepareTransfer,
  type PrepareTransferInput,
  type PreparedTransferDto,
} from './transferOperations.js';
import {
  isTransferPair,
  MAX_TRANSFER_DISCOVERY_TRANSACTIONS,
  pairTransfers,
  transferCandidates,
  TransferDiscoveryOverflowError,
  type PairTransferStats,
  type PairableTxn,
} from './transferCandidates.js';

export {
  isTransferPair,
  MAX_TRANSFER_DISCOVERY_TRANSACTIONS,
  pairTransfers,
  transferCandidates,
  TransferDiscoveryOverflowError,
  type PairTransferStats,
  type PairableTxn,
} from './transferCandidates.js';

// ---------------------------------------------------------------------------
// Pure pairing logic (unit-tested)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

export interface CounterpartAccountLike {
  qboId: string;
  name: string;
  active: boolean;
}

/**
 * Resolve a transfer leg's counterpart bank account by display name. Only
 * active accounts count, and an ambiguous name fails loudly — guessing here
 * would move money to the wrong ledger account. (Pure; unit-tested.)
 */
export function pickCounterpartAccount(
  accounts: CounterpartAccountLike[],
  name: string,
): CounterpartAccountLike {
  const matches = accounts.filter((a) => a.active && a.name === name);
  const first = matches[0];
  if (!first) {
    throw new Error(`Bank account "${name}" not found in the chart of accounts — re-sync first.`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Bank account "${name}" is ambiguous — ${matches.length} active accounts share that name. Rename one in QuickBooks and re-sync.`,
    );
  }
  return first;
}

interface RecordTransferRow {
  id: string;
  companyId: string;
  revision: number;
}

export interface RecordTransferDeps {
  db: {
    transaction: {
      findUnique(args: {
        where: { id: string };
        select: { id: true; companyId: true; revision: true };
      }): Promise<RecordTransferRow | null>;
    };
  };
  prepare(input: PrepareTransferInput): Promise<PreparedTransferDto>;
  get(
    operationId: string,
    actor: Actor,
  ): Promise<TransferOperationDto>;
  retry(
    operationId: string,
    actor: Actor,
  ): Promise<RetryTransferOperationDto>;
  commit(
    operationId: string,
    actor: Actor,
  ): Promise<TransferOperationDto>;
}

export type RecordTransferConflictCode =
  | 'TRANSFER_RETRYABLE'
  | 'TRANSFER_RECONCILIATION_REQUIRED';

const RECORD_TRANSFER_CONFLICT_MESSAGES:
Readonly<Record<RecordTransferConflictCode, string>> = {
  TRANSFER_RETRYABLE: 'The transfer was not sent. Retry this transfer.',
  TRANSFER_RECONCILIATION_REQUIRED:
    'The transfer may be partially recorded. Verify both transactions in QuickBooks before retrying.',
};

export class RecordTransferConflictError extends Error {
  constructor(readonly code: RecordTransferConflictCode) {
    super(RECORD_TRANSFER_CONFLICT_MESSAGES[code]);
    this.name = 'RecordTransferConflictError';
  }
}

const defaultRecordTransferDeps: RecordTransferDeps = {
  db: prisma,
  prepare: prepareTransfer,
  get: getTransferOperation,
  retry: retryTransferOperation,
  commit: commitTransfer,
};

function transferIdempotencyKey(
  actorId: string,
  rows: [RecordTransferRow, RecordTransferRow],
): string {
  const legs = rows
    .map((row) => ({
      transactionId: row.id,
      revision: row.revision,
    }))
    .sort((left, right) =>
      left.transactionId.localeCompare(right.transactionId)
    );
  const digest = createHash('sha256')
    .update(JSON.stringify({ actorId, legs }))
    .digest('hex');
  return `ui-transfer:${digest}`;
}

export async function recordTransfer(
  txnId: string,
  counterpartId: string,
  actor: Actor,
  dependencies: RecordTransferDeps = defaultRecordTransferDeps,
): Promise<{ status: TxnStatus }> {
  if (txnId === counterpartId) {
    throw new Error('A transaction cannot be its own transfer counterpart.');
  }
  if (typeof actor.id !== 'string' || actor.id.trim() === '') {
    throw new Error('A current user is required to record a transfer.');
  }

  const [a, b] = await Promise.all([
    dependencies.db.transaction.findUnique({
      where: { id: txnId },
      select: { id: true, companyId: true, revision: true },
    }),
    dependencies.db.transaction.findUnique({
      where: { id: counterpartId },
      select: { id: true, companyId: true, revision: true },
    }),
  ]);
  if (!a || !b) throw new Error('Transfer transaction not found');
  if (a.companyId !== b.companyId) {
    throw new Error('Transfer legs must belong to the same company');
  }
  const prepared = await dependencies.prepare({
    companyId: a.companyId,
    transactionId: a.id,
    counterpartTransactionId: b.id,
    expectedRevision: a.revision,
    counterpartExpectedRevision: b.revision,
    idempotencyKey: transferIdempotencyKey(actor.id, [a, b]),
    actor,
  });
  const beforeCommit = await dependencies.get(prepared.operationId, actor);
  let committed = await dependencies.commit(prepared.operationId, actor);
  if (
    isSafelyRetryableTransfer(beforeCommit)
    && isSafelyRetryableTransfer(committed)
  ) {
    const child = await dependencies.retry(prepared.operationId, actor);
    committed = await dependencies.commit(child.operationId, actor);
  }
  if (
    committed.state === 'VERIFIED'
    && committed.complete
    && committed.firstLeg.outcome === 'VERIFIED'
    && committed.secondLeg.outcome === 'VERIFIED'
  ) {
    return { status: 'POSTED' };
  }
  if (
    committed.state === 'DRY_RUN'
    && committed.complete
    && committed.firstLeg.outcome === 'DRY_RUN'
    && committed.secondLeg.outcome === 'DRY_RUN'
  ) {
    return { status: 'DRY_RUN' };
  }
  if (
    committed.state === 'PREPARED'
    || committed.state === 'RETRYABLE'
  ) {
    throw new RecordTransferConflictError('TRANSFER_RETRYABLE');
  }
  throw new RecordTransferConflictError(
    'TRANSFER_RECONCILIATION_REQUIRED',
  );
}

function isSafelyRetryableTransfer(
  operation: TransferOperationDto,
): boolean {
  const outcomes = [
    operation.firstLeg.outcome,
    operation.secondLeg.outcome,
  ];
  return (
    (operation.state === 'RETRYABLE' || operation.state === 'PARTIAL')
    && outcomes.some((outcome) =>
      outcome === 'RETRYABLE' || outcome === 'UNCHANGED'
    )
    && outcomes.every((outcome) =>
      outcome === 'VERIFIED'
      || outcome === 'RETRYABLE'
      || outcome === 'UNCHANGED'
    )
  );
}
