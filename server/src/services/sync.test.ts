import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  actionabilityEnabled: vi.fn(),
  audit: vi.fn(),
  refreshTaxReference: vi.fn(),
  refreshSuggestions: vi.fn(),
  listAccounts: vi.fn(),
  listTxnsInAccounts: vi.fn(),
  companyFindUnique: vi.fn(),
  companyUpdate: vi.fn(),
  postTransaction: vi.fn(),
  qboAccountUpsert: vi.fn(),
  transactionFindMany: vi.fn(),
  transactionFindUnique: vi.fn(),
  transactionUpdate: vi.fn(),
  transactionUpdateMany: vi.fn(),
  transactionUpsert: vi.fn(),
  txnTagUpsert: vi.fn(),
  ruleFindMany: vi.fn(),
  syncLogCreate: vi.fn(),
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: (() => {
    const transaction = {
      findMany: mocks.transactionFindMany,
      findUnique: mocks.transactionFindUnique,
      update: mocks.transactionUpdate,
      updateMany: mocks.transactionUpdateMany,
      upsert: mocks.transactionUpsert,
    };
    const client = {
      transaction,
      txnTag: { upsert: mocks.txnTagUpsert },
      $queryRawUnsafe: vi.fn(),
    };
    const prismaMock = {
      company: { findUnique: mocks.companyFindUnique, update: mocks.companyUpdate },
      qboAccount: { upsert: mocks.qboAccountUpsert },
      transaction,
      txnTag: client.txnTag,
      rule: { findMany: mocks.ruleFindMany },
      syncLog: { create: mocks.syncLogCreate },
      $queryRawUnsafe: client.$queryRawUnsafe,
      $transaction: vi.fn(async (callback) => callback(client)),
    };
    Object.defineProperty(prismaMock, 'transactionActionability', {
      get: () => mocks.actionabilityEnabled() ? {} : undefined,
    });
    return prismaMock;
  })(),
}));
vi.mock('../lib/qbo/factory.js', () => ({
  qboFactory: {
    forCompany: vi.fn(async () => ({
      listAccounts: mocks.listAccounts,
      listTxnsInAccounts: mocks.listTxnsInAccounts,
    })),
  },
}));
vi.mock('./suggestions.js', () => ({ refreshSuggestions: mocks.refreshSuggestions }));
vi.mock('./tax/reference.js', () => ({ refreshTaxReference: mocks.refreshTaxReference }));
vi.mock('./audit.js', () => ({ writeAudit: mocks.audit }));
vi.mock('./writeback.js', () => ({ postTransaction: mocks.postTransaction }));

import { syncCompany } from './sync.js';

interface TestMutationDeps {
  lease(
    key: { companyId: string; qboType: string; qboId: string },
    owner: string,
    callback: () => Promise<unknown>,
  ): Promise<unknown>;
  fence(
    key: { companyId: string; qboType: string; qboId: string },
    owner: string,
    tx: unknown,
  ): Promise<void>;
  owner(): string;
}

const syncWithMutations = syncCompany as unknown as (
  companyId: string,
  kind: 'manual',
  dependencies: TestMutationDeps,
) => Promise<{ ok: boolean; message: string }>;

function mutationDeps(
  overrides: Partial<TestMutationDeps> = {},
): TestMutationDeps {
  return {
    lease: async (_key, _owner, callback) => callback(),
    fence: async () => undefined,
    owner: () => 'sync-owner-generic',
    ...overrides,
  };
}

function qboTxn(overrides: Record<string, unknown> = {}) {
  return {
    qboType: 'Purchase',
    qboId: 'qbo-purchase-generic',
    syncToken: '7',
    date: '2026-07-29',
    payee: 'Generic counterparty',
    memo: null,
    amount: -42,
    bankAccount: 'Generic source account',
    lines: [{
      amount: -42,
      accountQboId: 'holding-generic',
      accountName: 'Generic holding',
    }],
    raw: { Id: 'qbo-purchase-generic', SyncToken: '7' },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.actionabilityEnabled.mockReturnValue(false);
  mocks.companyFindUnique.mockResolvedValue({ id: 'company-1', holdingAccountIds: [], lastSyncedAt: null });
  mocks.listAccounts.mockResolvedValue([]);
  mocks.listTxnsInAccounts.mockResolvedValue([]);
  mocks.transactionFindMany.mockResolvedValue([]);
  mocks.ruleFindMany.mockResolvedValue([]);
  mocks.refreshSuggestions.mockResolvedValue(undefined);
  mocks.companyUpdate.mockResolvedValue(undefined);
  mocks.syncLogCreate.mockResolvedValue(undefined);
  mocks.transactionFindUnique.mockResolvedValue(null);
  mocks.transactionUpdate.mockResolvedValue(undefined);
  mocks.transactionUpdateMany.mockResolvedValue({ count: 1 });
  mocks.transactionUpsert.mockResolvedValue(undefined);
  mocks.txnTagUpsert.mockResolvedValue(undefined);
  mocks.postTransaction.mockResolvedValue({ ok: true });
  mocks.audit.mockResolvedValue(undefined);
});

describe('syncCompany', () => {
  it('reports a newly mirrored holding transaction as created', async () => {
    mocks.companyFindUnique.mockResolvedValue({
      id: 'company-1',
      holdingAccountIds: ['holding-generic'],
      lastSyncedAt: null,
    });
    mocks.listAccounts.mockResolvedValue([{
      qboId: 'holding-generic', name: 'Generic holding', fullName: 'Generic holding',
      classification: 'Asset', accountType: 'Bank', active: true,
    }]);
    mocks.listTxnsInAccounts.mockResolvedValue([qboTxn()]);
    mocks.transactionFindMany.mockResolvedValue([]);
    mocks.transactionFindUnique.mockResolvedValue(null);

    const result = await syncWithMutations('company-1', 'manual', mutationDeps());

    expect(result).toMatchObject({
      ok: true,
      mirror: { created: 1, refreshed: 0, stale: 0, busy: 0, contended: 0 },
    });
  });

  it('reports a mirror write contention instead of claiming an existing snapshot refreshed', async () => {
    const current = {
      id: 'txn-generic',
      companyId: 'company-1',
      qboType: 'Purchase',
      qboId: 'qbo-purchase-generic',
      qboSyncToken: '7',
      revision: 4,
    };
    mocks.companyFindUnique.mockResolvedValue({
      id: 'company-1',
      holdingAccountIds: ['holding-generic'],
      lastSyncedAt: null,
    });
    mocks.listAccounts.mockResolvedValue([{
      qboId: 'holding-generic', name: 'Generic holding', fullName: 'Generic holding',
      classification: 'Asset', accountType: 'Bank', active: true,
    }]);
    mocks.listTxnsInAccounts.mockResolvedValue([qboTxn()]);
    mocks.transactionFindMany.mockResolvedValue([]);
    mocks.transactionFindUnique.mockResolvedValue(current);
    mocks.transactionUpdateMany.mockResolvedValue({ count: 0 });

    const result = await syncWithMutations('company-1', 'manual', mutationDeps());

    expect(result).toMatchObject({
      ok: true,
      mirror: { created: 0, refreshed: 0, stale: 0, busy: 0, contended: 1 },
    });
  });

  it('succeeds with a recorded tax diagnostic when the tax refresh fails', async () => {
    mocks.refreshTaxReference.mockRejectedValue(new Error('upstream payload should not leak'));

    const result = await syncCompany('company-1', 'manual');

    expect(result).toMatchObject({ ok: true, message: expect.stringContaining('Tax reference refresh failed.') });
    expect(mocks.syncLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ ok: true, message: expect.stringContaining('Tax reference refresh failed.') }) }),
    );
  });

  it('does not let a stale provider mirror overwrite a newer transfer binding', async () => {
    const current = {
      id: 'txn-generic',
      companyId: 'company-1',
      qboType: 'Purchase',
      qboId: 'qbo-purchase-generic',
      qboSyncToken: '7',
      revision: 4,
      status: 'PENDING',
    };
    mocks.companyFindUnique.mockResolvedValue({
      id: 'company-1',
      holdingAccountIds: ['holding-generic'],
      lastSyncedAt: null,
    });
    mocks.listAccounts.mockResolvedValue([{
      qboId: 'holding-generic',
      name: 'Generic holding',
      fullName: 'Generic holding',
      classification: 'Asset',
      accountType: 'Bank',
      active: true,
    }]);
    mocks.listTxnsInAccounts.mockResolvedValue([qboTxn()]);
    mocks.transactionFindMany.mockImplementation(async ({ where, select }) => {
      if (select?.qboType) {
        return [{ qboType: current.qboType, qboId: current.qboId }];
      }
      if (where?.status?.in) return [];
      if (where?.status === 'PENDING') return [];
      return [];
    });
    mocks.transactionFindUnique.mockImplementation(async () => ({ ...current }));
    mocks.transactionUpsert.mockImplementation(async ({ update }) => {
      Object.assign(current, update);
      return { ...current };
    });
    mocks.transactionUpdateMany.mockImplementation(async ({ where, data }) => {
      if (
        where.id === current.id
        && where.qboSyncToken === current.qboSyncToken
      ) {
        Object.assign(current, data);
        return { count: 1 };
      }
      return { count: 0 };
    });
    let releaseLease!: () => void;
    let announceLease!: () => void;
    const leaseStarted = new Promise<void>((resolve) => {
      announceLease = resolve;
    });
    const leaseRelease = new Promise<void>((resolve) => {
      releaseLease = resolve;
    });
    const deps = mutationDeps({
      lease: async (_key, _owner, callback) => {
        announceLease();
        await leaseRelease;
        return callback();
      },
    });

    const pendingSync = syncWithMutations('company-1', 'manual', deps);
    await leaseStarted;
    Object.assign(current, {
      qboSyncToken: '8',
      revision: 5,
      status: 'POSTED',
    });
    releaseLease();
    await pendingSync;

    expect(current).toMatchObject({
      qboSyncToken: '8',
      revision: 5,
      status: 'POSTED',
    });
  });

  it('does not supersede a transaction that completed after the sweep read it', async () => {
    const captured = {
      id: 'txn-generic',
      companyId: 'company-1',
      qboType: 'Purchase',
      qboId: 'qbo-purchase-generic',
      qboSyncToken: '7',
      revision: 4,
      status: 'PENDING',
      payee: 'Generic counterparty',
      amount: -42,
    };
    const current = { ...captured };
    mocks.transactionFindMany.mockImplementation(async ({ where, select }) => {
      if (select?.qboType) return [{
        qboType: captured.qboType,
        qboId: captured.qboId,
      }];
      if (where?.status?.in) return [{ ...captured }];
      if (where?.status === 'PENDING') return [];
      return [];
    });
    mocks.transactionFindUnique.mockImplementation(async () => ({ ...current }));
    mocks.transactionUpdate.mockImplementation(async ({ data }) => {
      Object.assign(current, data);
      return { ...current };
    });
    mocks.transactionUpdateMany.mockImplementation(async ({ where, data }) => {
      const matches =
        where.id === current.id
        && where.revision === current.revision
        && where.qboSyncToken === current.qboSyncToken
        && where.status?.in?.includes(current.status);
      if (!matches) return { count: 0 };
      Object.assign(current, data);
      return { count: 1 };
    });
    let releaseLease!: () => void;
    let announceLease!: () => void;
    const leaseStarted = new Promise<void>((resolve) => {
      announceLease = resolve;
    });
    const leaseRelease = new Promise<void>((resolve) => {
      releaseLease = resolve;
    });
    const deps = mutationDeps({
      lease: async (_key, _owner, callback) => {
        announceLease();
        await leaseRelease;
        return callback();
      },
    });

    const pendingSync = syncWithMutations('company-1', 'manual', deps);
    await leaseStarted;
    Object.assign(current, {
      qboSyncToken: '8',
      revision: 5,
      status: 'POSTED',
    });
    releaseLease();
    await pendingSync;

    expect(current).toMatchObject({
      qboSyncToken: '8',
      revision: 5,
      status: 'POSTED',
    });
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('does not stage auto-post fields while a transfer owns the entity', async () => {
    const pending = {
      ...qboTxn(),
      id: 'txn-generic',
      companyId: 'company-1',
      qboSyncToken: '7',
      revision: 4,
      status: 'PENDING',
      suggestion: {
        source: 'rule',
        ruleId: 'rule-generic',
        category: 'Generic category',
      },
      category: null,
      categoryQboId: null,
      txnTags: [],
      _count: { splitLines: 0 },
    };
    mocks.transactionFindMany.mockImplementation(async ({ where, select }) => {
      if (select?.qboType) return [{
        qboType: pending.qboType,
        qboId: pending.qboId,
      }];
      if (where?.status?.in) return [];
      if (where?.status === 'PENDING') return [{ ...pending }];
      return [];
    });
    mocks.ruleFindMany.mockResolvedValue([{
      id: 'rule-generic',
      autoPost: true,
      category: 'Generic category',
      categoryQboId: 'account-generic',
      ruleTags: [{ tagId: 'tag-generic' }],
    }]);
    mocks.transactionUpdate.mockImplementation(async ({ data }) => {
      Object.assign(pending, data);
      return { ...pending };
    });
    const busy = Object.assign(new Error('busy'), { code: 'ENTITY_BUSY' });
    const deps = mutationDeps({
      lease: async () => {
        throw busy;
      },
    });

    await syncWithMutations('company-1', 'manual', deps);

    expect(pending.category).toBeNull();
    expect(mocks.txnTagUpsert).not.toHaveBeenCalled();
    expect(mocks.postTransaction).not.toHaveBeenCalled();
  });

  it('auto-posts only provider-writable transactions governed by active rules', async () => {
    mocks.actionabilityEnabled.mockReturnValue(true);
    const checkedAt = new Date();
    const pending = (id: string, ruleId: string, disposition: 'WRITABLE' | 'UNKNOWN') => ({
      ...qboTxn({ qboId: `qbo-${id}` }),
      id,
      companyId: 'company-1',
      qboSyncToken: '7',
      revision: 4,
      status: 'PENDING',
      suggestion: { source: 'rule', ruleId, category: 'Generic category' },
      category: null,
      categoryQboId: null,
      txnTags: [],
      _count: { splitLines: 0 },
      providerActionability: {
        companyId: 'company-1',
        transactionId: id,
        disposition,
        checkedAt,
        revision: 4,
        qboSyncToken: '7',
        qboType: 'Purchase',
        qboId: `qbo-${id}`,
        txnDate: '2026-07-29',
        bankAccountQboId: 'bank-generic',
        bookCloseDate: null,
        cleared: false,
        reconciled: false,
        unavailableCode: null,
        unavailableReason: null,
      },
    });
    const activeWritable = pending('active-writable', 'rule-active', 'WRITABLE');
    const retiredWritable = pending('retired-writable', 'rule-retired', 'WRITABLE');
    const activeUnknown = pending('active-unknown', 'rule-active', 'UNKNOWN');
    mocks.transactionFindMany.mockImplementation(async ({ where, select }) => {
      if (select?.qboType) return [];
      if (where?.status?.in) return [];
      if (where?.status === 'PENDING') return [activeWritable, retiredWritable, activeUnknown];
      return [];
    });
    mocks.ruleFindMany.mockImplementation(async ({ where }) => {
      const rules = [
        {
          id: 'rule-active', enabled: true, retiredAt: null, autoPost: true,
          category: 'Generic category', categoryQboId: 'account-generic', ruleTags: [],
        },
        {
          id: 'rule-retired', enabled: false, retiredAt: checkedAt, autoPost: true,
          category: 'Retired category', categoryQboId: 'account-retired', ruleTags: [],
        },
      ];
      return where.enabled === true && where.retiredAt === null
        ? rules.filter((rule) => rule.enabled && rule.retiredAt === null)
        : rules;
    });

    await syncWithMutations('company-1', 'manual', mutationDeps());

    expect(mocks.postTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.postTransaction).toHaveBeenCalledWith(
      'active-writable',
      { id: null, label: 'system' },
      { auto: true },
    );
  });
});
