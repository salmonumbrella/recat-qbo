import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createCompanyReadService,
  transactionReadInclude,
  type CompanyReadDb,
} from './companyReads.js';
import {
  PrismaClassificationSearchRepository,
  searchClassificationMemorySnapshot,
} from './classification/search.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;

describePostgres('classification company reads on PostgreSQL', () => {
  let db: PrismaClient;
  const companyIds = new Set<string>();
  const userIds = new Set<string>();

  beforeAll(() => {
    db = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL! } } });
  });

  afterEach(async () => {
    if (companyIds.size > 0) {
      await db.company.deleteMany({ where: { id: { in: [...companyIds] } } });
      companyIds.clear();
    }
    if (userIds.size > 0) {
      await db.user.deleteMany({ where: { id: { in: [...userIds] } } });
      userIds.clear();
    }
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  it('projects a terminal retry successor instead of an older RETRYABLE attempt', async () => {
    const suffix = randomUUID();
    const company = await db.company.create({
      data: {
        realmId: `company-read-retry-${suffix}`,
        legalName: 'Retry Read Legal',
        nickname: 'Retry Read',
      },
    });
    companyIds.add(company.id);
    const transaction = await db.transaction.create({
      data: {
        companyId: company.id,
        qboId: `retry-${suffix}`,
        qboType: 'Purchase',
        qboSyncToken: '2',
        date: new Date('2026-09-02T00:00:00.000Z'),
        payee: 'Retry fixture',
        amount: '-10.00',
        bankAccount: 'Synthetic operating',
        status: 'PENDING',
        revision: 2,
      },
    });
    await db.qboMutationAttempt.createMany({
      data: [
        {
          transactionId: transaction.id,
          requestId: `retry-old-${suffix}`,
          operation: 'restore',
          status: 'RETRYABLE',
          expectedRevision: 1,
          expectedSyncToken: '1',
          requestHash: 'a'.repeat(64),
          requestPayload: {},
          beforeSnapshot: {},
          createdAt: new Date('2026-09-02T01:00:00.000Z'),
        },
        {
          transactionId: transaction.id,
          requestId: `retry-new-${suffix}`,
          operation: 'restore',
          status: 'VERIFIED',
          expectedRevision: 1,
          expectedSyncToken: '1',
          requestHash: 'b'.repeat(64),
          requestPayload: {},
          beforeSnapshot: {},
          createdAt: new Date('2026-09-02T02:00:00.000Z'),
        },
      ],
    });

    const row = await db.transaction.findUnique({
      where: { id: transaction.id },
      include: transactionReadInclude,
    });

    expect(row?.qboMutationAttempts).toEqual([expect.objectContaining({
      requestId: `retry-new-${suffix}`,
      operation: 'restore',
      status: 'VERIFIED',
    })]);
  });

  it('reads canonical rule, candidate, case, test, and search state through company fences', async () => {
    const suffix = randomUUID();
    const company = await db.company.create({
      data: { realmId: `company-reads-${suffix}`, legalName: 'Company Reads Legal', nickname: 'Company Reads' },
    });
    companyIds.add(company.id);
    const user = await db.user.create({ data: { email: `company-reads-${suffix}@example.test` } });
    userIds.add(user.id);
    await db.membership.create({ data: { userId: user.id, companyId: company.id, role: 'categorizer' } });
    const account = await db.qboAccount.create({
      data: {
        companyId: company.id,
        qboId: 'account-meals',
        name: 'Meals',
        fullName: 'Expenses · Meals',
        classification: 'Expense',
      },
    });
    const transaction = await db.transaction.create({
      data: {
        companyId: company.id,
        qboId: `purchase-${suffix}`,
        qboType: 'Purchase',
        qboSyncToken: '1',
        date: new Date('2026-08-30T00:00:00.000Z'),
        payee: 'Coffee Shop',
        memo: 'Team coffee',
        amount: '-12.00',
        bankAccount: 'Operating',
      },
    });
    const attempt = await db.qboMutationAttempt.create({
      data: {
        transactionId: transaction.id,
        requestId: `company-reads-${suffix}`,
        operation: 'post',
        status: 'VERIFIED',
        expectedRevision: 0,
        expectedSyncToken: '1',
        requestHash: 'a'.repeat(64),
        requestPayload: {},
        beforeSnapshot: {},
      },
    });
    const classificationCase = await db.classificationCase.create({
      data: {
        companyId: company.id,
        transactionId: transaction.id,
        qboMutationAttemptId: attempt.id,
        action: { categoryQboId: account.qboId, taxCalculation: 'NotApplicable', taxCodeQboId: null, tagIds: [] },
        actionFingerprint: 'b'.repeat(64),
        originIntent: 'apply_once',
        rationale: 'Verified coffee purchase.',
        requiredEvidence: [],
        examples: ['Coffee Shop'],
        counterexamples: [],
        citations: [],
        reviewer: { userId: user.id, configVersion: 'config-1', decision: 'approved' },
        jurisdiction: 'unknown',
        currency: 'CAD',
        context: { transactionDirection: 'out', qboType: 'Purchase', sourceAccountName: 'Operating', businessPurpose: null },
        provenance: { source: 'qbo_verified', sourceId: attempt.id, actorId: user.id, recordedAt: '2026-08-30T00:00:00.000Z' },
        transactionSnapshot: { privateSnapshotSentinel: true },
        verifiedAt: new Date('2026-08-30T00:00:00.000Z'),
      },
    });
    await db.classificationCaseInvalidation.create({
      data: {
        companyId: company.id,
        classificationCaseId: classificationCase.id,
        invalidatedAt: new Date('2026-08-31T00:00:00.000Z'),
        reason: 'Superseded by correction.',
      },
    });
    const rule = await db.rule.create({
      data: {
        companyId: company.id,
        matchText: 'Coffee',
        category: account.name,
        categoryQboId: account.qboId,
        taxCalculation: 'NotApplicable',
        revision: 1,
        originIntent: 'make_recurring',
      },
    });
    await db.ruleRevision.create({
      data: {
        ruleId: rule.id,
        companyId: company.id,
        revision: 1,
        state: 'enabled',
        matchText: 'Coffee',
        category: account.name,
        categoryQboId: account.qboId,
        taxCalculation: 'NotApplicable',
        priority: 0,
        autoPost: false,
        originIntent: 'make_recurring',
        changedBy: user.id,
      },
    });
    const candidate = await db.autopilotRuleCandidate.create({
      data: {
        companyId: company.id,
        conditionFingerprint: 'c'.repeat(64),
        schemaVersion: 'rule-candidate-v1',
        configVersion: 'config-1',
        matchText: 'Coffee',
        state: 'conflict',
        winningActionFingerprint: 'd'.repeat(64),
        categoryQboId: account.qboId,
        taxCalculation: 'NotApplicable',
        evidenceCount: 2,
        conflictingEvidenceCount: 1,
      },
    });
    const gatheringCandidate = await db.autopilotRuleCandidate.create({
      data: {
        companyId: company.id, conditionFingerprint: 'f'.repeat(64),
        schemaVersion: 'rule-candidate-v1', configVersion: 'config-1',
        matchText: 'Coffee gathering', state: 'gathering', evidenceCount: 1,
        conflictingEvidenceCount: 0,
      },
    });
    await db.autopilotRuleCandidateEvidence.create({
      data: {
        companyId: company.id,
        candidateId: candidate.id,
        transactionId: transaction.id,
        inputRevision: 0,
        requestId: `candidate-evidence-${suffix}`,
        source: 'autopilot',
        polarity: 'negative',
        actionFingerprint: 'e'.repeat(64),
        pattern: { privatePatternSentinel: true },
        active: false,
        observedAt: new Date('2026-08-30T00:00:00.000Z'),
        invalidatedAt: new Date('2026-08-31T00:00:00.000Z'),
        invalidationReason: 'Superseded.',
      },
    });

    const repository = new PrismaClassificationSearchRepository(db);
    const service = createCompanyReadService(
      db as unknown as CompanyReadDb,
      'company-reads-pg-cursor-secret',
      {
        classificationSearch: (input) => searchClassificationMemorySnapshot(input, { repository, semantic: null }),
      },
    );

    const [ruleRead, candidates, candidateRead, caseRead, tested, searched] = await Promise.all([
      service.getRule(user.id, company.id, rule.id),
      service.listRuleCandidates(user.id, company.id, { limit: 10 }),
      service.getRuleCandidate(user.id, company.id, candidate.id),
      service.getClassificationCase(user.id, company.id, classificationCase.id),
      service.testRule(user.id, company.id, { matchText: 'Coffee', limit: 10 }),
      service.searchClassificationKnowledge(user.id, company.id, { query: 'Coffee', mode: 'lexical', limit: 10 }),
    ]);

    expect(ruleRead).toMatchObject({
      active: true, executable: true,
      revision: { revision: 1, state: 'enabled', valid: true, invalidReasons: [] },
    });
    expect(candidates.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: candidate.id, state: 'conflict', executable: false }),
      expect.objectContaining({ id: gatheringCandidate.id, state: 'gathering', executable: false }),
    ]));
    expect(candidateRead.evidence).toEqual([expect.objectContaining({
      polarity: 'negative', active: false, invalidationReason: 'Superseded.',
    })]);
    expect(caseRead).toMatchObject({ invalidationReason: 'Superseded by correction.' });
    expect(JSON.stringify(caseRead)).not.toContain('privateSnapshotSentinel');
    expect(JSON.stringify(candidateRead)).not.toContain('privatePatternSentinel');
    expect(tested.samples).toEqual([expect.objectContaining({ transactionId: transaction.id })]);
    expect(searched.items.map((item) => item.id)).toContain(`rule:${rule.id}`);

    const firstPage = await service.searchClassificationKnowledge(user.id, company.id, {
      query: 'Coffee', mode: 'lexical', limit: 1,
    });
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    await db.rule.create({
      data: {
        companyId: company.id, matchText: 'Coffee new', category: account.name,
        categoryQboId: account.qboId, taxCalculation: 'NotApplicable', revision: 1,
        originIntent: 'make_recurring',
      },
    });
    await expect(service.searchClassificationKnowledge(user.id, company.id, {
      query: 'Coffee', mode: 'lexical', limit: 1, cursor: firstPage.nextCursor ?? undefined,
    })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });

    const expectRuleAndSearchAdvisory = async () => {
      const [currentRule, currentSearch] = await Promise.all([
        service.getRule(user.id, company.id, rule.id),
        service.searchClassificationKnowledge(user.id, company.id, {
          query: 'Coffee', mode: 'exact', limit: 20,
        }),
      ]);
      expect(currentRule).toMatchObject({
        executable: false,
        revision: {
          action: null, valid: false,
          invalidReasons: expect.arrayContaining(['Category account is missing or inactive.']),
        },
      });
      expect(currentSearch.items.find((item) => item.id === `rule:${rule.id}`)).toMatchObject({
        action: null, executable: false, advisory: true,
        actionSummary: { categoryName: account.name },
      });
    };
    await db.qboAccount.update({ where: { id: account.id }, data: { active: false } });
    await expectRuleAndSearchAdvisory();
    await db.qboAccount.delete({ where: { id: account.id } });
    await expectRuleAndSearchAdvisory();

    const legacyRule = await db.rule.create({
      data: {
        companyId: company.id, matchText: 'Legacy', category: 'Historical category',
        categoryQboId: null, taxCalculation: null, revision: 1, originIntent: null,
      },
    });
    await db.ruleRevision.create({
      data: {
        ruleId: legacyRule.id, companyId: company.id, revision: 1, state: 'enabled',
        matchText: 'Legacy', category: 'Historical category', categoryQboId: null,
        taxCalculation: null, priority: 0, autoPost: false,
      },
    });
    await expect(service.getRule(user.id, company.id, legacyRule.id)).resolves.toMatchObject({
      active: true, executable: false,
      revision: { action: null, valid: false },
    });
  });

  it('reads advisory observations without mutation and excludes the selected observation source', async () => {
    const suffix = randomUUID();
    const company = await db.company.create({
      data: { realmId: `company-read-observation-${suffix}`, legalName: 'Observation Read Legal', nickname: 'Observation Read' },
    });
    companyIds.add(company.id);
    const user = await db.user.create({ data: { email: `observation-read-${suffix}@example.test` } });
    userIds.add(user.id);
    await db.membership.create({ data: { userId: user.id, companyId: company.id, role: 'viewer' } });
    const transaction = await db.transaction.create({
      data: {
        companyId: company.id, qboId: `northwind-${suffix}`, qboType: 'Purchase', qboSyncToken: '1',
        date: new Date('2026-08-30T00:00:00.000Z'), payee: 'Northwind Fixture Supplies',
        memo: 'Advisory historical fixture', amount: '-113.00', bankAccount: 'Synthetic operating',
        status: 'POSTED', revision: 1, rawData: { CurrencyRef: { value: 'CAD' } },
      },
    });
    const observation = await db.historicalClassificationObservation.create({
      data: {
        companyId: company.id, sourceTransactionId: transaction.id, sourceQboType: 'Purchase',
        sourceQboId: transaction.qboId, sourceTransactionRevision: 1, sourceQboSyncToken: '1',
        sourceStatus: 'POSTED', sourceUpdatedAt: new Date('2026-08-30T00:00:00.000Z'),
        transactionDate: transaction.date, payee: 'Northwind Fixture Supplies',
        memo: 'Advisory historical fixture', amountCents: -11300n, currency: 'CAD',
        sourceAccountName: 'Synthetic operating', categoryName: 'Inventory',
        categoryQboId: 'inventory-fixture', taxCalculation: 'NotApplicable',
        taxCodeName: null, taxCodeQboId: null, tagNames: [],
      },
    });
    const repository = new PrismaClassificationSearchRepository(db);
    const service = createCompanyReadService(
      db as unknown as CompanyReadDb,
      'company-read-observation-cursor-secret',
      { classificationSearch: (input) => searchClassificationMemorySnapshot(input, { repository, semantic: null }) },
    );
    const counts = async () => Promise.all([
      db.transaction.count({ where: { companyId: company.id } }),
      db.historicalClassificationObservation.count({ where: { companyId: company.id } }),
      db.classificationCase.count({ where: { companyId: company.id } }),
      db.autopilotRuleCandidate.count({ where: { companyId: company.id } }),
      db.autopilotRuleCandidateEvidence.count({ where: { companyId: company.id } }),
      db.autopilotRuleCandidateFold.count({ where: { companyId: company.id } }),
      db.rule.count({ where: { companyId: company.id } }),
      db.ruleRevision.count({ where: { companyId: company.id } }),
      db.qboMutationAttempt.count({ where: { transactionId: transaction.id } }),
    ]);
    const before = await counts();

    const page = await service.searchClassificationKnowledge(user.id, company.id, {
      query: 'northwind', mode: 'lexical', limit: 20,
    });
    expect(page.items).toContainEqual(expect.objectContaining({
      sourceId: observation.id, kind: 'historical_observation', advisory: true,
      executable: false, action: null,
    }));
    await expect(counts()).resolves.toEqual(before);

    const selfExcluded = await service.searchClassificationKnowledge(user.id, company.id, {
      query: 'northwind', mode: 'lexical', limit: 20, transactionId: transaction.id,
    });
    expect(selfExcluded.items.map(({ sourceId }) => sourceId)).not.toContain(observation.id);
    await expect(counts()).resolves.toEqual(before);
  });
});
