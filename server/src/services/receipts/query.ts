import type {
  Prisma,
  PrismaClient,
  ReceiptDocumentStatus,
  ReceiptSourceKind,
} from '@prisma/client';
import {
  Prisma as PrismaRuntime,
} from '@prisma/client';
import type {
  AttachmentDto,
  ReceiptDetailDto,
  ReceiptEventDto,
  ReceiptListResponse,
  ReceiptMatchCandidateDto,
  ReceiptMatchEvidenceDto,
} from '@recat/shared';
import { prisma } from '../../lib/prisma.js';
import {
  toReceiptDto,
  toReceiptExtractionDto,
} from './intake.js';
import { ReceiptError } from './types.js';

export interface ReceiptQuery {
  statuses: ReceiptDocumentStatus[];
  documentTypes: string[];
  dateFrom: Date | null;
  dateTo: Date | null;
  sourceKinds: ReceiptSourceKind[];
  missingInfo: boolean;
  duplicate: boolean;
  matched: boolean | null;
  search: string;
  sortBy: 'createdAt' | 'receiptDate' | 'vendorName' | 'totalAmount' | 'status';
  sortOrder: 'asc' | 'desc';
  page: number;
  pageSize: number;
}

export interface ReceiptQueryDeps {
  readonly db?: PrismaClient;
}

const receiptListInclude = {
  attempts: {
    orderBy: [
      { generation: 'desc' },
      { attemptCount: 'desc' },
      { startedAt: 'desc' },
    ],
    take: 1,
  },
} satisfies Prisma.ReceiptDocumentInclude;

const receiptDetailInclude = {
  attempts: {
    orderBy: [
      { generation: 'desc' },
      { attemptCount: 'desc' },
      { startedAt: 'desc' },
    ],
    take: 25,
  },
  events: {
    orderBy: { createdAt: 'desc' },
    take: 100,
  },
  transactionAttachment: true,
} satisfies Prisma.ReceiptDocumentInclude;

function dbOf(deps?: ReceiptQueryDeps): PrismaClient {
  return deps?.db ?? prisma;
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/gu, '\\$&');
}

function assertQuery(query: ReceiptQuery): void {
  if (
    query.statuses.length > 5
    || query.documentTypes.length > 5
    || query.sourceKinds.length > 5
    || query.documentTypes.some((value) =>
      value.trim() === '' || Buffer.byteLength(value, 'utf8') > 80)
    || Buffer.byteLength(query.search, 'utf8') > 200
    || !Number.isInteger(query.page)
    || query.page < 1
    || !Number.isInteger(query.pageSize)
    || query.pageSize < 1
    || query.pageSize > 100
    || ![
      'createdAt',
      'receiptDate',
      'vendorName',
      'totalAmount',
      'status',
    ].includes(query.sortBy)
    || (query.sortOrder !== 'asc' && query.sortOrder !== 'desc')
    || (
      query.dateFrom !== null
      && !Number.isFinite(query.dateFrom.getTime())
    )
    || (
      query.dateTo !== null
      && !Number.isFinite(query.dateTo.getTime())
    )
    || (
      query.dateFrom !== null
      && query.dateTo !== null
      && query.dateFrom > query.dateTo
    )
  ) {
    throw new ReceiptError(
      'RECEIPT_INVALID_INPUT',
      'Receipt query is invalid.',
    );
  }
}

function whereSql(companyId: string, query: ReceiptQuery): Prisma.Sql {
  const conditions: Prisma.Sql[] = [
    PrismaRuntime.sql`d."companyId" = ${companyId}`,
    PrismaRuntime.sql`d."deletedAt" IS NULL`,
  ];
  if (query.statuses.length > 0) {
    conditions.push(
      PrismaRuntime.sql`d."status"::text IN (${PrismaRuntime.join(query.statuses)})`,
    );
  }
  if (query.sourceKinds.length > 0) {
    conditions.push(
      PrismaRuntime.sql`d."sourceKind"::text IN (${PrismaRuntime.join(query.sourceKinds)})`,
    );
  }
  if (query.documentTypes.length > 0) {
    conditions.push(
      PrismaRuntime.sql`a."documentType" IN (${PrismaRuntime.join(query.documentTypes)})`,
    );
  }
  if (query.dateFrom !== null) {
    conditions.push(PrismaRuntime.sql`a."receiptDate" >= ${query.dateFrom}`);
  }
  if (query.dateTo !== null) {
    conditions.push(PrismaRuntime.sql`a."receiptDate" <= ${query.dateTo}`);
  }
  if (query.missingInfo) {
    conditions.push(PrismaRuntime.sql`(
      a."id" IS NULL
      OR a."receiptDate" IS NULL
      OR a."vendorName" IS NULL
      OR a."totalAmount" IS NULL
    )`);
  }
  if (query.matched !== null) {
    conditions.push(query.matched
      ? PrismaRuntime.sql`d."matchedTransactionId" IS NOT NULL`
      : PrismaRuntime.sql`d."matchedTransactionId" IS NULL`);
  }
  if (query.search.trim() !== '') {
    const text = query.search.trim();
    const filenamePattern = `%${escapeLikePattern(text)}%`;
    const predicates: Prisma.Sql[] = [
      PrismaRuntime.sql`a."search_vector" @@ websearch_to_tsquery('simple', ${text})`,
      PrismaRuntime.sql`d."originalFilename" ILIKE ${filenamePattern} ESCAPE E'\\\\'`,
      PrismaRuntime.sql`d."id" = ${text}`,
    ];
    if (/^-?\d{1,14}(?:\.\d{1,4})?$/u.test(text)) {
      predicates.push(
        PrismaRuntime.sql`a."totalAmount" = CAST(${text} AS DECIMAL(18, 4))`,
      );
    }
    conditions.push(PrismaRuntime.sql`(${PrismaRuntime.join(predicates, ' OR ')})`);
  }
  if (query.duplicate) {
    conditions.push(PrismaRuntime.sql`EXISTS (
      SELECT 1
      FROM "ReceiptDocument" duplicate_document
      JOIN LATERAL (
        SELECT duplicate_attempt.*
        FROM "ReceiptExtractionAttempt" duplicate_attempt
        WHERE duplicate_attempt."documentId" = duplicate_document."id"
        ORDER BY
          duplicate_attempt."generation" DESC,
          duplicate_attempt."attemptCount" DESC,
          duplicate_attempt."startedAt" DESC
        LIMIT 1
      ) duplicate_extraction ON TRUE
      WHERE duplicate_document."companyId" = d."companyId"
        AND duplicate_document."deletedAt" IS NULL
        AND duplicate_document."id" <> d."id"
        AND duplicate_extraction."vendorReceiptId" IS NOT NULL
        AND duplicate_extraction."vendorReceiptId" = a."vendorReceiptId"
        AND duplicate_extraction."vendorName" = a."vendorName"
    )`);
  }
  return PrismaRuntime.join(conditions, ' AND ');
}

function orderSql(query: ReceiptQuery): Prisma.Sql {
  const column = {
    createdAt: PrismaRuntime.raw('d."createdAt"'),
    receiptDate: PrismaRuntime.raw('a."receiptDate"'),
    vendorName: PrismaRuntime.raw('a."vendorName"'),
    totalAmount: PrismaRuntime.raw('a."totalAmount"'),
    status: PrismaRuntime.raw('d."status"'),
  }[query.sortBy];
  const direction = query.sortOrder === 'asc'
    ? PrismaRuntime.raw('ASC')
    : PrismaRuntime.raw('DESC');
  return PrismaRuntime.sql`${column} ${direction} NULLS LAST, d."id" ${direction}`;
}

function latestAttemptJoin(): Prisma.Sql {
  return PrismaRuntime.sql`
    FROM "ReceiptDocument" d
    LEFT JOIN LATERAL (
      SELECT current_attempt.*
      FROM "ReceiptExtractionAttempt" current_attempt
      WHERE current_attempt."documentId" = d."id"
      ORDER BY
        current_attempt."generation" DESC,
        current_attempt."attemptCount" DESC,
        current_attempt."startedAt" DESC
      LIMIT 1
    ) a ON TRUE
  `;
}

export async function listReceipts(
  companyId: string,
  query: ReceiptQuery,
  deps?: ReceiptQueryDeps,
): Promise<ReceiptListResponse> {
  assertQuery(query);
  if (companyId.trim() === '') {
    throw new ReceiptError(
      'RECEIPT_INVALID_INPUT',
      'Receipt company scope is invalid.',
    );
  }
  const db = dbOf(deps);
  const where = whereSql(companyId, query);
  const join = latestAttemptJoin();
  const offset = (query.page - 1) * query.pageSize;
  const [idRows, countRows] = await Promise.all([
    db.$queryRaw<Array<{ id: string }>>(PrismaRuntime.sql`
      SELECT d."id"
      ${join}
      WHERE ${where}
      ORDER BY ${orderSql(query)}
      LIMIT ${query.pageSize}
      OFFSET ${offset}
    `),
    db.$queryRaw<Array<{ count: bigint }>>(PrismaRuntime.sql`
      SELECT COUNT(*)::bigint AS "count"
      ${join}
      WHERE ${where}
    `),
  ]);
  const ids = idRows.map((row) => row.id);
  const rows = ids.length === 0
    ? []
    : await db.receiptDocument.findMany({
        where: { id: { in: ids }, companyId, deletedAt: null },
        include: receiptListInclude,
      });
  const byId = new Map(rows.map((row) => [row.id, row]));
  return {
    receipts: ids.flatMap((id) => {
      const row = byId.get(id);
      return row ? [toReceiptDto(row)] : [];
    }),
    total: Number(countRows[0]?.count ?? 0n),
    page: query.page,
    pageSize: query.pageSize,
  };
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function nullableFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function matchEvidence(value: Prisma.JsonValue): ReceiptMatchEvidenceDto {
  const record = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value
    : {};
  return {
    amountPoints: finiteNumber(record.amountPoints),
    currencyPoints: finiteNumber(record.currencyPoints),
    datePoints: finiteNumber(record.datePoints),
    vendorPoints: finiteNumber(record.vendorPoints),
    paymentPoints: finiteNumber(record.paymentPoints),
    amountDifferenceCents: finiteNumber(record.amountDifferenceCents),
    dateDifferenceDays: nullableFiniteNumber(record.dateDifferenceDays),
    vendorSimilarity: nullableFiniteNumber(record.vendorSimilarity),
  };
}

function matchCandidateDto(
  row: Prisma.ReceiptMatchCandidateGetPayload<{
    include: { transaction: true };
  }>,
): ReceiptMatchCandidateDto {
  return {
    transactionId: row.transactionId,
    transactionRevision: row.transactionRevision,
    rank: row.rank,
    score: row.score,
    state: row.state as ReceiptMatchCandidateDto['state'],
    evidence: matchEvidence(row.evidence),
    transaction: {
      id: row.transaction.id,
      date: row.transaction.date.toISOString(),
      payee: row.transaction.payee,
      memo: row.transaction.memo,
      amount: Number(row.transaction.amount),
      status: row.transaction.status,
      revision: row.transaction.revision,
    },
  };
}

function eventRecord(
  value: Prisma.JsonValue | null,
): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function eventDto(
  row: Prisma.ReceiptEventGetPayload<Record<string, never>>,
): ReceiptEventDto {
  return {
    id: row.id,
    action: row.action,
    actorUserId: row.actorUserId,
    before: eventRecord(row.before),
    after: eventRecord(row.after),
    createdAt: row.createdAt.toISOString(),
  };
}

function attachmentDto(
  row: NonNullable<Prisma.ReceiptDocumentGetPayload<{
    include: { transactionAttachment: true };
  }>['transactionAttachment']>,
): AttachmentDto {
  return {
    id: row.id,
    transactionId: row.transactionId,
    filename: row.originalFilename,
    contentType: row.contentType,
    sizeBytes: Number(row.sizeBytes),
    sourceKind: row.sourceKind,
    retainedLocally: row.blobId !== null,
    status: row.status,
    qboAttached:
      row.qboAttachableId !== null
      && row.status !== 'DELETED'
      && row.status !== 'QBO_MISSING',
    canPreview:
      row.contentType === 'application/pdf'
      || row.contentType.startsWith('image/')
      || row.contentType.startsWith('text/'),
    error: row.errorCode
      ? {
          code: row.errorCode,
          message: 'The attachment operation requires attention.',
        }
      : null,
  };
}

export async function getReceiptDetail(
  companyId: string,
  receiptId: string,
  deps?: ReceiptQueryDeps,
): Promise<ReceiptDetailDto> {
  const db = dbOf(deps);
  const row = await db.receiptDocument.findFirst({
    where: { id: receiptId, companyId, deletedAt: null },
    include: receiptDetailInclude,
  });
  if (!row) {
    throw new ReceiptError('RECEIPT_NOT_FOUND', 'Receipt was not found.');
  }
  const currentAttemptId = row.attempts[0]?.id;
  const [previous, next, candidates] = await Promise.all([
    db.receiptDocument.findFirst({
      where: {
        companyId,
        deletedAt: null,
        OR: [
          { createdAt: { gt: row.createdAt } },
          { createdAt: row.createdAt, id: { gt: row.id } },
        ],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    }),
    db.receiptDocument.findFirst({
      where: {
        companyId,
        deletedAt: null,
        OR: [
          { createdAt: { lt: row.createdAt } },
          { createdAt: row.createdAt, id: { lt: row.id } },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    }),
    currentAttemptId
      ? db.receiptMatchCandidate.findMany({
          where: {
            documentId: row.id,
            extractionAttemptId: currentAttemptId,
          },
          orderBy: { rank: 'asc' },
          take: 20,
          include: { transaction: true },
        })
      : Promise.resolve([]),
  ]);
  return {
    ...toReceiptDto({ ...row, attempts: row.attempts.slice(0, 1) }),
    previousId: previous?.id ?? null,
    nextId: next?.id ?? null,
    attempts: row.attempts.map(toReceiptExtractionDto),
    candidates: candidates.map(matchCandidateDto),
    events: row.events.map(eventDto),
    attachment: row.transactionAttachment
      ? attachmentDto(row.transactionAttachment)
      : null,
  };
}

export async function setReceiptDeleted(
  companyId: string,
  receiptId: string,
  actorUserId: string,
  deleted: boolean,
  expectedRevision: number,
  deps?: ReceiptQueryDeps,
): Promise<void> {
  const db = dbOf(deps);
  await db.$transaction(async (transaction) => {
    const existing = await transaction.receiptDocument.findFirst({
      where: {
        id: receiptId,
        companyId,
      },
      select: {
        id: true,
        revision: true,
        status: true,
        deletedAt: true,
        transactionAttachmentId: true,
      },
    });
    if (!existing) {
      throw new ReceiptError('RECEIPT_NOT_FOUND', 'Receipt was not found.');
    }
    if (
      existing.revision !== expectedRevision
      || (existing.deletedAt !== null) === deleted
      || existing.status === 'ATTACHING'
      || existing.status === 'ATTACHED'
      || existing.transactionAttachmentId !== null
    ) {
      throw new ReceiptError(
        'RECEIPT_STALE',
        'Receipt revision changed; refresh before retrying.',
      );
    }
    const updated = await transaction.receiptDocument.updateMany({
      where: {
        id: existing.id,
        companyId,
        revision: expectedRevision,
        deletedAt: deleted ? null : { not: null },
      },
      data: {
        deletedAt: deleted ? new Date() : null,
        revision: { increment: 1 },
      },
    });
    if (updated.count !== 1) {
      throw new ReceiptError(
        'RECEIPT_STALE',
        'Receipt revision changed; refresh before retrying.',
      );
    }
    await transaction.receiptEvent.create({
      data: {
        companyId,
        documentId: existing.id,
        actorUserId,
        action: deleted ? 'deleted' : 'restored',
        before: { deleted: existing.deletedAt !== null },
        after: { deleted },
      },
    });
  });
}
