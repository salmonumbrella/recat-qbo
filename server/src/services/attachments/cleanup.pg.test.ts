import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runAttachmentCleanup } from './cleanup.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;

describePostgres('attachment cleanup on PostgreSQL', () => {
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

  async function company() {
    const row = await db.company.create({
      data: {
        realmId: `attachment-cleanup-${randomUUID()}`,
        legalName: 'Attachment Cleanup Fixture',
        nickname: 'Cleanup Fixture',
      },
    });
    companyIds.add(row.id);
    return row;
  }

  it('bounds expired grants and abandoned provisional blobs per pass', async () => {
    const fixture = await company();
    const expiredAt = new Date('2026-07-29T00:00:00.000Z');
    await db.attachmentUploadGrant.createMany({
      data: Array.from({ length: 101 }, (_, index) => ({
        tokenHash: index.toString(16).padStart(64, '0'),
        actorKey: 'session:cleanup',
        companyId: fixture.id,
        maxFileCount: 1,
        maxBytes: 1000n,
        expiresAt: expiredAt,
      })),
    });
    await db.attachmentBlob.createMany({
      data: Array.from({ length: 26 }, () => ({
        companyId: fixture.id,
        state: 'STAGING' as const,
        expiresAt: expiredAt,
      })),
    });

    const result = await runAttachmentCleanup({
      now: new Date('2026-07-30T00:00:00.000Z'),
    }, { db });

    expect(result).toMatchObject({ grants: 100, staging: 25 });
    await expect(db.attachmentUploadGrant.count({
      where: { companyId: fixture.id },
    })).resolves.toBe(1);
    await expect(db.attachmentBlob.count({
      where: { companyId: fixture.id, state: 'STAGING' },
    })).resolves.toBe(1);
  });

  it('preserves active, READY, and referenced blobs while collecting only safe candidates', async () => {
    const fixture = await company();
    const now = new Date('2026-07-30T00:00:00.000Z');
    const active = await db.attachmentBlob.create({
      data: {
        companyId: fixture.id,
        state: 'STAGING',
        expiresAt: new Date('2026-07-31T00:00:00.000Z'),
      },
    });
    const referenced = await db.attachmentBlob.create({
      data: {
        companyId: fixture.id,
        state: 'READY',
        sha256: 'a'.repeat(64),
        sizeBytes: 10n,
        contentType: 'application/pdf',
        chunkCount: 1,
      },
    });
    await db.stagedAttachment.create({
      data: {
        companyId: fixture.id,
        actorKey: 'session:cleanup',
        blobId: referenced.id,
        originalFilename: 'fixture.pdf',
        contentType: 'application/pdf',
        sizeBytes: 10n,
        sourceKind: 'LOCAL_UPLOAD',
        retainLocally: true,
        expiresAt: new Date('2026-07-31T00:00:00.000Z'),
      },
    });
    const unreferenced = await db.attachmentBlob.create({
      data: {
        companyId: fixture.id,
        state: 'READY',
        sha256: 'b'.repeat(64),
        sizeBytes: 10n,
        contentType: 'application/pdf',
        chunkCount: 1,
      },
    });

    const result = await runAttachmentCleanup({ now }, { db });

    expect(result.blobs).toBe(1);
    await expect(db.attachmentBlob.findMany({
      where: { id: { in: [active.id, referenced.id, unreferenced.id] } },
      orderBy: { id: 'asc' },
      select: { id: true },
    })).resolves.toEqual(
      [{ id: active.id }, { id: referenced.id }].sort((a, b) => a.id.localeCompare(b.id)),
    );
  });
});
