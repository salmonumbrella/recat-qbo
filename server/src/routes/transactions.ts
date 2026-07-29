// Transaction routes — two routers:
//   companyTransactionsRouter  → /api/companies/:companyId/transactions (queue list)
//   transferCandidatesRouter   → /api/companies/:companyId/transfer-candidates
//   transactionActionsRouter   → /api/transactions (categorize/post/undo/retry/transfer/bulk-post)
// Action routes load the txn by id and scope everything through its companyId.
// Paths and shapes mirror client/src/lib/api.ts exactly (THE contract).

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import type { User } from '@prisma/client';
import {
  MAX_EXPECTED_TRANSACTION_REVISION,
  type CategorizationMutationResult,
  type CommitCategorizationBody,
  type ReconcileCategorizationBody,
  type StageCategorizationBody,
  type SuggestionDto,
  type TransactionDto,
  type TxnStatus,
  type UndoCategorizationBody,
} from '@recat/shared';
import { asyncHandler, HttpError, validate } from '../lib/http.js';
import { prisma } from '../lib/prisma.js';
import { effectiveRole, requireRole, requireUser, roleRank } from '../middleware/auth.js';
import { withCompany } from '../middleware/company.js';
import { getTaxReadiness } from '../services/tax/reference.js';
import { ruleSuggestion, suggestForMany, type RuleLike } from '../services/suggestions.js';
import { recordTransfer, transferCandidates } from '../services/transfers.js';
import { stageCategorization } from '../services/categorization.js';
import {
  bulkPost,
  commitStagedCategorization,
  postTransaction,
  reconcileMutationAttempt,
  retryError,
  splitLineDtos,
  undoCategorization,
  undoPost,
  validateSplits,
  type Actor,
  type DurableMutationResult,
} from '../services/writeback.js';

/** Every txn query in this file loads split lines (with their tags) so the DTO
 * boundary can translate the SplitLine relation back into SplitDto[]. */
const txnInclude = {
  txnTags: true,
  splitLines: { include: { tags: true }, orderBy: { idx: 'asc' as const } },
  qboMutationAttempts: {
    where: { status: { in: ['PREPARED', 'COMMITTING', 'UNCERTAIN'] } },
    orderBy: { createdAt: 'desc' as const },
    take: 1,
    select: {
      requestId: true,
      operation: true,
      status: true,
    },
  },
} satisfies Prisma.TransactionInclude;

type TxnRow = Prisma.TransactionGetPayload<{ include: typeof txnInclude }>;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const STATUS_WORDS: Record<TxnStatus, string> = {
  PENDING: 'pending',
  POSTING: 'posting',
  POSTED: 'posted',
  DRY_RUN: 'dry run',
  ERROR: 'error failed',
  SUPERSEDED: 'superseded',
  REVERTED: 'reverted',
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function actorFor(user: User): Actor {
  return { id: user.id, label: user.name ?? user.email.split('@')[0] ?? user.email };
}

function requestUser(req: { user?: User }): User {
  if (!req.user) throw new HttpError(401, 'Not signed in', 'UNAUTHENTICATED');
  return req.user;
}

/**
 * Action routes are mounted at /api/transactions (no :companyId), so the
 * company gate runs per transaction: the caller's effective role in the txn's
 * company must be categorizer or better (instance admins pass everywhere).
 */
async function assertCategorizerFor(user: User, companyId: string): Promise<void> {
  const role = await effectiveRole(user, companyId);
  if (role === null || roleRank(role) < roleRank('categorizer')) {
    throw new HttpError(403, 'You do not have permission to do that', 'FORBIDDEN');
  }
}

async function assertCategorizationRouteAccess(user: User, companyId: string): Promise<void> {
  const role = await effectiveRole(user, companyId);
  if (role === null) {
    throw new HttpError(404, 'Transaction not found', 'TRANSACTION_NOT_FOUND');
  }
  if (roleRank(role) < roleRank('categorizer')) {
    throw new HttpError(403, 'You do not have permission to do that', 'FORBIDDEN');
  }
}

// ---------------------------------------------------------------------------
// DTO mapping
// ---------------------------------------------------------------------------

/**
 * Map DB rows to TransactionDto. Suggestions for PENDING txns are recomputed
 * live via suggestForMany (rules + history loaded ONCE for the whole page; no
 * AI calls from the list path) so rule edits reflect instantly in the queue.
 */
export async function transactionDtos(
  companyId: string,
  rows: TxnRow[],
  candidatesIn?: Map<string, string>,
): Promise<TransactionDto[]> {
  const candidates = candidatesIn ?? (await transferCandidates(companyId));
  const posterIds = [...new Set(rows.map((r) => r.postedByUserId).filter((v): v is string => v !== null))];
  const posters = posterIds.length > 0 ? await prisma.user.findMany({ where: { id: { in: posterIds } } }) : [];
  const posterLabel = new Map(posters.map((u) => [u.id, u.name ?? u.email.split('@')[0] ?? u.email]));

  const pendingRows = rows.filter((r) => r.status === 'PENDING');
  const liveSuggestions = await suggestForMany(
    companyId,
    pendingRows.map((r) => ({ payee: r.payee, memo: r.memo, amount: Number(r.amount) })),
  );
  const liveSuggestionByTxnId = new Map(pendingRows.map((r, i) => [r.id, liveSuggestions[i] ?? null]));

  const out: TransactionDto[] = [];
  for (const r of rows) {
    const amount = Number(r.amount);
    const activeAttempt = r.qboMutationAttempts[0];
    const activeCategorizationAttempt: TransactionDto['activeCategorizationAttempt'] =
      activeAttempt !== undefined &&
      UUID_PATTERN.test(activeAttempt.requestId) &&
      (activeAttempt.operation === 'recategorize' || activeAttempt.operation === 'restore') &&
      (activeAttempt.status === 'PREPARED' ||
        activeAttempt.status === 'COMMITTING' ||
        activeAttempt.status === 'UNCERTAIN')
        ? {
            requestId: activeAttempt.requestId,
            operation: activeAttempt.operation,
            status: activeAttempt.status,
          }
        : null;
    // Live pipeline first (rule edits must reflect instantly); fall back to the
    // snapshot computed at sync time (covers seeded/demo history suggestions
    // and AI suggestions stored by refreshSuggestions).
    const suggestion: SuggestionDto | null =
      r.status === 'PENDING'
        ? ((liveSuggestionByTxnId.get(r.id) ?? null) ?? (r.suggestion as SuggestionDto | null))
        : null;
    out.push({
      id: r.id,
      companyId: r.companyId,
      qboId: r.qboId,
      qboType: r.qboType as TransactionDto['qboType'],
      date: r.date.toISOString(),
      payee: r.payee,
      memo: r.memo,
      amount,
      bankAccount: r.bankAccount,
      status: r.status,
      revision: r.revision,
      category: r.category,
      categoryQboId: r.categoryQboId,
      taxCalculation: r.taxCalculation as TransactionDto['taxCalculation'],
      taxCode: r.taxCode,
      taxCodeQboId: r.taxCodeQboId,
      splits: splitLineDtos(r.splitLines),
      tagIds: r.txnTags.map((t) => t.tagId),
      suggestion,
      error:
        r.status === 'ERROR' && (r.errorCode !== null || r.errorMessage !== null)
          ? { code: r.errorCode ?? 'QBO_ERROR', message: r.errorMessage ?? 'Unknown error' }
          : null,
      postedAt: r.postedAt?.toISOString() ?? null,
      postedBy: r.postedByUserId !== null ? (posterLabel.get(r.postedByUserId) ?? null) : null,
      activeCategorizationAttempt,
      transferCandidateId: candidates.get(r.id) ?? null,
    });
  }
  return out;
}

async function loadTxn(id: string): Promise<TxnRow> {
  const txn = await prisma.transaction.findUnique({ where: { id }, include: txnInclude });
  if (!txn) throw new HttpError(404, 'Transaction not found', 'TXN_NOT_FOUND');
  return txn;
}

async function dtoById(id: string): Promise<TransactionDto> {
  const txn = await loadTxn(id);
  const [dto] = await transactionDtos(txn.companyId, [txn]);
  if (!dto) throw new HttpError(500, 'Could not build transaction');
  return dto;
}

// ---------------------------------------------------------------------------
// Search (server-side, matching the prototype's client-side matcher)
// ---------------------------------------------------------------------------

function formatQueueDate(iso: string): string {
  const d = new Date(iso);
  return `${MONTHS[d.getUTCMonth()] ?? ''} ${d.getUTCDate()}`;
}

function haystack(dto: TransactionDto, fullNameOf: Map<string, string>): string {
  const abs = Math.abs(dto.amount).toFixed(2);
  const parts = [
    dto.payee,
    dto.memo ?? '',
    dto.bankAccount,
    formatQueueDate(dto.date),
    dto.category ?? '',
    dto.category !== null ? (fullNameOf.get(dto.category) ?? '') : '',
    ...(dto.splits ?? []).flatMap((s) => [s.category, fullNameOf.get(s.category) ?? '']),
    dto.suggestion?.category ?? '',
    dto.suggestion !== null ? (fullNameOf.get(dto.suggestion.category) ?? '') : '',
    STATUS_WORDS[dto.status],
    abs,
    `$${abs}`,
    `${dto.amount < 0 ? '-' : '+'}$${abs}`,
  ];
  return parts.join(' ').toLowerCase();
}

function matchesSearch(dto: TransactionDto, search: string, fullNameOf: Map<string, string>): boolean {
  const hay = haystack(dto, fullNameOf);
  return search
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .every((token) => hay.includes(token));
}

// ---------------------------------------------------------------------------
// /api/companies/:companyId/transactions
// ---------------------------------------------------------------------------

const txnStatusSchema = z.enum(['PENDING', 'POSTING', 'POSTED', 'DRY_RUN', 'ERROR', 'SUPERSEDED', 'REVERTED']);

const listQuery = z.object({
  status: txnStatusSchema.optional(),
  search: z.string().optional(),
  account: z.string().optional(),
  cursor: z.string().optional(),
  countOnly: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
});

export const companyTransactionsRouter = Router({ mergeParams: true });
companyTransactionsRouter.use(requireUser, withCompany({ allowDisconnected: true }), requireRole('categorizer'));

companyTransactionsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const company = req.company;
    if (!company) throw new HttpError(404, 'Company not found', 'COMPANY_NOT_FOUND');
    const query = validate(listQuery)(req.query);

    // Queue badge: everything still waiting for a human (pending or errored).
    const pendingCount = await prisma.transaction.count({
      where: { companyId: company.id, status: { in: ['PENDING', 'ERROR'] } },
    });
    if (query.countOnly) {
      res.json({ transactions: [], nextCursor: null, pendingCount });
      return;
    }

    // The queue shows posted/dry-run/error rows too; only SUPERSEDED is hidden.
    // Prototype order: date ascending as entered.
    const rows = await prisma.transaction.findMany({
      where: { companyId: company.id, status: { not: 'SUPERSEDED' } },
      include: txnInclude,
      orderBy: { date: 'asc' },
    });
    // Same-date rows keep QBO entry order (ids are numeric strings — uuid
    // secondary sort would shuffle them run to run).
    rows.sort((a, b) => {
      const d = a.date.getTime() - b.date.getTime();
      if (d !== 0) return d;
      const an = Number(a.qboId);
      const bn = Number(b.qboId);
      if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return an - bn;
      return a.qboId.localeCompare(b.qboId);
    });
    let dtos = await transactionDtos(company.id, rows);

    if (query.status !== undefined) dtos = dtos.filter((d) => d.status === query.status);
    if (query.account !== undefined && query.account !== '' && query.account !== 'all') {
      dtos = dtos.filter((d) => d.bankAccount === query.account);
    }
    if (query.search !== undefined && query.search.trim() !== '') {
      const accounts = await prisma.qboAccount.findMany({ where: { companyId: company.id } });
      const fullNameOf = new Map(accounts.map((a) => [a.name, a.fullName]));
      dtos = dtos.filter((d) => matchesSearch(d, query.search ?? '', fullNameOf));
    }

    res.json({ transactions: dtos, nextCursor: null, pendingCount });
  }),
);

// ---------------------------------------------------------------------------
// /api/companies/:companyId/transfer-candidates
// ---------------------------------------------------------------------------

export const transferCandidatesRouter = Router({ mergeParams: true });
transferCandidatesRouter.use(requireUser, withCompany(), requireRole('categorizer'));

transferCandidatesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const company = req.company;
    if (!company) throw new HttpError(404, 'Company not found', 'COMPANY_NOT_FOUND');
    const candidates = await transferCandidates(company.id);

    // The map holds both directions; keep each pair once.
    const pairIds: [string, string][] = [];
    const seen = new Set<string>();
    for (const [idA, idB] of candidates) {
      if (seen.has(idA) || seen.has(idB)) continue;
      seen.add(idA);
      seen.add(idB);
      pairIds.push([idA, idB]);
    }

    const ids = pairIds.flat();
    const rows = ids.length > 0
      ? await prisma.transaction.findMany({ where: { id: { in: ids }, companyId: company.id }, include: txnInclude })
      : [];
    const dtos = await transactionDtos(company.id, rows, candidates);
    const byId = new Map(dtos.map((d) => [d.id, d]));

    const pairs: { a: TransactionDto; b: TransactionDto }[] = [];
    for (const [idA, idB] of pairIds) {
      const first = byId.get(idA);
      const second = byId.get(idB);
      if (!first || !second) continue;
      // Money-out leg first, for a stable presentation.
      const [a, b] = first.amount < 0 ? [first, second] : [second, first];
      pairs.push({ a, b });
    }
    res.json(pairs);
  }),
);

// ---------------------------------------------------------------------------
// /api/transactions — actions
// ---------------------------------------------------------------------------

const splitSchema = z.object({
  // Signed, matching the txn's sign (validated against the txn in the handler);
  // a zero line is rejected outright.
  amount: z
    .number()
    .finite()
    .refine((a) => Math.abs(a) >= 0.005, { message: 'Every split needs a nonzero amount.' }),
  category: z.string().min(1),
  categoryQboId: z.string().min(1).optional(),
  tagIds: z.array(z.string().min(1)).default([]),
  memo: z.string().optional(),
});

const categorizeBody = z.object({
  category: z.string().min(1).nullish(),
  categoryQboId: z.string().min(1).nullish(),
  splits: z.array(splitSchema).nullish(),
  tagIds: z.array(z.string().min(1)).optional(),
});

const transferBody = z.object({ counterpartTxnId: z.string().min(1) });

const bulkPostBody = z.object({ ids: z.array(z.string().min(1)).min(1).max(500) });

const transactionIdSchema = z.string().uuid();
const expectedRevisionSchema = z.number().int().min(0).max(MAX_EXPECTED_TRANSACTION_REVISION);
const qboReferenceSchema = z.string().trim().min(1).max(120);
const requestIdSchema = z.string().uuid();
const uniqueTagIdsSchema = z.array(z.string().uuid()).max(50)
  .refine((values) => new Set(values).size === values.length, 'Tag IDs must be unique.');

const stageCategorizationLineSchema: z.ZodType<StageCategorizationBody['lines'][number]> = z.object({
  grossCents: z.number().refine(Number.isSafeInteger, 'Line cents must be a safe integer.'),
  categoryQboId: qboReferenceSchema,
  taxCodeQboId: qboReferenceSchema.nullable(),
  memo: z.string().max(500).optional(),
  tagIds: uniqueTagIdsSchema,
}).strict();

const stageCategorizationBodySchema: z.ZodType<StageCategorizationBody> = z.object({
  expectedRevision: expectedRevisionSchema,
  taxCalculation: z.enum(['TaxInclusive', 'TaxExcluded', 'NotApplicable']),
  lines: z.array(stageCategorizationLineSchema).min(1).max(20),
  tagIds: uniqueTagIdsSchema,
}).strict().superRefine((body, context) => {
  for (const [lineIndex, line] of body.lines.entries()) {
    if (body.taxCalculation === 'NotApplicable' && line.taxCodeQboId !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'NotApplicable lines must use a null taxCodeQboId.',
        path: ['lines', lineIndex, 'taxCodeQboId'],
      });
    }
    if (body.taxCalculation !== 'NotApplicable' && line.taxCodeQboId === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Taxed lines require a taxCodeQboId.',
        path: ['lines', lineIndex, 'taxCodeQboId'],
      });
    }
  }
});

const commitCategorizationBodySchema: z.ZodType<CommitCategorizationBody> = z.object({
  expectedRevision: expectedRevisionSchema,
  requestId: requestIdSchema,
}).strict();

const reconcileCategorizationBodySchema: z.ZodType<ReconcileCategorizationBody> = z.object({
  requestId: requestIdSchema,
}).strict();

const undoCategorizationBodySchema: z.ZodType<UndoCategorizationBody> = z.object({
  requestId: requestIdSchema,
}).strict();

const safeCentsSchema = z.number().refine(Number.isSafeInteger, 'Cents must be a safe integer.');
const stageCategorizationResponseSchema = z.object({
  transactionId: z.string().uuid(),
  revision: z.number().int().min(1).max(MAX_EXPECTED_TRANSACTION_REVISION + 1),
  taxCalculation: z.enum(['TaxInclusive', 'TaxExcluded', 'NotApplicable']),
  totals: z.object({
    subtotalCents: safeCentsSchema,
    taxCents: safeCentsSchema,
    totalCents: safeCentsSchema,
  }),
  lines: z.array(z.object({
    idx: z.number().int().min(0).max(19),
    subtotalCents: safeCentsSchema,
    taxCents: safeCentsSchema,
    totalCents: safeCentsSchema,
    categoryQboId: qboReferenceSchema,
    taxCodeQboId: qboReferenceSchema.nullable(),
    memo: z.string().max(500).nullable(),
    tagIds: uniqueTagIdsSchema,
  })).min(1).max(20),
  tagIds: uniqueTagIdsSchema,
});

function boundedStageCategorizationResponse(
  value: unknown,
  expectedTransactionId: string,
): z.infer<typeof stageCategorizationResponseSchema> {
  const parsed = stageCategorizationResponseSchema.parse(value);
  if (parsed.transactionId !== expectedTransactionId) {
    throw new HttpError(500, 'Internal server error');
  }
  return parsed;
}

interface CategorizationScope {
  transactionId: string;
  companyId: string;
}

async function loadCategorizationScope(untrustedId: string | undefined): Promise<CategorizationScope> {
  const transactionId = validate(transactionIdSchema)(untrustedId);
  const txn = await prisma.transaction.findUnique({
    where: { id: transactionId },
    select: { id: true, companyId: true },
  });
  if (!txn) throw new HttpError(404, 'Transaction not found', 'TRANSACTION_NOT_FOUND');
  return { transactionId: txn.id, companyId: txn.companyId };
}

async function assertCompanyConnected(companyId: string): Promise<void> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { disconnectedAt: true },
  });
  if (!company) throw new HttpError(404, 'Transaction not found', 'TRANSACTION_NOT_FOUND');
  if (company.disconnectedAt !== null) {
    throw new HttpError(
      409,
      'This company is disconnected from QuickBooks.',
      'COMPANY_DISCONNECTED',
    );
  }
}

async function assertLegacyCategorizationAllowed(
  txn: Pick<
    TxnRow,
    | 'id'
    | 'companyId'
    | 'qboType'
    | 'taxCalculation'
    | 'taxCodeQboId'
    | 'splitLines'
    | 'qboMutationAttempts'
  >,
): Promise<void> {
  if (txn.qboType !== 'Purchase' && txn.qboType !== 'Deposit') return;
  const hasStagedMarker =
    txn.taxCalculation !== null ||
    txn.taxCodeQboId !== null ||
    txn.splitLines.some((line) => line.taxCodeQboId !== null);
  const durableAttempt =
    txn.qboMutationAttempts.length > 0
      ? txn.qboMutationAttempts[0]
      : await prisma.qboMutationAttempt.findFirst({
          where: { transactionId: txn.id },
          select: { id: true },
        });
  if (hasStagedMarker || durableAttempt) {
    throw new HttpError(
      409,
      txn.qboType === 'Purchase'
        ? 'Tax-ready Purchases must use staged categorization.'
        : 'Tax-ready transactions must use staged categorization.',
      'TAX_AWARE_STAGING_REQUIRED',
    );
  }
  if (txn.qboType === 'Deposit') {
    const readiness = await getTaxReadiness(txn.companyId);
    if (readiness.salesStatus !== 'ready') return;
    throw new HttpError(
      409,
      'Tax-ready transactions must use staged categorization.',
      'TAX_AWARE_STAGING_REQUIRED',
    );
  }
  const company = await prisma.company.findUnique({
    where: { id: txn.companyId },
    select: { taxSupportStatus: true, taxUsingSalesTax: true },
  });
  if (!company) throw new HttpError(404, 'Transaction not found', 'TRANSACTION_NOT_FOUND');
  if (company.taxSupportStatus === 'ready' && company.taxUsingSalesTax === true) {
    throw new HttpError(
      409,
      txn.qboType === 'Purchase'
        ? 'Tax-ready Purchases must use staged categorization.'
        : 'Tax-ready transactions must use staged categorization.',
      'TAX_AWARE_STAGING_REQUIRED',
    );
  }
}

async function assertAttemptScope(requestId: string, transactionId: string): Promise<void> {
  const attempt = await prisma.qboMutationAttempt.findUnique({
    where: { requestId },
    select: { transactionId: true },
  });
  if (!attempt || attempt.transactionId !== transactionId) {
    throw new HttpError(404, 'Mutation attempt not found', 'ATTEMPT_NOT_FOUND');
  }
}

const SAFE_SERVICE_ERRORS: Record<string, { status: number; message: string }> = {
  ATTEMPT_CORRUPT: { status: 500, message: 'Mutation state could not be verified.' },
  ATTEMPT_NOT_FOUND: { status: 404, message: 'Mutation attempt not found.' },
  COMPANY_DISCONNECTED: { status: 409, message: 'This company is disconnected from QuickBooks.' },
  ENTITY_BUSY: { status: 409, message: 'Another write is already in progress.' },
  FORBIDDEN: { status: 403, message: 'You do not have permission to do that.' },
  INVALID_ACCOUNT: { status: 400, message: 'One or more category accounts are unavailable for this company.' },
  INVALID_INPUT: { status: 400, message: 'The categorization request is invalid.' },
  INVALID_STAGE: { status: 409, message: 'The staged categorization is no longer valid.' },
  INVALID_STATUS: { status: 409, message: 'The transaction cannot be changed from its current status.' },
  INVALID_TAG: { status: 400, message: 'One or more tags are unavailable for this company.' },
  INVALID_TRANSACTION_AMOUNT: { status: 400, message: 'The transaction amount cannot be categorized safely.' },
  MUTATION_BLOCKED: {
    status: 409,
    message: 'This transaction has a prepared write that must be resumed or verified.',
  },
  PREWRITE_PERSISTENCE_FAILED: { status: 503, message: 'The prepared write was not sent. Retry with a new request.' },
  QBO_AMOUNT_UNSAFE: { status: 400, message: 'The transaction amount cannot be categorized safely.' },
  QBO_DEPOSIT_UNSUPPORTED: { status: 400, message: 'This transaction cannot use tax-aware Deposit writeback.' },
  QBO_ENTITY_UNSUPPORTED: { status: 400, message: 'This transaction type cannot use tax-aware writeback.' },
  QBO_PURCHASE_UNSUPPORTED: { status: 400, message: 'This transaction cannot use tax-aware Purchase writeback.' },
  QBO_REFERENCE_MISSING: { status: 400, message: 'Required QuickBooks references are unavailable.' },
  QBO_STATE_DRIFT: { status: 409, message: 'The QuickBooks transaction changed. Reload before continuing.' },
  RECONCILE_NOT_ALLOWED: { status: 409, message: 'This mutation attempt does not require reconciliation.' },
  REQUEST_ID_CONFLICT: { status: 409, message: 'This request ID belongs to a different mutation.' },
  STALE_REVISION: { status: 409, message: 'The transaction changed. Reload before continuing.' },
  TAX_AMOUNT_INVALID: { status: 400, message: 'The tax amount cannot be calculated safely.' },
  TAX_AMOUNT_SIGN_MISMATCH: { status: 400, message: 'Categorization lines do not match the transaction direction.' },
  TAX_AWARE_STAGING_REQUIRED: {
    status: 409,
    message: 'Tax-ready transactions must use staged categorization.',
  },
  TAX_CODE_INACTIVE: { status: 400, message: 'A selected tax code is unavailable.' },
  TAX_CODE_MALFORMED: { status: 400, message: 'A selected tax code is unsupported.' },
  TAX_CODE_PURCHASE_ONLY: { status: 400, message: 'A selected tax code is unsupported.' },
  TAX_CODE_SALES_ONLY: { status: 400, message: 'A selected tax code is unsupported.' },
  TAX_CODE_UNAVAILABLE: { status: 400, message: 'A selected tax code is unavailable.' },
  TAX_COMPANY_MISMATCH: { status: 400, message: 'A selected tax reference is unavailable for this company.' },
  TAX_NOT_READY: { status: 409, message: 'Tax references are not ready.' },
  TAX_RATE_INACTIVE: { status: 400, message: 'A selected tax code is unavailable.' },
  TAX_RATE_MALFORMED: { status: 400, message: 'A selected tax code is unsupported.' },
  TAX_RATE_UNAVAILABLE: { status: 400, message: 'A selected tax code is unavailable.' },
  TAX_RATE_UNSUPPORTED: { status: 400, message: 'A selected tax code is unsupported.' },
  TAX_REQUIRES_PURCHASE: { status: 400, message: 'Tax selection is unsupported for this transaction type.' },
  TAX_TREATMENT_AMBIGUOUS: { status: 400, message: 'A selected tax code is unsupported.' },
  TRANSACTION_NOT_FOUND: { status: 404, message: 'Transaction not found.' },
  UNBALANCED_TOTAL: { status: 400, message: 'Categorization lines do not balance to the transaction total.' },
  VERIFIED_POST_REQUIRED: { status: 409, message: 'Undo requires a verified posted categorization.' },
};

function mappedServiceHttpError(error: unknown): HttpError | null {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
  if (typeof code === 'string') {
    const safe = SAFE_SERVICE_ERRORS[code];
    if (safe) return new HttpError(safe.status, safe.message, code);
  }
  return null;
}

function throwMappedServiceError(error: unknown): never {
  const mapped = mappedServiceHttpError(error);
  if (mapped) throw mapped;
  throw error;
}

const SAFE_OUTCOME_ERRORS: Partial<Record<
  DurableMutationResult['outcome'],
  { code: string; message: string }
>> = {
  IN_PROGRESS: {
    code: 'MUTATION_IN_PROGRESS',
    message: 'This prepared write is already in progress and will not be sent again.',
  },
  RETRYABLE: {
    code: 'RETRYABLE',
    message: 'The prepared write was not sent. Create a new request to retry.',
  },
  UNCERTAIN: {
    code: 'QBO_WRITE_UNCERTAIN',
    message: 'The QuickBooks write may have succeeded — verify in QuickBooks before retrying.',
  },
};

function sendMutationResult(
  res: Response,
  result: DurableMutationResult,
  expected: { transactionId: string; requestId: string },
): void {
  if (
    result.transactionId !== expected.transactionId ||
    result.requestId !== expected.requestId
  ) {
    throw new HttpError(500, 'Mutation result identity could not be verified.');
  }
  const safe: CategorizationMutationResult = {
    transactionId: result.transactionId,
    requestId: result.requestId,
    ok: result.ok,
    status: result.status,
    outcome: result.outcome,
  };
  const safeError = SAFE_OUTCOME_ERRORS[result.outcome];
  if (!result.ok && safeError) safe.error = safeError;
  const status = result.outcome === 'IN_PROGRESS' ? 202
    : result.outcome === 'UNCERTAIN' || result.outcome === 'RETRYABLE' ? 409
      : 200;
  res.status(status).json(safe);
}

async function resolveCategoryQboId(
  companyId: string,
  name: string,
  given: string | null | undefined,
): Promise<string | null> {
  // Never trust a client-supplied account id verbatim: it must be an active
  // account in THIS company's chart of accounts (defense in depth — a stray
  // id would otherwise be written straight to QBO on post).
  if (given) {
    const byId = await prisma.qboAccount.findFirst({ where: { companyId, qboId: given, active: true } });
    if (!byId) {
      throw new HttpError(
        400,
        `Category account '${given}' is not an active account for this company`,
        'BAD_CATEGORY_ACCOUNT',
      );
    }
    return given;
  }
  const acct = await prisma.qboAccount.findFirst({ where: { companyId, name, active: true } });
  return acct?.qboId ?? null;
}

async function loadRuleLikes(companyId: string): Promise<RuleLike[]> {
  return prisma.rule.findMany({
    where: { companyId },
    select: { id: true, matchText: true, category: true, categoryQboId: true, priority: true, createdAt: true },
  });
}

export const transactionActionsRouter = Router();
transactionActionsRouter.use(requireUser);

transactionActionsRouter.post(
  '/:id/categorization/stage',
  asyncHandler(async (req, res) => {
    const body = validate(stageCategorizationBodySchema)(req.body);
    const scope = await loadCategorizationScope(req.params.id);
    await assertCategorizationRouteAccess(requestUser(req), scope.companyId);
    await assertCompanyConnected(scope.companyId);
    try {
      const staged = await stageCategorization({
        transactionId: scope.transactionId,
        companyId: scope.companyId,
        expectedRevision: body.expectedRevision,
        proposal: {
          taxCalculation: body.taxCalculation,
          lines: body.lines,
          tagIds: body.tagIds,
        },
      });
      res.json(boundedStageCategorizationResponse(staged, scope.transactionId));
    } catch (error) {
      throwMappedServiceError(error);
    }
  }),
);

transactionActionsRouter.post(
  '/:id/categorization/commit',
  asyncHandler(async (req, res) => {
    const body = validate(commitCategorizationBodySchema)(req.body);
    const scope = await loadCategorizationScope(req.params.id);
    const user = requestUser(req);
    await assertCategorizationRouteAccess(user, scope.companyId);
    try {
      const result = await commitStagedCategorization({
        transactionId: scope.transactionId,
        companyId: scope.companyId,
        expectedRevision: body.expectedRevision,
        requestId: body.requestId,
        actor: actorFor(user),
      });
      sendMutationResult(res, result, {
        transactionId: scope.transactionId,
        requestId: body.requestId,
      });
    } catch (error) {
      throwMappedServiceError(error);
    }
  }),
);

async function reconcileCategorizationRequest(
  req: Request,
  res: Response,
): Promise<void> {
  const body = validate(reconcileCategorizationBodySchema)(req.body);
  const scope = await loadCategorizationScope(req.params.id);
  const user = requestUser(req);
  await assertCategorizationRouteAccess(user, scope.companyId);
  await assertCompanyConnected(scope.companyId);
  await assertAttemptScope(body.requestId, scope.transactionId);
  try {
    const result = await reconcileMutationAttempt({
      requestId: body.requestId,
      actor: actorFor(user),
    });
    sendMutationResult(res, result, {
      transactionId: scope.transactionId,
      requestId: body.requestId,
    });
  } catch (error) {
    throwMappedServiceError(error);
  }
}

transactionActionsRouter.post(
  '/:id/categorization/reconcile',
  asyncHandler(reconcileCategorizationRequest),
);

transactionActionsRouter.post(
  '/:id/categorization/retry',
  asyncHandler(reconcileCategorizationRequest),
);

transactionActionsRouter.post(
  '/:id/categorization/undo',
  asyncHandler(async (req, res) => {
    const body = validate(undoCategorizationBodySchema)(req.body);
    const scope = await loadCategorizationScope(req.params.id);
    const user = requestUser(req);
    await assertCategorizationRouteAccess(user, scope.companyId);
    try {
      const result = await undoCategorization({
        transactionId: scope.transactionId,
        companyId: scope.companyId,
        requestId: body.requestId,
        actor: actorFor(user),
      });
      sendMutationResult(res, result, {
        transactionId: scope.transactionId,
        requestId: body.requestId,
      });
    } catch (error) {
      throwMappedServiceError(error);
    }
  }),
);

// Stage category/splits/tags locally — never writes to QBO.
transactionActionsRouter.post(
  '/:id/categorize',
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!id) throw new HttpError(400, 'Missing transaction id', 'BAD_REQUEST');
    const body = validate(categorizeBody)(req.body);
    const txn = await loadTxn(id);
    await assertCategorizerFor(requestUser(req), txn.companyId);
    await assertLegacyCategorizationAllowed(txn);
    if (txn.status !== 'PENDING' && txn.status !== 'ERROR') {
      throw new HttpError(400, `Cannot edit a transaction in status ${txn.status}`, 'BAD_STATUS');
    }
    const companyId = txn.companyId;
    const amount = Number(txn.amount);
    const data: Prisma.TransactionUpdateInput = {};
    let stagedCategory: string | null = null;

    if (body.splits && body.splits.length > 0) {
      const splitCheck = validateSplits(amount, body.splits);
      if (!splitCheck.ok) {
        throw new HttpError(400, splitCheck.message ?? 'Split amounts must add up to the transaction amount.', 'BAD_SPLITS');
      }
      // Every split-line tag must belong to this company (same gate as txn tags).
      const splitTagIds = [...new Set(body.splits.flatMap((s) => s.tagIds))];
      if (splitTagIds.length > 0) {
        const owned = await prisma.tag.findMany({ where: { companyId, id: { in: splitTagIds } } });
        if (owned.length !== splitTagIds.length) {
          throw new HttpError(400, 'One or more tags do not belong to this company', 'BAD_TAGS');
        }
      }
      const lines: Prisma.SplitLineCreateWithoutTxnInput[] = [];
      for (const [i, s] of body.splits.entries()) {
        const qboId = await resolveCategoryQboId(companyId, s.category, s.categoryQboId);
        lines.push({
          idx: i, // array order IS the line order
          amount: s.amount,
          category: s.category,
          categoryQboId: qboId,
          memo: s.memo ?? null,
          tags: { create: [...new Set(s.tagIds)].map((tagId) => ({ tagId })) },
        });
      }
      // Replace the txn's split set: delete the existing lines (SplitLineTag
      // rows cascade), then create the new ones — one nested atomic update.
      data.splitLines = { deleteMany: {}, create: lines };
      data.category = null;
      data.categoryQboId = null;
    } else {
      if (body.splits === null) data.splitLines = { deleteMany: {} };
      if (body.category !== undefined) {
        if (body.category === null) {
          data.category = null;
          data.categoryQboId = null;
        } else {
          stagedCategory = body.category;
          data.category = body.category;
          data.categoryQboId = await resolveCategoryQboId(companyId, body.category, body.categoryQboId);
          data.splitLines = { deleteMany: {} }; // single category replaces any staged splits
        }
      }
    }

    await prisma.transaction.update({ where: { id }, data });

    if (body.tagIds !== undefined) {
      const owned = await prisma.tag.findMany({ where: { companyId, id: { in: body.tagIds } } });
      if (owned.length !== new Set(body.tagIds).size) {
        throw new HttpError(400, 'One or more tags do not belong to this company', 'BAD_TAGS');
      }
      await prisma.txnTag.deleteMany({ where: { txnId: id } });
      for (const tagId of new Set(body.tagIds)) {
        await prisma.txnTag.create({ data: { txnId: id, tagId } });
      }
    }

    // Prototype behavior: accepting a rule's suggested category also applies
    // the rule's tags (merged into whatever is already staged).
    if (stagedCategory !== null) {
      const rules = await loadRuleLikes(companyId);
      const match = ruleSuggestion(txn.payee, rules);
      if (match?.ruleId !== undefined && match.category === stagedCategory) {
        const ruleTags = await prisma.ruleTag.findMany({ where: { ruleId: match.ruleId } });
        for (const rt of ruleTags) {
          await prisma.txnTag.upsert({
            where: { txnId_tagId: { txnId: id, tagId: rt.tagId } },
            create: { txnId: id, tagId: rt.tagId },
            update: {},
          });
        }
      }
    }

    res.json(await dtoById(id));
  }),
);

// Post to QuickBooks. Awaited (mock is instant, real is a couple of seconds)
// and the resulting DTO is returned so the client can treat it as completion.
transactionActionsRouter.post(
  '/:id/post',
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!id) throw new HttpError(400, 'Missing transaction id', 'BAD_REQUEST');
    const user = requestUser(req);
    const txn = await loadTxn(id); // 404 before the write-back service's plain Errors
    await assertCategorizerFor(user, txn.companyId);

    let result;
    try {
      result = await postTransaction(id, actorFor(user));
    } catch (err) {
      const mapped = mappedServiceHttpError(err);
      if (mapped) throw mapped;
      throw new HttpError(400, err instanceof Error ? err.message : String(err), 'POST_FAILED');
    }

    const dto = await dtoById(id);

    // 'Always file X as Y?' prompt: post succeeded, single category, and no
    // rule already covers this payee.
    let rulePromptEligible = false;
    if (
      result.ok &&
      (result.status === 'POSTED' || result.status === 'DRY_RUN') &&
      dto.category !== null &&
      (dto.splits === null || dto.splits.length === 0)
    ) {
      const rules = await loadRuleLikes(dto.companyId);
      rulePromptEligible = ruleSuggestion(dto.payee, rules) === null;
    }

    res.status(202).json({ ...dto, rulePromptEligible });
  }),
);

transactionActionsRouter.post(
  '/:id/undo',
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!id) throw new HttpError(400, 'Missing transaction id', 'BAD_REQUEST');
    const user = requestUser(req);
    const txn = await loadTxn(id);
    await assertCategorizerFor(user, txn.companyId);
    try {
      await undoPost(id, actorFor(user));
    } catch (err) {
      const mapped = mappedServiceHttpError(err);
      if (mapped) throw mapped;
      throw new HttpError(400, err instanceof Error ? err.message : String(err), 'UNDO_FAILED');
    }
    res.json(await dtoById(id));
  }),
);

transactionActionsRouter.post(
  '/:id/retry',
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!id) throw new HttpError(400, 'Missing transaction id', 'BAD_REQUEST');
    const txn = await loadTxn(id);
    await assertCategorizerFor(requestUser(req), txn.companyId);
    try {
      await retryError(id);
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err), 'RETRY_FAILED');
    }
    res.json(await dtoById(id));
  }),
);

transactionActionsRouter.post(
  '/:id/transfer',
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!id) throw new HttpError(400, 'Missing transaction id', 'BAD_REQUEST');
    const { counterpartTxnId } = validate(transferBody)(req.body);
    const user = requestUser(req);
    const txn = await loadTxn(id);
    await assertCategorizerFor(user, txn.companyId);
    try {
      await recordTransfer(id, counterpartTxnId, actorFor(user));
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err), 'TRANSFER_FAILED');
    }
    res.json([await dtoById(id), await dtoById(counterpartTxnId)]);
  }),
);

transactionActionsRouter.post(
  '/bulk-post',
  asyncHandler(async (req, res) => {
    const { ids } = validate(bulkPostBody)(req.body);
    const user = requestUser(req);

    // Role gate BEFORE any write: categorizer+ in every company touched.
    const companyIds = await prisma.transaction.findMany({
      where: { id: { in: ids } },
      select: { companyId: true },
      distinct: ['companyId'],
    });
    for (const { companyId } of companyIds) {
      await assertCategorizerFor(user, companyId);
    }

    const results = await bulkPost(ids, actorFor(user));

    const rows = await prisma.transaction.findMany({ where: { id: { in: ids } }, include: txnInclude });
    const byCompany = new Map<string, TxnRow[]>();
    for (const row of rows) {
      const list = byCompany.get(row.companyId) ?? [];
      list.push(row);
      byCompany.set(row.companyId, list);
    }
    const transactions: TransactionDto[] = [];
    for (const [companyId, companyRows] of byCompany) {
      transactions.push(...(await transactionDtos(companyId, companyRows)));
    }

    res.json({
      results: results.map((r) => ({
        id: r.id,
        ok: r.ok,
        ...(r.error !== undefined ? { error: r.error.message } : {}),
      })),
      transactions,
    });
  }),
);
