import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { classificationEmbeddingGeneration } from './recipe.js';
import { PgClassificationVectorStore } from './vectorStore.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const TEST_PGVECTOR_DATABASE_URL = process.env.TEST_PGVECTOR_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;
const describePgvector = TEST_PGVECTOR_DATABASE_URL ? describe : describe.skip;

function vector(seed: number): number[] {
  return Array.from({ length: 1024 }, (_unused, index) => index === seed ? 1 : 0);
}

describePostgres('classification vector store on vanilla PostgreSQL', () => {
  let db: PrismaClient;

  beforeAll(() => {
    db = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL! } } });
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  it('reports pgvector unavailable without creating an extension or derived tables', async () => {
    const store = new PgClassificationVectorStore(db);

    await expect(store.ensureAvailable()).resolves.toEqual({
      available: false,
      reason: 'vector_capability_unavailable',
    });
    await expect(db.$queryRaw<Array<{ present: boolean }>>`
      SELECT to_regclass('public."ClassificationEmbeddingChunk"') IS NOT NULL AS present
    `).resolves.toEqual([{ present: false }]);
  });
});

describePgvector('classification vector store on PostgreSQL with pgvector', () => {
  let db: PrismaClient;
  const companyIds = new Set<string>();

  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: TEST_PGVECTOR_DATABASE_URL! } } });
    await db.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS vector');
  });

  afterEach(async () => {
    const ids = [...companyIds];
    companyIds.clear();
    if (ids.length > 0) await db.company.deleteMany({ where: { id: { in: ids } } });
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  async function company(name: string) {
    const created = await db.company.create({
      data: {
        realmId: `vector-${randomUUID()}`,
        legalName: `${name} Legal`,
        nickname: name,
      },
    });
    companyIds.add(created.id);
    return created;
  }

  it('publishes atomically, fences companies, and never ranks a retired generation', async () => {
    const first = await company('Vector Company A');
    const second = await company('Vector Company B');
    const store = new PgClassificationVectorStore(db);
    await expect(store.ensureAvailable()).resolves.toEqual({ available: true, reason: null });
    const oldGeneration = classificationEmbeddingGeneration({
      baseUrl: 'https://api.voyageai.com/v1',
      fingerprintSalt: 'old-synthetic-generation',
    });
    const newGeneration = classificationEmbeddingGeneration({
      baseUrl: 'https://api.voyageai.com/v1',
      fingerprintSalt: 'new-synthetic-generation',
    });
    await store.publishGeneration({
      companyId: first.id,
      generation: oldGeneration,
      totalDocuments: 1,
      skippedDocuments: 0,
      chunks: [{
        companyId: first.id,
        documentId: 'classification_case:old-a',
        kind: 'classification_case',
        sourceId: 'old-a',
        revisedAt: '2026-08-30T00:00:00.000Z',
        chunkIndex: 0,
        contentHash: 'a'.repeat(64),
        embedding: vector(0),
      }],
    });
    await store.publishGeneration({
      companyId: second.id,
      generation: newGeneration,
      totalDocuments: 1,
      skippedDocuments: 0,
      chunks: [{
        companyId: second.id,
        documentId: 'classification_case:new-b',
        kind: 'classification_case',
        sourceId: 'new-b',
        revisedAt: '2026-08-31T00:00:00.000Z',
        chunkIndex: 0,
        contentHash: 'b'.repeat(64),
        embedding: vector(0),
      }],
    });
    await store.publishGeneration({
      companyId: first.id,
      generation: newGeneration,
      totalDocuments: 1,
      skippedDocuments: 0,
      chunks: [{
        companyId: first.id,
        documentId: 'classification_case:new-a',
        kind: 'classification_case',
        sourceId: 'new-a',
        revisedAt: '2026-08-31T00:00:00.000Z',
        chunkIndex: 0,
        contentHash: 'c'.repeat(64),
        embedding: vector(0),
      }],
    });

    await expect(store.search({
      companyIds: [first.id],
      fingerprint: oldGeneration.fingerprint,
      embedding: vector(0),
      cosineFloor: 0.8,
      limit: 10,
    })).resolves.toEqual([]);
    const current = await store.search({
      companyIds: [first.id],
      fingerprint: newGeneration.fingerprint,
      embedding: vector(0),
      cosineFloor: 0.8,
      limit: 10,
    });
    expect(current).toEqual([
      expect.objectContaining({ documentId: 'classification_case:new-a', companyId: first.id, similarity: 1 }),
    ]);
    expect(current.some((hit) => hit.companyId === second.id)).toBe(false);
    await expect(store.health(first.id)).resolves.toMatchObject({
      activeGeneration: newGeneration.fingerprint,
      embedded: 1,
      skipped: 0,
      backlog: 0,
      progress: 1,
      lastError: null,
    });
  });

  it('leaves the active generation readable when a replacement vector is invalid', async () => {
    const owner = await company('Vector Failure Company');
    const store = new PgClassificationVectorStore(db);
    await store.ensureAvailable();
    const active = classificationEmbeddingGeneration({
      baseUrl: 'https://api.voyageai.com/v1',
      fingerprintSalt: 'active-synthetic-generation',
    });
    const replacement = classificationEmbeddingGeneration({
      baseUrl: 'https://api.voyageai.com/v1',
      fingerprintSalt: 'replacement-synthetic-generation',
    });
    await store.publishGeneration({
      companyId: owner.id,
      generation: active,
      totalDocuments: 1,
      skippedDocuments: 0,
      chunks: [{
        companyId: owner.id,
        documentId: 'rule:active',
        kind: 'rule',
        sourceId: 'active',
        revisedAt: '2026-08-31T00:00:00.000Z',
        chunkIndex: 0,
        contentHash: 'd'.repeat(64),
        embedding: vector(1),
      }],
    });
    await expect(store.publishGeneration({
      companyId: owner.id,
      generation: replacement,
      totalDocuments: 1,
      skippedDocuments: 0,
      chunks: [{
        companyId: owner.id,
        documentId: 'rule:replacement',
        kind: 'rule',
        sourceId: 'replacement',
        revisedAt: '2026-08-31T00:00:00.000Z',
        chunkIndex: 0,
        contentHash: 'e'.repeat(64),
        embedding: [1, 2],
      }],
    })).rejects.toMatchObject({ code: 'INVALID_VECTOR' });
    await expect(store.health(owner.id)).resolves.toMatchObject({
      activeGeneration: active.fingerprint,
    });
  });
});
