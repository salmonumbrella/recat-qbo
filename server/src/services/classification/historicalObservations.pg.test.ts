import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { backfillHistoricalClassificationObservations } from './historicalObservations.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;

describePostgres('historical classification observations on PostgreSQL', () => {
  let db: PrismaClient;
  const companyIds = new Set<string>();

  beforeAll(() => {
    db = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL! } } });
  });

  afterEach(async () => {
    const ids = [...companyIds];
    companyIds.clear();
    if (ids.length > 0) await db.company.deleteMany({ where: { id: { in: ids } } });
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  async function company(label: string) {
    const created = await db.company.create({
      data: {
        realmId: `historical-observation-${label}-${randomUUID()}`,
        legalName: `${label} Legal`,
        nickname: label,
      },
    });
    companyIds.add(created.id);
    return created;
  }

  async function transaction(companyId: string, rawData: unknown = { CurrencyRef: { value: 'CAD' } }) {
    return db.transaction.create({
      data: {
        companyId,
        qboId: `purchase-${randomUUID()}`,
        qboType: 'Purchase',
        qboSyncToken: '3',
        date: new Date('2026-06-15T00:00:00.000Z'),
        payee: 'Synthetic historical vendor',
        memo: 'Synthetic historical memo',
        amount: '-113.00',
        bankAccount: 'Synthetic bank account',
        status: 'POSTED',
        category: 'Synthetic inventory',
        categoryQboId: 'synthetic-category',
        taxCalculation: 'TaxExcluded',
        taxCode: 'Synthetic tax',
        taxCodeQboId: 'synthetic-tax',
        rawData: rawData as never,
      },
    });
  }

  async function counts(companyId: string) {
    const [
      observations,
      transactions,
      cases,
      rules,
      candidates,
      candidateEvidence,
      candidateFolds,
      mutationAttempts,
    ] = await Promise.all([
      db.historicalClassificationObservation.count({ where: { companyId } }),
      db.transaction.count({ where: { companyId } }),
      db.classificationCase.count({ where: { companyId } }),
      db.rule.count({ where: { companyId } }),
      db.autopilotRuleCandidate.count({ where: { companyId } }),
      db.autopilotRuleCandidateEvidence.count({ where: { companyId } }),
      db.autopilotRuleCandidateFold.count({ where: { companyId } }),
      db.qboMutationAttempt.count({ where: { transaction: { companyId } } }),
    ]);
    return {
      observations, transactions, cases, rules, candidates, candidateEvidence, candidateFolds, mutationAttempts,
    };
  }

  async function latestCorpusRevision(companyId: string): Promise<bigint> {
    return (await db.classificationCorpusRevision.findFirstOrThrow({
      where: { companyId },
      orderBy: { revision: 'desc' },
    })).revision;
  }

  function validObservation(companyId: string, sourceTransactionId: string) {
    return {
      companyId,
      sourceTransactionId,
      sourceQboType: 'Purchase',
      sourceQboId: `source-${randomUUID()}`,
      sourceTransactionRevision: 3,
      sourceQboSyncToken: '3',
      sourceStatus: 'POSTED',
      sourceUpdatedAt: new Date('2026-06-15T12:00:00.000Z'),
      transactionDate: new Date('2026-06-15T00:00:00.000Z'),
      payee: 'Synthetic historical vendor',
      memo: 'Synthetic historical memo',
      amountCents: -11300n,
      currency: 'CAD',
      sourceAccountName: 'Synthetic bank account',
      categoryName: 'Synthetic inventory',
      categoryQboId: 'synthetic-category',
      taxCalculation: 'TaxExcluded',
      taxCodeName: 'Synthetic tax',
      taxCodeQboId: 'synthetic-tax',
      tagNames: ['Synthetic tag'],
    };
  }

  it('accepts one observation per source revision and advances the corpus revision only on insert and delete', async () => {
    const companyA = await company('Observation A');
    const source = await transaction(companyA.id);
    const before = await latestCorpusRevision(companyA.id);
    const observation = validObservation(companyA.id, source.id);
    const row = await db.historicalClassificationObservation.create({ data: observation });
    const afterInsert = await latestCorpusRevision(companyA.id);
    expect(afterInsert).toBeGreaterThan(before);
    await expect(db.historicalClassificationObservation.create({ data: observation })).rejects.toMatchObject({ code: 'P2002' });

    await db.historicalClassificationObservation.update({
      where: { id: row.id }, data: { memo: 'Updated display text only' },
    });
    expect(await latestCorpusRevision(companyA.id)).toBe(afterInsert);

    await db.historicalClassificationObservation.delete({ where: { id: row.id } });
    expect(await latestCorpusRevision(companyA.id)).toBeGreaterThan(afterInsert);
  });

  it('rejects duplicate source revision identities', async () => {
    const companyA = await company('Duplicate A');
    const source = await transaction(companyA.id);
    const observation = validObservation(companyA.id, source.id);
    observation.sourceQboId = 'duplicate-source';
    await db.historicalClassificationObservation.create({ data: observation });
    await expect(db.historicalClassificationObservation.create({ data: observation })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('rejects a source transaction from another company', async () => {
    const companyA = await company('Tenant A');
    const companyB = await company('Tenant B');
    const transactionB = await transaction(companyB.id);

    await expect(db.historicalClassificationObservation.create({
      data: validObservation(companyA.id, transactionB.id),
    })).rejects.toMatchObject({ code: 'P2003' });
  });

  it('enforces posted source status and a nonnegative source revision', async () => {
    const companyA = await company('Constraint A');
    const source = await transaction(companyA.id);

    await expect(db.historicalClassificationObservation.create({
      data: { ...validObservation(companyA.id, source.id), sourceStatus: 'PENDING' },
    })).rejects.toThrow();
    await expect(db.historicalClassificationObservation.create({
      data: { ...validObservation(companyA.id, source.id), sourceTransactionRevision: -1 },
    })).rejects.toThrow();
  });

  it('atomically snapshots only a valid projected currency without promoting source rows', async () => {
    const companyA = await company('Apply currency source');
    await transaction(companyA.id, { CurrencyRef: { value: 'CAD' } });
    await transaction(companyA.id, { CurrencyRef: { value: 'cad' } });
    await transaction(companyA.id, { CurrencyRef: { value: { code: 'CAD' } } });
    await transaction(companyA.id, {});
    const before = await counts(companyA.id);

    const first = await backfillHistoricalClassificationObservations({
      companyId: companyA.id, startDate: '2025-01-01', endDate: '2026-12-31', dryRun: false,
    }, db);
    const afterFirst = await counts(companyA.id);
    const second = await backfillHistoricalClassificationObservations({
      companyId: companyA.id, startDate: '2025-01-01', endDate: '2026-12-31', dryRun: false,
    }, db);
    const afterSecond = await counts(companyA.id);

    expect(first).toMatchObject({ eligible: 1, inserted: 1, existing: 0 });
    expect(first.excluded.missing_currency).toBe(3);
    expect(afterFirst.observations).toBe(before.observations + 1);
    expect(afterFirst.transactions).toBe(before.transactions);
    expect(afterFirst.cases).toBe(before.cases);
    expect(afterFirst.rules).toBe(before.rules);
    expect(afterFirst.candidates).toBe(before.candidates);
    expect(afterFirst.candidateEvidence).toBe(before.candidateEvidence);
    expect(afterFirst.candidateFolds).toBe(before.candidateFolds);
    expect(afterFirst.mutationAttempts).toBe(before.mutationAttempts);
    expect(second).toMatchObject({ eligible: 1, inserted: 0, existing: 1 });
    expect(afterSecond).toEqual(afterFirst);
  });
});
