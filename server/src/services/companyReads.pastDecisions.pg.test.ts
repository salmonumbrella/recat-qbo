import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createCompanyReadService, type CompanyReadDb } from './companyReads.js';
import {
  createDisposablePgvectorDatabase,
  type DisposablePgvectorDatabase,
  resetDisposablePgvectorDatabase,
} from '../test/disposablePgvectorDatabase.js';

const TEST_PGVECTOR_DATABASE_URL = process.env.TEST_PGVECTOR_DATABASE_URL;
const describePostgres = TEST_PGVECTOR_DATABASE_URL ? describe : describe.skip;

describePostgres('past-decision PostgreSQL reads', () => {
  let disposable: DisposablePgvectorDatabase;
  let db: PrismaClient;

  beforeAll(async () => {
    disposable = await createDisposablePgvectorDatabase(TEST_PGVECTOR_DATABASE_URL!);
    db = new PrismaClient({ datasources: { db: { url: disposable.databaseUrl } } });
  });

  afterEach(async () => {
    await resetDisposablePgvectorDatabase(db);
  });

  afterAll(async () => {
    await db?.$disconnect();
    await disposable?.destroy();
  });

  async function seedCompany(label: string) {
    const company = await db.company.create({ data: {
      realmId: `past-decisions-${label}-${randomUUID()}`,
      legalName: `${label} Legal`, nickname: label,
    } });
    const viewer = await db.user.create({ data: { email: `${label}-${randomUUID()}@example.test` } });
    await db.membership.create({ data: { userId: viewer.id, companyId: company.id, role: 'viewer' } });
    const account = await db.qboAccount.create({ data: {
      companyId: company.id, qboId: `account-${label}`, name: 'Meals',
      fullName: 'Expenses · Meals', classification: 'Expense',
    } });
    return { company, viewer, account };
  }

  async function seedTransaction(companyId: string, label: string) {
    return db.transaction.create({ data: {
      companyId, qboId: `purchase-${label}-${randomUUID()}`, qboType: 'Purchase', qboSyncToken: '7',
      date: new Date('2026-09-01T00:00:00.000Z'), payee: `${label} vendor`, memo: `${label} memo`,
      amount: '-12.00', bankAccount: 'Operating', status: 'POSTED',
    } });
  }

  async function seedCase(input: {
    companyId: string; userId: string; transactionId: string; accountQboId: string; verifiedAt: Date;
  }) {
    const attempt = await db.qboMutationAttempt.create({ data: {
      transactionId: input.transactionId, requestId: `past-decision-${randomUUID()}`,
      operation: 'post', status: 'VERIFIED', expectedRevision: 0, expectedSyncToken: '7',
      requestHash: 'a'.repeat(64), requestPayload: {}, beforeSnapshot: {},
    } });
    return db.classificationCase.create({ data: {
      companyId: input.companyId, transactionId: input.transactionId, qboMutationAttemptId: attempt.id,
      action: { categoryQboId: input.accountQboId, taxCalculation: 'NotApplicable', taxCodeQboId: null, tagIds: [] },
      actionFingerprint: randomUUID().replaceAll('-', '').padEnd(64, 'b'), originIntent: 'apply_once',
      rationale: 'Verified immutable decision.', requiredEvidence: [], examples: [], counterexamples: [], citations: [],
      reviewer: { userId: input.userId, configVersion: 'test', decision: 'approved' }, jurisdiction: 'unknown',
      currency: 'CAD', context: { transactionDirection: 'out', qboType: 'Purchase', sourceAccountName: 'Operating', businessPurpose: null },
      provenance: { source: 'qbo_verified', sourceId: attempt.id, actorId: input.userId, recordedAt: input.verifiedAt.toISOString() },
      transactionSnapshot: {}, verifiedAt: input.verifiedAt,
    } });
  }

  async function seedObservation(input: {
    companyId: string; transactionId: string; observedAt: Date; revision: number;
  }) {
    return db.historicalClassificationObservation.create({ data: {
      companyId: input.companyId, sourceTransactionId: input.transactionId, sourceQboType: 'Purchase',
      sourceQboId: `observation-${randomUUID()}`, sourceTransactionRevision: input.revision,
      sourceQboSyncToken: String(input.revision), sourceStatus: 'POSTED',
      sourceUpdatedAt: input.observedAt, observedAt: input.observedAt, transactionDate: input.observedAt,
      payee: 'Historical vendor', memo: 'Historical memo', amountCents: -1200n, currency: 'CAD',
      sourceAccountName: 'Operating', categoryName: 'Meals', categoryQboId: 'hidden-category-id',
      taxCalculation: 'NotApplicable', taxCodeName: null, taxCodeQboId: null, tagNames: ['Historical tag'],
    } });
  }

  it('lists only tenant-local immutable cases and advisory observations in deterministic order', async () => {
    const current = await seedCompany('current');
    const foreign = await seedCompany('foreign');
    const caseTransaction = await seedTransaction(current.company.id, 'case');
    const observationTransaction = await seedTransaction(current.company.id, 'observation');
    const tiedCaseTransaction = await seedTransaction(current.company.id, 'tied-case');
    const tiedObservationTransaction = await seedTransaction(current.company.id, 'tied-observation');
    const foreignTransaction = await seedTransaction(foreign.company.id, 'foreign');
    const verifiedCase = await seedCase({
      companyId: current.company.id, userId: current.viewer.id, transactionId: caseTransaction.id,
      accountQboId: current.account.qboId, verifiedAt: new Date('2026-09-01T10:00:00.000Z'),
    });
    const observation = await seedObservation({
      companyId: current.company.id, transactionId: observationTransaction.id,
      observedAt: new Date('2026-09-01T11:00:00.000Z'), revision: 4,
    });
    const tiedCase = await seedCase({
      companyId: current.company.id, userId: current.viewer.id, transactionId: tiedCaseTransaction.id,
      accountQboId: current.account.qboId, verifiedAt: new Date('2026-09-01T09:00:00.000Z'),
    });
    const tiedObservation = await seedObservation({
      companyId: current.company.id, transactionId: tiedObservationTransaction.id,
      observedAt: new Date('2026-09-01T09:00:00.000Z'), revision: 5,
    });
    const foreignObservation = await seedObservation({
      companyId: foreign.company.id, transactionId: foreignTransaction.id,
      observedAt: new Date('2026-09-01T12:00:00.000Z'), revision: 4,
    });
    const reads = createCompanyReadService(db as unknown as CompanyReadDb, 'past-decisions-pg-cursor-secret');

    const first = await reads.listPastDecisions(current.viewer.id, current.company.id, { kind: 'all', limit: 1 });
    expect(first.items).toEqual([expect.objectContaining({
      kind: 'historical_observation', id: observation.id, advisory: true, executable: false,
      observedRecatRevision: 4, observedQboRevision: '4', sourceStatus: 'POSTED',
      actionSummary: { categoryName: 'Meals', taxCalculation: 'NotApplicable', taxCodeName: null, tagNames: ['Historical tag'] },
    })]);
    expect(JSON.stringify(first.items[0])).not.toContain('hidden-category-id');
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await reads.listPastDecisions(current.viewer.id, current.company.id, {
      kind: 'all', limit: 1, cursor: first.nextCursor!,
    });
    expect(second.items).toEqual([expect.objectContaining({
      kind: 'classification_case', id: verifiedCase.id, advisory: false, executable: false,
      actionSummary: { categoryName: 'Meals', taxCalculation: 'NotApplicable', taxCodeName: null, tagNames: [] },
    })]);
    expect([...first.items, ...second.items].map(({ id }) => id)).not.toContain(foreignObservation.id);
    const all = await reads.listPastDecisions(current.viewer.id, current.company.id, { kind: 'all', limit: 10 });
    expect(all.items.map(({ kind, id }) => [kind, id])).toEqual([
      ['historical_observation', observation.id],
      ['classification_case', verifiedCase.id],
      ['classification_case', tiedCase.id],
      ['historical_observation', tiedObservation.id],
    ]);
    await expect(reads.getHistoricalObservation(current.viewer.id, current.company.id, observation.id))
      .resolves.toMatchObject({
        kind: 'historical_observation', id: observation.id, advisory: true, executable: false,
        observedRecatRevision: 4, observedQboRevision: '4', supersededByCaseId: null,
      });
    await expect(reads.getHistoricalObservation(current.viewer.id, current.company.id, foreignObservation.id))
      .rejects.toMatchObject({ status: 404, code: 'OBSERVATION_NOT_FOUND' });
  });

  it('returns the latest non-invalidated verified case that supersedes an observation', async () => {
    const current = await seedCompany('supersession');
    const transaction = await seedTransaction(current.company.id, 'supersession');
    const observation = await seedObservation({
      companyId: current.company.id, transactionId: transaction.id,
      observedAt: new Date('2026-09-01T09:00:00.000Z'), revision: 6,
    });
    await seedCase({
      companyId: current.company.id, userId: current.viewer.id, transactionId: transaction.id,
      accountQboId: current.account.qboId, verifiedAt: new Date('2026-09-01T10:00:00.000Z'),
    });
    const latestNonInvalidated = await seedCase({
      companyId: current.company.id, userId: current.viewer.id, transactionId: transaction.id,
      accountQboId: current.account.qboId, verifiedAt: new Date('2026-09-01T11:00:00.000Z'),
    });
    const laterInvalidated = await seedCase({
      companyId: current.company.id, userId: current.viewer.id, transactionId: transaction.id,
      accountQboId: current.account.qboId, verifiedAt: new Date('2026-09-01T12:00:00.000Z'),
    });
    await db.classificationCaseInvalidation.create({ data: {
      companyId: current.company.id, classificationCaseId: laterInvalidated.id,
      invalidatedAt: new Date('2026-09-01T13:00:00.000Z'), reason: 'Corrected after verification.',
    } });
    const reads = createCompanyReadService(db as unknown as CompanyReadDb, 'past-decisions-pg-supersession-secret');

    await expect(reads.listPastDecisions(current.viewer.id, current.company.id, {
      kind: 'historical_observation', limit: 10,
    })).resolves.toMatchObject({
      items: [expect.objectContaining({ id: observation.id, supersededByCaseId: latestNonInvalidated.id })],
    });
    await expect(reads.getHistoricalObservation(current.viewer.id, current.company.id, observation.id))
      .resolves.toMatchObject({ id: observation.id, supersededByCaseId: latestNonInvalidated.id });
  });

  it('binds cursors to actor, company, filter, and the current corpus revision', async () => {
    const current = await seedCompany('fence');
    const other = await db.user.create({ data: { email: `other-${randomUUID()}@example.test` } });
    await db.membership.create({ data: { userId: other.id, companyId: current.company.id, role: 'viewer' } });
    const firstTransaction = await seedTransaction(current.company.id, 'first');
    const secondTransaction = await seedTransaction(current.company.id, 'second');
    await seedObservation({ companyId: current.company.id, transactionId: firstTransaction.id, observedAt: new Date('2026-09-01T11:00:00.000Z'), revision: 1 });
    await seedObservation({ companyId: current.company.id, transactionId: secondTransaction.id, observedAt: new Date('2026-09-01T10:00:00.000Z'), revision: 2 });
    const reads = createCompanyReadService(db as unknown as CompanyReadDb, 'past-decisions-pg-fence-cursor-secret');
    const page = await reads.listPastDecisions(current.viewer.id, current.company.id, { kind: 'all', limit: 1 });
    expect(page.nextCursor).toEqual(expect.any(String));
    await expect(reads.listPastDecisions(other.id, current.company.id, { kind: 'all', limit: 1, cursor: page.nextCursor! }))
      .rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    await expect(reads.listPastDecisions(current.viewer.id, current.company.id, { kind: 'historical_observation', limit: 1, cursor: page.nextCursor! }))
      .rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    await db.classificationCorpusRevision.create({ data: { companyId: current.company.id } });
    await expect(reads.listPastDecisions(current.viewer.id, current.company.id, { kind: 'all', limit: 1, cursor: page.nextCursor! }))
      .rejects.toMatchObject({ code: 'INVALID_CURSOR' });
  });
});
