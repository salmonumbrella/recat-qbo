import { once } from 'node:events';
import { Router, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import type {
  ReceiptDocumentStatus,
  ReceiptSourceKind,
  TransactionAttachment,
} from '@prisma/client';
import { asyncHandler, HttpError, validate } from '../lib/http.js';
import { prisma } from '../lib/prisma.js';
import { qboFactory } from '../lib/qbo/factory.js';
import { QboAttachmentNotFoundError } from '../lib/qbo/types.js';
import { requireRole, requireUser } from '../middleware/auth.js';
import { withCompany } from '../middleware/company.js';
import {
  attachmentActorForUser,
  attachmentContentDisposition,
} from './attachments.js';
import { openAttachmentBlob } from '../services/attachments/blobStore.js';
import {
  AttachmentError,
  type AttachmentBlobReader,
} from '../services/attachments/types.js';
import { createReceipts } from '../services/receipts/intake.js';
import {
  getReceiptDetail,
  listReceipts,
  setReceiptDeleted,
  type ReceiptQuery,
} from '../services/receipts/query.js';
import { ReceiptError } from '../services/receipts/types.js';
import { reprocessReceipt } from '../services/receipts/worker.js';

const receiptStatuses = [
  'RECEIVED',
  'QUEUED',
  'PROCESSING',
  'NEEDS_REVIEW',
  'READY',
  'MATCHED',
  'ATTACHING',
  'ATTACHED',
  'FAILED',
] as const;
const receiptSourceKinds = [
  'WEB_UPLOAD',
  'API_UPLOAD',
  'MCP_UPLOAD',
] as const;

function commaSeparatedArray<T extends readonly [string, ...string[]]>(
  values: T,
) {
  return z.preprocess((value) => {
    const source = Array.isArray(value) ? value : [value];
    return source.flatMap((item) =>
      typeof item === 'string' && item !== ''
        ? item.split(',').map((part) => part.trim())
        : []);
  }, z.array(z.enum(values)).max(5).default([]));
}

function optionalBoolean(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return value;
}

const receiptListQuerySchema = z.object({
  statuses: commaSeparatedArray(receiptStatuses),
  documentTypes: z.preprocess((value) => {
    const source = Array.isArray(value) ? value : [value];
    return source.flatMap((item) =>
      typeof item === 'string' && item !== ''
        ? item.split(',').map((part) => part.trim())
        : []);
  }, z.array(z.string().trim().min(1).max(80)).max(5).default([])),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  sourceKinds: commaSeparatedArray(receiptSourceKinds),
  missingInfo: z.preprocess(optionalBoolean, z.boolean().default(false)),
  duplicate: z.preprocess(optionalBoolean, z.boolean().default(false)),
  matched: z.preprocess(optionalBoolean, z.boolean().optional()),
  search: z.string().trim().max(200).default(''),
  sortBy: z.enum([
    'createdAt',
    'receiptDate',
    'vendorName',
    'totalAmount',
    'status',
  ]).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

const createReceiptsBodySchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(128),
  files: z.array(z.object({
    uploadId: z.string().uuid(),
    sourceExternalId: z.string().trim().min(1).max(200).optional(),
  }).strict()).min(1).max(20),
  sourceKind: z.enum(receiptSourceKinds),
}).strict();

const receiptRevisionSchema = z.object({
  expectedRevision: z.coerce.number().int().min(0).max(2_147_483_647),
}).strict();
const receiptReprocessSchema = z.object({
  expectedRevision: z.number().int().min(0).max(2_147_483_646),
  idempotencyKey: z.string().trim().min(1).max(128),
}).strict();

export function parseReceiptListQuery(input: unknown): ReceiptQuery {
  const parsed = validate(receiptListQuerySchema)(input);
  return {
    statuses: parsed.statuses as ReceiptDocumentStatus[],
    documentTypes: parsed.documentTypes,
    dateFrom: parsed.dateFrom ?? null,
    dateTo: parsed.dateTo ?? null,
    sourceKinds: parsed.sourceKinds as ReceiptSourceKind[],
    missingInfo: parsed.missingInfo,
    duplicate: parsed.duplicate,
    matched: parsed.matched ?? null,
    search: parsed.search,
    sortBy: parsed.sortBy,
    sortOrder: parsed.sortOrder,
    page: parsed.page,
    pageSize: parsed.pageSize,
  };
}

function receiptHttpError(error: unknown): never {
  if (!(error instanceof ReceiptError)) throw error;
  const status = error.code === 'RECEIPT_FORBIDDEN'
    ? 403
    : error.code === 'RECEIPT_NOT_FOUND'
      ? 404
      : error.code === 'RECEIPT_IDEMPOTENCY_CONFLICT'
        || error.code === 'RECEIPT_STALE'
        ? 409
        : 400;
  throw new HttpError(status, error.message, error.code);
}

async function receiptCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    return receiptHttpError(error);
  }
}

const hideUnscopedCompany: RequestHandler = (req, _res, next) => {
  if (
    req.user?.isInstanceAdmin
    || req.user?.memberships.some(
      (membership) => membership.companyId === req.params.companyId,
    )
  ) {
    next();
    return;
  }
  next(new HttpError(404, 'Company not found', 'COMPANY_NOT_FOUND'));
};

async function streamBody(
  body: AsyncIterable<Uint8Array>,
  res: Response,
): Promise<void> {
  for await (const chunk of body) {
    if (res.destroyed) return;
    if (!res.write(chunk)) await once(res, 'drain');
  }
  res.end();
}

async function tryOpenBlob(
  companyId: string,
  blobId: string | null,
): Promise<AttachmentBlobReader | null> {
  if (blobId === null) return null;
  try {
    return await openAttachmentBlob(companyId, blobId);
  } catch (error) {
    if (
      error instanceof AttachmentError
      && error.code === 'ATTACHMENT_NOT_FOUND'
    ) {
      return null;
    }
    throw error;
  }
}

async function streamReceipt(
  companyId: string,
  receiptId: string,
  disposition: 'attachment' | 'inline',
  res: Response,
): Promise<void> {
  const receipt = await prisma.receiptDocument.findFirst({
    where: { id: receiptId, companyId, deletedAt: null },
    include: { transactionAttachment: true },
  });
  if (!receipt) {
    throw new HttpError(404, 'Receipt not found', 'RECEIPT_NOT_FOUND');
  }
  if (
    disposition === 'inline'
    && receipt.contentType !== 'application/pdf'
    && !receipt.contentType.startsWith('image/')
  ) {
    throw new HttpError(
      404,
      'Receipt preview not found',
      'RECEIPT_NOT_FOUND',
    );
  }

  let contentType: string;
  let sizeBytes: number | null;
  let body: AsyncIterable<Uint8Array>;
  const attachment = receipt.transactionAttachment;
  const primary = await tryOpenBlob(companyId, receipt.blobId);
  const fallback = primary === null && attachment?.blobId !== receipt.blobId
    ? await tryOpenBlob(companyId, attachment?.blobId ?? null)
    : null;
  const reader = primary ?? fallback;
  if (reader !== null) {
    contentType = reader.contentType;
    sizeBytes = reader.sizeBytes;
    body = reader.chunks();
  } else if (attachment !== null) {
    const source: TransactionAttachment = attachment;
    if (
      source.qboAttachableId !== null
      && source.status !== 'DELETED'
      && source.status !== 'QBO_MISSING'
    ) {
      const qbo = await qboFactory.forCompany(companyId);
      try {
        const download = await qbo.openAttachmentDownload(source.qboAttachableId);
        contentType = download.contentType;
        sizeBytes = download.sizeBytes;
        body = download.body;
      } catch (error) {
        if (!(error instanceof QboAttachmentNotFoundError)) throw error;
        throw new HttpError(
          410,
          'Receipt content is no longer available',
          'RECEIPT_GONE',
        );
      }
    } else {
      throw new HttpError(
        410,
        'Receipt content is no longer available',
        'RECEIPT_GONE',
      );
    }
  } else {
    throw new HttpError(
      410,
      'Receipt content is no longer available',
      'RECEIPT_GONE',
    );
  }
  res.setHeader('Content-Type', contentType);
  res.setHeader(
    'Content-Disposition',
    attachmentContentDisposition(receipt.originalFilename, disposition),
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; sandbox; img-src 'self' data:; style-src 'unsafe-inline'",
  );
  res.setHeader('Cache-Control', 'private, no-store');
  if (sizeBytes !== null) res.setHeader('Content-Length', String(sizeBytes));
  await streamBody(body, res);
}

export const receiptsRouter = Router({ mergeParams: true });
receiptsRouter.use(requireUser, withCompany(), hideUnscopedCompany);

receiptsRouter.post(
  '/',
  requireRole('categorizer'),
  asyncHandler(async (req, res) => {
    const body = validate(createReceiptsBodySchema)(req.body);
    const result = await receiptCall(() => createReceipts({
      actor: attachmentActorForUser(req.user!),
      companyId: req.company!.id,
      files: body.files,
      sourceKind: body.sourceKind,
      idempotencyKey: body.idempotencyKey,
    }));
    res.status(202).json(result);
  }),
);

receiptsRouter.get(
  '/',
  requireRole('viewer'),
  asyncHandler(async (req, res) => {
    res.json(await receiptCall(() =>
      listReceipts(req.company!.id, parseReceiptListQuery(req.query))));
  }),
);

receiptsRouter.get(
  '/:receiptId/file',
  requireRole('viewer'),
  asyncHandler(async (req, res) => {
    await streamReceipt(
      req.company!.id,
      req.params.receiptId!,
      'attachment',
      res,
    );
  }),
);

receiptsRouter.get(
  '/:receiptId/preview',
  requireRole('viewer'),
  asyncHandler(async (req, res) => {
    await streamReceipt(
      req.company!.id,
      req.params.receiptId!,
      'inline',
      res,
    );
  }),
);

receiptsRouter.delete(
  '/:receiptId',
  requireRole('categorizer'),
  asyncHandler(async (req, res) => {
    const query = validate(receiptRevisionSchema)(req.query);
    await receiptCall(() => setReceiptDeleted(
      req.company!.id,
      req.params.receiptId!,
      req.user!.id,
      true,
      query.expectedRevision,
    ));
    res.status(204).end();
  }),
);

receiptsRouter.post(
  '/:receiptId/restore',
  requireRole('categorizer'),
  asyncHandler(async (req, res) => {
    const body = validate(receiptRevisionSchema)(req.body);
    await receiptCall(() => setReceiptDeleted(
      req.company!.id,
      req.params.receiptId!,
      req.user!.id,
      false,
      body.expectedRevision,
    ));
    res.json(await receiptCall(() =>
      getReceiptDetail(req.company!.id, req.params.receiptId!)));
  }),
);

receiptsRouter.post(
  '/:receiptId/reprocess',
  requireRole('categorizer'),
  asyncHandler(async (req, res) => {
    const body = validate(receiptReprocessSchema)(req.body);
    await receiptCall(() => reprocessReceipt(
      req.company!.id,
      req.params.receiptId!,
      req.user!.id,
      body.expectedRevision,
      body.idempotencyKey,
    ));
    res.status(202).json(await receiptCall(() =>
      getReceiptDetail(req.company!.id, req.params.receiptId!)));
  }),
);

receiptsRouter.get(
  '/:receiptId',
  requireRole('viewer'),
  asyncHandler(async (req, res) => {
    res.json(await receiptCall(() =>
      getReceiptDetail(req.company!.id, req.params.receiptId!)));
  }),
);
