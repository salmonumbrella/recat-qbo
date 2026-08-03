import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  collectUnreferencedBlobs,
  openAttachmentBlob,
  stageAttachment,
} from './blobStore.js';
import { BLOB_CHUNK_BYTES } from './validation.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;

async function* irregularChunks(content: Uint8Array) {
  const widths = [17, 700_003, 31, 1_200_001, 65_537];
  let offset = 0;
  let index = 0;
  while (offset < content.byteLength) {
    const end = Math.min(content.byteLength, offset + widths[index % widths.length]!);
    yield content.subarray(offset, end);
    offset = end;
    index += 1;
  }
}

function pdfFixture(size: number, fill: number): Uint8Array {
  const content = new Uint8Array(size).fill(fill);
  content.set(new TextEncoder().encode('%PDF-1.7\n'), 0);
  return content;
}

describePostgres('attachment PostgreSQL blob store', () => {
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

  async function createCompany() {
    const company = await db.company.create({
      data: {
        realmId: `attachment-blob-${randomUUID()}`,
        legalName: 'Attachment Blob Fixture',
        nickname: 'Blob Fixture',
      },
    });
    companyIds.add(company.id);
    return company;
  }

  function stage(
    companyId: string,
    content: Uint8Array,
    actorKey = `user:${randomUUID()}`,
  ) {
    return stageAttachment({
      companyId,
      actorKey,
      sourceKind: 'LOCAL_UPLOAD',
      retainLocally: true,
      filename: 'receipt.pdf',
      declaredContentType: 'application/pdf',
      content: irregularChunks(content),
      expiresAt: new Date(Date.now() + 60_000),
    }, { db });
  }

  it('streams a 2.5 MiB file into ordered chunks no larger than one MiB', async () => {
    const company = await createCompany();
    const content = pdfFixture(BLOB_CHUNK_BYTES * 2 + BLOB_CHUNK_BYTES / 2, 7);
    const staged = await stage(company.id, content);
    const row = await db.stagedAttachment.findUniqueOrThrow({
      where: { id: staged.id },
      select: { blobId: true },
    });
    const chunks = await db.attachmentBlobChunk.findMany({
      where: { blobId: row.blobId },
      orderBy: { ordinal: 'asc' },
    });

    expect(chunks.map((chunk) => chunk.ordinal)).toEqual([0, 1, 2]);
    expect(chunks.map((chunk) => chunk.content.byteLength)).toEqual([
      BLOB_CHUNK_BYTES,
      BLOB_CHUNK_BYTES,
      BLOB_CHUNK_BYTES / 2,
    ]);

    const reader = await openAttachmentBlob(company.id, row.blobId, { db });
    const streamed: Buffer[] = [];
    for await (const chunk of reader.chunks()) streamed.push(Buffer.from(chunk));
    expect(Buffer.concat(streamed)).toEqual(Buffer.from(content));
  }, 30_000);

  it('deduplicates concurrent identical files per company but not across companies', async () => {
    const firstCompany = await createCompany();
    const secondCompany = await createCompany();
    const content = pdfFixture(256_000, 11);

    const [first, second] = await Promise.all([
      stage(firstCompany.id, content),
      stage(firstCompany.id, content),
    ]);
    const acrossCompany = await stage(secondCompany.id, content);

    expect(first.sha256).toBe(second.sha256);
    expect(acrossCompany.sha256).toBe(first.sha256);
    await expect(db.attachmentBlob.count({
      where: { companyId: firstCompany.id, state: 'READY' },
    })).resolves.toBe(1);
    await expect(db.attachmentBlob.count({
      where: { companyId: secondCompany.id, state: 'READY' },
    })).resolves.toBe(1);
  });

  it('garbage-collects only blobs whose staged and transaction references are gone', async () => {
    const company = await createCompany();
    const staged = await stage(company.id, pdfFixture(4096, 19));

    await expect(collectUnreferencedBlobs(10, { db })).resolves.toBe(0);
    await db.stagedAttachment.delete({ where: { id: staged.id } });
    await expect(collectUnreferencedBlobs(10, { db })).resolves.toBe(1);
  });
});
