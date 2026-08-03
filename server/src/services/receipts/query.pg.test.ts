import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  getReceiptDetail,
  listReceipts,
  type ReceiptQuery,
} from './query.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;
const BLOB_EXPIRES_AT = new Date('2100-01-01T00:00:00.000Z');

const DEFAULT_QUERY: ReceiptQuery = {
  statuses: [],
  documentTypes: [],
  dateFrom: null,
  dateTo: null,
  sourceKinds: [],
  missingInfo: false,
  duplicate: false,
  matched: null,
  search: '',
  sortBy: 'createdAt',
  sortOrder: 'desc',
  page: 1,
  pageSize: 50,
};

describePostgres('receipt library queries', () => {
  let db: PrismaClient;
  const companyIds = new Set<string>();

  beforeAll(() => {
    db = new PrismaClient({
      datasources: { db: { url: TEST_DATABASE_URL! } },
    });
  });

  afterEach(async () => {
    const ids = [...companyIds];
    companyIds.clear();
    if (ids.length > 0) {
      await db.company.deleteMany({ where: { id: { in: ids } } });
    }
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  async function createSearchableReceipt(
    companyId: string,
    sha: string,
    vendorName: string,
  ) {
    const blob = await db.attachmentBlob.create({
      data: {
        companyId,
        state: 'READY',
        sha256: sha,
        sizeBytes: 4n,
        contentType: 'image/png',
        chunkCount: 1,
        expiresAt: BLOB_EXPIRES_AT,
      },
    });
    const receipt = await db.receiptDocument.create({
      data: {
        companyId,
        blobId: blob.id,
        originalFilename: 'synthetic.png',
        contentType: 'image/png',
        sizeBytes: 4n,
        sha256: sha,
        sourceKind: 'WEB_UPLOAD',
        status: 'READY',
        retainLocally: true,
        jobs: {
          create: {
            companyId,
            generation: 1,
            configVersion: 'c'.repeat(64),
            status: 'completed',
            dueAt: new Date(),
          },
        },
      },
    });
    const job = await db.receiptProcessingJob.findUniqueOrThrow({
      where: {
        documentId_generation: { documentId: receipt.id, generation: 1 },
      },
    });
    await db.receiptExtractionAttempt.create({
      data: {
        jobId: job.id,
        documentId: receipt.id,
        generation: 1,
        attemptCount: 1,
        status: 'succeeded',
        vendorName,
        totalAmount: '12.3400',
        currency: 'USD',
        model: 'synthetic/model',
        promptVersion: 'synthetic-v1',
        schemaVersion: 'synthetic-v1',
        completedAt: new Date(),
      },
    });
    return receipt;
  }

  it('uses the search vector without leaking another company', async () => {
    const first = await db.company.create({
      data: {
        realmId: `receipt-query-${randomUUID()}`,
        legalName: 'Synthetic Query One',
        nickname: 'Query One',
      },
    });
    const second = await db.company.create({
      data: {
        realmId: `receipt-query-${randomUUID()}`,
        legalName: 'Synthetic Query Two',
        nickname: 'Query Two',
      },
    });
    companyIds.add(first.id);
    companyIds.add(second.id);
    const expected = await createSearchableReceipt(
      first.id,
      'd'.repeat(64),
      'Invented Aurora Supplies',
    );
    await createSearchableReceipt(
      second.id,
      'e'.repeat(64),
      'Invented Aurora Supplies',
    );

    for (const search of [
      'Aurora',
      'synthetic.png',
      expected.id,
      '12.34',
    ]) {
      const result = await listReceipts(first.id, {
        ...DEFAULT_QUERY,
        search,
      });

      expect(result.total, search).toBe(1);
      expect(result.receipts.map((receipt) => receipt.id), search)
        .toEqual([expected.id]);
      expect(result.receipts[0]?.currentExtraction?.totalAmount, search)
        .toBe('12.34');
    }
  });

  it('treats filename wildcard characters as literal search text', async () => {
    const company = await db.company.create({
      data: {
        realmId: `receipt-wildcard-${randomUUID()}`,
        legalName: 'Synthetic Wildcard Company',
        nickname: 'Wildcard',
      },
    });
    companyIds.add(company.id);
    const expected = await createSearchableReceipt(
      company.id,
      'a'.repeat(64),
      'Invented Literal Vendor',
    );
    await db.receiptDocument.update({
      where: { id: expected.id },
      data: { originalFilename: 'literal%_receipt.png' },
    });
    await createSearchableReceipt(
      company.id,
      'b'.repeat(64),
      'Invented Ordinary Vendor',
    );

    const result = await listReceipts(company.id, {
      ...DEFAULT_QUERY,
      search: '%_',
    });

    expect(result.receipts.map((receipt) => receipt.id)).toEqual([expected.id]);
  });

  it('bounds append-only attempts and events in receipt detail', async () => {
    const company = await db.company.create({
      data: {
        realmId: `receipt-detail-${randomUUID()}`,
        legalName: 'Synthetic Detail Company',
        nickname: 'Detail',
      },
    });
    companyIds.add(company.id);
    const blob = await db.attachmentBlob.create({
      data: {
        companyId: company.id,
        state: 'READY',
        sha256: 'f'.repeat(64),
        sizeBytes: 4n,
        contentType: 'image/png',
        chunkCount: 1,
        expiresAt: BLOB_EXPIRES_AT,
      },
    });
    const receipt = await db.receiptDocument.create({
      data: {
        companyId: company.id,
        blobId: blob.id,
        originalFilename: 'bounded.png',
        contentType: 'image/png',
        sizeBytes: 4n,
        sha256: 'f'.repeat(64),
        sourceKind: 'WEB_UPLOAD',
        status: 'READY',
        generation: 30,
      },
    });
    for (let generation = 1; generation <= 30; generation += 1) {
      const job = await db.receiptProcessingJob.create({
        data: {
          documentId: receipt.id,
          companyId: company.id,
          generation,
          configVersion: 'f'.repeat(64),
          status: 'completed',
          dueAt: new Date(),
        },
      });
      await db.receiptExtractionAttempt.create({
        data: {
          jobId: job.id,
          documentId: receipt.id,
          generation,
          attemptCount: 1,
          status: 'succeeded',
          model: 'synthetic/model',
          promptVersion: 'synthetic-v1',
          schemaVersion: 'synthetic-v1',
          completedAt: new Date(),
        },
      });
    }
    await db.receiptEvent.createMany({
      data: Array.from({ length: 120 }, (_, index) => ({
        companyId: company.id,
        documentId: receipt.id,
        action: `synthetic-${index}`,
      })),
    });

    const detail = await getReceiptDetail(company.id, receipt.id);

    expect(detail.attempts).toHaveLength(25);
    expect(detail.events).toHaveLength(100);
    expect(detail.attempts[0]?.generation).toBe(30);
  });
});
