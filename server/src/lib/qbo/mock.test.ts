// The mock client must mirror the real client's multi-line semantics (C1):
// reads expose only holding lines (amount = holding sum), writes replace only
// holding lines, and undo pulls back only the previously written category
// lines — the whole write-back/undo path is exercised against it in tests and
// demo mode, so its arithmetic has to match production.

import { beforeEach, describe, expect, it } from 'vitest';
import {
  getMockRealm,
  mergePersistedMockRealm,
  MockQboClient,
  MOCK_REALM_BLUEBIRD,
  MOCK_REALM_HARBOR,
  resetMockRealms,
} from './mock.js';

const HOLDING_IDS = ['4', '5']; // Harbor: Ask My Accountant + Uncategorized Expense

function client(): MockQboClient {
  return new MockQboClient(MOCK_REALM_HARBOR, HOLDING_IDS);
}

/** Turn the SYSCO purchase (id 2, -486.12 in holding) into a two-line entity. */
function addCategorizedLine(): void {
  const realm = getMockRealm(MOCK_REALM_HARBOR);
  const entity = realm.txns.find((t) => t.qboId === '2' && t.qboType === 'Purchase');
  if (!entity) throw new Error('seed txn missing');
  entity.lines.push({ id: '2', amount: 50, accountQboId: '10' }); // Food purchases, already categorized
  entity.amount = -536.12;
}

beforeEach(() => {
  resetMockRealms();
});

describe('MockQboClient multi-line entity safety', () => {
  it('fetchTxn exposes only holding lines with amount = holding sum', async () => {
    addCategorizedLine();
    const txn = await client().fetchTxn('Purchase', '2');
    expect(txn).not.toBeNull();
    expect(txn?.amount).toBe(-486.12); // NOT the -536.12 entity total
    expect(txn?.lines).toHaveLength(1);
    expect(txn?.lines[0]).toMatchObject({ accountQboId: '4', amount: 486.12 });
  });

  it('recategorize replaces only the holding line; the categorized line and total survive', async () => {
    addCategorizedLine();
    const c = client();
    const txn = await c.fetchTxn('Purchase', '2');
    if (!txn) throw new Error('missing txn');

    await c.recategorize(txn, [
      { amount: -400, accountQboId: '10' },
      { amount: -86.12, accountQboId: '12' },
    ]);

    const entity = getMockRealm(MOCK_REALM_HARBOR).txns.find((t) => t.qboId === '2');
    if (!entity) throw new Error('missing entity');
    // The pre-existing $50 categorized line survived verbatim.
    expect(entity.lines.filter((l) => l.accountQboId === '10' && l.amount === 50)).toHaveLength(1);
    // No holding lines remain; the splits are present.
    expect(entity.lines.some((l) => HOLDING_IDS.includes(l.accountQboId))).toBe(false);
    // Entity total unchanged: 50 + 400 + 86.12.
    const total = entity.lines.reduce((a, l) => a + l.amount, 0);
    expect(total).toBeCloseTo(536.12, 2);
  });

  it('moveToAccount pulls back only the previously posted category lines (undo)', async () => {
    addCategorizedLine();
    const c = client();
    const txn = await c.fetchTxn('Purchase', '2');
    if (!txn) throw new Error('missing txn');
    await c.recategorize(txn, [{ amount: -486.12, accountQboId: '17' }]); // Meals & entertainment

    const posted = await c.fetchTxn('Purchase', '2');
    if (!posted) throw new Error('missing posted txn');
    await c.moveToAccount(posted, '4', ['17']);

    const entity = getMockRealm(MOCK_REALM_HARBOR).txns.find((t) => t.qboId === '2');
    if (!entity) throw new Error('missing entity');
    // Back in holding at the original amount; the $50 categorized line intact.
    expect(entity.lines.filter((l) => l.accountQboId === '4' && l.amount === 486.12)).toHaveLength(1);
    expect(entity.lines.filter((l) => l.accountQboId === '10' && l.amount === 50)).toHaveLength(1);
    expect(entity.lines.some((l) => l.accountQboId === '17')).toBe(false);
    expect(entity.lines.reduce((a, l) => a + l.amount, 0)).toBeCloseTo(536.12, 2);
  });

  it('moveToAccount fails loudly when no lines post to the given categories', async () => {
    const c = client();
    const txn = await c.fetchTxn('Purchase', '2');
    if (!txn) throw new Error('missing txn');
    await expect(c.moveToAccount(txn, '4', ['17'])).rejects.toThrow(/no lines posting/);
  });

  it('listTxnsInAccounts filters lines by the ids given (wizard candidate probing)', async () => {
    addCategorizedLine();
    const txns = await client().listTxnsInAccounts(['10']); // probe a non-holding account
    const sysco = txns.find((t) => t.qboId === '2');
    expect(sysco?.lines).toHaveLength(1);
    expect(sysco?.lines[0]?.accountQboId).toBe('10');
    expect(sysco?.amount).toBe(-50);
  });
});

describe('MockQboClient tax fixtures', () => {
  it('hydrates pre-tax persisted mutations over current fixture defaults', () => {
    const current = getMockRealm(MOCK_REALM_BLUEBIRD);
    const persistedBeforePurchaseTax = {
      realmId: MOCK_REALM_BLUEBIRD,
      legalName: 'Stale persisted fixture name',
      accounts: [],
      txns: current.txns.map((txn) =>
        txn.qboId === '14'
          ? { ...txn, syncToken: 7, memo: 'Persisted user mutation' }
          : txn,
      ),
      transfers: [
        {
          qboId: 'transfer-1000',
          amount: 25,
          fromAccountQboId: '1',
          toAccountQboId: '2',
          date: '2026-07-15',
          memo: 'Persisted transfer',
          lastUpdated: '2026-07-15T08:00:00.000Z',
        },
      ],
      nextId: 1001,
    };

    const hydrated = mergePersistedMockRealm(current, persistedBeforePurchaseTax);

    expect(hydrated.legalName).toBe('Bluebird Salon LLC');
    expect(hydrated.accounts).toBe(current.accounts);
    expect(hydrated.taxProfile).toEqual({ usingSalesTax: true, partnerTaxEnabled: false });
    expect(hydrated.taxCodes).toHaveLength(3);
    expect(hydrated.taxRates).toHaveLength(2);
    expect(hydrated.purchaseSnapshots).toHaveLength(2);
    expect(hydrated.txns.find((txn) => txn.qboId === '14')).toMatchObject({
      syncToken: 7,
      memo: 'Persisted user mutation',
    });
    expect(hydrated.transfers).toEqual(persistedBeforePurchaseTax.transfers);
    expect(hydrated.nextId).toBe(1001);
  });

  it('ignores malformed persisted mutable state', () => {
    const current = getMockRealm(MOCK_REALM_BLUEBIRD);

    expect(() =>
      mergePersistedMockRealm(current, {
        txns: [{ qboId: '14', lines: null }],
        transfers: 'not-an-array',
        nextId: -1,
      }),
    ).not.toThrow();
    expect(
      mergePersistedMockRealm(current, {
        txns: [{ qboId: '14', lines: null }],
        transfers: 'not-an-array',
        nextId: -1,
      }),
    ).toEqual(current);
  });

  it('keeps tax-disabled and tax-enabled realm fixtures isolated', async () => {
    const harbor = client();
    const bluebird = new MockQboClient(MOCK_REALM_BLUEBIRD, ['3', '4']);

    await expect(harbor.getTaxProfile()).resolves.toEqual({ usingSalesTax: false, partnerTaxEnabled: null });
    await expect(harbor.listTaxCodes()).resolves.toEqual([]);
    await expect(harbor.listTaxRates()).resolves.toEqual([]);
    await expect(bluebird.getTaxProfile()).resolves.toEqual({ usingSalesTax: true, partnerTaxEnabled: false });
  });

  it('returns deterministic single-rate, multi-component, and inactive tax codes', async () => {
    const bluebird = new MockQboClient(MOCK_REALM_BLUEBIRD, ['3', '4']);

    await expect(bluebird.listTaxRates()).resolves.toEqual([
      { qboId: 'GST5', name: 'GST 5%', description: null, active: true, rateValue: 5, sourceUpdatedAt: null },
      { qboId: 'PST7', name: 'PST 7%', description: null, active: true, rateValue: 7, sourceUpdatedAt: null },
    ]);
    await expect(bluebird.listTaxCodes()).resolves.toEqual([
      {
        qboId: 'GST',
        name: 'GST',
        description: 'Goods and services tax',
        active: true,
        taxable: true,
        purchaseRates: [{ taxRateQboId: 'GST5', taxTypeApplicable: 'TaxOnAmount' }],
        sourceUpdatedAt: null,
      },
      {
        qboId: 'GST-PST',
        name: 'GST + PST',
        description: null,
        active: true,
        taxable: true,
        purchaseRates: [
          { taxRateQboId: 'GST5', taxTypeApplicable: 'TaxOnAmount' },
          { taxRateQboId: 'PST7', taxTypeApplicable: 'TaxOnAmount' },
        ],
        sourceUpdatedAt: null,
      },
      {
        qboId: 'OLD-GST',
        name: 'Old GST',
        description: null,
        active: false,
        taxable: true,
        purchaseRates: [{ taxRateQboId: 'GST5', taxTypeApplicable: 'TaxOnAmount' }],
        sourceUpdatedAt: null,
      },
    ]);
  });

  it('returns signed purchase and refund snapshots with complete account-expense detail', async () => {
    const bluebird = new MockQboClient(MOCK_REALM_BLUEBIRD, ['3', '4']);

    await expect(bluebird.fetchPurchaseSnapshot('14')).resolves.toEqual({
      qboId: '14',
      syncToken: '0',
      totalCents: -21430,
      accountQboId: '1',
      date: '2026-07-10',
      direction: 'purchase',
      globalTaxCalculation: 'TaxExcluded',
      totalTaxCents: -2572,
      lines: [
        {
          id: '1',
          amountCents: -21430,
          description: 'Color stock',
          accountQboId: '3',
          customerQboId: 'customer-1',
          classQboId: 'class-1',
          taxCodeQboId: 'UNKNOWN-PURCHASE-TAX',
          taxAmountCents: -2572,
          taxInclusiveCents: null,
        },
      ],
    });

    await expect(bluebird.fetchPurchaseSnapshot('refund-14')).resolves.toMatchObject({
      totalCents: 21430,
      direction: 'refund',
      totalTaxCents: 2572,
      lines: [{ amountCents: 21430, taxAmountCents: 2572 }],
    });
  });
});
