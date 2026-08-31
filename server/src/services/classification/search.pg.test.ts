import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  PrismaClassificationSearchRepository,
  searchClassificationMemory,
} from './search.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;

describePostgres('classification search on PostgreSQL', () => {
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

  async function company(name: string) {
    const created = await db.company.create({
      data: {
        realmId: `search-${randomUUID()}`,
        legalName: `${name} Legal`,
        nickname: name,
      },
    });
    companyIds.add(created.id);
    return created;
  }

  async function fixtures() {
    const current = await company('Delicious Milk');
    const foreign = await company('Amy Canada');
    const account = await db.qboAccount.create({
      data: {
        companyId: current.id,
        qboId: 'account-cogs',
        name: 'Inventory purchases',
        fullName: 'Cost of Goods Sold · Inventory purchases',
        classification: 'COGS',
      },
    });
    const taxCode = await db.qboTaxCode.create({
      data: {
        companyId: current.id,
        qboId: 'tax-hst-13',
        name: 'HST ON 13%',
        active: true,
        taxable: true,
        purchaseTaxRateList: [],
      },
    });
    const vendor = await db.vendorIdentity.create({
      data: {
        companyId: current.id,
        displayName: 'Coach Canada',
        normalizedName: 'coach canada',
      },
    });
    const alias = await db.vendorAlias.create({
      data: {
        companyId: current.id,
        vendorIdentityId: vendor.id,
        value: 'COACH Calgary Chinook',
        normalizedValue: 'coach calgary chinook',
        source: 'user',
      },
    });
    const foreignVendor = await db.vendorIdentity.create({
      data: {
        companyId: foreign.id,
        displayName: 'Coach Personal Purchase',
        normalizedName: 'coach personal purchase',
      },
    });
    await db.vendorAlias.create({
      data: {
        companyId: foreign.id,
        vendorIdentityId: foreignVendor.id,
        value: 'COACH Calgary Chinook',
        normalizedValue: 'coach calgary chinook',
        source: 'user',
      },
    });
    const rule = await db.rule.create({
      data: {
        companyId: current.id,
        matchText: 'Coach Ontario Outlet',
        category: account.name,
        categoryQboId: account.qboId,
        taxCalculation: 'TaxExcluded',
        taxCode: taxCode.name,
        taxCodeQboId: taxCode.qboId,
        revision: 2,
        originIntent: 'make_recurring',
      },
    });
    await db.rule.create({
      data: {
        companyId: current.id,
        matchText: 'Coach retired old rule',
        category: account.name,
        categoryQboId: account.qboId,
        enabled: false,
        retiredAt: new Date('2026-08-01T00:00:00.000Z'),
      },
    });
    const candidate = await db.autopilotRuleCandidate.create({
      data: {
        companyId: current.id,
        conditionFingerprint: randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64),
        schemaVersion: 'v2',
        configVersion: 'synthetic',
        matchText: 'Coach warehouse inventory',
        state: 'conflict',
        winningActionFingerprint: 'a'.repeat(64),
        categoryQboId: account.qboId,
        taxCalculation: 'TaxExcluded',
        taxCodeQboId: taxCode.qboId,
        evidenceCount: 3,
        conflictingEvidenceCount: 1,
      },
    });
    await db.autopilotRuleCandidate.create({
      data: {
        companyId: current.id,
        conditionFingerprint: randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64),
        schemaVersion: 'v2',
        configVersion: 'synthetic',
        matchText: 'Coach gathering hidden',
        state: 'gathering',
      },
    });
    const transaction = await db.transaction.create({
      data: {
        companyId: current.id,
        qboId: `purchase-${randomUUID()}`,
        qboType: 'Purchase',
        qboSyncToken: '1',
        date: new Date('2026-06-15T00:00:00.000Z'),
        payee: 'Coach Yorkdale',
        memo: 'Wholesale handbags for resale',
        amount: '-113.00',
        bankAccount: 'Synthetic Bank',
        category: account.name,
        categoryQboId: account.qboId,
        taxCalculation: 'TaxExcluded',
        taxCode: taxCode.name,
        taxCodeQboId: taxCode.qboId,
      },
    });
    const attempt = await db.qboMutationAttempt.create({
      data: {
        transactionId: transaction.id,
        requestId: `search-${randomUUID()}`,
        operation: 'post',
        status: 'VERIFIED',
        expectedRevision: 0,
        expectedSyncToken: '1',
        requestHash: 'b'.repeat(64),
        requestPayload: {},
        beforeSnapshot: {},
      },
    });
    const classificationCase = await db.classificationCase.create({
      data: {
        companyId: current.id,
        transactionId: transaction.id,
        vendorIdentityId: vendor.id,
        qboMutationAttemptId: attempt.id,
        action: {
          categoryQboId: account.qboId,
          taxCalculation: 'TaxExcluded',
          taxCodeQboId: taxCode.qboId,
          tagIds: [],
        },
        actionFingerprint: 'c'.repeat(64),
        originIntent: 'apply_once',
        rationale: 'Ontario thirteen percent HST input tax credit on inventory.',
        requiredEvidence: ['Invoice showing Ontario ship-to location'],
        examples: ['Wholesale handbags bought for resale'],
        counterexamples: ['Personal handbag purchase'],
        citations: [],
        reviewer: { userId: null, configVersion: 'synthetic', decision: 'approved' },
        jurisdiction: 'CA-ON',
        currency: 'CAD',
        context: {
          transactionDirection: 'out',
          qboType: 'Purchase',
          sourceAccountName: 'Synthetic Bank',
          businessPurpose: 'Inventory resale',
        },
        provenance: {
          source: 'qbo_verified',
          sourceId: attempt.requestId,
          actorId: null,
          recordedAt: '2026-06-15T00:00:00.000Z',
        },
        transactionSnapshot: {},
        verifiedAt: new Date('2026-06-15T00:00:00.000Z'),
      },
    });
    return { current, foreign, alias, rule, candidate, classificationCase };
  }

  it('finds live aliases, rules, candidates, and case evidence while excluding inactive rows', async () => {
    const data = await fixtures();
    const repository = new PrismaClassificationSearchRepository(db);

    const aliasResult = await searchClassificationMemory({
      query: 'COACH Calgary Chinook',
      companyId: data.current.id,
      scope: 'current_company',
      mode: 'exact',
      accessibleCompanyIds: [data.current.id, data.foreign.id],
    }, { repository, semantic: null });
    expect(aliasResult.hits.map((candidate) => candidate.id))
      .toContain(`vendor_alias:${data.alias.id}`);
    expect(aliasResult.hits.every((candidate) => candidate.companyId === data.current.id)).toBe(true);

    const lexical = await searchClassificationMemory({
      query: 'Ontario thirteen percent inventory',
      companyId: data.current.id,
      scope: 'current_company',
      mode: 'lexical',
      accessibleCompanyIds: [data.current.id],
    }, { repository, semantic: null });
    expect(lexical.hits.map((candidate) => candidate.id))
      .toContain(`classification_case:${data.classificationCase.id}`);

    const activeOnly = await repository.search(
      [data.current.id],
      'Coach',
      100,
    );
    expect(activeOnly.map((candidate) => candidate.hit.id)).toEqual(expect.arrayContaining([
      `vendor_alias:${data.alias.id}`,
      `rule:${data.rule.id}`,
      `rule_candidate:${data.candidate.id}`,
      `classification_case:${data.classificationCase.id}`,
    ]));
    expect(activeOnly.some((candidate) => candidate.hit.vendorName === 'Coach retired old rule')).toBe(false);
    expect(activeOnly.some((candidate) => candidate.hit.vendorName === 'Coach gathering hidden')).toBe(false);
  });

  it('reflects writes immediately and rehydration drops invalidated canonical records', async () => {
    const data = await fixtures();
    const repository = new PrismaClassificationSearchRepository(db);

    expect(await repository.search([data.current.id], 'new immediate alias', 20)).toHaveLength(0);
    const vendor = await db.vendorIdentity.findFirstOrThrow({ where: { companyId: data.current.id } });
    const created = await db.vendorAlias.create({
      data: {
        companyId: data.current.id,
        vendorIdentityId: vendor.id,
        value: 'New immediate alias',
        normalizedValue: 'new immediate alias',
        source: 'user',
      },
    });
    expect((await repository.search([data.current.id], 'new immediate alias', 20))
      .map((candidate) => candidate.hit.id)).toContain(`vendor_alias:${created.id}`);

    await db.classificationCaseInvalidation.create({
      data: {
        companyId: data.current.id,
        classificationCaseId: data.classificationCase.id,
        reason: 'Synthetic correction',
      },
    });
    await expect(repository.rehydrate(
      [data.current.id],
      [`classification_case:${data.classificationCase.id}`],
    )).resolves.toEqual([]);
  });
});
