import { describe, expect, it } from 'vitest';
import { classificationEmbeddingGeneration } from './recipe.js';
import { classificationSemanticHealth } from './health.js';

const generation = classificationEmbeddingGeneration({
  baseUrl: 'https://api.voyageai.com/v1',
  fingerprintSalt: 'synthetic',
});

describe('classification semantic health', () => {
  it('reports an unconfigured provider without touching optional vector tables', async () => {
    let vectorCalls = 0;
    const result = await classificationSemanticHealth('company-a', {
      generation: null,
      store: {
        async ensureAvailable() { vectorCalls += 1; return { available: true, reason: null }; },
        async health() { throw new Error('not called'); },
      },
    });

    expect(result).toEqual({
      configured: false,
      provider: 'voyage',
      model: 'voyage-4-large',
      dimensions: 1024,
      vectorAvailable: false,
      expectedGeneration: null,
      activeGeneration: null,
      embedded: 0,
      skipped: 0,
      backlog: 0,
      progress: 0,
      lastSuccessAt: null,
      lastError: null,
    });
    expect(vectorCalls).toBe(0);
  });

  it('reports capability degradation and healthy generation state without provider details', async () => {
    const unavailable = await classificationSemanticHealth('company-a', {
      generation,
      store: {
        async ensureAvailable() { return { available: false, reason: 'vector_capability_unavailable' }; },
        async health() { throw new Error('not called'); },
      },
    });
    expect(unavailable).toMatchObject({
      configured: true,
      vectorAvailable: false,
      expectedGeneration: generation.fingerprint,
      activeGeneration: null,
      lastError: 'vector_capability_unavailable',
    });

    const healthy = await classificationSemanticHealth('company-a', {
      generation,
      store: {
        async ensureAvailable() { return { available: true, reason: null }; },
        async health() {
          return {
            activeGeneration: generation.fingerprint,
            embedded: 8,
            skipped: 1,
            backlog: 1,
            progress: 0.9,
            lastSuccessAt: '2026-08-31T00:00:00.000Z',
            lastError: null,
          };
        },
      },
    });
    expect(healthy).toMatchObject({
      configured: true,
      vectorAvailable: true,
      embedded: 8,
      skipped: 1,
      backlog: 1,
      progress: 0.9,
      lastError: null,
    });
  });
});
