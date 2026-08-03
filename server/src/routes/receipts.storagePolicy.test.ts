import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errorMiddleware } from '../lib/http.js';
import { AttachmentError } from '../services/attachments/types.js';

const mocks = vi.hoisted(() => ({
  attachMatchedReceipt: vi.fn(),
}));

vi.mock('../middleware/auth.js', () => ({
  requireUser: ((req, _res, next) => {
    req.user = {
      id: 'categorizer-1',
      isInstanceAdmin: false,
      memberships: [{ companyId: 'company-1', role: 'categorizer' }],
    } as NonNullable<typeof req.user>;
    next();
  }) satisfies RequestHandler,
  requireRole: () => ((_req, _res, next) => next()) satisfies RequestHandler,
}));

vi.mock('../middleware/company.js', () => ({
  withCompany: () => ((req, _res, next) => {
    req.company = { id: req.params.companyId } as NonNullable<
      typeof req.company
    >;
    next();
  }) satisfies RequestHandler,
}));

vi.mock('../services/receipts/matching.js', () => ({
  attachMatchedReceipt: mocks.attachMatchedReceipt,
  confirmReceiptMatch: vi.fn(),
  rematchReceipt: vi.fn(),
  undoAttachedReceipt: vi.fn(),
}));

import { receiptsRouter } from './receipts.js';

function app() {
  const application = express();
  application.use(express.json());
  application.use('/api/companies/:companyId/receipts', receiptsRouter);
  application.use(errorMiddleware);
  return application;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('receipt route attachment policy errors', () => {
  it.each([
    'ATTACHMENT_COMPANY_QUOTA_EXCEEDED',
    'ATTACHMENT_INSTANCE_QUOTA_EXCEEDED',
  ] as const)('returns 413 for %s', async (code) => {
    mocks.attachMatchedReceipt.mockRejectedValueOnce(
      new AttachmentError(code, 'Attachment storage quota exceeded.'),
    );

    const response = await request(app())
      .post('/api/companies/company-1/receipts/receipt-1/attach')
      .send({
        expectedReceiptRevision: 0,
        expectedTransactionRevision: 0,
      });

    expect(response.status).toBe(413);
    expect(response.body).toEqual({
      error: 'Attachment storage quota exceeded.',
      code,
    });
  });
});
