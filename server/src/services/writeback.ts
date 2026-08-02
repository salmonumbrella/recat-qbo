// Write-back service (specs §5) — the only path that writes to QuickBooks.
//
// Invariants (CLAUDE.md):
//   * Never write without a fresh read: fetchTxn → verify still in holding →
//     recategorize with the fresh SyncToken; on conflict re-fetch + retry ONCE.
//   * Every QBO write gets an AuditEntry in the SAME prisma transaction as the
//     status change. No exceptions — including dry-run.
//   * DRY_RUN (env or per-company) never calls recategorize; it logs the exact
//     payload it would have sent and marks the txn DRY_RUN.
//
// Dependencies on other agents' modules (audit, qbo factory) are imported
// lazily and injectable, so unit tests can exercise this file with fakes.

import { createHash, randomUUID } from 'node:crypto';
import type { PrismaClient, Prisma } from '@prisma/client';
import type { AuditAction, SplitDto, StagedCategorization, TxnStatus } from '@recat/shared';
import {
  QboSyncTokenConflict,
  type QboClient,
  type QboPreparedWrite,
  type QboPurchaseSnapshot,
  type QboTxn,
  type QboWriteResult,
} from '../lib/qbo/types.js';
import { calculatePurchaseTransaction } from '../lib/qbo/purchaseTax.js';
import { verifyPurchaseResult } from './tax/verify.js';
import {
  acquireEntityLease,
  withEntityLease,
  type EntityLeaseDb,
  type EntityLeaseKey,
} from './entityLease.js';
import type { MutationAuditInput } from './audit.js';

export interface Actor {
  /** userId, or null for 'system' */
  id: string | null;
  /** display name shown in the audit log */
  label: string;
}

export interface PostResult {
  id: string;
  ok: boolean;
  status: TxnStatus;
  error?: { code: string; message: string };
}

interface AuditEntryInput {
  companyId: string;
  actorId?: string | null;
  actorLabel: string;
  txnId?: string;
  payee: string;
  amount: number;
  action: AuditAction;
  before: string;
  after: string;
  payload?: unknown;
  mutation?: MutationAuditInput;
}

type AuditFn = (txOrPrisma: Prisma.TransactionClient | PrismaClient, entry: AuditEntryInput) => Promise<unknown>;

export interface WritebackDeps {
  db: PrismaClient;
  getClient: (companyId: string) => Promise<QboClient>;
  audit: AuditFn;
  envDryRun: boolean;
}

async function defaultDeps(): Promise<WritebackDeps> {
  const [{ prisma }, { qboFactory }, { writeAudit }, { env }] = await Promise.all([
    import('../lib/prisma.js'),
    import('../lib/qbo/factory.js'),
    import('./audit.js'),
    import('../env.js'),
  ]);
  return {
    db: prisma,
    getClient: (companyId) => qboFactory.forCompany(companyId),
    audit: writeAudit,
    envDryRun: env.DRY_RUN,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

export interface SplitValidation {
  ok: boolean;
  message?: string;
}

/**
 * Splits must each be nonzero, share the transaction's sign (the client sends
 * signed amounts matching the txn), and sum to the signed transaction amount
 * within half a cent. A mixed-sign or zero line would silently reshape the
 * QBO entity, so each failure carries its own message.
 */
export function validateSplits(txnAmount: number, splits: { amount: number }[]): SplitValidation {
  const sign = Math.sign(txnAmount);
  for (const s of splits) {
    if (Math.abs(s.amount) < 0.005) {
      return { ok: false, message: 'Every split needs a nonzero amount.' };
    }
    if (sign !== 0 && Math.sign(s.amount) !== sign) {
      return {
        ok: false,
        message:
          sign < 0
            ? 'Every split must match the transaction: this is money out, so all split amounts must be negative.'
            : 'Every split must match the transaction: this is money in, so all split amounts must be positive.',
      };
    }
  }
  const sum = splits.reduce((acc, s) => acc + s.amount, 0);
  if (Math.abs(sum - txnAmount) > 0.005) {
    return { ok: false, message: 'Split amounts must add up to the transaction amount.' };
  }
  return { ok: true };
}

function jsonStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** Structural shape of a SplitLine row with its tags loaded (Prisma or fake). */
export interface SplitLineLike {
  idx: number;
  /** Prisma Decimal or plain number — Number() handles both */
  amount: number | { toString(): string };
  category: string;
  categoryQboId: string | null;
  taxCode?: string | null;
  taxCodeQboId?: string | null;
  memo: string | null;
  tags: { tagId: string }[];
}

/**
 * SplitLine rows → the wire/API SplitDto shape (ordered by idx). Returns null
 * for an empty set — the API contract uses `splits: null` for "not split".
 */
export function splitLineDtos(lines: SplitLineLike[]): SplitDto[] | null {
  if (lines.length === 0) return null;
  return [...lines]
    .sort((a, b) => a.idx - b.idx)
    .map((l) => ({
      amount: Number(l.amount),
      category: l.category,
      ...(l.categoryQboId !== null ? { categoryQboId: l.categoryQboId } : {}),
      taxCode: l.taxCode ?? null,
      taxCodeQboId: l.taxCodeQboId ?? null,
      tagIds: l.tags.map((t) => t.tagId),
      ...(l.memo !== null ? { memo: l.memo } : {}),
    }));
}

// ---------------------------------------------------------------------------

interface WriteSplit {
  amount: number;
  accountQboId: string;
  memo?: string;
}

interface ResolvedAccount {
  qboId: string;
  name: string;
  fullName: string;
}

async function resolveCategoryAccount(
  db: PrismaClient,
  companyId: string,
  categoryQboId: string | null | undefined,
  categoryName: string,
): Promise<ResolvedAccount | null> {
  const row = categoryQboId
    ? await db.qboAccount.findFirst({ where: { companyId, qboId: categoryQboId } })
    : await db.qboAccount.findFirst({ where: { companyId, name: categoryName, active: true } });
  if (!row) return null;
  return { qboId: row.qboId, name: row.name, fullName: row.fullName };
}

async function holdingAccountName(db: PrismaClient, companyId: string, holdingIds: string[]): Promise<string> {
  const first = holdingIds[0];
  if (!first) return 'Holding account';
  const row = await db.qboAccount.findFirst({ where: { companyId, qboId: first } });
  return row?.name ?? 'Holding account';
}

function errorInfo(err: unknown): { code: string; message: string } {
  if (err instanceof QboSyncTokenConflict) return { code: err.code, message: err.message };
  if (err instanceof Error) {
    const code = 'code' in err && typeof (err as { code?: unknown }).code === 'string' ? (err as { code: string }).code : 'QBO_ERROR';
    return { code, message: err.message };
  }
  return { code: 'QBO_ERROR', message: String(err) };
}

async function markSuperseded(
  d: WritebackDeps,
  txn: { id: string; companyId: string; payee: string; amount: number },
  before: string,
): Promise<PostResult> {
  await d.db.$transaction(async (tx) => {
    await tx.transaction.update({
      where: { id: txn.id },
      data: { status: 'SUPERSEDED', errorCode: null, errorMessage: null },
    });
    await d.audit(tx, {
      companyId: txn.companyId,
      actorId: null,
      actorLabel: 'system',
      txnId: txn.id,
      payee: txn.payee,
      amount: txn.amount,
      action: 'superseded',
      before,
      after: 'fixed inside QuickBooks',
    });
  });
  return {
    id: txn.id,
    ok: false,
    status: 'SUPERSEDED',
    error: { code: 'SUPERSEDED', message: 'This transaction was already categorized inside QuickBooks.' },
  };
}

// ---------------------------------------------------------------------------
// postTransaction
// ---------------------------------------------------------------------------

export async function postTransaction(
  txnId: string,
  actor: Actor,
  opts: { auto?: boolean } = {},
  deps?: WritebackDeps,
): Promise<PostResult> {
  const d = deps ?? (await defaultDeps());

  const txn = await d.db.transaction.findUnique({
    where: { id: txnId },
    include: {
      company: true,
      txnTags: true,
      splitLines: { include: { tags: true }, orderBy: { idx: 'asc' } },
    },
  });
  if (!txn) throw new Error(`Transaction ${txnId} not found`);
  const company = txn.company;
  if (
    txn.qboType === 'Purchase' &&
    company.taxSupportStatus === 'ready' &&
    company.taxUsingSalesTax === true
  ) {
    throw new WritebackLifecycleError(
      'TAX_AWARE_STAGING_REQUIRED',
      'Tax-ready Purchases must use staged categorization.',
    );
  }
  if (txn.status !== 'PENDING' && txn.status !== 'ERROR') {
    throw new Error(`Cannot post a transaction in status ${txn.status}`);
  }

  const amount = Number(txn.amount);
  const splits = splitLineDtos(txn.splitLines);
  const hasSplits = splits !== null && splits.length > 0;

  // ---- guards (handoff §2) — checked before we touch status or QBO ----
  if (!hasSplits && !txn.category) throw new Error('Pick a category (or splits) before posting.');
  if (hasSplits) {
    const splitCheck = validateSplits(amount, splits);
    if (!splitCheck.ok) throw new Error(splitCheck.message ?? 'Split amounts must add up to the transaction amount.');
  }
  if (company.tagsRequired) {
    const tagged = hasSplits ? splits.every((s) => (s.tagIds ?? []).length > 0) : txn.txnTags.length > 0;
    if (!tagged) {
      throw new Error(
        hasSplits
          ? 'This company requires at least one tag on every split before posting.'
          : 'This company requires at least one tag before posting.',
      );
    }
  }

  await d.db.transaction.update({ where: { id: txnId }, data: { status: 'POSTING' } });

  const holdingIds = jsonStringArray(company.holdingAccountIds);
  const baseTxn = { id: txn.id, companyId: txn.companyId, payee: txn.payee, amount };

  try {
    const client = await d.getClient(company.id);

    // ---- fresh read: never trust a cached SyncToken across user think-time ----
    const fresh = await client.fetchTxn(txn.qboType as QboTxn['qboType'], txn.qboId);
    const holdingLine = fresh?.lines.find((l) => holdingIds.includes(l.accountQboId));
    if (!fresh || !holdingLine) {
      // Someone already fixed it inside QuickBooks (or deleted it).
      const before = await holdingAccountName(d.db, company.id, holdingIds);
      return await markSuperseded(d, baseTxn, before);
    }
    const before = holdingLine.accountName;

    // ---- build the write payload ----
    const writeSplits: WriteSplit[] = [];
    let afterLabel: string;
    if (hasSplits) {
      for (const s of splits) {
        const acct = await resolveCategoryAccount(d.db, company.id, s.categoryQboId, s.category);
        if (!acct) throw new Error(`Unknown category "${s.category}" — re-sync the chart of accounts.`);
        writeSplits.push({ amount: s.amount, accountQboId: acct.qboId, memo: s.memo });
      }
      afterLabel = `Split · ${splits.map((s) => s.category).join(' / ')}`;
    } else {
      const categoryName = txn.category ?? '';
      const acct = await resolveCategoryAccount(d.db, company.id, txn.categoryQboId, categoryName);
      if (!acct) throw new Error(`Unknown category "${categoryName}" — re-sync the chart of accounts.`);
      writeSplits.push({ amount, accountQboId: acct.qboId, memo: txn.memo ?? undefined });
      afterLabel = acct.fullName || categoryName;
    }

    const now = new Date();
    const successAction: AuditAction = opts.auto ? 'auto-posted' : 'posted';
    const payload = {
      qboType: txn.qboType,
      qboId: txn.qboId,
      syncToken: fresh.syncToken,
      splits: writeSplits,
    };

    // ---- dry-run: log the exact payload, write NOTHING to QBO ----
    if (company.dryRun || d.envDryRun) {
      await d.db.$transaction(async (tx) => {
        await tx.transaction.update({
          where: { id: txnId },
          data: {
            status: 'DRY_RUN',
            postedAt: now,
            postedByUserId: actor.id,
            qboSyncToken: fresh.syncToken,
            errorCode: null,
            errorMessage: null,
          },
        });
        await d.audit(tx, {
          companyId: company.id,
          actorId: actor.id,
          actorLabel: actor.label,
          txnId,
          payee: txn.payee,
          amount,
          action: 'dry-run',
          before,
          after: afterLabel,
          payload,
        });
      });
      return { id: txnId, ok: true, status: 'DRY_RUN' };
    }

    // ---- real write, with one SyncToken-conflict retry ----
    let result: QboWriteResult;
    try {
      try {
        result = await client.recategorize(fresh, writeSplits);
      } catch (err) {
        if (!(err instanceof QboSyncTokenConflict)) throw err;
        // Someone edited the entity between our read and write: re-fetch and
        // retry exactly once.
        const refetched = await client.fetchTxn(txn.qboType as QboTxn['qboType'], txn.qboId);
        const stillHolding = refetched?.lines.some((l) => holdingIds.includes(l.accountQboId));
        if (!refetched || !stillHolding) return await markSuperseded(d, baseTxn, before);
        payload.syncToken = refetched.syncToken;
        result = await client.recategorize(refetched, writeSplits);
      }
    } catch (err) {
      const info = errorInfo(err);
      await d.db.$transaction(async (tx) => {
        await tx.transaction.update({
          where: { id: txnId },
          data: { status: 'ERROR', errorCode: info.code, errorMessage: info.message },
        });
        await d.audit(tx, {
          companyId: company.id,
          actorId: actor.id,
          actorLabel: actor.label,
          txnId,
          payee: txn.payee,
          amount,
          action: 'error',
          before,
          after: afterLabel,
          payload: { ...payload, error: info },
        });
      });
      return { id: txnId, ok: false, status: 'ERROR', error: info };
    }

    // ---- success: status + audit, atomically ----
    try {
      await d.db.$transaction(async (tx) => {
        await tx.transaction.update({
          where: { id: txnId },
          data: {
            status: 'POSTED',
            postedAt: now,
            postedByUserId: actor.id,
            qboSyncToken: result.newSyncToken,
            errorCode: null,
            errorMessage: null,
          },
        });
        await d.audit(tx, {
          companyId: company.id,
          actorId: actor.id,
          actorLabel: actor.label,
          txnId,
          payee: txn.payee,
          amount,
          action: successAction,
          before,
          after: afterLabel,
          payload,
        });
      });
    } catch (commitErr) {
      // Dual-write honesty: QuickBooks accepted the recategorize but our own
      // commit failed. Never pretend the write didn't happen — mark ERROR with
      // an explicit "go verify" message and leave a best-effort audit trail.
      const message = 'The QuickBooks write may have succeeded — verify in QuickBooks before retrying.';
      const info = { code: 'DB_COMMIT_FAILED', message };
      console.error(`[writeback] DB commit failed after a successful QBO write for txn ${txnId}:`, commitErr);
      await d.db.transaction
        .update({ where: { id: txnId }, data: { status: 'ERROR', errorCode: info.code, errorMessage: info.message } })
        .catch(() => undefined);
      await Promise.resolve(
        d.audit(d.db, {
          companyId: company.id,
          actorId: actor.id,
          actorLabel: actor.label,
          txnId,
          payee: txn.payee,
          amount,
          action: 'error',
          before,
          after: afterLabel,
          payload: { ...payload, error: info },
        }),
      ).catch(() => undefined);
      return { id: txnId, ok: false, status: 'ERROR', error: info };
    }
    return { id: txnId, ok: true, status: 'POSTED' };
  } catch (err) {
    // Unexpected failure after POSTING was set: fail loudly but never leave the
    // txn stuck in POSTING.
    const info = errorInfo(err);
    await d.db.transaction
      .update({ where: { id: txnId }, data: { status: 'ERROR', errorCode: info.code, errorMessage: info.message } })
      .catch(() => undefined);
    return { id: txnId, ok: false, status: 'ERROR', error: info };
  }
}

// ---------------------------------------------------------------------------
// undoPost — POSTED/DRY_RUN → (REVERTED) → PENDING, within 30 days
// ---------------------------------------------------------------------------

const UNDO_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export async function undoPost(txnId: string, actor: Actor, deps?: WritebackDeps): Promise<PostResult> {
  const d = deps ?? (await defaultDeps());

  const txn = await d.db.transaction.findUnique({
    where: { id: txnId },
    include: { company: true, splitLines: { include: { tags: true }, orderBy: { idx: 'asc' } } },
  });
  if (!txn) throw new Error(`Transaction ${txnId} not found`);
  const company = txn.company;
  if (
    txn.qboType === 'Purchase' &&
    company.taxSupportStatus === 'ready' &&
    company.taxUsingSalesTax === true
  ) {
    throw new WritebackLifecycleError(
      'TAX_AWARE_STAGING_REQUIRED',
      'Tax-ready Purchases must use staged categorization.',
    );
  }
  if (txn.status !== 'POSTED' && txn.status !== 'DRY_RUN') {
    throw new Error(`Only posted transactions can be undone (status is ${txn.status})`);
  }
  if (!txn.postedAt || Date.now() - txn.postedAt.getTime() > UNDO_WINDOW_MS) {
    throw new Error('The 30-day undo window for this transaction has passed.');
  }

  const amount = Number(txn.amount);
  const holdingIds = jsonStringArray(company.holdingAccountIds);
  const holdingId = holdingIds[0];
  if (!holdingId) throw new Error('No holding account configured for this company.');
  const holdingName = await holdingAccountName(d.db, company.id, holdingIds);

  const splits = splitLineDtos(txn.splitLines);
  const beforeLabel =
    splits && splits.length > 0 ? `Split · ${splits.map((s) => s.category).join(' / ')}` : txn.category ?? '—';

  // Undo in QBO based on HOW the txn was posted: DRY_RUN wrote nothing, so
  // there is nothing to undo there; POSTED always wrote, so it must always be
  // reversed — regardless of what the dry-run config says NOW.
  let newSyncToken = txn.qboSyncToken;
  let qboWrote = false;
  if (txn.status === 'POSTED') {
    const client = await d.getClient(company.id);
    const fresh = await client.fetchTxn(txn.qboType as QboTxn['qboType'], txn.qboId);
    if (!fresh) {
      // Re-queuing a txn whose QBO entity is gone would strand a phantom in
      // the queue — fail loudly instead.
      throw new Error('This transaction no longer exists in QuickBooks.');
    }
    // Pull back exactly the category lines the post wrote; any other lines on
    // the entity are preserved verbatim by moveToAccount.
    const fromIds: string[] = [];
    if (splits && splits.length > 0) {
      for (const s of splits) {
        const acct = await resolveCategoryAccount(d.db, company.id, s.categoryQboId, s.category);
        if (acct) fromIds.push(acct.qboId);
      }
    } else {
      const acct = await resolveCategoryAccount(d.db, company.id, txn.categoryQboId, txn.category ?? '');
      if (acct) fromIds.push(acct.qboId);
    }
    if (fromIds.length === 0) {
      throw new Error('Cannot undo — the posted category could not be resolved. Re-sync the chart of accounts.');
    }
    const result = await client.moveToAccount(fresh, holdingId, fromIds);
    newSyncToken = result.newSyncToken;
    qboWrote = true;
  }

  // REVERTED is a transition, not a resting state (handoff §2): the txn lands
  // back in the queue as PENDING with its staged category kept for re-posting.
  try {
    await d.db.$transaction(async (tx) => {
      await tx.transaction.update({
        where: { id: txnId },
        data: {
          status: 'PENDING',
          postedAt: null,
          postedByUserId: null,
          qboSyncToken: newSyncToken,
          errorCode: null,
          errorMessage: null,
        },
      });
      await d.audit(tx, {
        companyId: company.id,
        actorId: actor.id,
        actorLabel: actor.label,
        txnId,
        payee: txn.payee,
        amount,
        action: 'reverted',
        before: beforeLabel,
        after: `${holdingName} (re-queued)`,
      });
    });
  } catch (commitErr) {
    if (!qboWrote) throw commitErr;
    // Dual-write honesty: the QBO undo went through but our commit failed.
    const message = 'The QuickBooks write may have succeeded — verify in QuickBooks before retrying.';
    const info = { code: 'DB_COMMIT_FAILED', message };
    console.error(`[writeback] DB commit failed after a successful QBO undo for txn ${txnId}:`, commitErr);
    await d.db.transaction
      .update({ where: { id: txnId }, data: { status: 'ERROR', errorCode: info.code, errorMessage: info.message } })
      .catch(() => undefined);
    await Promise.resolve(
      d.audit(d.db, {
        companyId: company.id,
        actorId: actor.id,
        actorLabel: actor.label,
        txnId,
        payee: txn.payee,
        amount,
        action: 'error',
        before: beforeLabel,
        after: `${holdingName} (undo)`,
        payload: { error: info },
      }),
    ).catch(() => undefined);
    return { id: txnId, ok: false, status: 'ERROR', error: info };
  }
  return { id: txnId, ok: true, status: 'PENDING' };
}

// ---------------------------------------------------------------------------
// retryError — ERROR → PENDING with a fresh SyncToken
// ---------------------------------------------------------------------------

export async function retryError(txnId: string, deps?: WritebackDeps): Promise<PostResult> {
  const d = deps ?? (await defaultDeps());

  const txn = await d.db.transaction.findUnique({ where: { id: txnId }, include: { company: true } });
  if (!txn) throw new Error(`Transaction ${txnId} not found`);
  if (txn.status !== 'ERROR') throw new Error(`Only errored transactions can be retried (status is ${txn.status})`);
  const unresolvedPreparedWrite = await d.db.qboMutationAttempt.findFirst({
    where: {
      transactionId: txnId,
      status: { in: ['PREPARED', 'COMMITTING', 'UNCERTAIN'] },
    },
  });
  if (unresolvedPreparedWrite) {
    throw new WritebackLifecycleError(
      'MUTATION_BLOCKED',
      'This write must be reconciled before the transaction can be retried.',
    );
  }

  const holdingIds = jsonStringArray(txn.company.holdingAccountIds);
  const client = await d.getClient(txn.companyId);
  const fresh = await client.fetchTxn(txn.qboType as QboTxn['qboType'], txn.qboId);
  const stillHolding = fresh?.lines.some((l) => holdingIds.includes(l.accountQboId));
  if (!fresh || !stillHolding) {
    const before = await holdingAccountName(d.db, txn.companyId, holdingIds);
    return markSuperseded(d, { id: txn.id, companyId: txn.companyId, payee: txn.payee, amount: Number(txn.amount) }, before);
  }

  await d.db.transaction.update({
    where: { id: txnId },
    data: { status: 'PENDING', qboSyncToken: fresh.syncToken, errorCode: null, errorMessage: null },
  });
  return { id: txnId, ok: true, status: 'PENDING' };
}

// ---------------------------------------------------------------------------
// bulkPost — sequential, per-id results (QBO rate limits are generous but a
// self-hosted install should still write one at a time)
// ---------------------------------------------------------------------------

export async function bulkPost(txnIds: string[], actor: Actor, deps?: WritebackDeps): Promise<PostResult[]> {
  const d = deps ?? (await defaultDeps());
  const results: PostResult[] = [];
  for (const id of txnIds) {
    try {
      results.push(await postTransaction(id, actor, {}, d));
    } catch (err) {
      const info = errorInfo(err);
      results.push({ id, ok: false, status: 'PENDING', error: info });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Tax-aware durable prepared-write lifecycle
// ---------------------------------------------------------------------------

type AttemptStatus =
  | 'PREPARED'
  | 'COMMITTING'
  | 'VERIFIED'
  | 'UNCERTAIN'
  | 'RETRYABLE'
  | 'UNCHANGED'
  | 'DRY_RUN';

export interface DurableAttempt {
  id: string;
  transactionId: string;
  requestId: string;
  operation: string;
  status: string;
  expectedRevision: number;
  expectedSyncToken: string;
  requestHash: string;
  requestPayload: unknown;
  beforeSnapshot: unknown;
  responseSnapshot: unknown;
  verification: unknown;
  errorCode: string | null;
  errorMessage: string | null;
}

interface DurableTransaction {
  id: string;
  companyId: string;
  qboId: string;
  qboType: string;
  qboSyncToken: string;
  revision: number;
  status: string;
  amount: number | string | { toString(): string };
  payee: string;
  postedAt: Date | null;
  postedByUserId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  taxCalculation: string | null;
  company: {
    id: string;
    disconnectedAt: Date | null;
    dryRun: boolean;
    holdingAccountIds: unknown;
    taxSupportStatus: string;
    taxUsingSalesTax: boolean | null;
  };
  splitLines: {
    idx: number;
    amount: number | string | { toString(): string };
    category: string;
    categoryQboId: string | null;
    taxCode: string | null;
    taxCodeQboId: string | null;
    memo: string | null;
    tags?: { tagId: string }[];
  }[];
  txnTags: { tagId: string }[];
}

interface DurableTaxCode {
  qboId: string;
  name: string;
  active: boolean;
  taxable: boolean | null;
  purchaseTaxRateList: unknown;
}

interface DurableTaxRate {
  qboId: string;
  name: string;
  active: boolean;
  rateValue: number | string | { toString(): string };
}

export interface DurableWritebackDb {
  transaction: {
    findUnique(args: {
      where: { id: string };
      include: {
        company: true;
        splitLines: {
          orderBy: { idx: 'asc' };
          include?: { tags: true };
        };
        txnTags: true;
      };
    }): Promise<DurableTransaction | null>;
    update(args: {
      where: { id: string };
      data: Record<string, unknown>;
    }): Promise<unknown>;
  };
  qboMutationAttempt: {
    findUnique(args: {
      where: { requestId: string };
    }): Promise<DurableAttempt | null>;
    findFirst(args: {
      where: {
        transactionId: string;
        operation?: string;
        status?: string | { in: string[] };
      };
      orderBy?: { createdAt: 'desc' };
    }): Promise<DurableAttempt | null>;
    create(args: {
      data: {
        transactionId: string;
        requestId: string;
        operation: string;
        status: AttemptStatus;
        expectedRevision: number;
        expectedSyncToken: string;
        requestHash: string;
        requestPayload: unknown;
        beforeSnapshot: unknown;
        responseSnapshot?: unknown;
        verification?: unknown;
        errorCode?: string | null;
        errorMessage?: string | null;
      };
    }): Promise<DurableAttempt>;
    update(args: {
      where: { id: string };
      data: Record<string, unknown>;
    }): Promise<DurableAttempt>;
    updateMany(args: {
      where: { id: string; status: string | { in: string[] } };
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
  };
  qboAccount: {
    findMany(args: {
      where: { companyId: string; qboId: { in: string[] }; active: true };
    }): Promise<{ qboId: string; active: boolean }[]>;
  };
  qboTaxCode: {
    findMany(args: {
      where: { companyId: string; qboId: { in: string[] } };
    }): Promise<DurableTaxCode[]>;
  };
  qboTaxRate: {
    findMany(args: {
      where: { companyId: string; active: true };
    }): Promise<DurableTaxRate[]>;
  };
  $transaction<T>(callback: (tx: DurableWritebackDb) => Promise<T>): Promise<T>;
}

export interface DurableWritebackDeps {
  db: DurableWritebackDb;
  getClient: (companyId: string) => Promise<QboClient>;
  audit: AuditFn;
  authorize: (
    actorId: string | null,
    companyId: string,
    authorization: DurableMutationAuthorization,
  ) => Promise<boolean>;
  envDryRun: boolean;
  lease: <T>(
    key: EntityLeaseKey,
    owner: string,
    callback: () => Promise<T>,
  ) => Promise<T>;
  renewLease: (key: EntityLeaseKey, owner: string) => Promise<void>;
  invocationId: () => string;
  now: () => Date;
}

export type DurableMutationAuthorization =
  | { kind: 'user' }
  | { kind: 'mcp'; tokenId: string; tokenPrefix: string };

export interface ExpectedQboBinding {
  qboType: string;
  qboId: string;
  qboSyncToken: string;
}

export interface CommitStagedCategorizationInput {
  transactionId: string;
  companyId: string;
  expectedRevision: number;
  requestId: string;
  actor: Actor;
  expectedStageHash?: string;
  expectedQboBinding?: ExpectedQboBinding;
  authorization?: DurableMutationAuthorization;
}

export interface ReconcileMutationAttemptInput {
  requestId: string;
  actor: Actor;
  authorization?: DurableMutationAuthorization;
  expectedStageHash?: string;
  expectedQboBinding?: ExpectedQboBinding;
  auditAttribution?: McpMutationAuditAttribution;
}

export interface UndoCategorizationInput {
  transactionId: string;
  companyId: string;
  requestId: string;
  actor: Actor;
  authorization?: DurableMutationAuthorization;
  proof?: CategorizationUndoProof;
  auditAttribution?: McpMutationAuditAttribution;
}

export interface CategorizationUndoProof {
  sourceRequestId: string;
  expectedRevision: number;
  expectedQboBinding: ExpectedQboBinding;
  sourcePreparedHash: string;
  currentPostHash: string;
  restoreHash: string;
}

export interface McpMutationAuditAttribution {
  sourceOperationId: string;
  operationId: string;
  tokenPrefix: string;
}

export interface PrepareCategorizationUndoInput {
  transactionId: string;
  companyId: string;
  sourceRequestId: string;
  expectedRevision: number;
  expectedSourceSyncToken: string;
  expectedQboBinding: Pick<ExpectedQboBinding, 'qboType' | 'qboId'>;
  actor: Actor;
  authorization: DurableMutationAuthorization;
}

export interface PreparedCategorizationUndo {
  transactionId: string;
  companyId: string;
  revision: number;
  qboType: 'Purchase';
  qboId: string;
  qboSyncToken: string;
  sourcePreparedHash: string;
  currentPostHash: string;
  restoreHash: string;
  preview: {
    action: 'restore_purchase_categorization';
    resultingStatus: 'REVERTED';
    direction: 'purchase' | 'refund';
    totalCents: number;
    totalTaxCents: number | null;
    lineCount: number;
    restorationDigest: string;
  };
}

export type DurableMutationOutcome =
  | 'VERIFIED'
  | 'UNCERTAIN'
  | 'IN_PROGRESS'
  | 'UNCHANGED'
  | 'DRY_RUN'
  | 'RETRYABLE';

export interface DurableMutationResult {
  transactionId: string;
  requestId: string;
  ok: boolean;
  status: TxnStatus;
  outcome: DurableMutationOutcome;
  error?: { code: string; message: string };
}

export class WritebackLifecycleError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'WritebackLifecycleError';
  }
}

const ACTIVE_ATTEMPT_STATUSES = ['PREPARED', 'COMMITTING', 'UNCERTAIN'];
const POSSIBLE_WRITE_GUIDANCE =
  'The QuickBooks write may have succeeded — verify in QuickBooks before retrying.';

async function defaultDurableDeps(): Promise<DurableWritebackDeps> {
  const [{ prisma }, { qboFactory }, { writeAudit }, { env }] = await Promise.all([
    import('../lib/prisma.js'),
    import('../lib/qbo/factory.js'),
    import('./audit.js'),
    import('../env.js'),
  ]);
  return {
    db: prisma as unknown as DurableWritebackDb,
    getClient: (companyId) => qboFactory.forCompany(companyId),
    audit: writeAudit,
    authorize: async (actorId, companyId, authorization) => {
      if (actorId === null) return false;
      if (authorization.kind === 'mcp') {
        const token = await prisma.mcpToken.findFirst({
          where: {
            id: authorization.tokenId,
            userId: actorId,
            prefix: authorization.tokenPrefix,
            revokedAt: null,
            expiresAt: { gt: new Date() },
          },
          select: { id: true },
        });
        if (token === null) return false;
      }
      const user = await prisma.user.findUnique({
        where: { id: actorId },
        select: { isInstanceAdmin: true },
      });
      if (user?.isInstanceAdmin) return true;
      const membership = await prisma.membership.findUnique({
        where: { userId_companyId: { userId: actorId, companyId } },
        select: { role: true },
      });
      return membership?.role === 'admin' || membership?.role === 'categorizer';
    },
    envDryRun: env.DRY_RUN,
    lease: (key, owner, callback) =>
      withEntityLease(key, owner, callback, {
        db: prisma as unknown as EntityLeaseDb,
      }),
    renewLease: (key, owner) =>
      acquireEntityLease(key, owner, {
        db: prisma as unknown as EntityLeaseDb,
      }),
    invocationId: randomUUID,
    now: () => new Date(),
  };
}

function lifecycleError(code: string, message: string): never {
  throw new WritebackLifecycleError(code, message);
}

function exactMoneyCents(value: DurableTransaction['amount']): number {
  const text = value.toString();
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return lifecycleError('INVALID_TRANSACTION_AMOUNT', 'Transaction amount is not exact cents.');
  const sign = match[1] === '-' ? -1n : 1n;
  const cents =
    sign *
    (BigInt(match[2]!) * 100n + BigInt((match[3] ?? '').padEnd(2, '0')));
  if (cents < BigInt(Number.MIN_SAFE_INTEGER) || cents > BigInt(Number.MAX_SAFE_INTEGER)) {
    return lifecycleError('INVALID_TRANSACTION_AMOUNT', 'Transaction amount is outside the safe cents range.');
  }
  return Number(cents);
}

function uniqueStrings(values: (string | null)[]): string[] {
  return [...new Set(values.filter((value): value is string => value !== null && value.trim() !== ''))];
}

function asPurchaseRates(value: unknown): {
  taxRateQboId: string;
  taxTypeApplicable: string;
}[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (
      typeof candidate !== 'object' ||
      candidate === null ||
      !('taxRateQboId' in candidate) ||
      !('taxTypeApplicable' in candidate) ||
      typeof candidate.taxRateQboId !== 'string' ||
      typeof candidate.taxTypeApplicable !== 'string'
    ) {
      return [];
    }
    return [{
      taxRateQboId: candidate.taxRateQboId,
      taxTypeApplicable: candidate.taxTypeApplicable,
    }];
  });
}

async function loadAuthorizedStage(
  transactionId: string,
  companyId: string,
  expectedRevision: number,
  actorId: string | null,
  d: DurableWritebackDeps,
  allowedStatuses: string[],
  authorization: DurableMutationAuthorization = { kind: 'user' },
  expectedStageHash?: string,
  expectedQboBinding?: ExpectedQboBinding,
): Promise<{ txn: DurableTransaction; staged: StagedCategorization }> {
  const [txn, authorized] = await Promise.all([
    d.db.transaction.findUnique({
      where: { id: transactionId },
      include: {
        company: true,
        splitLines: { orderBy: { idx: 'asc' }, include: { tags: true } },
        txnTags: true,
      },
    }),
    d.authorize(actorId, companyId, authorization),
  ]);
  if (!authorized) lifecycleError('FORBIDDEN', 'You do not have permission to write this transaction.');
  if (!txn || txn.companyId !== companyId) {
    lifecycleError('TRANSACTION_NOT_FOUND', 'Transaction was not found for this company.');
  }
  if (txn.company.disconnectedAt !== null) {
    lifecycleError('COMPANY_DISCONNECTED', 'This company is disconnected from QuickBooks.');
  }
  if (txn.revision !== expectedRevision) {
    lifecycleError('STALE_REVISION', 'The staged transaction changed. Reload before writing.');
  }
  if (
    expectedQboBinding !== undefined
    && (
      txn.qboType !== expectedQboBinding.qboType
      || txn.qboId !== expectedQboBinding.qboId
      || txn.qboSyncToken !== expectedQboBinding.qboSyncToken
    )
  ) {
    lifecycleError('STALE_QBO_BINDING', 'The QuickBooks transaction binding changed.');
  }
  if (!allowedStatuses.includes(txn.status)) {
    lifecycleError('INVALID_STATUS', `Transaction cannot be written from status ${txn.status}.`);
  }
  if (txn.qboType !== 'Purchase') {
    lifecycleError('QBO_PURCHASE_UNSUPPORTED', 'Tax-aware durable writes support Purchase transactions only.');
  }
  if (txn.splitLines.length === 0) {
    lifecycleError('INVALID_STAGE', 'The staged Purchase has no prepared lines.');
  }

  const accountIds = uniqueStrings(txn.splitLines.map((line) => line.categoryQboId));
  if (accountIds.length !== txn.splitLines.length) {
    lifecycleError('INVALID_ACCOUNT', 'Every prepared line requires a category account.');
  }
  const accounts = await d.db.qboAccount.findMany({
    where: { companyId, qboId: { in: accountIds }, active: true },
  });
  if (accounts.length !== accountIds.length) {
    lifecycleError('INVALID_ACCOUNT', 'A prepared category account is no longer available.');
  }

  const taxCalculation = txn.taxCalculation;
  if (
    taxCalculation !== 'TaxInclusive' &&
    taxCalculation !== 'TaxExcluded' &&
    taxCalculation !== 'NotApplicable'
  ) {
    lifecycleError('INVALID_STAGE', 'The staged Purchase tax calculation is invalid.');
  }

  const grossCents = txn.splitLines.map((line) => exactMoneyCents(line.amount));
  let calculatedLines: {
    subtotalCents: number;
    taxCents: number;
    totalCents: number;
  }[];
  if (taxCalculation === 'NotApplicable') {
    if (txn.splitLines.some((line) => line.taxCodeQboId !== null)) {
      lifecycleError('INVALID_STAGE', 'NotApplicable lines cannot retain tax references.');
    }
    calculatedLines = grossCents.map((totalCents) => ({
      subtotalCents: totalCents,
      taxCents: 0,
      totalCents,
    }));
  } else {
    if (
      txn.company.taxSupportStatus !== 'ready' ||
      txn.company.taxUsingSalesTax !== true
    ) {
      lifecycleError('TAX_NOT_READY', 'Purchase tax references are not ready.');
    }
    const taxCodeIds = uniqueStrings(txn.splitLines.map((line) => line.taxCodeQboId));
    if (taxCodeIds.length !== txn.splitLines.length) {
      lifecycleError('TAX_CODE_UNAVAILABLE', 'Every taxed line requires an available tax code.');
    }
    const [taxCodes, taxRates] = await Promise.all([
      d.db.qboTaxCode.findMany({
        where: { companyId, qboId: { in: taxCodeIds } },
      }),
      d.db.qboTaxRate.findMany({ where: { companyId, active: true } }),
    ]);
    if (
      taxCodes.length !== taxCodeIds.length ||
      taxCodes.some((code) => !code.active)
    ) {
      lifecycleError('TAX_CODE_UNAVAILABLE', 'A prepared tax code is no longer available.');
    }
    const calculation = calculatePurchaseTransaction(
      {
        companyId,
        taxCalculation,
        lines: txn.splitLines.map((line, index) => ({
          grossCents: grossCents[index]!,
          taxCodeQboId: line.taxCodeQboId!,
        })),
      },
      {
        companyId,
        codes: taxCodes.map((code) => ({
          qboId: code.qboId,
          name: code.name,
          description: null,
          active: code.active,
          taxable: code.taxable,
          purchaseRates: asPurchaseRates(code.purchaseTaxRateList),
          sourceUpdatedAt: null,
        })),
        rates: taxRates.map((rate) => ({
          qboId: rate.qboId,
          name: rate.name,
          description: null,
          active: rate.active,
          rateValue: Number(rate.rateValue),
          sourceUpdatedAt: null,
        })),
      },
    );
    if (!calculation.eligible) {
      lifecycleError(calculation.reason, 'Prepared Purchase tax references no longer calculate exactly.');
    }
    calculatedLines = calculation.lines.map((line) => ({
      subtotalCents: line.netCents,
      taxCents: line.taxCents,
      totalCents: line.grossCents,
    }));
  }

  const totals = calculatedLines.reduce(
    (sum, line) => ({
      subtotalCents: sum.subtotalCents + line.subtotalCents,
      taxCents: sum.taxCents + line.taxCents,
      totalCents: sum.totalCents + line.totalCents,
    }),
    { subtotalCents: 0, taxCents: 0, totalCents: 0 },
  );
  if (totals.totalCents !== exactMoneyCents(txn.amount)) {
    lifecycleError('STALE_REVISION', 'The staged Purchase total no longer matches the transaction.');
  }
  const staged: StagedCategorization = {
      transactionId: txn.id,
      revision: txn.revision,
      taxCalculation,
      totals,
      lines: txn.splitLines.map((line, index) => ({
        idx: line.idx,
        ...calculatedLines[index]!,
        categoryQboId: line.categoryQboId!,
        taxCodeQboId: line.taxCodeQboId,
        memo: line.memo,
        tagIds: (line.tags?.map((tag) => tag.tagId) ?? []).sort(),
      })),
      tagIds: txn.txnTags.map((tag) => tag.tagId).sort(),
  };
  if (
    expectedStageHash !== undefined
    && hashStagedCategorization(staged) !== expectedStageHash
  ) {
    lifecycleError('STALE_STAGE', 'The staged categorization no longer matches this operation.');
  }
  return { txn, staged };
}

function isRuntimeRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNullableSafeInteger(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value));
}

function isSnapshotLine(value: unknown): boolean {
  if (!isRuntimeRecord(value)) return false;
  return (
    isNullableString(value.id) &&
    typeof value.amountCents === 'number' &&
    Number.isSafeInteger(value.amountCents) &&
    isNullableString(value.description) &&
    isNullableString(value.accountQboId) &&
    isNullableString(value.customerQboId) &&
    isNullableString(value.classQboId) &&
    isNullableString(value.taxCodeQboId) &&
    isNullableSafeInteger(value.taxAmountCents) &&
    isNullableSafeInteger(value.taxInclusiveCents)
  );
}

function isPurchaseSnapshot(value: unknown): value is QboPurchaseSnapshot {
  if (!isRuntimeRecord(value)) return false;
  return (
    typeof value.qboId === 'string' &&
    value.qboId.trim() !== '' &&
    typeof value.syncToken === 'string' &&
    value.syncToken.trim() !== '' &&
    typeof value.totalCents === 'number' &&
    Number.isSafeInteger(value.totalCents) &&
    isNullableString(value.accountQboId) &&
    typeof value.date === 'string' &&
    value.date.trim() !== '' &&
    (value.direction === 'purchase' || value.direction === 'refund') &&
    isNullableString(value.globalTaxCalculation) &&
    isNullableSafeInteger(value.totalTaxCents) &&
    Array.isArray(value.lines) &&
    value.lines.every(isSnapshotLine)
  );
}

function isExpectedPurchase(value: unknown): value is QboPreparedWrite['expected'] {
  if (!isRuntimeRecord(value)) return false;
  return (
    typeof value.qboId === 'string' &&
    value.qboId.trim() !== '' &&
    typeof value.totalCents === 'number' &&
    Number.isSafeInteger(value.totalCents) &&
    isNullableString(value.accountQboId) &&
    typeof value.date === 'string' &&
    value.date.trim() !== '' &&
    (value.direction === 'purchase' || value.direction === 'refund') &&
    isNullableString(value.globalTaxCalculation) &&
    isNullableSafeInteger(value.totalTaxCents) &&
    Array.isArray(value.targetLines) &&
    value.targetLines.every(isSnapshotLine) &&
    Array.isArray(value.untouchedLineHashes) &&
    value.untouchedLineHashes.every((hash) => typeof hash === 'string')
  );
}

function isQboReference(value: unknown): boolean {
  return (
    isRuntimeRecord(value) &&
    typeof value.value === 'string' &&
    value.value.trim() !== '' &&
    (value.name === undefined || typeof value.name === 'string')
  );
}

function isOptionalQboReference(value: unknown): boolean {
  return value === undefined || isQboReference(value);
}

function isOptionalFiniteNumber(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value));
}

function isPreparedBody(value: unknown): value is QboPreparedWrite['body'] {
  if (!isRuntimeRecord(value)) return false;
  if (
    typeof value.Id !== 'string' ||
    value.Id.trim() === '' ||
    typeof value.SyncToken !== 'string' ||
    value.SyncToken.trim() === '' ||
    typeof value.TxnDate !== 'string' ||
    value.TxnDate.trim() === '' ||
    typeof value.TotalAmt !== 'number' ||
    !Number.isFinite(value.TotalAmt) ||
    !isQboReference(value.AccountRef) ||
    !isOptionalQboReference(value.EntityRef) ||
    !isOptionalQboReference(value.CurrencyRef) ||
    !isOptionalFiniteNumber(value.ExchangeRate) ||
    (value.PaymentType !== undefined &&
      (typeof value.PaymentType !== 'string' || value.PaymentType.trim() === '')) ||
    (value.GlobalTaxCalculation !== undefined &&
      (typeof value.GlobalTaxCalculation !== 'string' ||
        value.GlobalTaxCalculation.trim() === '')) ||
    !Array.isArray(value.Line) ||
    value.Line.length === 0
  ) {
    return false;
  }
  return value.Line.every((line) => {
    if (!isRuntimeRecord(line)) return false;
    if (line.Id !== undefined && (typeof line.Id !== 'string' || line.Id.trim() === '')) return false;
    if (typeof line.Amount !== 'number' || !Number.isFinite(line.Amount)) {
      return false;
    }
    if (line.Description !== undefined && typeof line.Description !== 'string') return false;
    if (line.DetailType !== 'AccountBasedExpenseLineDetail') return false;
    const detail = line.AccountBasedExpenseLineDetail;
    if (!isRuntimeRecord(detail)) return false;
    return (
      isQboReference(detail.AccountRef) &&
      isOptionalQboReference(detail.CustomerRef) &&
      isOptionalQboReference(detail.ClassRef) &&
      isOptionalQboReference(detail.TaxCodeRef) &&
      isOptionalFiniteNumber(detail.TaxAmount) &&
      isOptionalFiniteNumber(detail.TaxInclusiveAmt)
    );
  });
}

function persistedPrepared(value: unknown): QboPreparedWrite {
  if (
    !isRuntimeRecord(value) ||
    (value.operation !== 'recategorize' && value.operation !== 'restore') ||
    value.qboType !== 'Purchase' ||
    typeof value.qboId !== 'string' ||
    typeof value.requestId !== 'string' ||
    value.requestId.trim() === '' ||
    typeof value.requestHash !== 'string' ||
    value.requestHash.trim() === '' ||
    !isPreparedBody(value.body) ||
    !isPurchaseSnapshot(value.before) ||
    !isExpectedPurchase(value.expected) ||
    value.body.Id !== value.qboId ||
    value.before.qboId !== value.qboId ||
    value.expected.qboId !== value.qboId ||
    (value.operation === 'recategorize' &&
      (typeof value.body.GlobalTaxCalculation !== 'string' ||
        value.body.GlobalTaxCalculation.trim() === '')) ||
    (value.expected.globalTaxCalculation !== null &&
      value.body.GlobalTaxCalculation !== value.expected.globalTaxCalculation)
  ) {
    return lifecycleError('ATTEMPT_CORRUPT', 'Stored mutation attempt is incomplete.');
  }
  return value as unknown as QboPreparedWrite;
}

function persistedSnapshot(value: unknown): QboPurchaseSnapshot {
  if (!isPurchaseSnapshot(value)) {
    return lifecycleError('ATTEMPT_CORRUPT', 'Stored Purchase snapshot is incomplete.');
  }
  return value;
}

function preparedForAttempt(attempt: DurableAttempt): QboPreparedWrite {
  const prepared = persistedPrepared(attempt.requestPayload);
  if (
    prepared.operation !== attempt.operation ||
    prepared.requestId !== attempt.requestId ||
    prepared.requestHash !== attempt.requestHash ||
    hashPreparedWriteBody(prepared.body) !== attempt.requestHash ||
    prepared.body.SyncToken !== attempt.expectedSyncToken
  ) {
    lifecycleError('ATTEMPT_CORRUPT', 'Stored mutation attempt identity is inconsistent.');
  }
  return prepared;
}

function validateAttemptPersistence(attempt: DurableAttempt): QboPreparedWrite {
  const prepared = preparedForAttempt(attempt);
  const before = persistedSnapshot(attempt.beforeSnapshot);
  if (
    (prepared.operation === 'recategorize' && !snapshotEquals(before, prepared.before))
    || (
      prepared.operation === 'restore'
      && (
        before.qboId !== prepared.qboId
        || before.syncToken !== prepared.body.SyncToken
      )
    )
  ) {
    lifecycleError('ATTEMPT_CORRUPT', 'Stored mutation attempt before-image is inconsistent.');
  }
  if (attempt.responseSnapshot !== null) {
    const response = persistedSnapshot(attempt.responseSnapshot);
    if (response.qboId !== prepared.qboId) {
      lifecycleError('ATTEMPT_CORRUPT', 'Stored mutation attempt response identity is inconsistent.');
    }
  }
  if (attempt.status === 'VERIFIED') {
    const response = persistedSnapshot(attempt.responseSnapshot);
    const verification = isRuntimeRecord(attempt.verification)
      ? attempt.verification
      : lifecycleError('ATTEMPT_CORRUPT', 'Verified mutation evidence is incomplete.');
    const expectedStatus = prepared.operation === 'restore' ? 'REVERTED' : 'POSTED';
    if (
      verification.outcome !== 'VERIFIED'
      || verification.status !== expectedStatus
      || typeof verification.newSyncToken !== 'string'
      || verification.newSyncToken !== response.syncToken
      || !verifyPurchaseResult(prepared.expected, response).ok
    ) {
      lifecycleError('ATTEMPT_CORRUPT', 'Verified mutation evidence is inconsistent.');
    }
  }
  if (attempt.status === 'UNCHANGED') {
    const response = persistedSnapshot(attempt.responseSnapshot);
    const verification = isRuntimeRecord(attempt.verification)
      ? attempt.verification
      : lifecycleError('ATTEMPT_CORRUPT', 'Unchanged mutation evidence is incomplete.');
    const expectedStatus = prepared.operation === 'restore' ? 'POSTED' : 'PENDING';
    if (
      verification.outcome !== 'UNCHANGED'
      || verification.status !== expectedStatus
      || !snapshotEquals(response, before)
    ) {
      lifecycleError('ATTEMPT_CORRUPT', 'Unchanged mutation evidence is inconsistent.');
    }
  }
  return prepared;
}

export interface DurableAttemptPersistenceProof {
  operation: string;
  qboType: string;
  qboId: string;
  requestId: string;
  requestHash: string;
  expectedSyncToken: string;
  preparedBindingHash?: string;
  beforeSnapshotHash?: string;
}

export function validateDurableAttemptPersistence(
  attempt: DurableAttempt,
): DurableAttemptPersistenceProof {
  const prepared = validateAttemptPersistence(attempt);
  return {
    operation: prepared.operation,
    qboType: prepared.qboType,
    qboId: prepared.qboId,
    requestId: prepared.requestId,
    requestHash: prepared.requestHash,
    expectedSyncToken: prepared.body.SyncToken,
    preparedBindingHash: hashPreparedWriteBinding(prepared),
    beforeSnapshotHash: hashPurchaseSnapshot(
      persistedSnapshot(attempt.beforeSnapshot),
    ),
  };
}

function mutationMetadata(
  prepared: Pick<QboPreparedWrite, 'requestId' | 'operation' | 'qboType' | 'qboId' | 'expected'>,
  outcome: MutationAuditInput['outcome'],
  mcp?: McpMutationAuditAttribution,
): MutationAuditInput {
  return {
    requestId: prepared.requestId,
    outcome,
    references: {
      operation: prepared.operation,
      qboType: prepared.qboType,
      qboId: prepared.qboId,
      accountQboIds: uniqueStrings(
        prepared.expected.targetLines.map((line) => line.accountQboId),
      ),
      taxCodeQboIds: uniqueStrings(
        prepared.expected.targetLines.map((line) => line.taxCodeQboId),
      ),
    },
    ...(mcp === undefined ? {} : { mcp }),
  };
}

function auditLabels(txn: DurableTransaction): {
  before: string;
  after: string;
} {
  return {
    before: 'QuickBooks Purchase',
    after: txn.splitLines.map((line) => line.category).join(' / '),
  };
}

async function writeMutationAudit(
  d: DurableWritebackDeps,
  tx: DurableWritebackDb,
  txn: DurableTransaction,
  actor: Actor,
  action: AuditAction,
  mutation: MutationAuditInput,
): Promise<void> {
  const labels = auditLabels(txn);
  await d.audit(tx as unknown as Prisma.TransactionClient, {
    companyId: txn.companyId,
    actorId: actor.id,
    actorLabel: actor.label,
    txnId: txn.id,
    payee: txn.payee,
    amount: Number(txn.amount),
    action,
    before: labels.before,
    after: labels.after,
    mutation,
  });
}

function recordedAttemptResult(
  attempt: DurableAttempt,
  transactionStatus: string,
): DurableMutationResult {
  if (attempt.status === 'VERIFIED') {
    const status = attempt.operation === 'restore' ? 'REVERTED' : 'POSTED';
    return {
      transactionId: attempt.transactionId,
      requestId: attempt.requestId,
      ok: true,
      status,
      outcome: 'VERIFIED',
    };
  }
  if (attempt.status === 'DRY_RUN') {
    return {
      transactionId: attempt.transactionId,
      requestId: attempt.requestId,
      ok: true,
      status: 'DRY_RUN',
      outcome: 'DRY_RUN',
    };
  }
  if (attempt.status === 'UNCHANGED') {
    const status = attempt.operation === 'restore' ? 'POSTED' : 'PENDING';
    return {
      transactionId: attempt.transactionId,
      requestId: attempt.requestId,
      ok: true,
      status,
      outcome: 'UNCHANGED',
    };
  }
  if (attempt.status === 'RETRYABLE') {
    return {
      transactionId: attempt.transactionId,
      requestId: attempt.requestId,
      ok: false,
      status: transactionStatus as TxnStatus,
      outcome: 'RETRYABLE',
      error: { code: 'RETRYABLE', message: 'The prepared write was not sent. Create a new request to retry.' },
    };
  }
  if (attempt.status === 'UNCERTAIN') {
    return {
      transactionId: attempt.transactionId,
      requestId: attempt.requestId,
      ok: false,
      status: 'ERROR',
      outcome: 'UNCERTAIN',
      error: { code: 'QBO_WRITE_UNCERTAIN', message: POSSIBLE_WRITE_GUIDANCE },
    };
  }
  return {
    transactionId: attempt.transactionId,
    requestId: attempt.requestId,
    ok: false,
    status: transactionStatus as TxnStatus,
    outcome: 'IN_PROGRESS',
    error: {
      code: 'MUTATION_IN_PROGRESS',
      message: 'This prepared write is already in progress and will not be sent again.',
    },
  };
}

interface RequestIntent {
  transactionId: string;
  operation: 'recategorize' | 'restore';
  expectedRevision: number;
  requestHash?: string;
}

function assertRequestIdentity(attempt: DurableAttempt, intent: RequestIntent): void {
  if (
    attempt.transactionId !== intent.transactionId ||
    attempt.operation !== intent.operation ||
    attempt.expectedRevision !== intent.expectedRevision ||
    (intent.requestHash !== undefined && attempt.requestHash !== intent.requestHash)
  ) {
    lifecycleError('REQUEST_ID_CONFLICT', 'This request ID represents a different mutation.');
  }
  if (attempt.status !== 'DRY_RUN') {
    validateAttemptPersistence(attempt);
  }
}

async function findRequestOrConflict(
  d: DurableWritebackDeps,
  requestId: string,
  intent: RequestIntent,
): Promise<DurableAttempt | null> {
  const same = await d.db.qboMutationAttempt.findUnique({ where: { requestId } });
  if (same) {
    assertRequestIdentity(same, intent);
    return same;
  }
  const active = await d.db.qboMutationAttempt.findFirst({
    where: {
      transactionId: intent.transactionId,
      status: { in: ACTIVE_ATTEMPT_STATUSES },
    },
    orderBy: { createdAt: 'desc' },
  });
  if (active) {
    lifecycleError(
      'MUTATION_BLOCKED',
      'A write for this QuickBooks entity is already active or needs reconciliation.',
    );
  }
  return null;
}

async function markRetryable(
  d: DurableWritebackDeps,
  attempt: DurableAttempt,
  error: unknown,
): Promise<
  | { won: true; attempt: DurableAttempt }
  | { won: false; attempt: DurableAttempt }
> {
  const info = errorInfo(error);
  try {
    const updated = await d.db.qboMutationAttempt.updateMany({
      where: { id: attempt.id, status: 'PREPARED' },
      data: {
        status: 'RETRYABLE',
        errorCode: info.code,
        errorMessage: info.message.slice(0, 500),
      },
    });
    if (updated.count === 1) {
      return { won: true, attempt: { ...attempt, status: 'RETRYABLE' } };
    }
  } catch {
    // PREPARED remains safely resumable if the best-effort transition fails.
  }
  try {
    const latest = await d.db.qboMutationAttempt.findUnique({
      where: { requestId: attempt.requestId },
    });
    return { won: false, attempt: latest ?? attempt };
  } catch {
    return { won: false, attempt };
  }
}

async function markUncertain(
  d: DurableWritebackDeps,
  attempt: DurableAttempt,
  txn: DurableTransaction,
  actor: Actor,
  prepared: QboPreparedWrite,
  auditAttribution?: McpMutationAuditAttribution,
): Promise<DurableMutationResult> {
  const safeUncertainResult = (): DurableMutationResult =>
    recordedAttemptResult({ ...attempt, status: 'UNCERTAIN' }, 'ERROR');
  const attemptData = {
    status: 'UNCERTAIN',
    errorCode: 'QBO_WRITE_UNCERTAIN',
    errorMessage: POSSIBLE_WRITE_GUIDANCE,
  };
  const transactionData = {
    status: 'ERROR',
    errorCode: 'QBO_WRITE_UNCERTAIN',
    errorMessage: POSSIBLE_WRITE_GUIDANCE,
  };
  let transitioned = false;
  try {
    await d.db.$transaction(async (tx) => {
      const guarded = await tx.qboMutationAttempt.updateMany({
        where: { id: attempt.id, status: 'COMMITTING' },
        data: attemptData,
      });
      if (guarded.count !== 1) return;
      transitioned = true;
      await tx.transaction.update({
        where: { id: txn.id },
        data: transactionData,
      });
      await writeMutationAudit(
        d,
        tx,
        txn,
        actor,
        'error',
        mutationMetadata(prepared, 'UNCERTAIN', auditAttribution),
      );
    });
  } catch {
    // The exact prepared request is already durable as COMMITTING, so it is
    // still a non-resend barrier. Make independent best-effort updates and
    // always return the safe uncertain result even if the database is degraded.
    transitioned = false;
    try {
      const guarded = await d.db.qboMutationAttempt.updateMany({
        where: { id: attempt.id, status: 'COMMITTING' },
        data: attemptData,
      });
      if (guarded.count === 1) {
        transitioned = true;
        await Promise.allSettled([
          d.db.transaction.update({
            where: { id: txn.id },
            data: transactionData,
          }),
          writeMutationAudit(
            d,
            d.db,
            txn,
            actor,
            'error',
            mutationMetadata(prepared, 'UNCERTAIN', auditAttribution),
          ),
        ]);
      }
    } catch {
      // The durable COMMITTING record remains a reconciliation-only barrier.
    }
  }
  if (transitioned) {
    return safeUncertainResult();
  }
  try {
    const latest = await d.db.qboMutationAttempt.findUnique({
      where: { requestId: attempt.requestId },
    });
    if (
      !latest ||
      (latest.status !== 'VERIFIED' &&
        latest.status !== 'UNCHANGED' &&
        latest.status !== 'UNCERTAIN')
    ) {
      return safeUncertainResult();
    }
    assertRequestIdentity(latest, {
      transactionId: attempt.transactionId,
      operation: prepared.operation,
      expectedRevision: attempt.expectedRevision,
      requestHash: attempt.requestHash,
    });
    return recordedAttemptResult(latest, txn.status);
  } catch {
    return safeUncertainResult();
  }
}

async function finalizeVerified(
  d: DurableWritebackDeps,
  attempt: DurableAttempt,
  txn: DurableTransaction,
  actor: Actor,
  prepared: QboPreparedWrite,
  response: QboPurchaseSnapshot,
  newSyncToken: string,
  status: 'POSTED' | 'REVERTED',
  auditAttribution?: McpMutationAuditAttribution,
): Promise<DurableMutationResult> {
  let transitioned = false;
  await d.db.$transaction(async (tx) => {
    const guarded = await tx.qboMutationAttempt.updateMany({
      where: { id: attempt.id, status: { in: ['COMMITTING', 'UNCERTAIN'] } },
      data: {
        status: 'VERIFIED',
        responseSnapshot: response,
        verification: {
          outcome: 'VERIFIED',
          status,
          newSyncToken,
        },
        errorCode: null,
        errorMessage: null,
      },
    });
    if (guarded.count !== 1) return;
    transitioned = true;
    await tx.transaction.update({
      where: { id: txn.id },
      data: {
        status,
        qboSyncToken: newSyncToken,
        postedAt: status === 'POSTED' ? d.now() : txn.postedAt,
        postedByUserId: status === 'POSTED' ? actor.id : txn.postedByUserId,
        errorCode: null,
        errorMessage: null,
      },
    });
    await writeMutationAudit(
      d,
      tx,
      txn,
      actor,
      status === 'POSTED' ? 'posted' : 'reverted',
      mutationMetadata(prepared, 'VERIFIED', auditAttribution),
    );
  });
  if (!transitioned) {
    const latest = await d.db.qboMutationAttempt.findUnique({
      where: { requestId: attempt.requestId },
    });
    if (!latest) lifecycleError('ATTEMPT_CORRUPT', 'Mutation attempt disappeared during finalization.');
    return recordedAttemptResult(latest, txn.status);
  }
  return {
    transactionId: txn.id,
    requestId: attempt.requestId,
    ok: true,
    status,
    outcome: 'VERIFIED',
  };
}

async function persistPrepared(
  d: DurableWritebackDeps,
  transactionId: string,
  expectedRevision: number,
  prepared: QboPreparedWrite,
  beforeSnapshot: QboPurchaseSnapshot,
): Promise<{ attempt: DurableAttempt; created: boolean }> {
  try {
    const attempt = await d.db.qboMutationAttempt.create({
      data: {
        transactionId,
        requestId: prepared.requestId,
        operation: prepared.operation,
        status: 'PREPARED',
        expectedRevision,
        expectedSyncToken: prepared.body.SyncToken,
        requestHash: prepared.requestHash,
        requestPayload: prepared,
        beforeSnapshot,
        responseSnapshot: null,
        verification: null,
        errorCode: null,
        errorMessage: null,
      },
    });
    return { attempt, created: true };
  } catch (error) {
    if (
      !isRuntimeRecord(error) ||
      error.code !== 'P2002'
    ) {
      throw error;
    }
    const raced = await d.db.qboMutationAttempt.findUnique({
      where: { requestId: prepared.requestId },
    });
    if (!raced) {
      lifecycleError('REQUEST_ID_CONFLICT', 'Concurrent request identity could not be resolved.');
    }
    assertRequestIdentity(raced, {
      transactionId,
      operation: prepared.operation,
      expectedRevision,
      requestHash: prepared.requestHash,
    });
    return { attempt: raced, created: false };
  }
}

async function preliminaryTransaction(
  d: DurableWritebackDeps,
  transactionId: string,
): Promise<DurableTransaction> {
  const txn = await d.db.transaction.findUnique({
    where: { id: transactionId },
    include: {
      company: true,
      splitLines: { orderBy: { idx: 'asc' } },
      txnTags: true,
    },
  });
  if (!txn) lifecycleError('TRANSACTION_NOT_FOUND', 'Transaction was not found.');
  return txn;
}

function leaseKey(txn: DurableTransaction): EntityLeaseKey {
  return {
    companyId: txn.companyId,
    qboType: txn.qboType,
    qboId: txn.qboId,
  };
}

function allowedStatusesForAttempt(attempt: DurableAttempt): string[] {
  if (attempt.status === 'VERIFIED') {
    return [attempt.operation === 'restore' ? 'REVERTED' : 'POSTED'];
  }
  if (attempt.status === 'DRY_RUN') return ['DRY_RUN'];
  if (attempt.status === 'UNCHANGED') {
    return [attempt.operation === 'restore' ? 'POSTED' : 'PENDING'];
  }
  if (attempt.status === 'PREPARED' || attempt.status === 'RETRYABLE') {
    return [attempt.operation === 'restore' ? 'POSTED' : 'PENDING'];
  }
  return attempt.operation === 'restore'
    ? ['POSTED', 'ERROR', 'SUPERSEDED']
    : ['PENDING', 'POSTING', 'ERROR', 'SUPERSEDED'];
}

async function loadAuthorizedAttempt(
  d: DurableWritebackDeps,
  attempt: DurableAttempt,
  companyId: string,
  actorId: string | null,
  authorization: DurableMutationAuthorization = { kind: 'user' },
  expectedStageHash?: string,
  expectedQboBinding?: ExpectedQboBinding,
): Promise<{ txn: DurableTransaction; staged: StagedCategorization }> {
  return loadAuthorizedStage(
    attempt.transactionId,
    companyId,
    attempt.expectedRevision,
    actorId,
    d,
    allowedStatusesForAttempt(attempt),
    authorization,
    expectedStageHash,
    expectedQboBinding,
  );
}

async function loadAuthorizedRecordedAttempt(
  d: DurableWritebackDeps,
  attempt: DurableAttempt,
  companyId: string,
  actorId: string | null,
  authorization: DurableMutationAuthorization = { kind: 'user' },
): Promise<DurableTransaction> {
  const [txn, authorized] = await Promise.all([
    preliminaryTransaction(d, attempt.transactionId),
    d.authorize(actorId, companyId, authorization),
  ]);
  if (!authorized) {
    lifecycleError('FORBIDDEN', 'You do not have permission to write this transaction.');
  }
  if (txn.companyId !== companyId) {
    lifecycleError('TRANSACTION_NOT_FOUND', 'Transaction was not found for this company.');
  }
  return txn;
}

async function enterCommitting(
  d: DurableWritebackDeps,
  attempt: DurableAttempt,
  txn: DurableTransaction,
  actor: Actor,
  owner: string,
  allowedStatuses: string[],
  authorization: DurableMutationAuthorization = { kind: 'user' },
  expectedStageHash?: string,
  expectedQboBinding?: ExpectedQboBinding,
  finalQboProof?: () => Promise<void>,
): Promise<
  | { won: true; attempt: DurableAttempt }
  | { won: false; attempt: DurableAttempt }
> {
  try {
    // Reacquisition may block behind a fenced staging transaction. Reload
    // every mutable authorization fact only after it returns so a stage that
    // committed while we waited cannot authorize this prepared revision.
    await d.renewLease(leaseKey(txn), owner);
    await loadAuthorizedStage(
      txn.id,
      txn.companyId,
      attempt.expectedRevision,
      actor.id,
      d,
      allowedStatuses,
      authorization,
      expectedStageHash,
      expectedQboBinding,
    );
    if (finalQboProof) await finalQboProof();
  } catch (error) {
    const retryable = await markRetryable(d, attempt, error);
    if (!retryable.won && retryable.attempt.status !== 'PREPARED') {
      return { won: false, attempt: retryable.attempt };
    }
    throw error;
  }
  try {
    const guarded = await d.db.qboMutationAttempt.updateMany({
      where: { id: attempt.id, status: 'PREPARED' },
      data: { status: 'COMMITTING' },
    });
    if (guarded.count === 1) {
      return { won: true, attempt: { ...attempt, status: 'COMMITTING' } };
    }
    const latest = await d.db.qboMutationAttempt.findUnique({
      where: { requestId: attempt.requestId },
    });
    if (!latest) lifecycleError('ATTEMPT_CORRUPT', 'Mutation attempt disappeared before committing.');
    return { won: false, attempt: latest };
  } catch {
    const persistenceError = new WritebackLifecycleError(
      'PREWRITE_PERSISTENCE_FAILED',
      'The prepared write was not sent because its committing state could not be stored.',
    );
    const retryable = await markRetryable(
      d,
      attempt,
      persistenceError,
    );
    if (!retryable.won && retryable.attempt.status !== 'PREPARED') {
      return { won: false, attempt: retryable.attempt };
    }
    throw persistenceError;
  }
}

async function sendAndVerifyPrepared(
  d: DurableWritebackDeps,
  client: QboClient,
  attempt: DurableAttempt,
  txn: DurableTransaction,
  actor: Actor,
  prepared: QboPreparedWrite,
  status: 'POSTED' | 'REVERTED',
  auditAttribution?: McpMutationAuditAttribution,
): Promise<DurableMutationResult> {
  // Possible-write boundary: COMMITTING is durable before this function runs.
  try {
    await client.sendPreparedWrite(prepared);
    const response = await client.fetchPurchaseSnapshot(txn.qboId);
    if (!response) throw new Error('Prepared Purchase readback was missing.');
    const verification = verifyPurchaseResult(prepared.expected, response);
    if (!verification.ok) throw new Error(verification.message);
    return await finalizeVerified(
      d,
      attempt,
      txn,
      actor,
      prepared,
      response,
      response.syncToken,
      status,
      auditAttribution,
    );
  } catch {
    return markUncertain(
      d,
      attempt,
      txn,
      actor,
      prepared,
      auditAttribution,
    );
  }
}

async function recordDryRun(
  input: CommitStagedCategorizationInput,
  txn: DurableTransaction,
  staged: StagedCategorization,
  d: DurableWritebackDeps,
): Promise<DurableMutationResult> {
  const accountQboIds = uniqueStrings(staged.lines.map((line) => line.categoryQboId));
  const taxCodeQboIds = uniqueStrings(staged.lines.map((line) => line.taxCodeQboId));
  const requestPayload = {
    operation: 'recategorize',
    qboType: 'Purchase',
    qboId: txn.qboId,
    requestId: input.requestId,
    references: { accountQboIds, taxCodeQboIds },
    outcome: 'DRY_RUN',
  };
  const mutation: MutationAuditInput = {
    requestId: input.requestId,
    outcome: 'DRY_RUN',
    references: {
      operation: 'recategorize',
      qboType: 'Purchase',
      qboId: txn.qboId,
      accountQboIds,
      taxCodeQboIds,
    },
  };
  await d.db.$transaction(async (tx) => {
    await tx.qboMutationAttempt.create({
      data: {
        transactionId: txn.id,
        requestId: input.requestId,
        operation: 'recategorize',
        status: 'DRY_RUN',
        expectedRevision: input.expectedRevision,
        expectedSyncToken: txn.qboSyncToken,
        requestHash: `dry-run:${input.requestId}`,
        requestPayload,
        beforeSnapshot: { outcome: 'DRY_RUN' },
        responseSnapshot: null,
        verification: { outcome: 'DRY_RUN', status: 'DRY_RUN' },
        errorCode: null,
        errorMessage: null,
      },
    });
    await tx.transaction.update({
      where: { id: txn.id },
      data: {
        status: 'DRY_RUN',
        postedAt: d.now(),
        postedByUserId: input.actor.id,
        errorCode: null,
        errorMessage: null,
      },
    });
    await writeMutationAudit(d, tx, txn, input.actor, 'dry-run', mutation);
  });
  return {
    transactionId: txn.id,
    requestId: input.requestId,
    ok: true,
    status: 'DRY_RUN',
    outcome: 'DRY_RUN',
  };
}

export async function commitStagedCategorization(
  input: CommitStagedCategorizationInput,
  deps?: DurableWritebackDeps,
): Promise<DurableMutationResult> {
  const d = deps ?? (await defaultDurableDeps());
  const authorization = input.authorization ?? { kind: 'user' };
  const invocationOwner = d.invocationId();
  const preliminary = await preliminaryTransaction(d, input.transactionId);
  if (preliminary.companyId !== input.companyId) {
    lifecycleError('TRANSACTION_NOT_FOUND', 'Transaction was not found for this company.');
  }
  return d.lease(leaseKey(preliminary), invocationOwner, async () => {
    const intent: RequestIntent = {
      transactionId: input.transactionId,
      operation: 'recategorize',
      expectedRevision: input.expectedRevision,
    };
    const existing = await findRequestOrConflict(d, input.requestId, intent);
    if (existing) {
      if (existing.status !== 'PREPARED') {
        const txn = await loadAuthorizedRecordedAttempt(
          d,
          existing,
          input.companyId,
          input.actor.id,
          authorization,
        );
        return recordedAttemptResult(existing, txn.status);
      }
      const { txn } = await loadAuthorizedAttempt(
        d,
        existing,
        input.companyId,
        input.actor.id,
        authorization,
        input.expectedStageHash,
        input.expectedQboBinding,
      );

      const prepared = preparedForAttempt(existing);
      const before = persistedSnapshot(existing.beforeSnapshot);
      const client = await d.getClient(input.companyId);
      const entered = await enterCommitting(
        d,
        existing,
        txn,
        input.actor,
        invocationOwner,
        ['PENDING'],
        authorization,
        input.expectedStageHash,
        input.expectedQboBinding,
        async () => {
          const [freshTxn, current] = await Promise.all([
            client.fetchTxn('Purchase', txn.qboId),
            client.fetchPurchaseSnapshot(txn.qboId),
          ]);
          if (
            !freshTxn ||
            !current ||
            freshTxn.syncToken !== existing.expectedSyncToken ||
            current.syncToken !== existing.expectedSyncToken ||
            txn.qboSyncToken !== existing.expectedSyncToken ||
            !snapshotEquals(current, before)
          ) {
            lifecycleError('QBO_STATE_DRIFT', 'Purchase changed before the prepared write could resume.');
          }
        },
      );
      if (!entered.won) {
        const { txn: latestTxn } = await loadAuthorizedAttempt(
          d,
          entered.attempt,
          input.companyId,
          input.actor.id,
          authorization,
          input.expectedStageHash,
          input.expectedQboBinding,
        );
        return recordedAttemptResult(entered.attempt, latestTxn.status);
      }
      return sendAndVerifyPrepared(
        d,
        client,
        existing,
        txn,
        input.actor,
        prepared,
        'POSTED',
      );
    }

    const { txn, staged } = await loadAuthorizedStage(
      input.transactionId,
      input.companyId,
      input.expectedRevision,
      input.actor.id,
      d,
      ['PENDING'],
      authorization,
      input.expectedStageHash,
      input.expectedQboBinding,
    );
    if (txn.company.dryRun || d.envDryRun) {
      return recordDryRun(input, txn, staged, d);
    }

    await d.renewLease(leaseKey(txn), invocationOwner);
    const client = await d.getClient(input.companyId);
    const [freshTxn, before] = await Promise.all([
      client.fetchTxn('Purchase', txn.qboId),
      client.fetchPurchaseSnapshot(txn.qboId),
    ]);
    if (!freshTxn || !before) {
      lifecycleError('QBO_STATE_DRIFT', 'Purchase no longer exists in QuickBooks.');
    }
    if (
      freshTxn.syncToken !== before.syncToken ||
      freshTxn.syncToken !== txn.qboSyncToken
    ) {
      lifecycleError('QBO_STATE_DRIFT', 'Purchase SyncToken changed before preparation.');
    }

    const prepared = await client.preparePurchaseRecategorization(
      freshTxn,
      staged,
      before,
      input.requestId,
    );
    const persisted = await persistPrepared(
      d,
      txn.id,
      input.expectedRevision,
      prepared,
      before,
    );
    if (!persisted.created) {
      const { txn: racedTxn } = await loadAuthorizedAttempt(
        d,
        persisted.attempt,
        input.companyId,
        input.actor.id,
        authorization,
        input.expectedStageHash,
        input.expectedQboBinding,
      );
      return recordedAttemptResult(persisted.attempt, racedTxn.status);
    }
    const entered = await enterCommitting(
      d,
      persisted.attempt,
      txn,
      input.actor,
      invocationOwner,
      ['PENDING'],
      authorization,
      input.expectedStageHash,
      input.expectedQboBinding,
    );
    if (!entered.won) {
      const { txn: latestTxn } = await loadAuthorizedAttempt(
        d,
        entered.attempt,
        input.companyId,
        input.actor.id,
        authorization,
        input.expectedStageHash,
        input.expectedQboBinding,
      );
      return recordedAttemptResult(entered.attempt, latestTxn.status);
    }
    return sendAndVerifyPrepared(
      d,
      client,
      persisted.attempt,
      txn,
      input.actor,
      prepared,
      'POSTED',
    );
  });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

export function hashPreparedWriteBody(body: QboPreparedWrite['body']): string {
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

export function hashPreparedWriteBinding(prepared: QboPreparedWrite): string {
  const { requestId: _throwawayRequestId, ...binding } = prepared;
  return createHash('sha256').update(canonicalJson(binding)).digest('hex');
}

function hashPurchaseSnapshot(snapshot: QboPurchaseSnapshot): string {
  return createHash('sha256').update(canonicalJson(snapshot)).digest('hex');
}

export function hashStagedCategorization(staged: StagedCategorization): string {
  const normalized: StagedCategorization = {
    ...staged,
    lines: [...staged.lines]
      .sort((left, right) => left.idx - right.idx)
      .map((line) => ({
        ...line,
        ...(line.tagIds === undefined
          ? {}
          : { tagIds: [...line.tagIds].sort() }),
      })),
    tagIds: [...staged.tagIds].sort(),
  };
  return createHash('sha256').update(canonicalJson(normalized)).digest('hex');
}

function snapshotEquals(left: QboPurchaseSnapshot, right: QboPurchaseSnapshot): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

async function finalizeUnchanged(
  d: DurableWritebackDeps,
  attempt: DurableAttempt,
  txn: DurableTransaction,
  actor: Actor,
  prepared: QboPreparedWrite,
  actual: QboPurchaseSnapshot,
  auditAttribution?: McpMutationAuditAttribution,
): Promise<DurableMutationResult> {
  const unchangedStatus = prepared.operation === 'restore' ? 'POSTED' : 'PENDING';
  let transitioned = false;
  await d.db.$transaction(async (tx) => {
    const guarded = await tx.qboMutationAttempt.updateMany({
      where: { id: attempt.id, status: { in: ['COMMITTING', 'UNCERTAIN'] } },
      data: {
        status: 'UNCHANGED',
        responseSnapshot: actual,
        verification: { outcome: 'UNCHANGED', status: unchangedStatus },
        errorCode: null,
        errorMessage: null,
      },
    });
    if (guarded.count !== 1) return;
    transitioned = true;
    await tx.transaction.update({
      where: { id: txn.id },
      data: {
        status: unchangedStatus,
        errorCode: null,
        errorMessage: null,
      },
    });
    await writeMutationAudit(
      d,
      tx,
      txn,
      actor,
      'error',
      mutationMetadata(prepared, 'UNCHANGED', auditAttribution),
    );
  });
  if (!transitioned) {
    const latest = await d.db.qboMutationAttempt.findUnique({
      where: { requestId: attempt.requestId },
    });
    if (!latest) lifecycleError('ATTEMPT_CORRUPT', 'Mutation attempt disappeared during reconciliation.');
    return recordedAttemptResult(latest, txn.status);
  }
  return {
    transactionId: txn.id,
    requestId: attempt.requestId,
    ok: true,
    status: unchangedStatus,
    outcome: 'UNCHANGED',
  };
}

export async function reconcileMutationAttempt(
  input: ReconcileMutationAttemptInput,
  deps?: DurableWritebackDeps,
): Promise<DurableMutationResult> {
  const d = deps ?? (await defaultDurableDeps());
  const authorization = input.authorization ?? { kind: 'user' };
  const invocationOwner = d.invocationId();
  const preliminaryAttempt = await d.db.qboMutationAttempt.findUnique({
    where: { requestId: input.requestId },
  });
  if (!preliminaryAttempt) {
    lifecycleError('ATTEMPT_NOT_FOUND', 'Mutation attempt was not found.');
  }
  const preliminary = await preliminaryTransaction(d, preliminaryAttempt.transactionId);
  return d.lease(leaseKey(preliminary), invocationOwner, async () => {
    const attempt = await d.db.qboMutationAttempt.findUnique({
      where: { requestId: input.requestId },
    });
    if (!attempt) lifecycleError('ATTEMPT_NOT_FOUND', 'Mutation attempt was not found.');
    if (attempt.status === 'DRY_RUN') {
      const { txn } = await loadAuthorizedAttempt(
        d,
        attempt,
        preliminary.companyId,
        input.actor.id,
        authorization,
        input.expectedStageHash,
        input.expectedQboBinding,
      );
      return recordedAttemptResult(attempt, txn.status);
    }
    if (
      attempt.status !== 'VERIFIED' &&
      attempt.status !== 'UNCHANGED' &&
      attempt.status !== 'UNCERTAIN' &&
      attempt.status !== 'COMMITTING'
    ) {
      await loadAuthorizedAttempt(
        d,
        attempt,
        preliminary.companyId,
        input.actor.id,
        authorization,
      );
      lifecycleError('RECONCILE_NOT_ALLOWED', 'Only uncertain writes can be reconciled.');
    }
    const prepared = validateAttemptPersistence(attempt);
    const { txn } = await loadAuthorizedAttempt(
      d,
      attempt,
      preliminary.companyId,
      input.actor.id,
      authorization,
      input.expectedStageHash,
      input.expectedQboBinding,
    );
    if (attempt.status === 'VERIFIED' || attempt.status === 'UNCHANGED') {
      return recordedAttemptResult(attempt, txn.status);
    }
    const before = persistedSnapshot(attempt.beforeSnapshot);
    await d.renewLease(leaseKey(txn), invocationOwner);
    await loadAuthorizedAttempt(
      d,
      attempt,
      preliminary.companyId,
      input.actor.id,
      authorization,
      input.expectedStageHash,
      input.expectedQboBinding,
    );
    const client = await d.getClient(txn.companyId);
    const actual = await client.fetchPurchaseSnapshot(txn.qboId);
    if (!actual) {
      return markUncertain(
        d,
        attempt,
        txn,
        input.actor,
        prepared,
        input.auditAttribution,
      );
    }

    const expectedVerification = verifyPurchaseResult(prepared.expected, actual);
    if (expectedVerification.ok) {
      return finalizeVerified(
        d,
        attempt,
        txn,
        input.actor,
        prepared,
        actual,
        actual.syncToken,
        prepared.operation === 'restore' ? 'REVERTED' : 'POSTED',
        input.auditAttribution,
      );
    }
    if (snapshotEquals(actual, before)) {
      return finalizeUnchanged(
        d,
        attempt,
        txn,
        input.actor,
        prepared,
        actual,
        input.auditAttribution,
      );
    }
    return markUncertain(
      d,
      attempt,
      txn,
      input.actor,
      prepared,
      input.auditAttribution,
    );
  });
}

export async function prepareCategorizationUndo(
  input: PrepareCategorizationUndoInput,
  deps?: DurableWritebackDeps,
): Promise<PreparedCategorizationUndo> {
  const d = deps ?? (await defaultDurableDeps());
  const invocationOwner = d.invocationId();
  const preliminary = await preliminaryTransaction(d, input.transactionId);
  if (preliminary.companyId !== input.companyId) {
    lifecycleError('TRANSACTION_NOT_FOUND', 'Transaction was not found for this company.');
  }
  return d.lease(leaseKey(preliminary), invocationOwner, async () => {
    const source = await d.db.qboMutationAttempt.findUnique({
      where: { requestId: input.sourceRequestId },
    });
    if (
      source === null
      || source.transactionId !== input.transactionId
      || source.operation !== 'recategorize'
      || source.status !== 'VERIFIED'
      || source.expectedRevision !== input.expectedRevision
      || source.expectedSyncToken !== input.expectedSourceSyncToken
    ) {
      lifecycleError('VERIFIED_POST_REQUIRED', 'Undo requires the exact verified MCP categorization write.');
    }
    const sourcePrepared = validateAttemptPersistence(source);
    if (
      sourcePrepared.qboType !== input.expectedQboBinding.qboType
      || sourcePrepared.qboId !== input.expectedQboBinding.qboId
      || sourcePrepared.body.SyncToken !== input.expectedSourceSyncToken
    ) {
      lifecycleError('VERIFIED_POST_REQUIRED', 'The verified source write does not match this operation.');
    }

    const { txn: initialTxn } = await loadAuthorizedStage(
      input.transactionId,
      input.companyId,
      input.expectedRevision,
      input.actor.id,
      d,
      ['POSTED'],
      input.authorization,
    );
    if (
      initialTxn.qboType !== input.expectedQboBinding.qboType
      || initialTxn.qboId !== input.expectedQboBinding.qboId
    ) {
      lifecycleError('STALE_QBO_BINDING', 'The QuickBooks transaction binding changed.');
    }

    await d.renewLease(leaseKey(initialTxn), invocationOwner);
    const finalSource = await d.db.qboMutationAttempt.findUnique({
      where: { requestId: input.sourceRequestId },
    });
    if (
      finalSource === null
      || finalSource.transactionId !== input.transactionId
      || finalSource.operation !== 'recategorize'
      || finalSource.status !== 'VERIFIED'
      || finalSource.expectedRevision !== input.expectedRevision
      || finalSource.expectedSyncToken !== input.expectedSourceSyncToken
    ) {
      lifecycleError('VERIFIED_POST_REQUIRED', 'Undo requires the exact verified MCP categorization write.');
    }
    const finalSourcePrepared = validateAttemptPersistence(finalSource);
    if (
      hashPreparedWriteBinding(finalSourcePrepared)
        !== hashPreparedWriteBinding(sourcePrepared)
      || finalSourcePrepared.qboType !== input.expectedQboBinding.qboType
      || finalSourcePrepared.qboId !== input.expectedQboBinding.qboId
      || finalSourcePrepared.body.SyncToken !== input.expectedSourceSyncToken
    ) {
      lifecycleError('VERIFIED_POST_REQUIRED', 'The verified source write changed while preparing undo.');
    }
    const { txn } = await loadAuthorizedStage(
      input.transactionId,
      input.companyId,
      input.expectedRevision,
      input.actor.id,
      d,
      ['POSTED'],
      input.authorization,
    );
    if (
      txn.qboType !== input.expectedQboBinding.qboType
      || txn.qboId !== input.expectedQboBinding.qboId
    ) {
      lifecycleError('STALE_QBO_BINDING', 'The QuickBooks transaction binding changed.');
    }
    const client = await d.getClient(input.companyId);
    const [freshTxn, current] = await Promise.all([
      client.fetchTxn('Purchase', txn.qboId),
      client.fetchPurchaseSnapshot(txn.qboId),
    ]);
    if (
      freshTxn === null
      || current === null
      || freshTxn.qboId !== txn.qboId
      || current.qboId !== txn.qboId
      || freshTxn.syncToken !== current.syncToken
      || current.syncToken !== txn.qboSyncToken
    ) {
      lifecycleError('QBO_STATE_DRIFT', 'Purchase changed after the verified categorization.');
    }
    const currentVerification = verifyPurchaseResult(sourcePrepared.expected, current);
    if (!currentVerification.ok) {
      lifecycleError('QBO_STATE_DRIFT', currentVerification.message);
    }

    const restore = persistedPrepared(await client.preparePurchaseRestore(
      freshTxn,
      sourcePrepared,
      input.sourceRequestId,
    ));
    if (
      restore.operation !== 'restore'
      || restore.qboType !== 'Purchase'
      || restore.qboId !== txn.qboId
      || restore.body.SyncToken !== current.syncToken
      || restore.requestHash !== hashPreparedWriteBody(restore.body)
    ) {
      lifecycleError('ATTEMPT_CORRUPT', 'Prepared restore identity is inconsistent.');
    }
    const restoreHash = hashPreparedWriteBinding(restore);
    return {
      transactionId: txn.id,
      companyId: txn.companyId,
      revision: txn.revision,
      qboType: 'Purchase',
      qboId: txn.qboId,
      qboSyncToken: current.syncToken,
      sourcePreparedHash: hashPreparedWriteBinding(sourcePrepared),
      currentPostHash: hashPurchaseSnapshot(current),
      restoreHash,
      preview: {
        action: 'restore_purchase_categorization',
        resultingStatus: 'REVERTED',
        direction: restore.expected.direction,
        totalCents: restore.expected.totalCents,
        totalTaxCents: restore.expected.totalTaxCents,
        lineCount: restore.expected.targetLines.length,
        restorationDigest: restoreHash,
      },
    };
  });
}

export async function undoCategorization(
  input: UndoCategorizationInput,
  deps?: DurableWritebackDeps,
): Promise<DurableMutationResult> {
  const d = deps ?? (await defaultDurableDeps());
  const authorization = input.authorization ?? { kind: 'user' };
  if (authorization.kind === 'mcp' && input.proof === undefined) {
    lifecycleError('UNDO_PROOF_REQUIRED', 'MCP undo requires an exact preparation proof.');
  }
  const invocationOwner = d.invocationId();
  const preliminary = await preliminaryTransaction(d, input.transactionId);
  if (preliminary.companyId !== input.companyId) {
    lifecycleError('TRANSACTION_NOT_FOUND', 'Transaction was not found for this company.');
  }
  return d.lease(leaseKey(preliminary), invocationOwner, async () => {
    const loadVerifiedSource = async (): Promise<{
      attempt: DurableAttempt;
      prepared: QboPreparedWrite;
    }> => {
      const source = input.proof === undefined
        ? await d.db.qboMutationAttempt.findFirst({
            where: {
              transactionId: input.transactionId,
              operation: 'recategorize',
              status: 'VERIFIED',
            },
            orderBy: { createdAt: 'desc' },
          })
        : await d.db.qboMutationAttempt.findUnique({
            where: { requestId: input.proof.sourceRequestId },
          });
      if (
        source === null
        || source.transactionId !== input.transactionId
        || source.operation !== 'recategorize'
        || source.status !== 'VERIFIED'
      ) {
        lifecycleError('VERIFIED_POST_REQUIRED', 'Undo requires a verified prepared write.');
      }
      const prepared = validateAttemptPersistence(source);
      if (
        input.proof !== undefined
        && (
          source.requestId !== input.proof.sourceRequestId
          || source.expectedRevision !== input.proof.expectedRevision
          || prepared.qboType !== input.proof.expectedQboBinding.qboType
          || prepared.qboId !== input.proof.expectedQboBinding.qboId
          || hashPreparedWriteBinding(prepared) !== input.proof.sourcePreparedHash
        )
      ) {
        lifecycleError('UNDO_PROOF_MISMATCH', 'The verified source no longer matches the prepared undo.');
      }
      return { attempt: source, prepared };
    };
    const assertCurrentProof = (
      txn: DurableTransaction,
      current: QboPurchaseSnapshot,
    ): void => {
      if (
        input.proof !== undefined
        && (
          txn.qboType !== input.proof.expectedQboBinding.qboType
          || txn.qboId !== input.proof.expectedQboBinding.qboId
          || txn.qboSyncToken !== input.proof.expectedQboBinding.qboSyncToken
          || current.syncToken !== input.proof.expectedQboBinding.qboSyncToken
          || hashPurchaseSnapshot(current) !== input.proof.currentPostHash
        )
      ) {
        lifecycleError('UNDO_PROOF_MISMATCH', 'The current Purchase no longer matches the prepared undo.');
      }
    };
    const assertRestoreProof = (restore: QboPreparedWrite): void => {
      if (
        input.proof !== undefined
        && hashPreparedWriteBinding(restore) !== input.proof.restoreHash
      ) {
        lifecycleError('UNDO_PROOF_MISMATCH', 'The prepared restore no longer matches the prepared undo.');
      }
    };
    const persistedRestoreForProof = (
      attempt: DurableAttempt,
    ): QboPreparedWrite => {
      const restore = validateAttemptPersistence(attempt);
      assertRestoreProof(restore);
      if (
        input.proof !== undefined
        && hashPurchaseSnapshot(persistedSnapshot(attempt.beforeSnapshot))
          !== input.proof.currentPostHash
      ) {
        lifecycleError('UNDO_PROOF_MISMATCH', 'The stored current Purchase no longer matches the prepared undo.');
      }
      return restore;
    };

    const source = await loadVerifiedSource();
    const original = source.attempt;
    const originalPrepared = source.prepared;
    const intent: RequestIntent = {
      transactionId: input.transactionId,
      operation: 'restore',
      expectedRevision: original.expectedRevision,
    };
    const sameRequest = await findRequestOrConflict(d, input.requestId, intent);
    if (sameRequest) {
      const restore = persistedRestoreForProof(sameRequest);
      if (sameRequest.status !== 'PREPARED') {
        const txn = await loadAuthorizedRecordedAttempt(
          d,
          sameRequest,
          input.companyId,
          input.actor.id,
          authorization,
        );
        return recordedAttemptResult(sameRequest, txn.status);
      }
      const { txn } = await loadAuthorizedAttempt(
        d,
        sameRequest,
        input.companyId,
        input.actor.id,
        authorization,
        undefined,
        input.proof?.expectedQboBinding,
      );
      const client = await d.getClient(input.companyId);
      const entered = await enterCommitting(
        d,
        sameRequest,
        txn,
        input.actor,
        invocationOwner,
        ['POSTED'],
        authorization,
        undefined,
        input.proof?.expectedQboBinding,
        async () => {
          const finalSource = await loadVerifiedSource();
          if (
            hashPreparedWriteBinding(finalSource.prepared)
              !== hashPreparedWriteBinding(originalPrepared)
          ) {
            lifecycleError('UNDO_PROOF_MISMATCH', 'The verified source changed before restore send.');
          }
          const [freshTxn, current] = await Promise.all([
            client.fetchTxn('Purchase', txn.qboId),
            client.fetchPurchaseSnapshot(txn.qboId),
          ]);
          const verification = current
            ? verifyPurchaseResult(originalPrepared.expected, current)
            : { ok: false as const };
          if (
            !freshTxn ||
            !current ||
            freshTxn.syncToken !== sameRequest.expectedSyncToken ||
            current.syncToken !== sameRequest.expectedSyncToken ||
            txn.qboSyncToken !== sameRequest.expectedSyncToken ||
            !verification.ok
          ) {
            lifecycleError('QBO_STATE_DRIFT', 'Purchase changed before the prepared restore could resume.');
          }
          assertCurrentProof(txn, current);
        },
      );
      if (!entered.won) {
        const { txn: latestTxn } = await loadAuthorizedAttempt(
          d,
          entered.attempt,
          input.companyId,
          input.actor.id,
          authorization,
          undefined,
          input.proof?.expectedQboBinding,
        );
        return recordedAttemptResult(entered.attempt, latestTxn.status);
      }
      return sendAndVerifyPrepared(
        d,
        client,
        sameRequest,
        txn,
        input.actor,
        restore,
        'REVERTED',
        input.auditAttribution,
      );
    }

    const { txn } = await loadAuthorizedStage(
      input.transactionId,
      input.companyId,
      original.expectedRevision,
      input.actor.id,
      d,
      ['POSTED'],
      authorization,
      undefined,
      input.proof?.expectedQboBinding,
    );
    await d.renewLease(leaseKey(txn), invocationOwner);
    const client = await d.getClient(input.companyId);
    const [freshTxn, current] = await Promise.all([
      client.fetchTxn('Purchase', txn.qboId),
      client.fetchPurchaseSnapshot(txn.qboId),
    ]);
    if (!freshTxn || !current) {
      lifecycleError('QBO_STATE_DRIFT', 'Purchase no longer exists in QuickBooks.');
    }
    if (
      freshTxn.syncToken !== current.syncToken ||
      current.syncToken !== txn.qboSyncToken
    ) {
      lifecycleError('QBO_STATE_DRIFT', 'Purchase SyncToken changed after the verified post.');
    }
    const currentVerification = verifyPurchaseResult(
      originalPrepared.expected,
      current,
    );
    if (!currentVerification.ok) {
      lifecycleError('QBO_STATE_DRIFT', currentVerification.message);
    }
    assertCurrentProof(txn, current);

    const restore = await client.preparePurchaseRestore(
      freshTxn,
      originalPrepared,
      input.requestId,
    );
    assertRestoreProof(restore);
    const persisted = await persistPrepared(
      d,
      txn.id,
      original.expectedRevision,
      restore,
      current,
    );
    if (!persisted.created) {
      persistedRestoreForProof(persisted.attempt);
      const { txn: racedTxn } = await loadAuthorizedAttempt(
        d,
        persisted.attempt,
        input.companyId,
        input.actor.id,
        authorization,
        undefined,
        input.proof?.expectedQboBinding,
      );
      return recordedAttemptResult(persisted.attempt, racedTxn.status);
    }
    const entered = await enterCommitting(
      d,
      persisted.attempt,
      txn,
      input.actor,
      invocationOwner,
      ['POSTED'],
      authorization,
      undefined,
      input.proof?.expectedQboBinding,
      async () => {
        const finalSource = await loadVerifiedSource();
        if (
          hashPreparedWriteBinding(finalSource.prepared)
            !== hashPreparedWriteBinding(originalPrepared)
        ) {
          lifecycleError('UNDO_PROOF_MISMATCH', 'The verified source changed before restore send.');
        }
        const [lastTxn, lastSnapshot] = await Promise.all([
          client.fetchTxn('Purchase', txn.qboId),
          client.fetchPurchaseSnapshot(txn.qboId),
        ]);
        const verification = lastSnapshot
          ? verifyPurchaseResult(originalPrepared.expected, lastSnapshot)
          : { ok: false as const };
        if (
          !lastTxn ||
          !lastSnapshot ||
          lastTxn.syncToken !== persisted.attempt.expectedSyncToken ||
          lastSnapshot.syncToken !== persisted.attempt.expectedSyncToken ||
          txn.qboSyncToken !== persisted.attempt.expectedSyncToken ||
          !verification.ok
        ) {
          lifecycleError('QBO_STATE_DRIFT', 'Purchase changed before the prepared restore send.');
        }
        assertCurrentProof(txn, lastSnapshot);
      },
    );
    if (!entered.won) {
      persistedRestoreForProof(entered.attempt);
      const { txn: latestTxn } = await loadAuthorizedAttempt(
        d,
        entered.attempt,
        input.companyId,
        input.actor.id,
        authorization,
        undefined,
        input.proof?.expectedQboBinding,
      );
      return recordedAttemptResult(entered.attempt, latestTxn.status);
    }
    return sendAndVerifyPrepared(
      d,
      client,
      persisted.attempt,
      txn,
      input.actor,
      restore,
      'REVERTED',
      input.auditAttribution,
    );
  });
}
