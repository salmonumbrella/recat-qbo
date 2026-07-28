import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  refreshTaxReference: vi.fn(),
  refreshSuggestions: vi.fn(),
  listAccounts: vi.fn(),
  listTxnsInAccounts: vi.fn(),
  companyFindUnique: vi.fn(),
  companyUpdate: vi.fn(),
  qboAccountUpsert: vi.fn(),
  transactionFindMany: vi.fn(),
  transactionUpsert: vi.fn(),
  ruleFindMany: vi.fn(),
  syncLogCreate: vi.fn(),
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    company: { findUnique: mocks.companyFindUnique, update: mocks.companyUpdate },
    qboAccount: { upsert: mocks.qboAccountUpsert },
    transaction: { findMany: mocks.transactionFindMany, upsert: mocks.transactionUpsert },
    rule: { findMany: mocks.ruleFindMany },
    syncLog: { create: mocks.syncLogCreate },
  },
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

import { syncCompany } from './sync.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.companyFindUnique.mockResolvedValue({ id: 'company-1', holdingAccountIds: [], lastSyncedAt: null });
  mocks.listAccounts.mockResolvedValue([]);
  mocks.listTxnsInAccounts.mockResolvedValue([]);
  mocks.transactionFindMany.mockResolvedValue([]);
  mocks.ruleFindMany.mockResolvedValue([]);
  mocks.refreshSuggestions.mockResolvedValue(undefined);
  mocks.companyUpdate.mockResolvedValue(undefined);
  mocks.syncLogCreate.mockResolvedValue(undefined);
});

describe('syncCompany', () => {
  it('succeeds with a recorded tax diagnostic when the tax refresh fails', async () => {
    mocks.refreshTaxReference.mockRejectedValue(new Error('upstream payload should not leak'));

    const result = await syncCompany('company-1', 'manual');

    expect(result).toMatchObject({ ok: true, message: expect.stringContaining('Tax reference refresh failed.') });
    expect(mocks.syncLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ ok: true, message: expect.stringContaining('Tax reference refresh failed.') }) }),
    );
  });
});
