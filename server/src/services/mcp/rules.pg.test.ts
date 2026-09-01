import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { McpPrincipal } from '../../mcp/auth.js';
import {
  createPreparedRuleOperation,
  hashOperationPayload,
  loadOwnedRuleOperation,
  type CreatePreparedRuleOperationInput,
  type McpRuleOperationRecord,
  type McpRuleOperationStore,
} from './operations.js';
import {
  commitMcpRuleChange,
  prepareMcpRuleChange,
  type PrepareMcpRuleChangeInput,
} from './rules.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;
const NOW = new Date('2026-08-31T12:00:00.000Z');

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function operationInput(
  overrides: Partial<CreatePreparedRuleOperationInput> = {},
): CreatePreparedRuleOperationInput {
  const principal: McpPrincipal = {
    tokenId: randomUUID(),
    tokenPrefix: 'rct_rulepg1',
    userId: randomUUID(),
    isInstanceAdmin: false,
    memberships: [],
  };
  return {
    principal,
    companyId: randomUUID(),
    resourceType: 'rule',
    resourceId: randomUUID(),
    mutation: 'update',
    idempotencyKey: `rule-${randomUUID()}`,
    payload: { proposedSnapshot: { matchText: 'PostgreSQL Vendor' } },
    sourceRevision: 4,
    proposedRevision: 5,
    proposedSnapshotHash: hashOperationPayload({ matchText: 'PostgreSQL Vendor' }),
    retryOfId: null,
    ...overrides,
  };
}

function barrierStore(
  transaction: Prisma.TransactionClient,
  reachedPreflight: Deferred,
  releasePreflight: Deferred,
): McpRuleOperationStore {
  let paused = false;
  const model = (transaction as any).mcpRuleOperation;
  return {
    mcpRuleOperation: {
      async findFirst({ where }) {
        const row = await model.findFirst({ where });
        if (!paused && row === null && where.idempotencyKey !== undefined) {
          paused = true;
          reachedPreflight.resolve();
          await releasePreflight.promise;
        }
        return row as McpRuleOperationRecord | null;
      },
      async createMany({ data, skipDuplicates }) {
        return model.createMany({ data, skipDuplicates });
      },
    },
  };
}

describePostgres('MCP rule operation PostgreSQL durability', () => {
  let firstClient: PrismaClient;
  let secondClient: PrismaClient;

  beforeAll(() => {
    firstClient = new PrismaClient({
      datasources: { db: { url: TEST_DATABASE_URL! } },
    });
    secondClient = new PrismaClient({
      datasources: { db: { url: TEST_DATABASE_URL! } },
    });
  });

  afterAll(async () => {
    await Promise.all([firstClient?.$disconnect(), secondClient?.$disconnect()]);
  });

  it('returns one exact company-resource replay for a concurrent idempotency race', async () => {
    expect((firstClient as any).mcpRuleOperation).toBeDefined();
    const input = operationInput();
    const firstReady = deferred();
    const secondReady = deferred();
    const release = deferred();

    const first = firstClient.$transaction(
      (tx) => createPreparedRuleOperation(input, {
        store: barrierStore(tx, firstReady, release),
        now: () => NOW,
      }),
      { timeout: 30_000 },
    );
    const second = secondClient.$transaction(
      (tx) => createPreparedRuleOperation(input, {
        store: barrierStore(tx, secondReady, release),
        now: () => new Date(NOW.getTime() + 1_000),
      }),
      { timeout: 30_000 },
    );

    await Promise.all([firstReady.promise, secondReady.promise]);
    release.resolve();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(secondResult).toEqual(firstResult);
    await expect((firstClient as any).mcpRuleOperation.count({
      where: {
        tokenId: input.principal.tokenId,
        companyId: input.companyId,
        idempotencyKey: input.idempotencyKey,
      },
    })).resolves.toBe(1);
  }, 30_000);

  it('allows exactly one atomic commit receipt and rejects later mutation or deletion', async () => {
    const input = operationInput();
    const operation = await createPreparedRuleOperation(input, {
      store: firstClient as unknown as McpRuleOperationStore,
      now: () => NOW,
    });
    const commitResult = {
      ok: true,
      operationId: operation.id,
      companyId: input.companyId,
      mutation: 'update',
      status: 'COMMITTED',
    };

    await expect((firstClient as any).mcpRuleOperation.update({
      where: { id: operation.id },
      data: {
        committedAt: new Date(NOW.getTime() + 1_000),
        commitResult,
        commitResultHash: hashOperationPayload(commitResult),
      },
    })).resolves.toMatchObject({ committedAt: expect.any(Date), commitResult });

    await expect((firstClient as any).mcpRuleOperation.update({
      where: { id: operation.id },
      data: { resourceId: randomUUID() },
    })).rejects.toThrow('McpRuleOperation immutable fields cannot be changed');
    await expect((firstClient as any).mcpRuleOperation.update({
      where: { id: operation.id },
      data: { committedAt: new Date(NOW.getTime() + 2_000) },
    })).rejects.toThrow('McpRuleOperation immutable fields cannot be changed');
    await expect((firstClient as any).mcpRuleOperation.delete({
      where: { id: operation.id },
    })).rejects.toThrow('McpRuleOperation immutable fields cannot be changed');
  });

  it('keeps actor and token ownership isolated without foreign-key deletion cascades', async () => {
    const input = operationInput();
    const operation = await createPreparedRuleOperation(input, {
      store: firstClient as unknown as McpRuleOperationStore,
      now: () => NOW,
    });

    await expect(loadOwnedRuleOperation(operation.id, {
      tokenId: randomUUID(),
      userId: input.principal.userId,
    }, { store: firstClient as unknown as McpRuleOperationStore }))
      .rejects.toMatchObject({ code: 'OPERATION_NOT_FOUND' });
    await expect(loadOwnedRuleOperation(operation.id, input.principal, {
      store: firstClient as unknown as McpRuleOperationStore,
    })).resolves.toMatchObject({ id: operation.id });
  });
});

describePostgres('MCP rule lifecycle PostgreSQL behavior', () => {
  let db: PrismaClient;

  beforeAll(() => {
    db = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL! } } });
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  async function seed() {
    const suffix = randomUUID();
    const user = await db.user.create({
      data: {
        email: `mcp-rules-${suffix}@example.invalid`,
        name: 'Rule Reviewer',
      },
    });
    const company = await db.company.create({
      data: {
        realmId: `mcp-rules-${suffix}`,
        legalName: 'MCP Rule Fixture',
        nickname: `rule-${suffix.slice(0, 8)}`,
        taxSupportStatus: 'ready',
        taxUsingSalesTax: true,
      },
    });
    await db.membership.create({
      data: { userId: user.id, companyId: company.id, role: 'categorizer' },
    });
    const token = await db.mcpToken.create({
      data: {
        userId: user.id,
        digest: createHash('sha256').update(suffix).digest('hex'),
        prefix: 'rct_rulepg2',
        label: 'MCP Rule Fixture',
        expiresAt: new Date(NOW.getTime() + 60 * 60 * 1000),
      },
    });
    const account = await db.qboAccount.create({
      data: {
        companyId: company.id,
        qboId: `expense-${suffix}`,
        name: 'Operating expense',
        fullName: 'Expenses · Operating expense',
        classification: 'Expenses',
      },
    });
    const tag = await db.tag.create({
      data: { companyId: company.id, name: 'Operations', color: '#445566' },
    });
    await db.transaction.createMany({
      data: [
        {
          companyId: company.id,
          qboId: `pending-${suffix}`,
          qboType: 'Purchase',
          qboSyncToken: '0',
          date: new Date('2026-08-30T00:00:00.000Z'),
          payee: 'Harbour Supply Vancouver',
          amount: '-12.34',
          bankAccount: 'Operating',
          status: 'PENDING',
        },
        {
          companyId: company.id,
          qboId: `posted-${suffix}`,
          qboType: 'Purchase',
          qboSyncToken: '0',
          date: new Date('2026-08-29T00:00:00.000Z'),
          payee: 'Harbour Supply Burnaby',
          amount: '-56.78',
          bankAccount: 'Operating',
          status: 'POSTED',
        },
      ],
    });
    const principal: McpPrincipal = {
      tokenId: token.id,
      tokenPrefix: token.prefix,
      userId: user.id,
      isInstanceAdmin: false,
      memberships: [{ companyId: company.id, role: 'categorizer' }],
    };
    return { user, company, account, tag, principal };
  }

  it('prepares without changing rules, then commits and replays one canonical revision', async () => {
    const fixture = await seed();
    const input: PrepareMcpRuleChangeInput = {
      companyId: fixture.company.id,
      mutation: 'create',
      expectedRevision: 0,
      idempotencyKey: `create-${randomUUID()}`,
      proposal: {
        matchText: 'Harbour Supply',
        categoryQboId: fixture.account.qboId,
        taxCalculation: 'NotApplicable',
        taxCodeQboId: null,
        tagIds: [fixture.tag.id],
        autoPost: false,
        priority: 0,
      },
    };

    const prepared = await prepareMcpRuleChange(fixture.principal, input, {
      db,
      now: () => NOW,
    });

    expect(prepared).toMatchObject({
      ok: true,
      status: 'PREPARED',
      mutation: 'create',
      revision: 1,
      preview: {
        currentRevision: 0,
        proposedRevision: 1,
        autoPost: false,
        affectedPendingCount: 1,
        affectedPostedCount: 1,
      },
    });
    await expect(db.rule.count({ where: { companyId: fixture.company.id } }))
      .resolves.toBe(0);

    const committed = await commitMcpRuleChange(fixture.principal, {
      operationId: prepared.operationId,
      idempotencyKey: input.idempotencyKey,
    }, { db, now: () => new Date(NOW.getTime() + 1_000) });
    const replayed = await commitMcpRuleChange(fixture.principal, {
      operationId: prepared.operationId,
      idempotencyKey: input.idempotencyKey,
    }, { db, now: () => new Date(NOW.getTime() + 2_000) });

    expect(committed).toMatchObject({
      ok: true,
      status: 'COMMITTED',
      rule: {
        revision: 1,
        state: 'enabled',
        autoPost: false,
        originIntent: 'make_recurring',
      },
    });
    expect(replayed).toMatchObject({
      ...committed,
      status: 'REPLAYED',
    });
    await expect(db.ruleRevision.findMany({
      where: { companyId: fixture.company.id, ruleId: committed.ruleId! },
      select: { revision: true },
      orderBy: { revision: 'asc' },
    })).resolves.toEqual([{ revision: 0 }, { revision: 1 }]);
    await expect(db.auditEntry.count({
      where: { companyId: fixture.company.id, action: 'rule-created' },
    })).resolves.toBe(1);
  });

  it('makes false-to-true autoPost a standalone prepared change with pending impact', async () => {
    const fixture = await seed();
    const rule = await db.rule.create({
      data: {
        companyId: fixture.company.id,
        matchText: 'Harbour Supply',
        category: fixture.account.name,
        categoryQboId: fixture.account.qboId,
        taxCalculation: 'NotApplicable',
        autoPost: false,
        revision: 2,
        originIntent: 'make_recurring',
        createdById: fixture.user.id,
        updatedById: fixture.user.id,
      },
      include: { ruleTags: true },
    });
    await db.ruleRevision.create({
      data: {
        ruleId: rule.id,
        companyId: fixture.company.id,
        revision: 2,
        state: 'enabled',
        matchText: rule.matchText,
        category: rule.category,
        categoryQboId: rule.categoryQboId,
        taxCalculation: 'NotApplicable',
        tagIds: [],
        priority: rule.priority,
        autoPost: false,
        originIntent: 'make_recurring',
        changedBy: fixture.user.id,
      },
    });

    const prepared = await prepareMcpRuleChange(fixture.principal, {
      companyId: fixture.company.id,
      mutation: 'update',
      ruleId: rule.id,
      expectedRevision: 2,
      idempotencyKey: `autopost-${randomUUID()}`,
      proposal: { autoPost: true },
    }, { db, now: () => NOW });
    expect(prepared.preview).toMatchObject({
      autoPost: true,
      affectedPendingCount: 1,
      conflicts: [],
      warnings: expect.arrayContaining([
        'Enabling auto-post affects matching pending transactions.',
      ]),
    });

    await expect(prepareMcpRuleChange(fixture.principal, {
      companyId: fixture.company.id,
      mutation: 'update',
      ruleId: rule.id,
      expectedRevision: 2,
      idempotencyKey: `autopost-mixed-${randomUUID()}`,
      proposal: { autoPost: true, matchText: 'Changed at the same time' },
    }, { db, now: () => NOW })).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    const committed = await commitMcpRuleChange(fixture.principal, {
      operationId: prepared.operationId,
      idempotencyKey: `wrong-${randomUUID()}`,
    }, { db, now: () => new Date(NOW.getTime() + 1_000) }).catch((error) => error);
    expect(committed).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(db.rule.findUniqueOrThrow({ where: { id: rule.id } }))
      .resolves.toMatchObject({ revision: 2, autoPost: false });
  });

  it('fails closed for a foreign-company executable rule identifier', async () => {
    const current = await seed();
    const foreign = await seed();
    const foreignRule = await db.rule.create({
      data: {
        companyId: foreign.company.id,
        matchText: 'Foreign payee',
        category: foreign.account.name,
        categoryQboId: foreign.account.qboId,
        taxCalculation: 'NotApplicable',
        revision: 4,
      },
    });

    await expect(prepareMcpRuleChange(current.principal, {
      companyId: current.company.id,
      mutation: 'disable',
      ruleId: foreignRule.id,
      expectedRevision: 4,
      idempotencyKey: `foreign-${randomUUID()}`,
    }, { db, now: () => NOW })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(db.mcpRuleOperation.count({
      where: { companyId: current.company.id },
    })).resolves.toBe(0);
  });

  it('commits update, disable, enable, reorder, and retire through one revision path', async () => {
    const fixture = await seed();
    async function canonicalRule(matchText: string, priority: number, revision: number) {
      const rule = await db.rule.create({
        data: {
          companyId: fixture.company.id,
          matchText,
          category: fixture.account.name,
          categoryQboId: fixture.account.qboId,
          taxCalculation: 'NotApplicable',
          priority,
          revision,
          originIntent: 'make_recurring',
          updatedById: fixture.user.id,
        },
        include: { ruleTags: true },
      });
      await db.ruleRevision.create({
        data: {
          ruleId: rule.id, companyId: fixture.company.id, revision,
          state: 'enabled', matchText, category: fixture.account.name,
          categoryQboId: fixture.account.qboId, taxCalculation: 'NotApplicable',
          tagIds: [], priority, autoPost: false, originIntent: 'make_recurring',
          changedBy: fixture.user.id,
        },
      });
      return rule;
    }
    const first = await canonicalRule('Harbour Supply', 0, 2);

    async function run(input: PrepareMcpRuleChangeInput) {
      const prepared = await prepareMcpRuleChange(fixture.principal, input, { db, now: () => NOW });
      return commitMcpRuleChange(fixture.principal, {
        operationId: prepared.operationId,
        idempotencyKey: input.idempotencyKey,
      }, { db, now: () => new Date(NOW.getTime() + 1_000) });
    }

    const updated = await run({
      companyId: fixture.company.id, mutation: 'update', ruleId: first.id,
      expectedRevision: 2, idempotencyKey: `update-${randomUUID()}`,
      proposal: { matchText: 'Harbour Supply Co' },
    });
    expect(updated.rule).toMatchObject({ revision: 3, condition: { matchText: 'Harbour Supply Co' } });
    const disabled = await run({
      companyId: fixture.company.id, mutation: 'disable', ruleId: first.id,
      expectedRevision: 3, idempotencyKey: `disable-${randomUUID()}`,
    });
    expect(disabled.rule).toMatchObject({ revision: 4, state: 'disabled' });
    const enabled = await run({
      companyId: fixture.company.id, mutation: 'enable', ruleId: first.id,
      expectedRevision: 4, idempotencyKey: `enable-${randomUUID()}`,
    });
    expect(enabled.rule).toMatchObject({ revision: 5, state: 'enabled' });

    const second = await canonicalRule('Second supplier', 1, 7);
    const reordered = await run({
      companyId: fixture.company.id, mutation: 'reorder', expectedRevision: 7,
      idempotencyKey: `reorder-${randomUUID()}`,
      proposal: { orderIds: [second.id, first.id] },
    });
    expect(reordered.rule).toMatchObject({ ruleId: second.id, revision: 8, priority: 0 });
    const retired = await run({
      companyId: fixture.company.id, mutation: 'retire', ruleId: second.id,
      expectedRevision: 8, idempotencyKey: `retire-${randomUUID()}`,
    });
    expect(retired.rule).toMatchObject({ ruleId: second.id, revision: 9, state: 'retired' });
    await expect(db.ruleRevision.findMany({
      where: { companyId: fixture.company.id, ruleId: second.id },
      select: { revision: true, state: true },
      orderBy: { revision: 'asc' },
    })).resolves.toEqual([
      { revision: 0, state: 'enabled' },
      { revision: 7, state: 'enabled' },
      { revision: 8, state: 'enabled' },
      { revision: 9, state: 'retired' },
    ]);
  });

  it('dismisses a candidate without deleting its counterexample provenance', async () => {
    const fixture = await seed();
    const transaction = await db.transaction.findFirstOrThrow({
      where: { companyId: fixture.company.id },
    });
    const candidate = await db.autopilotRuleCandidate.create({
      data: {
        companyId: fixture.company.id,
        conditionFingerprint: createHash('sha256').update(randomUUID()).digest('hex'),
        schemaVersion: 'classification-rule-v2',
        configVersion: 'verified-writeback-v1',
        matchText: 'Harbour Supply',
        state: 'conflict',
        winningActionFingerprint: 'a'.repeat(64),
        categoryQboId: fixture.account.qboId,
        taxCalculation: 'NotApplicable',
        tagIds: [],
        evidenceCount: 1,
        conflictingEvidenceCount: 1,
      },
    });
    const evidence = await db.autopilotRuleCandidateEvidence.create({
      data: {
        companyId: fixture.company.id,
        candidateId: candidate.id,
        transactionId: transaction.id,
        inputRevision: transaction.revision,
        requestId: `counterexample-${randomUUID()}`,
        source: 'mcp',
        polarity: 'negative',
        actionFingerprint: 'b'.repeat(64),
        pattern: { matchText: candidate.matchText },
      },
    });
    const input: PrepareMcpRuleChangeInput = {
      companyId: fixture.company.id,
      mutation: 'dismiss_candidate',
      candidateId: candidate.id,
      expectedRevision: 0,
      idempotencyKey: `dismiss-${randomUUID()}`,
    };

    const prepared = await prepareMcpRuleChange(fixture.principal, input, { db, now: () => NOW });
    const committed = await commitMcpRuleChange(fixture.principal, {
      operationId: prepared.operationId,
      idempotencyKey: input.idempotencyKey,
    }, { db, now: () => new Date(NOW.getTime() + 1_000) });

    expect(committed).toMatchObject({
      status: 'COMMITTED',
      rule: null,
      candidate: { candidateId: candidate.id, state: 'dismissed', ruleId: null },
    });
    await expect(db.autopilotRuleCandidateEvidence.findUnique({
      where: { id: evidence.id },
    })).resolves.toMatchObject({ id: evidence.id, active: true, polarity: 'negative' });
  });

  it('rejects a stale prepared revision without consuming its commit receipt', async () => {
    const fixture = await seed();
    const rule = await db.rule.create({
      data: {
        companyId: fixture.company.id,
        matchText: 'Harbour Supply',
        category: fixture.account.name,
        categoryQboId: fixture.account.qboId,
        taxCalculation: 'NotApplicable',
        revision: 2,
        originIntent: 'make_recurring',
      },
      include: { ruleTags: true },
    });
    await db.ruleRevision.create({
      data: {
        ruleId: rule.id, companyId: fixture.company.id, revision: 2,
        state: 'enabled', matchText: rule.matchText, category: rule.category,
        categoryQboId: rule.categoryQboId, taxCalculation: 'NotApplicable',
        tagIds: [], priority: 0, autoPost: false, originIntent: 'make_recurring',
      },
    });
    const input: PrepareMcpRuleChangeInput = {
      companyId: fixture.company.id,
      mutation: 'update',
      ruleId: rule.id,
      expectedRevision: 2,
      idempotencyKey: `stale-${randomUUID()}`,
      proposal: { matchText: 'Prepared condition' },
    };
    const prepared = await prepareMcpRuleChange(fixture.principal, input, { db, now: () => NOW });
    const changed = await db.rule.update({
      where: { id: rule.id },
      data: { matchText: 'Concurrent condition', revision: 3 },
      include: { ruleTags: true },
    });
    await db.ruleRevision.create({
      data: {
        ruleId: changed.id, companyId: fixture.company.id, revision: 3,
        state: 'enabled', matchText: changed.matchText, category: changed.category,
        categoryQboId: changed.categoryQboId, taxCalculation: 'NotApplicable',
        tagIds: [], priority: 0, autoPost: false, originIntent: 'make_recurring',
      },
    });

    await expect(commitMcpRuleChange(fixture.principal, {
      operationId: prepared.operationId,
      idempotencyKey: input.idempotencyKey,
    }, { db, now: () => new Date(NOW.getTime() + 1_000) }))
      .rejects.toMatchObject({ code: 'STALE_REVISION' });
    await expect(db.mcpRuleOperation.findUniqueOrThrow({
      where: { id: prepared.operationId },
    })).resolves.toMatchObject({ committedAt: null, commitResult: null });
  });

  it('serializes concurrent commits into one mutation and one replay receipt', async () => {
    const fixture = await seed();
    const input: PrepareMcpRuleChangeInput = {
      companyId: fixture.company.id,
      mutation: 'create',
      expectedRevision: 0,
      idempotencyKey: `concurrent-commit-${randomUUID()}`,
      proposal: {
        matchText: 'Concurrent Harbour',
        categoryQboId: fixture.account.qboId,
        taxCalculation: 'NotApplicable',
        taxCodeQboId: null,
        tagIds: [],
        priority: 0,
        autoPost: false,
      },
    };
    const prepared = await prepareMcpRuleChange(fixture.principal, input, { db, now: () => NOW });
    const second = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL! } } });
    try {
      const results = await Promise.all([
        commitMcpRuleChange(fixture.principal, {
          operationId: prepared.operationId,
          idempotencyKey: input.idempotencyKey,
        }, { db, now: () => new Date(NOW.getTime() + 1_000) }),
        commitMcpRuleChange(fixture.principal, {
          operationId: prepared.operationId,
          idempotencyKey: input.idempotencyKey,
        }, { db: second, now: () => new Date(NOW.getTime() + 1_000) }),
      ]);
      expect(results.map(({ status }) => status).sort()).toEqual(['COMMITTED', 'REPLAYED']);
      await expect(db.rule.count({ where: { id: prepared.ruleId! } })).resolves.toBe(1);
      await expect(db.ruleRevision.count({
        where: { companyId: fixture.company.id, ruleId: prepared.ruleId! },
      })).resolves.toBe(2);
    } finally {
      await second.$disconnect();
    }
  });
});
