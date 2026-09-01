import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;

describePostgres('rule lifecycle revision PostgreSQL fence', () => {
  let db: PrismaClient;
  const companyIds = new Set<string>();

  beforeAll(() => {
    db = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL! } } });
  });

  afterEach(async () => {
    await db.company.deleteMany({ where: { id: { in: [...companyIds] } } });
    companyIds.clear();
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  async function fence(companyId: string): Promise<bigint> {
    const rows = await db.$queryRaw<Array<{ revision: bigint }>>`
      SELECT "revision"
        FROM "RuleLifecycleRevision"
       WHERE "companyId" = ${companyId}
    `;
    return rows[0]?.revision ?? -1n;
  }

  async function createRule(companyId: string, suffix: string) {
    return db.rule.create({ data: {
      id: `fence-rule-${suffix}`,
      companyId,
      matchText: 'Fence vendor',
      category: 'Meals',
      priority: 10,
    } });
  }

  it('initializes a zero-state fence for every newly created company', async () => {
    const suffix = randomUUID();
    const company = await db.company.create({ data: {
      realmId: `lifecycle-fence-${suffix}`,
      legalName: 'Lifecycle Fence Legal',
      nickname: 'Lifecycle Fence',
    } });
    companyIds.add(company.id);

    const rows = await db.$queryRaw<Array<{ revision: bigint }>>`
      SELECT "revision"
        FROM "RuleLifecycleRevision"
       WHERE "companyId" = ${company.id}
    `;

    expect(rows).toEqual([{ revision: 0n }]);
  });

  it('bumps the company fence when a rolling old writer inserts a Rule directly', async () => {
    const suffix = randomUUID();
    const company = await db.company.create({ data: {
      realmId: `lifecycle-old-writer-${suffix}`,
      legalName: 'Lifecycle Old Writer Legal',
      nickname: 'Lifecycle Old Writer',
    } });
    companyIds.add(company.id);
    const ruleId = `legacy-rule-${suffix}`;

    await db.$executeRaw`
      INSERT INTO "Rule" ("id", "companyId", "matchText", "category", "updatedAt")
      VALUES (${ruleId}, ${company.id}, 'Legacy vendor', 'Meals', CURRENT_TIMESTAMP)
    `;

    expect(await fence(company.id)).toBeGreaterThan(0n);
    await expect(db.ruleRevision.findUnique({
      where: { companyId_ruleId_revision: { companyId: company.id, ruleId, revision: 0 } },
    })).resolves.not.toBeNull();
  });

  it('ignores unrelated/no-op Rule updates and bumps every lifecycle-visible Rule field', async () => {
    const suffix = randomUUID();
    const company = await db.company.create({ data: {
      realmId: `lifecycle-fields-${suffix}`,
      legalName: 'Lifecycle Fields Legal',
      nickname: 'Lifecycle Fields',
    } });
    companyIds.add(company.id);
    const rule = await db.rule.create({ data: {
      companyId: company.id,
      matchText: 'Original vendor',
      category: 'Meals',
      priority: 10,
    } });
    let expected = await fence(company.id);

    await db.rule.update({ where: { id: rule.id }, data: { matchText: 'Unrelated vendor edit' } });
    expect(await fence(company.id)).toBe(expected);

    await db.rule.update({ where: { id: rule.id }, data: { priority: 11 } });
    expect(await fence(company.id)).toBe(++expected);
    await db.rule.update({ where: { id: rule.id }, data: { revision: 1 } });
    expect(await fence(company.id)).toBe(++expected);
    await db.rule.update({ where: { id: rule.id }, data: { enabled: false } });
    expect(await fence(company.id)).toBe(++expected);
    await db.rule.update({ where: { id: rule.id }, data: {
      retiredAt: new Date('2026-08-31T01:00:00.000Z'),
    } });
    expect(await fence(company.id)).toBe(++expected);
    await db.rule.update({ where: { id: rule.id }, data: {
      createdAt: new Date('2026-08-30T01:00:00.000Z'),
    } });
    expect(await fence(company.id)).toBe(++expected);
    await db.rule.update({ where: { id: rule.id }, data: {
      reviewRequiredAt: new Date('2026-08-31T02:00:00.000Z'),
    } });
    expect(await fence(company.id)).toBe(++expected);
    await db.rule.update({ where: { id: rule.id }, data: { reviewReason: 'References changed.' } });
    expect(await fence(company.id)).toBe(++expected);
  });

  it('fences RuleRevision changes and direct deletes without losing immutable history protections', async () => {
    const suffix = randomUUID();
    const company = await db.company.create({ data: {
      realmId: `lifecycle-history-${suffix}`,
      legalName: 'Lifecycle History Legal',
      nickname: 'Lifecycle History',
    } });
    companyIds.add(company.id);
    const rule = await createRule(company.id, suffix);
    let expected = await fence(company.id);

    await db.ruleRevision.create({ data: {
      companyId: company.id,
      ruleId: rule.id,
      revision: 7,
      state: 'enabled',
      matchText: 'Historical snapshot',
      category: 'Meals',
      priority: 10,
      autoPost: false,
    } });
    expect(await fence(company.id)).toBe(++expected);

    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE "RuleRevision" DISABLE TRIGGER "RuleRevision_append_only"');
      await tx.$executeRaw`UPDATE "RuleRevision" SET "changedBy" = "changedBy" WHERE "id" = ${`rule-revision-${rule.id}`}`;
      expect(await tx.$queryRaw<Array<{ revision: bigint }>>`
        SELECT "revision" FROM "RuleLifecycleRevision" WHERE "companyId" = ${company.id}
      `).toEqual([{ revision: expected }]);
      await tx.$executeRaw`UPDATE "RuleRevision" SET "changedBy" = 'legacy-writer' WHERE "id" = ${`rule-revision-${rule.id}`}`;
      expect(await tx.$queryRaw<Array<{ revision: bigint }>>`
        SELECT "revision" FROM "RuleLifecycleRevision" WHERE "companyId" = ${company.id}
      `).toEqual([{ revision: ++expected }]);
      await tx.$executeRawUnsafe('ALTER TABLE "RuleRevision" ENABLE TRIGGER "RuleRevision_append_only"');
    });

    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE "Rule" DISABLE TRIGGER "Rule_no_delete"');
      await tx.$executeRawUnsafe('ALTER TABLE "RuleRevision" DISABLE TRIGGER "RuleRevision_append_only"');
      await tx.rule.delete({ where: { id: rule.id } });
      const rows = await tx.$queryRaw<Array<{ revision: bigint }>>`
        SELECT "revision" FROM "RuleLifecycleRevision" WHERE "companyId" = ${company.id}
      `;
      expect(rows[0]?.revision).toBeGreaterThan(expected);
      await tx.$executeRawUnsafe('ALTER TABLE "RuleRevision" ENABLE TRIGGER "RuleRevision_append_only"');
      await tx.$executeRawUnsafe('ALTER TABLE "Rule" ENABLE TRIGGER "Rule_no_delete"');
    });
  });

  it('removes the lifecycle fence only with its owning company cascade', async () => {
    const suffix = randomUUID();
    const company = await db.company.create({ data: {
      realmId: `lifecycle-cascade-${suffix}`,
      legalName: 'Lifecycle Cascade Legal',
      nickname: 'Lifecycle Cascade',
    } });
    companyIds.add(company.id);
    await createRule(company.id, suffix);

    await db.company.delete({ where: { id: company.id } });

    expect(await fence(company.id)).toBe(-1n);
  });

  it('does not lose concurrent direct-writer bumps or deadlock reversed company order', async () => {
    const suffix = randomUUID();
    const companies = await Promise.all(['a', 'b'].map((label) => db.company.create({ data: {
      realmId: `lifecycle-concurrency-${label}-${suffix}`,
      legalName: `Lifecycle Concurrency ${label.toUpperCase()} Legal`,
      nickname: `Lifecycle Concurrency ${label.toUpperCase()}`,
    } })));
    companies.forEach((company) => companyIds.add(company.id));
    const [companyA, companyB] = companies;
    const beforeA = await fence(companyA!.id);
    const beforeB = await fence(companyB!.id);
    const writerA = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL! } } });
    const writerB = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL! } } });

    try {
      await Promise.all([
        writerA.$executeRaw`SELECT rule_lifecycle_bump_company_ids(ARRAY[${companyA!.id}, ${companyB!.id}]::text[])`,
        writerB.$executeRaw`SELECT rule_lifecycle_bump_company_ids(ARRAY[${companyB!.id}, ${companyA!.id}]::text[])`,
      ]);
    } finally {
      await Promise.all([writerA.$disconnect(), writerB.$disconnect()]);
    }

    expect(await fence(companyA!.id)).toBe(beforeA + 2n);
    expect(await fence(companyB!.id)).toBe(beforeB + 2n);
  });

  it('fences both owners when a direct legacy repair changes a Rule company or ID', async () => {
    const suffix = randomUUID();
    const source = await db.company.create({ data: {
      realmId: `lifecycle-owner-source-${suffix}`,
      legalName: 'Lifecycle Owner Source Legal',
      nickname: 'Lifecycle Owner Source',
    } });
    const target = await db.company.create({ data: {
      realmId: `lifecycle-owner-target-${suffix}`,
      legalName: 'Lifecycle Owner Target Legal',
      nickname: 'Lifecycle Owner Target',
    } });
    companyIds.add(source.id);
    companyIds.add(target.id);
    const rule = await createRule(source.id, suffix);
    const sourceBefore = await fence(source.id);
    const targetBefore = await fence(target.id);

    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE "RuleRevision" DISABLE TRIGGER "RuleRevision_append_only"');
      await tx.rule.update({ where: { id: rule.id }, data: { companyId: target.id } });
      await tx.$executeRawUnsafe('ALTER TABLE "RuleRevision" ENABLE TRIGGER "RuleRevision_append_only"');
    });

    expect(await fence(source.id)).toBeGreaterThan(sourceBefore);
    expect(await fence(target.id)).toBeGreaterThan(targetBefore);
    const targetAfterMove = await fence(target.id);
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE "RuleRevision" DISABLE TRIGGER "RuleRevision_append_only"');
      await tx.rule.update({ where: { id: rule.id }, data: { id: `${rule.id}-moved` } });
      await tx.$executeRawUnsafe('ALTER TABLE "RuleRevision" ENABLE TRIGGER "RuleRevision_append_only"');
    });
    expect(await fence(target.id)).toBeGreaterThan(targetAfterMove);
  });

  it('self-heals a missing zero-state row on the next old-writer mutation', async () => {
    const suffix = randomUUID();
    const company = await db.company.create({ data: {
      realmId: `lifecycle-self-heal-${suffix}`,
      legalName: 'Lifecycle Self Heal Legal',
      nickname: 'Lifecycle Self Heal',
    } });
    companyIds.add(company.id);
    await db.ruleLifecycleRevision.delete({ where: { companyId: company.id } });

    await createRule(company.id, suffix);

    expect(await fence(company.id)).toBeGreaterThan(0n);
  });
});
