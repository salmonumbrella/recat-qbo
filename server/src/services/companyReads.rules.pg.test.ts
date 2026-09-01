import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { RuleLifecycleFilter, RuleLifecyclePageDto } from '@recat/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createCompanyReadService,
  type CompanyReadDb,
} from './companyReads.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;

describePostgres('rule lifecycle collection PostgreSQL reads', () => {
  let db: PrismaClient;
  const companyIds = new Set<string>();
  const userIds = new Set<string>();

  beforeAll(() => {
    db = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL! } } });
  });

  afterEach(async () => {
    await db.company.deleteMany({ where: { id: { in: [...companyIds] } } });
    await db.user.deleteMany({ where: { id: { in: [...userIds] } } });
    companyIds.clear();
    userIds.clear();
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  async function seedRule(
    companyId: string,
    userId: string,
    accountQboId: string,
    input: {
      matchText: string;
      priority: number;
      state: 'enabled' | 'disabled' | 'retired';
      createdAt?: Date;
    },
  ) {
    const retiredAt = input.state === 'retired' ? new Date('2026-08-30T03:00:00.000Z') : null;
    const rule = await db.rule.create({
      data: {
        companyId,
        matchText: input.matchText,
        category: 'Meals',
        categoryQboId: accountQboId,
        taxCalculation: 'NotApplicable',
        enabled: input.state === 'enabled',
        retiredAt,
        revision: 1,
        priority: input.priority,
        originIntent: 'make_recurring',
        ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
      },
    });
    await db.ruleRevision.create({
      data: {
        companyId,
        ruleId: rule.id,
        revision: 1,
        state: input.state,
        matchText: input.matchText,
        category: 'Meals',
        categoryQboId: accountQboId,
        taxCalculation: 'NotApplicable',
        priority: input.priority,
        autoPost: false,
        originIntent: 'make_recurring',
        changedBy: userId,
        retiredAt,
        ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
      },
    });
    return rule;
  }

  async function listLifecycle(
    service: ReturnType<typeof createCompanyReadService>,
    userId: string,
    companyId: string,
    input: { state: RuleLifecycleFilter; limit: number; cursor?: string },
  ): Promise<RuleLifecyclePageDto> {
    return service.listRuleLifecycle(userId, companyId, input);
  }

  it('rediscovers disabled and retired rules through explicit company-scoped filters', async () => {
    const suffix = randomUUID();
    const company = await db.company.create({
      data: {
        realmId: `lifecycle-${suffix}`,
        legalName: 'Lifecycle Legal',
        nickname: 'Lifecycle',
        disconnectedAt: new Date('2026-08-31T00:00:00.000Z'),
      },
    });
    const foreign = await db.company.create({
      data: { realmId: `foreign-${suffix}`, legalName: 'Foreign Legal', nickname: 'Foreign' },
    });
    companyIds.add(company.id);
    companyIds.add(foreign.id);
    const user = await db.user.create({ data: { email: `lifecycle-${suffix}@example.test` } });
    userIds.add(user.id);
    await db.membership.create({ data: { userId: user.id, companyId: company.id, role: 'categorizer' } });
    await db.qboAccount.createMany({ data: [company.id, foreign.id].map((companyId) => ({
      companyId, qboId: 'account-meals', name: 'Meals', fullName: 'Expenses · Meals', classification: 'Expense',
    })) });
    const enabled = await seedRule(company.id, user.id, 'account-meals', {
      matchText: 'Enabled vendor', priority: 0, state: 'enabled',
    });
    const disabled = await seedRule(company.id, user.id, 'account-meals', {
      matchText: 'Disabled vendor', priority: 1, state: 'disabled',
    });
    const retired = await seedRule(company.id, user.id, 'account-meals', {
      matchText: 'Retired vendor', priority: 2, state: 'retired',
    });
    await seedRule(foreign.id, user.id, 'account-meals', {
      matchText: 'Foreign vendor', priority: -1, state: 'disabled',
    });
    const service = createCompanyReadService(
      db as unknown as CompanyReadDb,
      'rule-lifecycle-pg-cursor-secret',
    );

    const [enabledPage, disabledPage, retiredPage, allPage] = await Promise.all([
      listLifecycle(service, user.id, company.id, { state: 'enabled', limit: 10 }),
      listLifecycle(service, user.id, company.id, { state: 'disabled', limit: 10 }),
      listLifecycle(service, user.id, company.id, { state: 'retired', limit: 10 }),
      listLifecycle(service, user.id, company.id, { state: 'all', limit: 10 }),
    ]);

    expect(enabledPage.items.map((item) => item.revision.ruleId)).toEqual([enabled.id]);
    expect(disabledPage.items).toEqual([
      expect.objectContaining({ active: false, executable: false, revision: expect.objectContaining({
        ruleId: disabled.id, state: 'disabled', revision: 1, valid: true,
      }) }),
    ]);
    expect(retiredPage.items).toEqual([
      expect.objectContaining({ active: false, executable: false, revision: expect.objectContaining({
        ruleId: retired.id, state: 'retired', revision: 1, valid: true,
      }) }),
    ]);
    expect(allPage.items.map((item) => item.revision.ruleId)).toEqual([
      enabled.id, disabled.id, retired.id,
    ]);
  });

  it('binds deterministic pagination to the exact actor, tenant, filter, limit, and population', async () => {
    const suffix = randomUUID();
    const company = await db.company.create({ data: {
      realmId: `paging-${suffix}`, legalName: 'Paging Legal', nickname: 'Paging',
      disconnectedAt: new Date('2026-08-31T00:00:00.000Z'),
    } });
    const foreign = await db.company.create({ data: {
      realmId: `paging-foreign-${suffix}`, legalName: 'Paging Foreign Legal', nickname: 'Paging Foreign',
    } });
    companyIds.add(company.id);
    companyIds.add(foreign.id);
    const user = await db.user.create({ data: { email: `paging-${suffix}@example.test` } });
    const otherUser = await db.user.create({ data: { email: `paging-other-${suffix}@example.test` } });
    userIds.add(user.id);
    userIds.add(otherUser.id);
    await db.membership.createMany({ data: [
      { userId: user.id, companyId: company.id, role: 'categorizer' },
      { userId: user.id, companyId: foreign.id, role: 'categorizer' },
      { userId: otherUser.id, companyId: company.id, role: 'categorizer' },
    ] });
    await db.qboAccount.create({ data: {
      companyId: company.id, qboId: 'account-meals', name: 'Meals',
      fullName: 'Expenses · Meals', classification: 'Expense',
    } });
    const newest = await seedRule(company.id, user.id, 'account-meals', {
      matchText: 'Newest', priority: 0, state: 'disabled',
      createdAt: new Date('2026-08-30T03:00:00.000Z'),
    });
    const older = await seedRule(company.id, user.id, 'account-meals', {
      matchText: 'Older', priority: 0, state: 'disabled',
      createdAt: new Date('2026-08-30T02:00:00.000Z'),
    });
    const laterPriority = await seedRule(company.id, user.id, 'account-meals', {
      matchText: 'Later priority', priority: 1, state: 'disabled',
      createdAt: new Date('2026-08-30T04:00:00.000Z'),
    });
    const service = createCompanyReadService(
      db as unknown as CompanyReadDb,
      'rule-lifecycle-paging-cursor-secret',
    );

    await expect(listLifecycle(service, user.id, company.id, {
      state: 'unknown' as RuleLifecycleFilter, limit: 1,
    })).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    const first = await listLifecycle(service, user.id, company.id, { state: 'disabled', limit: 1 });
    expect(first.items.map((item) => item.revision.ruleId)).toEqual([newest.id]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const cursor = first.nextCursor ?? '';

    const second = await listLifecycle(service, user.id, company.id, {
      state: 'disabled', limit: 1, cursor,
    });
    expect(second.items.map((item) => item.revision.ruleId)).toEqual([older.id]);

    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith('a') ? 'b' : 'a'}`;
    await expect(listLifecycle(service, user.id, company.id, {
      state: 'disabled', limit: 1, cursor: tampered,
    })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    await expect(listLifecycle(service, user.id, company.id, {
      state: 'all', limit: 1, cursor,
    })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    await expect(listLifecycle(service, user.id, company.id, {
      state: 'disabled', limit: 2, cursor,
    })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    await expect(listLifecycle(service, otherUser.id, company.id, {
      state: 'disabled', limit: 1, cursor,
    })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    await expect(listLifecycle(service, user.id, foreign.id, {
      state: 'disabled', limit: 1, cursor,
    })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });

    await db.rule.update({
      where: { id: laterPriority.id },
      data: { priority: 2, revision: 2 },
    });
    await db.ruleRevision.create({ data: {
      companyId: company.id, ruleId: laterPriority.id, revision: 2, state: 'disabled',
      matchText: 'Later priority', category: 'Meals', categoryQboId: 'account-meals',
      taxCalculation: 'NotApplicable', priority: 2, autoPost: false,
      originIntent: 'make_recurring', changedBy: user.id,
    } });
    await expect(listLifecycle(service, user.id, company.id, {
      state: 'disabled', limit: 1, cursor,
    })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
  });
});
