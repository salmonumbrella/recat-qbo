import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import type { McpPrincipal } from '../../mcp/auth.js';
import {
  MCP_OPERATION_EXPIRY_MS,
  McpOperationError,
  createPreparedOperation,
  hasValidMcpOperationIntegrity,
  hashOperationPayload,
  loadOwnedOperation,
  type CreatePreparedOperationInput,
  type McpOperationRecord,
  type McpOperationStore,
} from './operations.js';

const NOW = new Date('2026-07-29T12:00:00.000Z');
const TOKEN_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_TOKEN_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_USER_ID = '44444444-4444-4444-8444-444444444444';
const COMPANY_ID = '55555555-5555-4555-8555-555555555555';
const TRANSACTION_ID = '66666666-6666-4666-8666-666666666666';
const RETRY_OF_ID = '77777777-7777-4777-8777-777777777777';

const principal: McpPrincipal = {
  tokenId: TOKEN_ID,
  tokenPrefix: 'rct_example1',
  userId: USER_ID,
  isInstanceAdmin: false,
  memberships: [{ companyId: COMPANY_ID, role: 'categorizer' }],
};

function input(
  overrides: Partial<CreatePreparedOperationInput> = {},
): CreatePreparedOperationInput {
  return {
    principal,
    companyId: COMPANY_ID,
    transactionId: TRANSACTION_ID,
    toolName: 'prepare_categorization',
    kind: 'categorization',
    idempotencyKey: ' operation-1 ',
    payload: {
      zLabel: 'Cafe\u0301',
      proposal: {
        tagIds: [],
        lines: [{ categoryQboId: 'category-1', grossCents: -1250 }],
      },
    },
    sourceRevision: 3,
    preparedRevision: 4,
    qboType: 'Purchase',
    qboId: 'qbo-transaction-1',
    qboSyncToken: 'sync-7',
    retryOfId: null,
    ...overrides,
  };
}

function cloneRow(row: McpOperationRecord): McpOperationRecord {
  return structuredClone(row);
}

function matches(
  row: McpOperationRecord,
  where: Record<string, unknown>,
): boolean {
  return Object.entries(where).every(([key, value]) => (
    row[key as keyof McpOperationRecord] === value
  ));
}

function createStore() {
  const rows = new Map<string, McpOperationRecord>();
  let nextId = 1;
  const store: McpOperationStore = {
    mcpOperation: {
      async findFirst({ where }) {
        const row = [...rows.values()].find((candidate) => matches(candidate, where));
        return row === undefined ? null : cloneRow(row);
      },
      async createMany({ data, skipDuplicates }) {
        expect(skipDuplicates).toBe(true);
        const duplicateIdempotency = (
          data.idempotencyKey !== null
          && [...rows.values()].some((row) => (
            row.tokenId === data.tokenId
            && row.toolName === data.toolName
            && row.transactionId === data.transactionId
            && row.idempotencyKey === data.idempotencyKey
          ))
        );
        const duplicateRetry = (
          data.retryOfId !== null
          && [...rows.values()].some((row) => row.retryOfId === data.retryOfId)
        );
        if (duplicateIdempotency || duplicateRetry) return { count: 0 };

        const createdAt = new Date(NOW.getTime() + nextId);
        const row: McpOperationRecord = {
          ...structuredClone(data),
          createdAt,
          updatedAt: createdAt,
        };
        nextId += 1;
        rows.set(row.id, row);
        return { count: 1 };
      },
    },
  };
  return { store, rows };
}

function error(caught: unknown): McpOperationError {
  expect(caught).toBeInstanceOf(McpOperationError);
  return caught as McpOperationError;
}

describe('createPreparedOperation', () => {
  it('persists an immutable attributed envelope, normalized payload, hashes, and 15-minute expiry', async () => {
    const { store } = createStore();

    const operation = await createPreparedOperation(input(), {
      store,
      now: () => NOW,
    });

    expect(operation).toMatchObject({
      tokenId: TOKEN_ID,
      tokenPrefix: 'rct_example1',
      userId: USER_ID,
      companyId: COMPANY_ID,
      transactionId: TRANSACTION_ID,
      toolName: 'prepare_categorization',
      kind: 'categorization',
      idempotencyKey: 'operation-1',
      payload: {
        proposal: {
          lines: [{ categoryQboId: 'category-1', grossCents: -1250 }],
          tagIds: [],
        },
        zLabel: 'Café',
      },
      sourceRevision: 3,
      preparedRevision: 4,
      qboType: 'Purchase',
      qboId: 'qbo-transaction-1',
      qboSyncToken: 'sync-7',
      retryOfId: null,
      cancelledAt: null,
      manualRecordedAt: null,
    });
    expect(operation.payloadHash).toBe(hashOperationPayload(operation.payload));
    expect(operation.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(operation.expiresAt.getTime() - NOW.getTime()).toBe(MCP_OPERATION_EXPIRY_MS);
    expect(MCP_OPERATION_EXPIRY_MS).toBe(15 * 60 * 1000);
  });

  it('accepts an explicit later expiry for governed manual operations', async () => {
    const { store } = createStore();
    const expiresAt = new Date('9999-12-31T23:59:59.999Z');

    const operation = await createPreparedOperation(input(), {
      store,
      now: () => NOW,
      expiresAt: () => expiresAt,
    });

    expect(operation.expiresAt).toEqual(expiresAt);
  });

  it('accepts transfer envelopes and detects any private second-leg binding change', async () => {
    const { store } = createStore();
    const operation = await createPreparedOperation(input({
      toolName: 'prepare_transfer',
      kind: 'transfer' as never,
      payload: {
        transferOperationId: RETRY_OF_ID,
        first: {
          qboType: 'Purchase',
          qboId: 'qbo-transaction-1',
          qboSyncToken: 'sync-7',
        },
        second: {
          transactionId: OTHER_USER_ID,
          qboType: 'Deposit',
          qboId: 'qbo-transaction-2',
          qboSyncToken: 'sync-8',
        },
        preview: {
          action: 'record_transfer',
          direction: 'between_accounts',
          totalCents: 1250,
          legCount: 2,
          preparationDigest: 'a'.repeat(64),
        },
      },
    }), { store, now: () => NOW });

    expect(hasValidMcpOperationIntegrity(operation)).toBe(true);
    const tampered = structuredClone(operation);
    (tampered.payload as Record<string, any>).second.qboId = 'changed';
    expect(hasValidMcpOperationIntegrity(tampered)).toBe(false);
  });

  it('accepts a distinct tax-refund preparation envelope', async () => {
    const { store } = createStore();
    const operation = await createPreparedOperation(input({
      toolName: 'prepare_tax_refund',
      kind: 'tax_refund' as never,
      qboType: 'Deposit',
      payload: {
        capability: 'manual_required',
        preview: {
          action: 'record_gst_hst_refund',
          refundPrincipalCents: 123456,
          suspenseAccountQboId: '55',
        },
      },
    }), { store, now: () => NOW });

    expect(operation.kind).toBe('tax_refund');
    expect(hasValidMcpOperationIntegrity(operation)).toBe(true);
  });

  it('uses the caller-supplied transaction/store instead of the default client', async () => {
    const { store } = createStore();
    const createMany = vi.spyOn(store.mcpOperation, 'createMany');

    await createPreparedOperation(input(), { store, now: () => NOW });

    expect(createMany).toHaveBeenCalledOnce();
    expect(createMany).toHaveBeenCalledWith(expect.objectContaining({
      skipDuplicates: true,
    }));
  });

  it('replays an exact idempotency key and rejects any changed immutable input', async () => {
    const { store, rows } = createStore();
    const retryParent = await createPreparedOperation(input({
      idempotencyKey: 'parent-operation',
    }), { store, now: () => NOW });
    const first = await createPreparedOperation(input(), { store, now: () => NOW });

    const replay = await createPreparedOperation(input({
      payload: {
        proposal: {
          lines: [{ grossCents: -1250, categoryQboId: 'category-1' }],
          tagIds: [],
        },
        zLabel: 'Café',
      },
    }), { store, now: () => new Date(NOW.getTime() + 1_000) });

    expect(replay).toEqual(first);
    expect(rows.size).toBe(2);

    for (const changed of [
      input({ payload: { proposal: 'changed' } }),
      input({ sourceRevision: 2 }),
      input({ preparedRevision: 5 }),
      input({ qboType: 'Bill' }),
      input({ qboSyncToken: 'sync-8' }),
      input({ kind: 'undo' }),
      input({ retryOfId: retryParent.id }),
      input({ principal: { ...principal, tokenPrefix: 'rct_changed1' } }),
    ]) {
      await expect(
        createPreparedOperation(changed, { store, now: () => NOW }),
      ).rejects.toMatchObject({
        code: 'IDEMPOTENCY_CONFLICT',
        message: 'Idempotency key conflicts with an existing operation.',
      });
    }
    expect(rows.size).toBe(2);
  });

  it('recovers exact idempotency and retry-lineage replays after unique-key races', async () => {
    const { store } = createStore();
    const parent = await createPreparedOperation(input({
      idempotencyKey: 'parent-operation',
    }), { store, now: () => NOW });
    const first = await createPreparedOperation(input({
      retryOfId: parent.id,
    }), { store, now: () => NOW });
    const originalFind = store.mcpOperation.findFirst;
    store.mcpOperation.findFirst = vi.fn()
      .mockResolvedValueOnce(parent)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockImplementation(originalFind);

    await expect(createPreparedOperation(input({
      retryOfId: parent.id,
    }), { store, now: () => NOW })).resolves.toEqual(first);

    store.mcpOperation.findFirst = vi.fn()
      .mockResolvedValueOnce(parent)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockImplementation(originalFind);
    await expect(createPreparedOperation(input({
      retryOfId: parent.id,
      payload: { proposal: 'changed' },
    }), { store, now: () => NOW })).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
  });

  it('enforces one direct retry per operation even without an idempotency key', async () => {
    const { store, rows } = createStore();
    const parent = await createPreparedOperation(input({
      idempotencyKey: 'parent-operation',
    }), { store, now: () => NOW });
    const retry = input({ idempotencyKey: null, retryOfId: parent.id });
    const first = await createPreparedOperation(retry, { store, now: () => NOW });

    await expect(
      createPreparedOperation(retry, { store, now: () => NOW }),
    ).resolves.toEqual(first);
    await expect(createPreparedOperation({
      ...retry,
      payload: { proposal: 'different retry' },
    }, { store, now: () => NOW })).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    expect(rows.size).toBe(2);
  });

  it('hides nonexistent and foreign-owned retry parents', async () => {
    const { store } = createStore();

    await expect(
      createPreparedOperation(input({ retryOfId: RETRY_OF_ID }), {
        store,
        now: () => NOW,
      }),
    ).rejects.toMatchObject({
      code: 'OPERATION_NOT_FOUND',
      message: 'MCP operation not found.',
    });

    const foreignParent = await createPreparedOperation(input({
      principal: {
        ...principal,
        tokenId: OTHER_TOKEN_ID,
        userId: OTHER_USER_ID,
      },
      idempotencyKey: 'foreign-parent',
    }), { store, now: () => NOW });
    await expect(
      createPreparedOperation(input({ retryOfId: foreignParent.id }), {
        store,
        now: () => NOW,
      }),
    ).rejects.toMatchObject({
      code: 'OPERATION_NOT_FOUND',
      message: 'MCP operation not found.',
    });
  });

  it('rejects retry-of-retry lineage and mismatched parent target or kind', async () => {
    const { store } = createStore();
    const parent = await createPreparedOperation(input({
      idempotencyKey: 'parent-operation',
    }), { store, now: () => NOW });
    const firstRetry = await createPreparedOperation(input({
      idempotencyKey: 'first-retry',
      retryOfId: parent.id,
    }), { store, now: () => NOW });

    await expect(
      createPreparedOperation(input({
        idempotencyKey: 'retry-of-retry',
        retryOfId: firstRetry.id,
      }), { store, now: () => NOW }),
    ).rejects.toMatchObject({ code: 'OPERATION_INVALID_INPUT' });

    for (const mismatched of [
      input({
        idempotencyKey: 'wrong-company',
        retryOfId: parent.id,
        companyId: '99999999-9999-4999-8999-999999999999',
      }),
      input({
        idempotencyKey: 'wrong-transaction',
        retryOfId: parent.id,
        transactionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      }),
      input({
        idempotencyKey: 'wrong-kind',
        retryOfId: parent.id,
        kind: 'undo',
      }),
    ]) {
      await expect(
        createPreparedOperation(mismatched, { store, now: () => NOW }),
      ).rejects.toMatchObject({
        code: 'OPERATION_INVALID_INPUT',
        message: 'Invalid MCP operation input.',
      });
    }
  });

  it.each([
    '',
    ' ',
    'x'.repeat(129),
    'contains\ncontrol',
    '\uD800',
    '\uDC00',
  ])('rejects an invalid bounded idempotency key: %j', async (idempotencyKey) => {
    const { store } = createStore();

    await expect(
      createPreparedOperation(input({ idempotencyKey }), { store, now: () => NOW }),
    ).rejects.toMatchObject({
      code: 'OPERATION_INVALID_INPUT',
      message: 'Invalid MCP operation input.',
    });
  });

  it.each([
    'post_transfer',
    'categorization\nunsafe',
    '',
  ])('rejects an unsupported or unsafe operation kind: %j', async (kind) => {
    const { store } = createStore();

    await expect(
      createPreparedOperation(input({ kind: kind as 'categorization' }), {
        store,
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ code: 'OPERATION_INVALID_INPUT' });
  });

  it.each([
    null,
    [],
  ])('rejects a non-object accounting payload before persistence: %j', async (payload) => {
    const { store } = createStore();

    await expect(
      createPreparedOperation(input({ payload }), { store, now: () => NOW }),
    ).rejects.toMatchObject({ code: 'OPERATION_INVALID_INPUT' });
  });
});

describe('hashOperationPayload', () => {
  it('validates both payload and immutable metadata bindings', async () => {
    const { store } = createStore();
    const operation = await createPreparedOperation(input(), { store, now: () => NOW });
    expect(hasValidMcpOperationIntegrity(operation)).toBe(true);
    expect(hasValidMcpOperationIntegrity({
      ...operation,
      qboId: 'redirected-qbo-id',
    })).toBe(false);
    expect(hasValidMcpOperationIntegrity({
      ...operation,
      payload: { proposal: 'changed' },
    })).toBe(false);
  });

  it('is deterministic across object order and NFC-equivalent strings while preserving array order', () => {
    expect(hashOperationPayload({
      b: 2,
      a: { value: 'Cafe\u0301', list: [1, 2] },
    })).toBe(hashOperationPayload({
      a: { list: [1, 2], value: 'Café' },
      b: 2,
    }));
    expect(hashOperationPayload({ list: [1, 2] }))
      .not.toBe(hashOperationPayload({ list: [2, 1] }));
  });

  it('rejects unsafe or unbounded JSON without reflecting values or invoking getters', () => {
    const getter = vi.fn(() => {
      throw new Error('getter-secret');
    });
    const withGetter = Object.defineProperty({}, 'payload', {
      enumerable: true,
      get: getter,
    });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const globallyWide = {
      groups: Array.from(
        { length: 6 },
        () => Array.from({ length: 1_000 }, () => 0),
      ),
    };

    for (const value of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      new Date(),
      withGetter,
      cyclic,
      { text: '\u0000' },
      { text: '\uD800' },
      { text: '\uDC00' },
      globallyWide,
      { large: 'x'.repeat(65 * 1024) },
    ]) {
      let caught: unknown;
      try {
        hashOperationPayload(value);
      } catch (errorValue) {
        caught = errorValue;
      }
      expect(error(caught)).toMatchObject({
        code: 'OPERATION_INVALID_INPUT',
        message: 'Invalid MCP operation input.',
      });
      expect(String(caught)).not.toContain('getter-secret');
    }
    expect(getter).not.toHaveBeenCalled();
  });
});

describe('loadOwnedOperation', () => {
  it('returns only the exact token and user owner and otherwise uses one stable not-found error', async () => {
    const { store } = createStore();
    const operation = await createPreparedOperation(input(), {
      store,
      now: () => NOW,
    });

    await expect(
      loadOwnedOperation(operation.id, principal, { store }),
    ).resolves.toEqual(operation);

    for (const other of [
      { ...principal, tokenId: OTHER_TOKEN_ID },
      { ...principal, userId: OTHER_USER_ID },
    ]) {
      await expect(
        loadOwnedOperation(operation.id, other, { store }),
      ).rejects.toMatchObject({
        code: 'OPERATION_NOT_FOUND',
        message: 'MCP operation not found.',
      });
    }
  });
});

describe('Prisma durability contract', () => {
  it('defines the immutable scalar envelope without lifecycle or write-result mirrors', async () => {
    const schema = await readFile(new URL('../../../../prisma/schema.prisma', import.meta.url), 'utf8');
    const model = schema.match(/model McpOperation \{([\s\S]*?)\n\}/)?.[1] ?? '';

    for (const field of [
      'tokenId',
      'tokenPrefix',
      'userId',
      'companyId',
      'transactionId',
      'toolName',
      'kind',
      'idempotencyKey',
      'inputHash',
      'payload',
      'payloadHash',
      'sourceRevision',
      'preparedRevision',
      'qboType',
      'qboId',
      'qboSyncToken',
      'expiresAt',
      'retryOfId',
      'cancelledAt',
      'manualRecordedAt',
    ]) {
      expect(model).toMatch(new RegExp(`${field}\\s+`));
    }
    for (const forbidden of [
      'state',
      'attemptId',
      'result',
      'verification',
      'reconciliation',
      'errorCode',
      'errorMessage',
    ]) {
      expect(model).not.toMatch(new RegExp(`^\\s*${forbidden}\\s+`, 'm'));
    }
    expect(model).not.toContain('@relation');
    expect(model).toMatch(/retryOfId\s+String\?\s+@unique/);
  });

  it('orders the migration after MCP tokens and enforces hashes, revisions, lineage, and no cascade', async () => {
    const migrationDirectory = new URL('../../../../prisma/migrations/', import.meta.url);
    const migrations = (await readdir(migrationDirectory)).sort();
    const operationMigration = '20260729220000_add_mcp_operations';
    expect(migrations.indexOf(operationMigration))
      .toBeGreaterThan(migrations.indexOf('20260728210000_add_mcp_tokens'));

    const migration = await readFile(
      new URL(`${operationMigration}/migration.sql`, migrationDirectory),
      'utf8',
    );
    expect(migration).toContain('CREATE TABLE "McpOperation"');
    expect(migration).toContain('"inputHash" CHAR(64) NOT NULL');
    expect(migration).toContain('"payloadHash" CHAR(64) NOT NULL');
    expect(migration).toMatch(/CHECK \("kind" IN \('categorization', 'undo'\)\)/);
    expect(migration).toMatch(/CHECK \("sourceRevision" >= 0\)/);
    expect(migration).toMatch(/CHECK \("preparedRevision" >= 0\)/);
    expect(migration).toContain('CREATE UNIQUE INDEX "McpOperation_retryOfId_key"');
    expect(migration).toMatch(/BEFORE UPDATE OR DELETE ON "McpOperation"/);
    expect(migration).toContain('McpOperation immutable fields cannot be changed');
    expect(migration).not.toContain('ON DELETE CASCADE');
    expect(migration).not.toContain('FOREIGN KEY ("tokenId")');
    expect(migration).not.toContain('FOREIGN KEY ("userId")');
    expect(migration).not.toContain('FOREIGN KEY ("companyId")');
    expect(migration).not.toContain('FOREIGN KEY ("transactionId")');

    const transferMigration = '20260729234000_allow_mcp_transfer_operations';
    expect(migrations.indexOf(transferMigration))
      .toBeGreaterThan(migrations.indexOf(operationMigration));
    const transferKindMigration = await readFile(
      new URL(`${transferMigration}/migration.sql`, migrationDirectory),
      'utf8',
    );
    expect(transferKindMigration)
      .toMatch(/CHECK \("kind" IN \('categorization', 'transfer', 'undo'\)\)/);

    const taxRefundMigration = '20260904223000_allow_mcp_tax_refund_operations';
    expect(migrations.indexOf(taxRefundMigration))
      .toBeGreaterThan(migrations.indexOf(transferMigration));
    const taxRefundKindMigration = await readFile(
      new URL(`${taxRefundMigration}/migration.sql`, migrationDirectory),
      'utf8',
    );
    expect(taxRefundKindMigration).toMatch(
      /CHECK \("kind" IN \('categorization', 'transfer', 'undo', 'tax_refund'\)\)/,
    );
    expect(taxRefundKindMigration).toMatch(
      /CREATE UNIQUE INDEX "McpOperation_tax_refund_source_key"[\s\S]*WHERE "kind" = 'tax_refund'/,
    );
  });
});
