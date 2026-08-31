import { describe, expect, it } from 'vitest';
import type { ClassificationSearchHit } from '@recat/shared';
import {
  ClassificationSearchError,
  searchClassificationMemory,
  type ClassificationSearchRecord,
  type ClassificationSearchRepository,
} from './search.js';
import { classificationEmbeddingGeneration } from './embedding/recipe.js';

function hit(overrides: Partial<ClassificationSearchHit> = {}): ClassificationSearchHit {
  return {
    id: 'vendor_alias:alias-a',
    sourceId: 'alias-a',
    kind: 'vendor_alias',
    companyId: 'company-a',
    companyName: 'Company A',
    companyRelation: 'current',
    executable: false,
    advisory: true,
    matchedIn: [],
    score: 0,
    vendorIdentityId: 'vendor-a',
    vendorName: 'Coach Calgary',
    action: null,
    actionSummary: null,
    originIntent: null,
    evidenceCount: 0,
    conflictingEvidenceCount: 0,
    conflicts: [],
    provenance: {
      source: 'user',
      sourceId: 'alias-a',
      actorId: null,
      recordedAt: '2026-08-31T00:00:00.000Z',
    },
    rationale: null,
    examples: [],
    counterexamples: [],
    jurisdiction: null,
    currency: null,
    verifiedAt: null,
    ruleRevision: null,
    ...overrides,
  };
}

function record(
  value: Partial<ClassificationSearchRecord> & { hit?: Partial<ClassificationSearchHit> } = {},
): ClassificationSearchRecord {
  return {
    hit: hit(value.hit),
    revisedAt: '2026-08-31T00:00:00.000Z',
    lexicalScore: 0.8,
    exactReasons: ['alias'],
    ...value,
    ...(value.hit ? { hit: hit(value.hit) } : {}),
  };
}

function repository(records: ClassificationSearchRecord[]): ClassificationSearchRepository {
  return {
    async search() {
      return records;
    },
    async rehydrate(_companyIds, ids) {
      return records.filter((candidate) => ids.includes(candidate.hit.id));
    },
    async documents() {
      return { documents: [], totalDocuments: 0, skippedDocuments: 0 };
    },
  };
}

const generation = classificationEmbeddingGeneration({
  baseUrl: 'https://api.voyageai.com/v1',
  fingerprintSalt: 'synthetic',
});

describe('classification memory search', () => {
  it('returns immediately consistent exact and lexical matches without semantic configuration', async () => {
    const records = [
      record(),
      record({
        hit: {
          id: 'rule:rule-a',
          sourceId: 'rule-a',
          kind: 'rule',
          vendorIdentityId: null,
          vendorName: 'Coach Calgary',
        },
        exactReasons: ['rule'],
        lexicalScore: 0.7,
      }),
    ];

    const result = await searchClassificationMemory({
      query: 'Coach Calgary',
      companyId: 'company-a',
      scope: 'current_company',
      mode: 'lexical',
      limit: 10,
      accessibleCompanyIds: ['company-a'],
    }, { repository: repository(records), semantic: null });

    expect(result).toMatchObject({
      requestedMode: 'lexical',
      mode: 'lexical',
      degraded: false,
      status: 'matched',
      total: 2,
    });
    expect(result.hits[0]?.matchedIn).toEqual(expect.arrayContaining(['alias', 'lexical']));
    expect(result.hits[1]?.matchedIn).toEqual(expect.arrayContaining(['rule', 'lexical']));
  });

  it('never lets a requested company escape the caller accessibility fence', async () => {
    const calls: string[][] = [];
    const repo: ClassificationSearchRepository = {
      async search(companyIds) {
        calls.push([...companyIds]);
        return [record()];
      },
      async rehydrate() {
        return [];
      },
      async documents() {
        return { documents: [], totalDocuments: 0, skippedDocuments: 0 };
      },
    };

    await searchClassificationMemory({
      query: 'Coach',
      companyId: 'company-a',
      scope: 'accessible_companies',
      mode: 'exact',
      limit: 10,
      accessibleCompanyIds: ['company-a', 'company-b', 'company-b'],
    }, { repository: repo, semantic: null });

    expect(calls).toEqual([['company-a', 'company-b']]);
    await expect(searchClassificationMemory({
      query: 'Coach',
      companyId: 'company-x',
      scope: 'current_company',
      mode: 'exact',
      limit: 10,
      accessibleCompanyIds: ['company-a'],
    }, { repository: repo, semantic: null })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('labels auto fallback while explicit semantic and hybrid fail closed', async () => {
    const auto = await searchClassificationMemory({
      query: 'Coach',
      companyId: 'company-a',
      scope: 'current_company',
      mode: 'auto',
      limit: 10,
      accessibleCompanyIds: ['company-a'],
    }, { repository: repository([record()]), semantic: null });

    expect(auto).toMatchObject({
      requestedMode: 'auto',
      mode: 'lexical',
      degraded: true,
      degradedReason: 'embedding_not_configured',
    });
    for (const mode of ['semantic', 'hybrid'] as const) {
      const failure = await searchClassificationMemory({
        query: 'Coach',
        companyId: 'company-a',
        scope: 'current_company',
        mode,
        limit: 10,
        accessibleCompanyIds: ['company-a'],
      }, { repository: repository([record()]), semantic: null }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ClassificationSearchError);
      expect(failure).toMatchObject({ code: 'SEMANTIC_UNAVAILABLE' });
    }
  });

  it('does not rank an active generation while its expected corpus is stale or failed', async () => {
    let providerCalls = 0;
    const semantic = {
      generation,
      client: {
        async embedDocuments() { throw new Error('not used'); },
        async embedQuery() { providerCalls += 1; return Array.from({ length: 1024 }, () => 0); },
      },
      store: {
        async ensureAvailable() { return { available: true as const, reason: null }; },
        async health() {
          return {
            activeGeneration: generation.fingerprint,
            expectedGeneration: generation.fingerprint,
            expectedState: 'failed',
            embedded: 8,
            skipped: 0,
            backlog: 1,
            progress: 8 / 9,
            lastSuccessAt: '2026-08-31T00:00:00.000Z',
            lastError: 'semantic_error',
            latestAttemptGeneration: generation.fingerprint,
            latestAttemptState: 'failed',
            latestAttemptAt: '2026-08-31T00:01:00.000Z',
            latestAttemptError: 'semantic_error',
          };
        },
        async search() { throw new Error('must not rank stale vectors'); },
      },
    };
    const input = {
      query: 'Coach',
      companyId: 'company-a',
      scope: 'current_company' as const,
      limit: 10,
      accessibleCompanyIds: ['company-a'],
    };

    await expect(searchClassificationMemory(
      { ...input, mode: 'auto' },
      { repository: repository([record()]), semantic },
    )).resolves.toMatchObject({
      mode: 'lexical',
      degraded: true,
      degradedReason: 'semantic_unavailable',
    });
    await expect(searchClassificationMemory(
      { ...input, mode: 'semantic' },
      { repository: repository([record()]), semantic },
    )).rejects.toMatchObject({ code: 'SEMANTIC_UNAVAILABLE' });
    expect(providerCalls).toBe(0);
  });

  it('runs hybrid legs concurrently, rolls up chunks, and drops stale semantic documents on rehydration', async () => {
    const current = record({ exactReasons: [], lexicalScore: 0.7 });
    let lexicalStarted = false;
    let semanticStarted = false;
    let release!: () => void;
    const bothStarted = new Promise<void>((resolve) => { release = resolve; });
    const repo: ClassificationSearchRepository = {
      async search() {
        lexicalStarted = true;
        if (semanticStarted) release();
        await bothStarted;
        return [current];
      },
      async rehydrate(_companyIds, ids) {
        return ids.includes(current.hit.id) ? [current] : [];
      },
      async documents() {
        return { documents: [], totalDocuments: 0, skippedDocuments: 0 };
      },
    };
    const result = await searchClassificationMemory({
      query: 'luxury inventory',
      companyId: 'company-a',
      scope: 'current_company',
      mode: 'hybrid',
      limit: 10,
      accessibleCompanyIds: ['company-a'],
    }, {
      repository: repo,
      semantic: {
        generation,
        client: {
          async embedDocuments() { throw new Error('not used'); },
          async embedQuery() { return Array.from({ length: 1024 }, () => 0); },
        },
        store: {
          async ensureAvailable() { return { available: true, reason: null }; },
          async health() {
            return {
              activeGeneration: generation.fingerprint,
              expectedGeneration: generation.fingerprint,
              expectedState: 'succeeded',
              embedded: 1,
              skipped: 0,
              backlog: 0,
              progress: 1,
              lastSuccessAt: '2026-08-31T00:00:00.000Z',
              lastError: null,
              latestAttemptGeneration: generation.fingerprint,
              latestAttemptState: 'succeeded',
              latestAttemptAt: '2026-08-31T00:00:00.000Z',
              latestAttemptError: null,
            };
          },
          async search() {
            semanticStarted = true;
            if (lexicalStarted) release();
            return [
              { documentId: current.hit.id, companyId: 'company-a', kind: 'vendor_alias', sourceId: 'alias-a', revisedAt: current.revisedAt, similarity: 0.91 },
              { documentId: current.hit.id, companyId: 'company-a', kind: 'vendor_alias', sourceId: 'alias-a', revisedAt: current.revisedAt, similarity: 0.89 },
              { documentId: 'classification_case:deleted', companyId: 'company-a', kind: 'classification_case', sourceId: 'deleted', revisedAt: current.revisedAt, similarity: 0.99 },
            ];
          },
        },
      },
    });

    expect(result.mode).toBe('hybrid');
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.matchedIn).toEqual(expect.arrayContaining(['lexical', 'semantic']));
  });

  it('bounds database failures without exposing connection or tenant details', async () => {
    const secret = 'postgresql://private-host/tenant-a';
    const repo: ClassificationSearchRepository = {
      async search() { throw new Error(secret); },
      async rehydrate() { throw new Error(secret); },
      async documents() { throw new Error(secret); },
    };

    const failure = await searchClassificationMemory({
      query: 'Coach',
      companyId: 'company-a',
      scope: 'current_company',
      mode: 'lexical',
      accessibleCompanyIds: ['company-a'],
    }, { repository: repo, semantic: null }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ClassificationSearchError);
    expect(failure).toMatchObject({ code: 'COMPANY_UNAVAILABLE' });
    expect(String(failure)).not.toContain(secret);
    expect(JSON.stringify(failure)).not.toContain('private-host');
  });
});
