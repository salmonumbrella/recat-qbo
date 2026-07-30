import { randomUUID } from 'node:crypto';
import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { errorMiddleware } from '../lib/http.js';
import { qboFactory } from '../lib/qbo/factory.js';
import { QboAttachmentNotFoundError } from '../lib/qbo/types.js';
import { createSession, SESSION_COOKIE } from '../middleware/auth.js';
import {
  attachmentUploadsRouter,
  companyAttachmentGrantsRouter,
} from './attachments.js';
import { receiptsRouter } from './receipts.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;

describePostgres('receipt HTTP routes on PostgreSQL', () => {
  let db: PrismaClient;
  const companyIds = new Set<string>();
  const userIds = new Set<string>();

  beforeAll(() => {
    db = new PrismaClient({
      datasources: { db: { url: TEST_DATABASE_URL! } },
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    const companies = [...companyIds];
    const users = [...userIds];
    companyIds.clear();
    userIds.clear();
    if (companies.length > 0) {
      await db.company.deleteMany({ where: { id: { in: companies } } });
    }
    if (users.length > 0) {
      await db.user.deleteMany({ where: { id: { in: users } } });
    }
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  function application() {
    const app = express();
    app.use(cookieParser());
    app.use(express.json({ limit: '1mb' }));
    app.use(
      '/api/companies/:companyId/attachment-upload-grants',
      companyAttachmentGrantsRouter,
    );
    app.use('/api/attachment-uploads', attachmentUploadsRouter);
    app.use('/api/companies/:companyId/receipts', receiptsRouter);
    app.use(errorMiddleware);
    return app;
  }

  async function company(realmId = `receipt-route-${randomUUID()}`) {
    const row = await db.company.create({
      data: {
        realmId,
        legalName: 'Synthetic Receipt Route Company',
        nickname: 'Receipt Route',
      },
    });
    companyIds.add(row.id);
    return row;
  }

  async function signedIn(
    companyId: string,
    role: 'viewer' | 'categorizer' | 'admin',
  ) {
    const user = await db.user.create({
      data: {
        email: `${randomUUID()}@example.invalid`,
        memberships: { create: { companyId, role } },
      },
    });
    userIds.add(user.id);
    const session = await createSession(user.id);
    return `${SESSION_COOKIE}=${session.token}`;
  }

  async function upload(
    app: ReturnType<typeof application>,
    companyId: string,
    cookie: string,
  ) {
    const grantResponse = await request(app)
      .post(`/api/companies/${companyId}/attachment-upload-grants`)
      .set('Cookie', cookie)
      .send({});
    expect(grantResponse.status).toBe(201);
    const grant = grantResponse.body as { uploadUrl: string; grant: string };
    const staged = await request(app)
      .post(grant.uploadUrl)
      .set('Authorization', `Bearer ${grant.grant}`)
      .attach('files', Buffer.from('%PDF-1.7\nsynthetic receipt'), {
        filename: 'synthetic.pdf',
        contentType: 'application/pdf',
      });
    expect(staged.status).toBe(201);
    return staged.body.uploads[0] as { id: string };
  }

  it('lets a categorizer ingest and a viewer read and preview a receipt', async () => {
    const app = application();
    const firstCompany = await company();
    const categorizer = await signedIn(firstCompany.id, 'categorizer');
    const viewer = await signedIn(firstCompany.id, 'viewer');
    const staged = await upload(app, firstCompany.id, categorizer);

    const created = await request(app)
      .post(`/api/companies/${firstCompany.id}/receipts`)
      .set('Cookie', categorizer)
      .send({
        idempotencyKey: 'receipt-create-1',
        files: [{ uploadId: staged.id }],
        sourceKind: 'WEB_UPLOAD',
      });
    expect(created.status).toBe(202);
    expect(created.body.receipts[0]).toMatchObject({
      filename: 'synthetic.pdf',
      status: 'QUEUED',
    });
    const receiptId = created.body.receipts[0].id as string;

    const listed = await request(app)
      .get(`/api/companies/${firstCompany.id}/receipts`)
      .set('Cookie', viewer);
    expect(listed.status).toBe(200);
    expect(listed.body.receipts.map((receipt: { id: string }) => receipt.id))
      .toContain(receiptId);

    await request(app)
      .get(`/api/companies/${firstCompany.id}/receipts/${receiptId}`)
      .set('Cookie', viewer)
      .expect(200);
    const preview = await request(app)
      .get(`/api/companies/${firstCompany.id}/receipts/${receiptId}/preview`)
      .set('Cookie', viewer)
      .buffer(true);
    expect(preview.status).toBe(200);
    expect(preview.body).toEqual(Buffer.from('%PDF-1.7\nsynthetic receipt'));
    expect(preview.headers['content-disposition']).toMatch(/^inline;/u);
    expect(preview.headers['x-content-type-options']).toBe('nosniff');
    expect(preview.headers['content-security-policy']).toContain(
      "default-src 'none'",
    );
  });

  it('returns 403 for a viewer mutation and 404 outside company scope', async () => {
    const app = application();
    const firstCompany = await company();
    const secondCompany = await company();
    const categorizer = await signedIn(firstCompany.id, 'categorizer');
    const viewer = await signedIn(firstCompany.id, 'viewer');
    const otherCategorizer = await signedIn(secondCompany.id, 'categorizer');
    const staged = await upload(app, firstCompany.id, categorizer);
    const created = await request(app)
      .post(`/api/companies/${firstCompany.id}/receipts`)
      .set('Cookie', categorizer)
      .send({
        idempotencyKey: 'scope-receipt',
        files: [{ uploadId: staged.id }],
        sourceKind: 'WEB_UPLOAD',
      });
    const receiptId = created.body.receipts[0].id as string;

    await request(app)
      .post(`/api/companies/${firstCompany.id}/receipts`)
      .set('Cookie', viewer)
      .send({
        idempotencyKey: 'viewer-receipt',
        files: [{ uploadId: randomUUID() }],
        sourceKind: 'WEB_UPLOAD',
      })
      .expect(403);
    await request(app)
      .get(`/api/companies/${firstCompany.id}/receipts`)
      .set('Cookie', otherCategorizer)
      .expect(404);
    for (const suffix of [
      receiptId,
      `${receiptId}/file`,
      `${receiptId}/preview`,
    ]) {
      await request(app)
        .get(`/api/companies/${firstCompany.id}/receipts/${suffix}`)
        .set('Cookie', otherCategorizer)
        .expect(404);
    }
    await request(app)
      .delete(
        `/api/companies/${firstCompany.id}/receipts/${receiptId}`
        + '?expectedRevision=0',
      )
      .set('Cookie', otherCategorizer)
      .expect(404);
    await request(app)
      .post(`/api/companies/${firstCompany.id}/receipts/${receiptId}/restore`)
      .set('Cookie', otherCategorizer)
      .send({ expectedRevision: 0 })
      .expect(404);
  });

  it('revision-fences delete and restore mutations', async () => {
    const app = application();
    const firstCompany = await company();
    const categorizer = await signedIn(firstCompany.id, 'categorizer');
    const staged = await upload(app, firstCompany.id, categorizer);
    const created = await request(app)
      .post(`/api/companies/${firstCompany.id}/receipts`)
      .set('Cookie', categorizer)
      .send({
        idempotencyKey: 'revision-receipt',
        files: [{ uploadId: staged.id }],
        sourceKind: 'WEB_UPLOAD',
      });
    const receiptId = created.body.receipts[0].id as string;

    await request(app)
      .delete(`/api/companies/${firstCompany.id}/receipts/${receiptId}`)
      .set('Cookie', categorizer)
      .expect(400);
    await request(app)
      .delete(
        `/api/companies/${firstCompany.id}/receipts/${receiptId}`
        + '?expectedRevision=1',
      )
      .set('Cookie', categorizer)
      .expect(409);
    await request(app)
      .delete(
        `/api/companies/${firstCompany.id}/receipts/${receiptId}`
        + '?expectedRevision=0',
      )
      .set('Cookie', categorizer)
      .expect(204);
    await request(app)
      .delete(
        `/api/companies/${firstCompany.id}/receipts/${receiptId}`
        + '?expectedRevision=0',
      )
      .set('Cookie', categorizer)
      .expect(409);
    await request(app)
      .post(`/api/companies/${firstCompany.id}/receipts/${receiptId}/restore`)
      .set('Cookie', categorizer)
      .send({ expectedRevision: 0 })
      .expect(409);
    const restored = await request(app)
      .post(`/api/companies/${firstCompany.id}/receipts/${receiptId}/restore`)
      .set('Cookie', categorizer)
      .send({ expectedRevision: 1 });
    expect(restored.status).toBe(200);
    expect(restored.body.revision).toBe(2);
  });

  it('falls back to attached local content when the primary blob is unavailable', async () => {
    const app = application();
    const firstCompany = await company();
    const categorizer = await signedIn(firstCompany.id, 'categorizer');
    const staged = await upload(app, firstCompany.id, categorizer);
    const created = await request(app)
      .post(`/api/companies/${firstCompany.id}/receipts`)
      .set('Cookie', categorizer)
      .send({
        idempotencyKey: 'fallback-receipt',
        files: [{ uploadId: staged.id }],
        sourceKind: 'WEB_UPLOAD',
      });
    const receiptId = created.body.receipts[0].id as string;
    const receipt = await db.receiptDocument.findUniqueOrThrow({
      where: { id: receiptId },
    });
    const fallbackContent = Buffer.from('%PDF-1.7\nfallback receipt');
    const fallbackBlob = await db.attachmentBlob.create({
      data: {
        companyId: firstCompany.id,
        state: 'READY',
        sha256: 'c'.repeat(64),
        sizeBytes: BigInt(fallbackContent.byteLength),
        contentType: 'application/pdf',
        chunkCount: 1,
        chunks: {
          create: { ordinal: 0, content: fallbackContent },
        },
      },
    });
    const transaction = await db.transaction.create({
      data: {
        companyId: firstCompany.id,
        qboId: `fallback-${randomUUID()}`,
        qboType: 'Purchase',
        qboSyncToken: '0',
        date: new Date('2026-07-30T00:00:00.000Z'),
        payee: 'Synthetic Fallback Vendor',
        amount: -10,
        bankAccount: 'Synthetic Bank',
      },
    });
    const attachment = await db.transactionAttachment.create({
      data: {
        companyId: firstCompany.id,
        transactionId: transaction.id,
        blobId: fallbackBlob.id,
        originalFilename: 'fallback.pdf',
        contentType: 'application/pdf',
        sizeBytes: BigInt(fallbackContent.byteLength),
        sha256: 'c'.repeat(64),
        sourceKind: 'LOCAL_UPLOAD',
        retainLocally: true,
        status: 'ATTACHED',
        recatMarker: randomUUID(),
      },
    });
    await db.receiptDocument.update({
      where: { id: receipt.id },
      data: { transactionAttachmentId: attachment.id },
    });
    await db.attachmentBlob.update({
      where: { id: receipt.blobId! },
      data: {
        state: 'STAGING',
        sha256: null,
        sizeBytes: 0n,
        contentType: null,
        chunkCount: 0,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const preview = await request(app)
      .get(`/api/companies/${firstCompany.id}/receipts/${receiptId}/preview`)
      .set('Cookie', categorizer)
      .buffer(true);

    expect(preview.status).toBe(200);
    expect(preview.body).toEqual(fallbackContent);
  });

  it.each(['DELETED', 'QBO_MISSING'] as const)(
    'does not download a logically unavailable %s QuickBooks attachment',
    async (status) => {
      const app = application();
      const firstCompany = await company();
      const categorizer = await signedIn(firstCompany.id, 'categorizer');
      const staged = await upload(app, firstCompany.id, categorizer);
      const created = await request(app)
        .post(`/api/companies/${firstCompany.id}/receipts`)
        .set('Cookie', categorizer)
        .send({
          idempotencyKey: `unavailable-${status.toLowerCase()}`,
          files: [{ uploadId: staged.id }],
          sourceKind: 'WEB_UPLOAD',
        });
      const receiptId = created.body.receipts[0].id as string;
      const receipt = await db.receiptDocument.findUniqueOrThrow({
        where: { id: receiptId },
      });
      const transaction = await db.transaction.create({
        data: {
          companyId: firstCompany.id,
          qboId: `unavailable-${status.toLowerCase()}`,
          qboType: 'Purchase',
          qboSyncToken: '0',
          date: new Date('2026-07-30T00:00:00.000Z'),
          payee: 'Synthetic Unavailable Vendor',
          amount: -10,
          bankAccount: 'Synthetic Bank',
        },
      });
      const attachment = await db.transactionAttachment.create({
        data: {
          companyId: firstCompany.id,
          transactionId: transaction.id,
          originalFilename: 'unavailable.pdf',
          contentType: 'application/pdf',
          sizeBytes: 8n,
          sha256: '9'.repeat(64),
          sourceKind: 'LOCAL_UPLOAD',
          retainLocally: false,
          status,
          qboAttachableId: 'missing-qbo-attachment',
          recatMarker: randomUUID(),
        },
      });
      await db.receiptDocument.update({
        where: { id: receipt.id },
        data: {
          blobId: null,
          transactionAttachmentId: attachment.id,
        },
      });
      await db.attachmentBlob.update({
        where: { id: receipt.blobId! },
        data: {
          state: 'STAGING',
          sha256: null,
          sizeBytes: 0n,
          contentType: null,
          chunkCount: 0,
          expiresAt: new Date(Date.now() + 60_000),
        },
      });

      await request(app)
        .get(`/api/companies/${firstCompany.id}/receipts/${receiptId}/file`)
        .set('Cookie', categorizer)
        .expect(410);
    },
  );

  it('maps a missing QuickBooks provider object to gone', async () => {
    const app = application();
    const firstCompany = await company();
    const categorizer = await signedIn(firstCompany.id, 'categorizer');
    const staged = await upload(app, firstCompany.id, categorizer);
    const created = await request(app)
      .post(`/api/companies/${firstCompany.id}/receipts`)
      .set('Cookie', categorizer)
      .send({
        idempotencyKey: 'provider-missing',
        files: [{ uploadId: staged.id }],
        sourceKind: 'WEB_UPLOAD',
      });
    const receiptId = created.body.receipts[0].id as string;
    const receipt = await db.receiptDocument.findUniqueOrThrow({
      where: { id: receiptId },
    });
    const transaction = await db.transaction.create({
      data: {
        companyId: firstCompany.id,
        qboId: 'provider-missing',
        qboType: 'Purchase',
        qboSyncToken: '0',
        date: new Date('2026-07-30T00:00:00.000Z'),
        payee: 'Synthetic Missing Vendor',
        amount: -10,
        bankAccount: 'Synthetic Bank',
      },
    });
    const attachment = await db.transactionAttachment.create({
      data: {
        companyId: firstCompany.id,
        transactionId: transaction.id,
        originalFilename: 'provider-missing.pdf',
        contentType: 'application/pdf',
        sizeBytes: 8n,
        sha256: '8'.repeat(64),
        sourceKind: 'LOCAL_UPLOAD',
        retainLocally: false,
        status: 'ATTACHED',
        qboAttachableId: 'missing-qbo-attachment',
        recatMarker: randomUUID(),
      },
    });
    await db.receiptDocument.update({
      where: { id: receipt.id },
      data: {
        blobId: null,
        transactionAttachmentId: attachment.id,
      },
    });
    await db.attachmentBlob.update({
      where: { id: receipt.blobId! },
      data: {
        state: 'STAGING',
        sha256: null,
        sizeBytes: 0n,
        contentType: null,
        chunkCount: 0,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    vi.spyOn(qboFactory, 'forCompany').mockResolvedValue({
      getAttachment: async () => ({
        id: 'missing-qbo-attachment',
        syncToken: '0',
        filename: 'provider-missing.pdf',
        contentType: 'application/pdf',
        sizeBytes: 8,
        note: null,
        refs: [{ qboType: 'Purchase', qboId: 'provider-missing' }],
      }),
      openAttachmentDownload: async () => {
        throw new QboAttachmentNotFoundError();
      },
    } as never);

    await request(app)
      .get(`/api/companies/${firstCompany.id}/receipts/${receiptId}/file`)
      .set('Cookie', categorizer)
      .expect(410);
  });
});
