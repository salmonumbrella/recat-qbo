import { randomUUID } from 'node:crypto';
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
