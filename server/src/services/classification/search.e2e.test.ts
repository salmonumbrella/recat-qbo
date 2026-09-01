import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterEach, describe, expect, it } from 'vitest';
import { createCompanyReadService } from '../companyReads.js';
import {
  commitRuleChange,
  prepareRuleChange,
  type RuleChangePrincipal,
} from '../ruleChanges.js';
import {
  ClassificationSearchError,
  PrismaClassificationSearchRepository,
  searchClassificationMemory,
} from './search.js';
import { createVoyageEmbeddingClient } from './embedding/client.js';
import { classificationEmbeddingGeneration } from './embedding/recipe.js';
import { reconcileClassificationEmbeddings } from './embedding/reconciler.js';
import { PgClassificationVectorStore } from './embedding/vectorStore.js';
import {
  startDeterministicEmbeddingFixture,
  type DeterministicEmbeddingFixture,
} from '../../test/deterministicEmbeddingFixture.js';

describe('classification memory deterministic end-to-end fixture', () => {
  const fixtures: DeterministicEmbeddingFixture[] = [];

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
  });

  it('maps fixed accounting topics to stable literal unit vectors', async () => {
    const fixture = await startDeterministicEmbeddingFixture('a');
    fixtures.push(fixture);
    const client = createVoyageEmbeddingClient({
      apiKey: 'synthetic-local-only',
      baseUrl: fixture.baseUrl,
      batchSize: 8,
      timeoutMs: 2_000,
    });

    const vectors = await client.embedDocuments([
      'Fleet propellant expenditure',
      'Owner gift-card reimbursement',
      'Wholesale stock for resale goods',
      'Team lunch at a restaurant',
    ]);

    expect(vectors.map((vector) => vector.findIndex((component) => component === 1)))
      .toEqual([0, 1, 2, 3]);
    expect(vectors.every((vector) => vector.reduce((sum, value) => sum + value * value, 0) === 1))
      .toBe(true);
    expect(fixture.requests).toEqual([{
      method: 'POST',
      path: '/v1/embeddings',
      inputType: 'document',
      inputs: [
        'Fleet propellant expenditure',
        'Owner gift-card reimbursement',
        'Wholesale stock for resale goods',
        'Team lunch at a restaurant',
      ],
      topics: ['fuel', 'personal', 'inventory', 'meals'],
    }]);
  });
});

const TASK8_DATABASE_URL = process.env.TEST_PGVECTOR_DATABASE_URL;
const describeTask8 = TASK8_DATABASE_URL ? describe.sequential : describe.skip;
const NOW = new Date('2026-09-01T12:00:00.000Z');

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function newClient(): PrismaClient {
  return new PrismaClient({ datasources: { db: { url: TASK8_DATABASE_URL! } } });
}

async function createVerifiedCase(
  db: PrismaClient,
  input: {
    companyId: string;
    transactionId: string;
    vendorIdentityId: string;
    categoryQboId: string;
    rationale: string;
    examples: string[];
    counterexamples: string[];
    jurisdiction?: string;
  },
) {
  const transaction = await db.transaction.findUniqueOrThrow({ where: { id: input.transactionId } });
  const requestId = `task8-${randomUUID()}`;
  const attempt = await db.qboMutationAttempt.create({
    data: {
      transactionId: transaction.id,
      requestId,
      operation: 'recategorize',
      status: 'VERIFIED',
      expectedRevision: transaction.revision,
      expectedSyncToken: transaction.qboSyncToken,
      requestHash: digest(requestId),
      requestPayload: {},
      beforeSnapshot: {},
      verification: { outcome: 'VERIFIED', status: 'POSTED' },
    },
  });
  const action = {
    categoryQboId: input.categoryQboId,
    taxCalculation: 'NotApplicable',
    taxCodeQboId: null,
    tagIds: [],
  } as const;
  return db.classificationCase.create({
    data: {
      companyId: input.companyId,
      transactionId: transaction.id,
      vendorIdentityId: input.vendorIdentityId,
      qboMutationAttemptId: attempt.id,
      action,
      actionFingerprint: digest(JSON.stringify(action)),
      originIntent: 'apply_once',
      rationale: input.rationale,
      requiredEvidence: ['Synthetic receipt and fleet purpose'],
      examples: input.examples,
      counterexamples: input.counterexamples,
      citations: [],
      reviewer: { userId: null, configVersion: 'task8-e2e-v1', decision: 'approved' },
      jurisdiction: input.jurisdiction ?? 'CA-BC',
      currency: 'CAD',
      context: {
        transactionDirection: 'out',
        qboType: 'Purchase',
        sourceAccountName: 'Synthetic operating card',
        businessPurpose: input.rationale,
      },
      provenance: {
        source: 'qbo_verified',
        sourceId: requestId,
        actorId: null,
        recordedAt: NOW.toISOString(),
      },
      transactionSnapshot: {
        schemaVersion: 'classification-case/v1',
        transactionId: transaction.id,
        transactionRevision: transaction.revision,
        qboType: transaction.qboType,
        qboId: transaction.qboId,
        date: transaction.date.toISOString(),
        amountCents: Number(transaction.amount) * 100,
        currency: 'CAD',
        payee: transaction.payee,
        memo: transaction.memo,
        sourceAccountName: transaction.bankAccount,
      },
      verifiedAt: NOW,
    },
  });
}

async function seedChevronCompany(db: PrismaClient, nickname = 'Task 8 Current') {
  const suffix = randomUUID();
  const user = await db.user.create({ data: { email: `task8-${suffix}@example.invalid` } });
  const company = await db.company.create({
    data: {
      realmId: `task8-${suffix}`,
      legalName: `${nickname} Legal`,
      nickname,
      taxSupportStatus: 'ready',
      taxUsingSalesTax: true,
    },
  });
  await db.membership.create({ data: { userId: user.id, companyId: company.id, role: 'categorizer' } });
  const session = await db.session.create({
    data: {
      userId: user.id,
      tokenHash: digest(`session-${suffix}`),
      expiresAt: new Date(NOW.getTime() + 60 * 60 * 1000),
    },
  });
  const [fuelAccount, personalAccount] = await Promise.all([
    db.qboAccount.create({ data: {
      companyId: company.id, qboId: `fuel-${suffix}`, name: 'Fleet fuel',
      fullName: 'Expenses · Fleet fuel', classification: 'Expenses',
    } }),
    db.qboAccount.create({ data: {
      companyId: company.id, qboId: `personal-${suffix}`, name: 'Owner reimbursement',
      fullName: 'Expenses · Owner reimbursement', classification: 'Expenses',
    } }),
  ]);
  const vendor = await db.vendorIdentity.create({
    data: {
      companyId: company.id,
      displayName: 'Chevron Mobility',
      normalizedName: 'chevron mobility',
    },
  });
  const alias = await db.vendorAlias.create({
    data: {
      companyId: company.id,
      vendorIdentityId: vendor.id,
      value: 'CHEVRON 00456 VANCOUVER',
      normalizedValue: 'chevron 00456 vancouver',
      source: 'user',
    },
  });
  const transactions = await Promise.all([
    db.transaction.create({ data: {
      companyId: company.id, qboId: `fuel-txn-${suffix}`, qboType: 'Purchase',
      qboSyncToken: '1', date: new Date('2026-08-20T00:00:00.000Z'),
      payee: 'Chevron Fleet Pump', memo: 'Fleet propellant expenditure', amount: '-88.00',
      bankAccount: 'Synthetic operating card', status: 'POSTED', revision: 1,
    } }),
    db.transaction.create({ data: {
      companyId: company.id, qboId: `personal-txn-${suffix}`, qboType: 'Purchase',
      qboSyncToken: '1', date: new Date('2026-08-21T00:00:00.000Z'),
      payee: 'Chevron Convenience Counter', memo: 'Owner gift-card reimbursement', amount: '-25.00',
      bankAccount: 'Synthetic operating card', status: 'POSTED', revision: 1,
    } }),
  ]);
  const fuelCase = await createVerifiedCase(db, {
    companyId: company.id,
    transactionId: transactions[0].id,
    vendorIdentityId: vendor.id,
    categoryQboId: fuelAccount.qboId,
    rationale: 'Fleet propellant expenditure supported by a pump receipt and business mileage.',
    examples: ['Work-truck motor fuel purchase'],
    counterexamples: ['Store merchandise without a pump receipt'],
  });
  const personalCase = await createVerifiedCase(db, {
    companyId: company.id,
    transactionId: transactions[1].id,
    vendorIdentityId: vendor.id,
    categoryQboId: personalAccount.qboId,
    rationale: 'Owner gift-card reimbursement was not a fleet expense.',
    examples: ['Personal convenience purchase'],
    counterexamples: ['Fleet propellant purchase with mileage evidence'],
  });
  const candidate = await db.autopilotRuleCandidate.create({
    data: {
      companyId: company.id,
      conditionFingerprint: digest(`candidate-${suffix}`),
      schemaVersion: 'classification-rule-v2',
      configVersion: 'task8-e2e-v1',
      matchText: 'Chevron',
      state: 'conflict',
      winningActionFingerprint: fuelCase.actionFingerprint,
      categoryQboId: fuelAccount.qboId,
      taxCalculation: 'NotApplicable',
      tagIds: [],
      evidenceCount: 1,
      conflictingEvidenceCount: 1,
    },
  });
  await Promise.all([
    db.autopilotRuleCandidateEvidence.create({ data: {
      companyId: company.id, candidateId: candidate.id, transactionId: transactions[0].id,
      inputRevision: 1, requestId: `candidate-positive-${suffix}`, source: 'verified_outcome',
      polarity: 'positive', actionFingerprint: fuelCase.actionFingerprint,
      pattern: { payee: 'Chevron', topic: 'fleet propellant' }, observedAt: NOW,
    } }),
    db.autopilotRuleCandidateEvidence.create({ data: {
      companyId: company.id, candidateId: candidate.id, transactionId: transactions[1].id,
      inputRevision: 1, requestId: `candidate-negative-${suffix}`, source: 'verified_outcome',
      polarity: 'negative', actionFingerprint: personalCase.actionFingerprint,
      pattern: { payee: 'Chevron', topic: 'owner gift card' }, observedAt: NOW,
    } }),
  ]);
  const principal: RuleChangePrincipal = {
    kind: 'session', sessionId: session.id, userId: user.id,
  };
  return {
    user, company, session, principal, fuelAccount, personalAccount, vendor, alias,
    transactions, fuelCase, personalCase, candidate,
  };
}

async function seedForeignChevron(db: PrismaClient, userId: string) {
  const suffix = randomUUID();
  const company = await db.company.create({
    data: {
      realmId: `task8-foreign-${suffix}`, legalName: 'Task 8 Foreign Legal',
      nickname: 'Task 8 Foreign', taxSupportStatus: 'ready', taxUsingSalesTax: true,
    },
  });
  await db.membership.create({ data: { userId, companyId: company.id, role: 'viewer' } });
  const account = await db.qboAccount.create({ data: {
    companyId: company.id, qboId: `foreign-fuel-${suffix}`, name: 'Foreign fleet fuel',
    fullName: 'Expenses · Foreign fleet fuel', classification: 'Expenses',
  } });
  const vendor = await db.vendorIdentity.create({ data: {
    companyId: company.id, displayName: 'Chevron Foreign Fleet', normalizedName: 'chevron foreign fleet',
  } });
  await db.vendorAlias.create({ data: {
    companyId: company.id, vendorIdentityId: vendor.id,
    value: 'CHEVRON FOREIGN 900', normalizedValue: 'chevron foreign 900', source: 'user',
  } });
  const transaction = await db.transaction.create({ data: {
    companyId: company.id, qboId: `foreign-txn-${suffix}`, qboType: 'Purchase', qboSyncToken: '1',
    date: NOW, payee: 'Chevron Foreign Pump', memo: 'Fleet propellant expenditure',
    amount: '-50.00', bankAccount: 'Foreign card', status: 'POSTED', revision: 1,
  } });
  const classificationCase = await createVerifiedCase(db, {
    companyId: company.id, transactionId: transaction.id, vendorIdentityId: vendor.id,
    categoryQboId: account.qboId, rationale: 'Foreign fleet propellant expenditure.',
    examples: ['Foreign work-truck motor fuel'], counterexamples: [],
  });
  return { company, account, vendor, transaction, classificationCase };
}

async function publishEmbeddings(
  db: PrismaClient,
  companyId: string,
  fixture: DeterministicEmbeddingFixture,
  salt: string,
) {
  const repository = new PrismaClassificationSearchRepository(db);
  const store = new PgClassificationVectorStore(db);
  const generation = classificationEmbeddingGeneration({ baseUrl: fixture.baseUrl, fingerprintSalt: salt });
  await expect(store.ensureAvailable()).resolves.toEqual({ available: true, reason: null });
  const attempt = await store.beginAttempt({ companyId, fingerprint: generation.fingerprint });
  const corpus = await repository.documents(companyId, attempt.targetRevision);
  const result = await reconcileClassificationEmbeddings({
    companyId,
    documents: corpus.documents,
    totalDocuments: corpus.totalDocuments,
    skippedDocuments: corpus.skippedDocuments,
    generation,
    client: createVoyageEmbeddingClient({
      apiKey: 'synthetic-local-only', baseUrl: fixture.baseUrl, batchSize: 32, timeoutMs: 2_000,
    }),
    store,
    targetRevision: attempt.targetRevision,
    attemptToken: attempt.token,
  });
  expect(result).toMatchObject({ status: 'published', backlog: 0, error: null });
  return { repository, store, generation, corpus };
}

function semanticDependencies(
  db: PrismaClient,
  fixture: DeterministicEmbeddingFixture,
  salt: string,
) {
  const generation = classificationEmbeddingGeneration({ baseUrl: fixture.baseUrl, fingerprintSalt: salt });
  return {
    repository: new PrismaClassificationSearchRepository(db),
    semantic: {
      generation,
      client: createVoyageEmbeddingClient({
        apiKey: 'synthetic-local-only', baseUrl: fixture.baseUrl, batchSize: 32, timeoutMs: 500,
      }),
      store: new PgClassificationVectorStore(db),
    },
  };
}

interface FaultBoundary {
  model: string;
  method: string;
  occurrence?: number;
}

function faultInjectedClient(db: PrismaClient, boundary: FaultBoundary): PrismaClient {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === '$transaction') {
        return async (callback: (transaction: unknown) => unknown, options?: unknown) => (
          (target.$transaction as unknown as (
            work: (transaction: unknown) => unknown,
            options?: unknown,
          ) => Promise<unknown>)(async (transaction) => {
            let calls = 0;
            const faultedTransaction = new Proxy(transaction as object, {
              get(transactionTarget, modelProperty, transactionReceiver) {
                const model = Reflect.get(transactionTarget, modelProperty, transactionReceiver) as unknown;
                if (modelProperty !== boundary.model || model === null || typeof model !== 'object') {
                  return typeof model === 'function'
                    ? model.bind(transactionTarget)
                    : model;
                }
                return new Proxy(model, {
                  get(modelTarget, methodProperty, modelReceiver) {
                    const method = Reflect.get(modelTarget, methodProperty, modelReceiver) as unknown;
                    if (methodProperty !== boundary.method || typeof method !== 'function') {
                      return typeof method === 'function' ? method.bind(modelTarget) : method;
                    }
                    return async (...arguments_: unknown[]) => {
                      const result = await method.apply(modelTarget, arguments_);
                      calls += 1;
                      if (calls === (boundary.occurrence ?? 1)) {
                        throw new Error(`task8-simulated-crash:${boundary.model}.${boundary.method}`);
                      }
                      return result;
                    };
                  },
                });
              },
            });
            return callback(faultedTransaction);
          }, options)
        );
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as PrismaClient;
}

describeTask8('classification memory deterministic PostgreSQL end-to-end', () => {
  const clients: PrismaClient[] = [];
  const fixtures: DeterministicEmbeddingFixture[] = [];
  const companyIds = new Set<string>();

  const client = () => {
    const db = newClient();
    clients.push(db);
    return db;
  };

  afterEach(async () => {
    const cleanup = newClient();
    try {
      if (companyIds.size > 0) {
        await cleanup.company.deleteMany({ where: { id: { in: [...companyIds] } } });
      }
    } finally {
      companyIds.clear();
      await Promise.allSettled(clients.splice(0).map((db) => db.$disconnect()));
      await Promise.allSettled(fixtures.splice(0).map((fixture) => fixture.close()));
      await cleanup.$disconnect();
    }
  });

  it('proves exact, semantic-only, hybrid RRF, re-embed, cutover, tenancy, and endpoint-down degradation', async () => {
    const db = client();
    const current = await seedChevronCompany(db);
    const foreign = await seedForeignChevron(db, current.user.id);
    companyIds.add(current.company.id);
    companyIds.add(foreign.company.id);
    const releaseA = await startDeterministicEmbeddingFixture('a');
    fixtures.push(releaseA);
    const saltA = 'task8-model-release-a';
    const firstPublication = await publishEmbeddings(db, current.company.id, releaseA, saltA);
    await publishEmbeddings(db, foreign.company.id, releaseA, saltA);

    const exact = await searchClassificationMemory({
      query: current.alias.value, companyId: current.company.id, scope: 'current_company',
      mode: 'exact', accessibleCompanyIds: [current.company.id],
    }, { repository: firstPublication.repository, semantic: null });
    expect(exact.hits).toContainEqual(expect.objectContaining({
      id: `vendor_alias:${current.alias.id}`, matchedIn: expect.arrayContaining(['alias']),
    }));

    const semanticOnlyQuery = 'settle a road-trip refuelling stop for the work truck';
    const lexical = await searchClassificationMemory({
      query: semanticOnlyQuery, companyId: current.company.id, scope: 'current_company',
      mode: 'lexical', accessibleCompanyIds: [current.company.id],
    }, { repository: firstPublication.repository, semantic: null });
    expect(lexical.hits.map(({ id }) => id)).not.toContain(`classification_case:${current.fuelCase.id}`);
    const semantic = await searchClassificationMemory({
      query: semanticOnlyQuery, companyId: current.company.id, scope: 'current_company',
      mode: 'semantic', accessibleCompanyIds: [current.company.id],
    }, semanticDependencies(db, releaseA, saltA));
    expect(semantic.hits).toContainEqual(expect.objectContaining({
      id: `classification_case:${current.fuelCase.id}`, matchedIn: expect.arrayContaining(['semantic']),
    }));

    const hybrid = await searchClassificationMemory({
      query: current.alias.value, companyId: current.company.id, scope: 'current_company',
      mode: 'hybrid', accessibleCompanyIds: [current.company.id],
    }, semanticDependencies(db, releaseA, saltA));
    expect(hybrid.hits).toContainEqual(expect.objectContaining({
      id: `vendor_alias:${current.alias.id}`,
      matchedIn: expect.arrayContaining(['alias', 'lexical', 'semantic']),
    }));

    const accessible = await searchClassificationMemory({
      query: 'Chevron fleet propellant', companyId: current.company.id,
      scope: 'accessible_companies', mode: 'hybrid',
      accessibleCompanyIds: [current.company.id, foreign.company.id],
    }, semanticDependencies(db, releaseA, saltA));
    const foreignHits = accessible.hits.filter(({ companyId }) => companyId === foreign.company.id);
    expect(foreignHits.length).toBeGreaterThan(0);
    expect(foreignHits.every((hit) => hit.companyRelation === 'foreign'
      && hit.advisory && !hit.executable && hit.action === null)).toBe(true);
    await expect(searchClassificationMemory({
      query: 'Chevron', companyId: foreign.company.id, scope: 'current_company', mode: 'exact',
      accessibleCompanyIds: [current.company.id],
    }, { repository: firstPublication.repository, semantic: null }))
      .rejects.toBeInstanceOf(ClassificationSearchError);

    const requestsBeforeEdit = releaseA.requests.length;
    await db.vendorIdentity.update({
      where: { id: current.vendor.id },
      data: { displayName: 'Chevron Fleet Energy', normalizedName: 'chevron fleet energy' },
    });
    const edited = await publishEmbeddings(db, current.company.id, releaseA, saltA);
    const editRequests = releaseA.requests.slice(requestsBeforeEdit).flatMap(({ inputs }) => inputs);
    expect(editRequests.some((text) => text.includes('Chevron Fleet Energy'))).toBe(true);
    expect(editRequests.length).toBeGreaterThan(0);
    expect(editRequests.length).toBeLessThan(edited.corpus.totalDocuments);

    const releaseB = await startDeterministicEmbeddingFixture('b');
    fixtures.push(releaseB);
    const saltB = 'task8-model-release-b';
    const generationB = classificationEmbeddingGeneration({ baseUrl: releaseB.baseUrl, fingerprintSalt: saltB });
    const buildingStore = new PgClassificationVectorStore(db);
    await buildingStore.beginAttempt({ companyId: current.company.id, fingerprint: generationB.fingerprint });
    await expect(searchClassificationMemory({
      query: semanticOnlyQuery, companyId: current.company.id, scope: 'current_company',
      mode: 'semantic', accessibleCompanyIds: [current.company.id],
    }, semanticDependencies(db, releaseB, saltB))).rejects.toMatchObject({ code: 'SEMANTIC_UNAVAILABLE' });
    const duringCutover = await searchClassificationMemory({
      query: 'Chevron', companyId: current.company.id, scope: 'current_company',
      mode: 'auto', accessibleCompanyIds: [current.company.id],
    }, semanticDependencies(db, releaseB, saltB));
    expect(duringCutover).toMatchObject({
      mode: 'lexical', degraded: true, degradedReason: 'semantic_unavailable',
    });

    const oldFingerprint = edited.generation.fingerprint;
    const cutover = await publishEmbeddings(db, current.company.id, releaseB, saltB);
    expect(cutover.generation.fingerprint).not.toBe(oldFingerprint);
    const oldRows = await db.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) AS count FROM "ClassificationEmbeddingGeneration"
      WHERE "companyId" = ${current.company.id} AND "fingerprint" = ${oldFingerprint}
    `;
    expect(oldRows[0]?.count).toBe(0n);
    const afterCutover = await searchClassificationMemory({
      query: semanticOnlyQuery, companyId: current.company.id, scope: 'current_company',
      mode: 'semantic', accessibleCompanyIds: [current.company.id],
    }, semanticDependencies(db, releaseB, saltB));
    expect(afterCutover.hits.map(({ id }) => id)).toContain(`classification_case:${current.fuelCase.id}`);

    await releaseB.close();
    const endpointDown = await searchClassificationMemory({
      query: 'Chevron', companyId: current.company.id, scope: 'current_company',
      mode: 'auto', accessibleCompanyIds: [current.company.id],
    }, semanticDependencies(db, releaseB, saltB));
    expect(endpointDown).toMatchObject({
      mode: 'lexical', requestedMode: 'auto', degraded: true,
      degradedReason: 'semantic_error', status: 'matched',
    });
  }, 60_000);

  it('runs the isolated Chevron suggestion flow with restart readback and zero accounting-provider writes', async () => {
    let db = client();
    const seeded = await seedChevronCompany(db, 'Task 8 Restart');
    companyIds.add(seeded.company.id);
    const endpoint = await startDeterministicEmbeddingFixture('a');
    fixtures.push(endpoint);
    const salt = 'task8-restart-model';
    await publishEmbeddings(db, seeded.company.id, endpoint, salt);
    const beforeAttempts = await db.qboMutationAttempt.count({
      where: { transaction: { companyId: seeded.company.id } },
    });
    const transactionProjection = {
      id: true, qboSyncToken: true, revision: true, status: true,
      categoryQboId: true, taxCalculation: true, taxCodeQboId: true,
    } as const;
    const beforeTransactions = await db.transaction.findMany({
      where: { companyId: seeded.company.id }, select: transactionProjection, orderBy: { id: 'asc' },
    });

    const unfamiliar = await searchClassificationMemory({
      query: 'CHEVRON 00991 RICHMOND road-trip refuelling',
      companyId: seeded.company.id, scope: 'current_company', mode: 'hybrid',
      accessibleCompanyIds: [seeded.company.id],
    }, semanticDependencies(db, endpoint, salt));
    expect(unfamiliar.hits).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: `classification_case:${seeded.fuelCase.id}`,
        rationale: expect.stringContaining('Fleet propellant'), evidenceCount: 1,
        counterexamples: ['Store merchandise without a pump receipt'],
      }),
      expect.objectContaining({
        id: `rule_candidate:${seeded.candidate.id}`,
        advisory: true, executable: false, conflictingEvidenceCount: 1,
        rationale: 'Verified outcomes disagree for this candidate.',
        conflicts: [expect.objectContaining({
          reason: 'Verified outcomes disagree for this rule candidate.', evidenceCount: 1,
        })],
      }),
    ]));

    const idempotencyKey = `task8-recurring-${randomUUID()}`;
    const prepared = await prepareRuleChange(seeded.principal, {
      companyId: seeded.company.id, mutation: 'create', expectedRevision: 0, idempotencyKey,
      proposal: {
        matchText: 'Chevron', categoryQboId: seeded.fuelAccount.qboId,
        taxCalculation: 'NotApplicable', taxCodeQboId: null, tagIds: [],
        priority: 0, autoPost: false, sourceCaseId: seeded.fuelCase.id,
      },
    }, { db, now: () => NOW });
    expect(prepared).toMatchObject({
      status: 'PREPARED', originIntent: 'make_recurring',
      preview: { autoPost: false, action: { categoryQboId: seeded.fuelAccount.qboId } },
    });
    expect(await db.rule.count({ where: { companyId: seeded.company.id } })).toBe(0);
    const committed = await commitRuleChange(seeded.principal, {
      companyId: seeded.company.id, operationId: prepared.operationId, idempotencyKey,
    }, { db, now: () => new Date(NOW.getTime() + 1_000) });
    expect(committed).toMatchObject({
      status: 'COMMITTED', rule: { state: 'enabled', autoPost: false, sourceCaseId: seeded.fuelCase.id },
    });
    await publishEmbeddings(db, seeded.company.id, endpoint, salt);

    expect(endpoint.requests.length).toBeGreaterThan(0);
    expect(endpoint.requests.every(({ method, path }) => method === 'POST' && path === '/v1/embeddings')).toBe(true);
    expect(await db.qboMutationAttempt.count({
      where: { transaction: { companyId: seeded.company.id } },
    })).toBe(beforeAttempts);
    expect(await db.transaction.findMany({
      where: { companyId: seeded.company.id }, select: transactionProjection, orderBy: { id: 'asc' },
    })).toEqual(beforeTransactions);

    await db.$disconnect();
    db = client();
    const reads = createCompanyReadService(
      db as never,
      'task8-restart-cursor-secret',
      {
        classificationSearch: (input) => searchClassificationMemory(
          input,
          semanticDependencies(db, endpoint, salt),
        ),
      },
    );
    const [caseReadback, ruleReadback, revisionPage, candidateReadback, searchReadback] = await Promise.all([
      reads.getClassificationCase(seeded.user.id, seeded.company.id, seeded.fuelCase.id),
      reads.getRule(seeded.user.id, seeded.company.id, committed.ruleId!),
      reads.listRuleRevisions(seeded.user.id, seeded.company.id, committed.ruleId!, { limit: 20 }),
      reads.getRuleCandidate(seeded.user.id, seeded.company.id, seeded.candidate.id),
      reads.searchClassificationKnowledge(seeded.user.id, seeded.company.id, {
        query: 'road-trip refuelling', mode: 'semantic', limit: 20,
      }),
    ]);
    expect(caseReadback).toMatchObject({ id: seeded.fuelCase.id, invalidatedAt: null });
    expect(ruleReadback).toMatchObject({
      active: true,
      executable: true,
      revision: { ruleId: committed.ruleId, revision: 1, autoPost: false },
    });
    expect(revisionPage.items.map(({ revision }) => revision).sort()).toEqual([0, 1]);
    expect(candidateReadback).toMatchObject({
      id: seeded.candidate.id, state: 'conflict', evidenceCount: 1, conflictingEvidenceCount: 1,
    });
    expect(searchReadback.items.map(({ id }) => id)).toContain(`classification_case:${seeded.fuelCase.id}`);
    expect(await db.qboMutationAttempt.count({
      where: { transaction: { companyId: seeded.company.id } },
    })).toBe(beforeAttempts);
    expect(await db.transaction.findMany({
      where: { companyId: seeded.company.id }, select: transactionProjection, orderBy: { id: 'asc' },
    })).toEqual(beforeTransactions);
  }, 60_000);

  it('recovers rule prepare and commit at every durable boundary without partial policy or order state', async () => {
    const createInput = (
      seeded: Awaited<ReturnType<typeof seedChevronCompany>>,
      idempotencyKey: string,
      overrides: Record<string, unknown> = {},
    ) => ({
      companyId: seeded.company.id,
      mutation: 'create' as const,
      expectedRevision: 0,
      idempotencyKey,
      proposal: {
        matchText: `Chevron ${idempotencyKey.slice(-8)}`,
        categoryQboId: seeded.fuelAccount.qboId,
        taxCalculation: 'NotApplicable' as const,
        taxCodeQboId: null,
        tagIds: [] as string[],
        priority: 0,
        autoPost: false as const,
        sourceCaseId: seeded.fuelCase.id,
        ...overrides,
      },
    });

    const prepareDb = client();
    const prepareSeed = await seedChevronCompany(prepareDb, 'Task 8 Prepare Recovery');
    companyIds.add(prepareSeed.company.id);
    const prepareKey = `prepare-crash-${randomUUID()}`;
    const prepareRequest = createInput(prepareSeed, prepareKey);
    await expect(prepareRuleChange(
      prepareSeed.principal,
      prepareRequest,
      {
        db: faultInjectedClient(prepareDb, { model: 'mcpRuleOperation', method: 'createMany' }),
        now: () => NOW,
      },
    )).rejects.toThrow('task8-simulated-crash:mcpRuleOperation.createMany');
    expect(await prepareDb.mcpRuleOperation.count({
      where: { companyId: prepareSeed.company.id, idempotencyKey: prepareKey },
    })).toBe(0);
    expect(await prepareDb.rule.count({ where: { companyId: prepareSeed.company.id } })).toBe(0);
    const preparedAfterRestart = await prepareRuleChange(
      prepareSeed.principal,
      prepareRequest,
      { db: client(), now: () => new Date(NOW.getTime() + 1_000) },
    );
    expect(preparedAfterRestart.status).toBe('PREPARED');
    expect(await prepareDb.mcpRuleOperation.count({
      where: { companyId: prepareSeed.company.id, idempotencyKey: prepareKey },
    })).toBe(1);
    expect(await prepareDb.rule.count({ where: { companyId: prepareSeed.company.id } })).toBe(0);

    const commitBoundaries: FaultBoundary[] = [
      { model: 'rule', method: 'create' },
      { model: 'ruleRevision', method: 'create' },
      { model: 'auditEntry', method: 'create' },
      { model: 'mcpRuleOperation', method: 'update' },
    ];
    for (const boundary of commitBoundaries) {
      const db = client();
      const seeded = await seedChevronCompany(db, `Task 8 ${boundary.model}`);
      companyIds.add(seeded.company.id);
      const idempotencyKey = `commit-${boundary.model}-${randomUUID()}`;
      const request = createInput(seeded, idempotencyKey);
      const prepared = await prepareRuleChange(seeded.principal, request, { db, now: () => NOW });

      await expect(commitRuleChange(seeded.principal, {
        companyId: seeded.company.id,
        operationId: prepared.operationId,
        idempotencyKey,
      }, {
        db: faultInjectedClient(db, boundary),
        now: () => new Date(NOW.getTime() + 1_000),
      })).rejects.toThrow(`task8-simulated-crash:${boundary.model}.${boundary.method}`);

      expect(await db.rule.count({ where: { id: prepared.ruleId! } }), boundary.model).toBe(0);
      expect(await db.ruleRevision.count({ where: { ruleId: prepared.ruleId! } }), boundary.model).toBe(0);
      expect(await db.auditEntry.count({
        where: { companyId: seeded.company.id, payload: { path: ['ruleId'], equals: prepared.ruleId! } },
      }), boundary.model).toBe(0);
      expect(await db.mcpRuleOperation.findUniqueOrThrow({ where: { id: prepared.operationId } }))
        .toMatchObject({ committedAt: null, commitResult: null });

      const restarted = client();
      const committed = await commitRuleChange(seeded.principal, {
        companyId: seeded.company.id, operationId: prepared.operationId, idempotencyKey,
      }, { db: restarted, now: () => new Date(NOW.getTime() + 2_000) });
      const replayed = await commitRuleChange(seeded.principal, {
        companyId: seeded.company.id, operationId: prepared.operationId, idempotencyKey,
      }, { db: client(), now: () => new Date(NOW.getTime() + 3_000) });
      expect(committed.status, boundary.model).toBe('COMMITTED');
      expect(replayed.status, boundary.model).toBe('REPLAYED');
      expect(await db.rule.count({ where: { id: prepared.ruleId! } }), boundary.model).toBe(1);
      expect(await db.ruleRevision.count({ where: { ruleId: prepared.ruleId! } }), boundary.model).toBe(2);
      expect(await db.auditEntry.count({
        where: { companyId: seeded.company.id, action: 'rule-created' },
      }), boundary.model).toBe(1);
    }

    const expiryDb = client();
    const expirySeed = await seedChevronCompany(expiryDb, 'Task 8 Expiry');
    companyIds.add(expirySeed.company.id);
    const expiryKey = `expiry-${randomUUID()}`;
    const expiryInput = createInput(expirySeed, expiryKey);
    const expired = await prepareRuleChange(expirySeed.principal, expiryInput, { db: expiryDb, now: () => NOW });
    const retryAt = new Date(NOW.getTime() + 16 * 60 * 1_000);
    await expect(commitRuleChange(expirySeed.principal, {
      companyId: expirySeed.company.id, operationId: expired.operationId, idempotencyKey: expiryKey,
    }, { db: expiryDb, now: () => retryAt })).rejects.toMatchObject({ code: 'OPERATION_EXPIRED' });
    expect(await expiryDb.rule.count({ where: { id: expired.ruleId! } })).toBe(0);
    expect(await expiryDb.mcpRuleOperation.findUniqueOrThrow({ where: { id: expired.operationId } }))
      .toMatchObject({ committedAt: null, commitResult: null });
    const retryKey = `expiry-retry-${randomUUID()}`;
    const retry = await prepareRuleChange(expirySeed.principal, {
      ...expiryInput, idempotencyKey: retryKey, retryOfId: expired.operationId,
    }, { db: client(), now: () => retryAt });
    expect(retry.ruleId).toBe(expired.ruleId);
    await expect(commitRuleChange(expirySeed.principal, {
      companyId: expirySeed.company.id, operationId: retry.operationId, idempotencyKey: retryKey,
    }, { db: client(), now: () => new Date(retryAt.getTime() + 1_000) }))
      .resolves.toMatchObject({ status: 'COMMITTED', ruleId: expired.ruleId });

    const conflictDb = client();
    const conflictSeed = await seedChevronCompany(conflictDb, 'Task 8 Candidate Conflict');
    companyIds.add(conflictSeed.company.id);
    await expect(prepareRuleChange(conflictSeed.principal, {
      companyId: conflictSeed.company.id,
      mutation: 'activate_candidate',
      candidateId: conflictSeed.candidate.id,
      expectedRevision: 0,
      idempotencyKey: `candidate-conflict-${randomUUID()}`,
    }, { db: conflictDb, now: () => NOW })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await conflictDb.rule.count({ where: { companyId: conflictSeed.company.id } })).toBe(0);

    const historyDb = client();
    const historySeed = await seedChevronCompany(historyDb, 'Task 8 History');
    companyIds.add(historySeed.company.id);
    const createKey = `history-create-${randomUUID()}`;
    const historyPrepared = await prepareRuleChange(
      historySeed.principal,
      createInput(historySeed, createKey),
      { db: historyDb, now: () => NOW },
    );
    const historyCreated = await commitRuleChange(historySeed.principal, {
      companyId: historySeed.company.id,
      operationId: historyPrepared.operationId,
      idempotencyKey: createKey,
    }, { db: historyDb, now: () => new Date(NOW.getTime() + 1_000) });
    const staleKey = `history-stale-${randomUUID()}`;
    const stalePrepared = await prepareRuleChange(historySeed.principal, {
      companyId: historySeed.company.id, mutation: 'update', ruleId: historyCreated.ruleId!,
      expectedRevision: 1, idempotencyKey: staleKey, proposal: { matchText: 'Prepared stale Chevron' },
    }, { db: historyDb, now: () => new Date(NOW.getTime() + 2_000) });
    const updateKey = `history-update-${randomUUID()}`;
    const currentUpdate = await prepareRuleChange(historySeed.principal, {
      companyId: historySeed.company.id, mutation: 'update', ruleId: historyCreated.ruleId!,
      expectedRevision: 1, idempotencyKey: updateKey, proposal: { matchText: 'Current Chevron' },
    }, { db: historyDb, now: () => new Date(NOW.getTime() + 3_000) });
    await commitRuleChange(historySeed.principal, {
      companyId: historySeed.company.id, operationId: currentUpdate.operationId, idempotencyKey: updateKey,
    }, { db: historyDb, now: () => new Date(NOW.getTime() + 4_000) });
    await expect(commitRuleChange(historySeed.principal, {
      companyId: historySeed.company.id, operationId: stalePrepared.operationId, idempotencyKey: staleKey,
    }, { db: historyDb, now: () => new Date(NOW.getTime() + 5_000) }))
      .rejects.toMatchObject({ code: 'STALE_REVISION' });
    await expect(prepareRuleChange(historySeed.principal, {
      companyId: historySeed.company.id, mutation: 'update', ruleId: historyCreated.ruleId!,
      expectedRevision: 1, idempotencyKey: `known-stale-${randomUUID()}`,
      proposal: { matchText: 'Known stale Chevron' },
    }, { db: historyDb, now: () => new Date(NOW.getTime() + 6_000) }))
      .rejects.toMatchObject({ code: 'STALE_REVISION' });
    const disableKey = `history-disable-${randomUUID()}`;
    const disablePrepared = await prepareRuleChange(historySeed.principal, {
      companyId: historySeed.company.id, mutation: 'disable', ruleId: historyCreated.ruleId!,
      expectedRevision: 2, idempotencyKey: disableKey,
    }, { db: historyDb, now: () => new Date(NOW.getTime() + 7_000) });
    await commitRuleChange(historySeed.principal, {
      companyId: historySeed.company.id, operationId: disablePrepared.operationId, idempotencyKey: disableKey,
    }, { db: historyDb, now: () => new Date(NOW.getTime() + 8_000) });
    const revisions = await historyDb.ruleRevision.findMany({
      where: { ruleId: historyCreated.ruleId! }, select: { id: true, revision: true },
      orderBy: { revision: 'asc' },
    });
    expect(revisions.map(({ revision }) => revision)).toEqual([0, 1, 2, 3]);
    await expect(historyDb.ruleRevision.update({
      where: { id: revisions[1]!.id }, data: { matchText: 'Mutated history' },
    })).rejects.toThrow('RuleRevision is append-only');
    await expect(historyDb.ruleRevision.delete({ where: { id: revisions[1]!.id } }))
      .rejects.toThrow('RuleRevision is append-only');
    expect(await historyDb.ruleRevision.count({ where: { ruleId: historyCreated.ruleId! } })).toBe(4);

    const orderDb = client();
    const orderSeed = await seedChevronCompany(orderDb, 'Task 8 Order');
    companyIds.add(orderSeed.company.id);
    const firstKey = `order-first-${randomUUID()}`;
    const firstPrepared = await prepareRuleChange(
      orderSeed.principal,
      createInput(orderSeed, firstKey, { matchText: 'Chevron First', priority: 0 }),
      { db: orderDb, now: () => NOW },
    );
    const first = await commitRuleChange(orderSeed.principal, {
      companyId: orderSeed.company.id, operationId: firstPrepared.operationId, idempotencyKey: firstKey,
    }, { db: orderDb, now: () => new Date(NOW.getTime() + 1_000) });
    const secondKey = `order-second-${randomUUID()}`;
    const secondPrepared = await prepareRuleChange(
      orderSeed.principal,
      createInput(orderSeed, secondKey, { matchText: 'Chevron Second', priority: 1 }),
      { db: orderDb, now: () => new Date(NOW.getTime() + 2_000) },
    );
    const second = await commitRuleChange(orderSeed.principal, {
      companyId: orderSeed.company.id, operationId: secondPrepared.operationId, idempotencyKey: secondKey,
    }, { db: orderDb, now: () => new Date(NOW.getTime() + 3_000) });
    const orderBefore = await orderDb.rule.findMany({
      where: { id: { in: [first.ruleId!, second.ruleId!] } },
      select: { id: true, priority: true, revision: true }, orderBy: { id: 'asc' },
    });
    const reorderKey = `order-recovery-${randomUUID()}`;
    const reorder = await prepareRuleChange(orderSeed.principal, {
      companyId: orderSeed.company.id, mutation: 'reorder', expectedRevision: 1,
      idempotencyKey: reorderKey, proposal: { orderIds: [second.ruleId!, first.ruleId!] },
    }, { db: orderDb, now: () => new Date(NOW.getTime() + 4_000) });
    await expect(commitRuleChange(orderSeed.principal, {
      companyId: orderSeed.company.id, operationId: reorder.operationId, idempotencyKey: reorderKey,
    }, {
      db: faultInjectedClient(orderDb, { model: 'rule', method: 'update' }),
      now: () => new Date(NOW.getTime() + 5_000),
    })).rejects.toThrow('task8-simulated-crash:rule.update');
    expect(await orderDb.rule.findMany({
      where: { id: { in: [first.ruleId!, second.ruleId!] } },
      select: { id: true, priority: true, revision: true }, orderBy: { id: 'asc' },
    })).toEqual(orderBefore);
    expect(await orderDb.mcpRuleOperation.findUniqueOrThrow({ where: { id: reorder.operationId } }))
      .toMatchObject({ committedAt: null, commitResult: null });
    await expect(commitRuleChange(orderSeed.principal, {
      companyId: orderSeed.company.id, operationId: reorder.operationId, idempotencyKey: reorderKey,
    }, { db: client(), now: () => new Date(NOW.getTime() + 6_000) }))
      .resolves.toMatchObject({ status: 'COMMITTED' });
    await expect(orderDb.rule.findMany({
      where: { id: { in: [first.ruleId!, second.ruleId!] } },
      select: { id: true, priority: true }, orderBy: { priority: 'asc' },
    })).resolves.toEqual([
      { id: second.ruleId!, priority: 0 },
      { id: first.ruleId!, priority: 1 },
    ]);
  }, 120_000);
});
