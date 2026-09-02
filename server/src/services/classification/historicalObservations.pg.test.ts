import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

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

  async function transaction(companyId: string) {
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
      },
    });
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
});
