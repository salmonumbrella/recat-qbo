import { describe, expect, it } from 'vitest';
import type { VoyageEmbeddingClient } from './client.js';
import { classificationEmbeddingGeneration, createClassificationSearchDocument } from './recipe.js';
import {
  reconcileClassificationEmbeddings,
  runClassificationEmbeddingTick,
} from './reconciler.js';
import type { ClassificationEmbeddingStore } from './vectorStore.js';

function document(sourceId: string, value: string) {
  return createClassificationSearchDocument({
    companyId: 'company-a',
    kind: 'classification_case',
    sourceId,
    revisedAt: '2026-08-31T00:00:00.000Z',
    fields: [['rationale', value]],
  });
}

function vector(seed: number): number[] {
  return Array.from({ length: 1024 }, (_unused, index) => index === seed ? 1 : 0);
}

const generation = classificationEmbeddingGeneration({
  baseUrl: 'https://api.voyageai.com/v1',
  fingerprintSalt: 'synthetic-current-generation',
});

describe('classification embedding reconciliation', () => {
  it('publishes one complete company generation only after every chunk is embedded', async () => {
    const events: string[] = [];
    const published: unknown[] = [];
    const client: VoyageEmbeddingClient = {
      async embedDocuments(inputs) {
        events.push(`embed:${inputs.length}`);
        return inputs.map((_input, index) => vector(index));
      },
      async embedQuery() {
        throw new Error('not used');
      },
    };
    const store: ClassificationEmbeddingStore = {
      async ensureAvailable() {
        events.push('available');
        return { available: true, reason: null };
      },
      async publishGeneration(input) {
        events.push('publish');
        published.push(input);
      },
      async recordFailure() {
        events.push('failure');
      },
    };

    const result = await reconcileClassificationEmbeddings({
      companyId: 'company-a',
      documents: [document('case-a', 'Office meals'), document('case-b', 'Inventory freight')],
      generation: classificationEmbeddingGeneration({
        baseUrl: 'https://api.voyageai.com/v1',
        fingerprintSalt: 'synthetic',
      }),
      client,
      store,
    });

    expect(events).toEqual(['available', 'embed:2', 'publish']);
    expect(result).toMatchObject({ status: 'published', embedded: 2, skipped: 0, backlog: 0 });
    expect(published).toEqual([
      expect.objectContaining({
        companyId: 'company-a',
        totalDocuments: 2,
        skippedDocuments: 0,
        chunks: [
          expect.objectContaining({ documentId: 'classification_case:case-a', embedding: vector(0) }),
          expect.objectContaining({ documentId: 'classification_case:case-b', embedding: vector(1) }),
        ],
      }),
    ]);
  });

  it('keeps the prior generation active and records a bounded failure when embedding fails', async () => {
    const events: unknown[] = [];
    const client: VoyageEmbeddingClient = {
      async embedDocuments() {
        throw new Error('provider body with private tenant data');
      },
      async embedQuery() {
        throw new Error('not used');
      },
    };
    const store: ClassificationEmbeddingStore = {
      async ensureAvailable() {
        return { available: true, reason: null };
      },
      async publishGeneration() {
        events.push('published');
      },
      async recordFailure(input) {
        events.push(input);
      },
    };

    const result = await reconcileClassificationEmbeddings({
      companyId: 'company-a',
      documents: [document('case-a', 'Office meals')],
      generation: classificationEmbeddingGeneration({
        baseUrl: 'https://api.voyageai.com/v1',
        fingerprintSalt: 'synthetic',
      }),
      client,
      store,
    });

    expect(result).toMatchObject({ status: 'failed', error: 'semantic_error' });
    expect(events).toEqual([
      expect.objectContaining({ errorCode: 'semantic_error', embeddedDocuments: 0 }),
    ]);
    expect(JSON.stringify(events)).not.toContain('private tenant data');
  });

  it('does not contact Voyage when pgvector is unavailable', async () => {
    let providerCalls = 0;
    const result = await reconcileClassificationEmbeddings({
      companyId: 'company-a',
      documents: [document('case-a', 'Office meals')],
      generation: classificationEmbeddingGeneration({
        baseUrl: 'https://api.voyageai.com/v1',
        fingerprintSalt: 'synthetic',
      }),
      client: {
        async embedDocuments() {
          providerCalls += 1;
          return [vector(0)];
        },
        async embedQuery() {
          return vector(0);
        },
      },
      store: {
        async ensureAvailable() {
          return { available: false, reason: 'vector_capability_unavailable' };
        },
        async publishGeneration() {},
        async recordFailure() {},
      },
    });

    expect(result).toEqual({
      status: 'unavailable',
      embedded: 0,
      skipped: 0,
      backlog: 1,
      error: 'vector_capability_unavailable',
    });
    expect(providerCalls).toBe(0);
  });

  it('reuses active same-generation chunks and embeds only changed documents', async () => {
    const first = document('case-a', 'Unchanged office meals');
    const second = document('case-b', 'Changed inventory freight');
    const existing = [
      {
        companyId: 'company-a',
        documentId: first.id,
        kind: first.kind,
        sourceId: first.sourceId,
        revisedAt: first.revisedAt,
        chunkIndex: first.chunks[0]!.index,
        contentHash: first.chunks[0]!.contentHash,
        embedding: vector(7),
      },
      {
        companyId: 'company-a',
        documentId: second.id,
        kind: second.kind,
        sourceId: second.sourceId,
        revisedAt: second.revisedAt,
        chunkIndex: second.chunks[0]!.index,
        contentHash: '0'.repeat(64),
        embedding: vector(8),
      },
    ];
    const providerInputs: string[] = [];
    let published: readonly { documentId: string; embedding: readonly number[] }[] = [];

    const result = await reconcileClassificationEmbeddings({
      companyId: 'company-a',
      documents: [first, second],
      generation,
      client: {
        async embedDocuments(inputs) {
          providerInputs.push(...inputs);
          return inputs.map(() => vector(9));
        },
        async embedQuery() { return vector(0); },
      },
      store: {
        async ensureAvailable() { return { available: true, reason: null }; },
        async currentChunks() { return existing; },
        async publishGeneration(input) { published = input.chunks; },
        async recordFailure() {},
      },
    });

    expect(result).toMatchObject({ status: 'published', embedded: 1, backlog: 0 });
    expect(providerInputs).toEqual([second.chunks[0]!.text]);
    expect(published).toEqual(expect.arrayContaining([
      expect.objectContaining({ documentId: first.id, embedding: vector(7) }),
      expect.objectContaining({ documentId: second.id, embedding: vector(9) }),
    ]));
  });

  it('keeps the background tick inert when the dedicated provider is unconfigured', async () => {
    let companyReads = 0;
    const result = await runClassificationEmbeddingTick({
      runtimeConfig: () => null,
      async listCompanyIds() { companyReads += 1; return ['company-a']; },
      async documents() { return []; },
      createClient() { throw new Error('not called'); },
      createStore() { throw new Error('not called'); },
      reconcile: reconcileClassificationEmbeddings,
    });

    expect(result).toEqual({
      configured: false,
      processed: 0,
      published: 0,
      failed: 0,
      unavailable: 0,
    });
    expect(companyReads).toBe(0);
  });

  it('processes configured companies independently so one failed build does not stop the rest', async () => {
    const seen: string[] = [];
    const result = await runClassificationEmbeddingTick({
      runtimeConfig: () => ({
        apiKey: 'synthetic-key',
        baseUrl: 'https://api.voyageai.com/v1',
        timeoutMs: 1_000,
        batchSize: 2,
        fingerprintSalt: 'synthetic',
      }),
      async listCompanyIds() { return ['company-a', 'company-b']; },
      async documents(companyId) { return [document(`case-${companyId}`, companyId)]; },
      createClient() {
        return {
          async embedDocuments() { return [vector(0)]; },
          async embedQuery() { return vector(0); },
        };
      },
      createStore() {
        return {
          async ensureAvailable() { return { available: true, reason: null }; },
          async publishGeneration() {},
          async recordFailure() {},
        };
      },
      async reconcile(input) {
        seen.push(input.companyId);
        return input.companyId === 'company-a'
          ? { status: 'published', embedded: 1, skipped: 0, backlog: 0, error: null }
          : { status: 'failed', embedded: 0, skipped: 0, backlog: 1, error: 'semantic_error' };
      },
    });

    expect(seen).toEqual(['company-a', 'company-b']);
    expect(result).toEqual({
      configured: true,
      processed: 2,
      published: 1,
      failed: 1,
      unavailable: 0,
    });
  });
});
