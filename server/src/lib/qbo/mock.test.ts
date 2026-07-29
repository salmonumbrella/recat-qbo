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
import { mapDepositSnapshot } from './depositTax.js';
import type { StagedCategorization } from '@recat/shared';
import type {
  QboDepositSnapshot,
  RawDeposit,
  RawPurchase,
} from './types.js';

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
  it('hydrates pre-tax persisted Purchase mutations into a coherent preparable raw body', async () => {
    const current = getMockRealm(MOCK_REALM_BLUEBIRD);
    const persistedBeforePurchaseTax = {
      realmId: MOCK_REALM_BLUEBIRD,
      legalName: 'Stale persisted fixture name',
      accounts: [],
      txns: current.txns.map((txn) =>
        txn.qboId === '14'
          ? {
              ...txn,
              syncToken: 7,
              memo: 'Persisted user mutation',
              lines: txn.lines.map((line) => ({
                ...line,
                memo: 'Persisted line mutation',
              })),
            }
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
    Object.assign(current, hydrated);
    const client = new MockQboClient(MOCK_REALM_BLUEBIRD, ['3', '4']);
    const txn = await client.fetchTxn('Purchase', '14');
    const before = await client.fetchPurchaseSnapshot('14');
    if (!txn || !before) throw new Error('hydrated legacy Purchase missing');
    const prepared = await client.preparePurchaseRecategorization(
      txn,
      {
        transactionId: '00000000-0000-4000-8000-000000000014',
        revision: 1,
        taxCalculation: 'TaxExcluded',
        totals: {
          subtotalCents: -18_858,
          taxCents: -2_572,
          totalCents: -21_430,
        },
        lines: [{
          idx: 0,
          subtotalCents: -18_858,
          taxCents: -2_572,
          totalCents: -21_430,
          categoryQboId: '8',
          taxCodeQboId: before.lines[0]!.taxCodeQboId!,
          memo: 'Legacy hydrated preparation',
        }],
        tagIds: [],
      },
      before,
      'REQUEST_LEGACY_HYDRATED',
    );
    expect((txn.raw as RawPurchase).SyncToken).toBe('7');
    expect((txn.raw as RawPurchase).Line?.[0]?.Description).toBe(
      'Persisted line mutation',
    );
    expect(prepared.body.SyncToken).toBe('7');
  });

  it('derives coherent raw bodies from unusable or inconsistent persisted sets', () => {
    const current = getMockRealm(MOCK_REALM_BLUEBIRD);
    const txnsWithMutatedPurchase = current.txns.map((txn) =>
      txn.qboId === '14' ? { ...txn, syncToken: 7 } : txn);
    const staleTokenRaw = structuredClone(current.rawPurchases);
    const preservedRaw = staleTokenRaw.find((raw) => raw.Id === '15');
    if (!preservedRaw) throw new Error('preserved raw fixture missing');
    preservedRaw.LegacyUnknownDocumentField = { preserve: true };
    const incompleteRaw = structuredClone(staleTokenRaw);
    delete incompleteRaw[0]!.Line;
    const cases = [
      staleTokenRaw,
      staleTokenRaw.slice(0, 2),
      incompleteRaw,
    ];

    for (const rawPurchases of cases) {
      const hydrated = mergePersistedMockRealm(current, {
        txns: txnsWithMutatedPurchase,
        purchaseSnapshots: current.purchaseSnapshots,
        rawPurchases,
        transfers: current.transfers,
        nextId: current.nextId,
      });
      const purchaseEntities = hydrated.txns.filter(
        (txn) => txn.qboType === 'Purchase' && !txn.deleted,
      );
      expect(hydrated.rawPurchases).toHaveLength(purchaseEntities.length);
      for (const entity of purchaseEntities) {
        const raw = hydrated.rawPurchases.find((candidate) => candidate.Id === entity.qboId);
        expect(raw).toMatchObject({
          SyncToken: String(entity.syncToken),
          TxnDate: entity.date,
          TotalAmt: Math.abs(entity.amount),
          AccountRef: { value: entity.bankAccountQboId },
          Line: expect.any(Array),
        });
      }
      expect(
        hydrated.rawPurchases.find((candidate) => candidate.Id === '15')
          ?.LegacyUnknownDocumentField,
      ).toEqual({ preserve: true });
    }
  });

  it('derives only the Purchase with an unsupported persisted line before preparation', async () => {
    const current = getMockRealm(MOCK_REALM_BLUEBIRD);
    const malformedLines: RawPurchase['Line'][] = [
      [{}],
      [{
        Id: '1',
        Amount: 214.3,
        DetailType: 'AccountBasedExpenseLineDetail',
        AccountBasedExpenseLineDetail: {},
      }],
    ];
    const hydratedCases = malformedLines.map((Line) => {
      const rawPurchases = structuredClone(current.rawPurchases);
      const malformed = rawPurchases.find((raw) => raw.Id === '14');
      const coherentSibling = rawPurchases.find((raw) => raw.Id === '15');
      if (!malformed || !coherentSibling) throw new Error('raw fixture missing');
      malformed.Line = Line;
      coherentSibling.UnknownSiblingField = { preserve: true };
      return mergePersistedMockRealm(current, {
        txns: structuredClone(current.txns),
        purchaseSnapshots: structuredClone(current.purchaseSnapshots),
        rawPurchases,
        transfers: structuredClone(current.transfers),
        nextId: current.nextId,
      });
    });

    for (const hydrated of hydratedCases) {
      expect(
        hydrated.rawPurchases.find((raw) => raw.Id === '14')?.Line?.[0],
      ).toMatchObject({
        Id: '1',
        Amount: 214.3,
        DetailType: 'AccountBasedExpenseLineDetail',
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: '3' },
        },
      });
      expect(
        hydrated.rawPurchases.find((raw) => raw.Id === '15')
          ?.UnknownSiblingField,
      ).toEqual({ preserve: true });
    }

    Object.assign(current, hydratedCases[0]);
    const client = new MockQboClient(MOCK_REALM_BLUEBIRD, ['3', '4']);
    const txn = await client.fetchTxn('Purchase', '14');
    const before = await client.fetchPurchaseSnapshot('14');
    if (!txn || !before) throw new Error('reconciled Purchase missing');
    await expect(
      client.preparePurchaseRecategorization(
        txn,
        {
          transactionId: '00000000-0000-4000-8000-000000000014',
          revision: 1,
          taxCalculation: 'TaxExcluded',
          totals: {
            subtotalCents: -18_858,
            taxCents: -2_572,
            totalCents: -21_430,
          },
          lines: [{
            idx: 0,
            subtotalCents: -18_858,
            taxCents: -2_572,
            totalCents: -21_430,
            categoryQboId: '8',
            taxCodeQboId: before.lines[0]!.taxCodeQboId!,
            memo: 'Reconciled malformed raw line',
          }],
          tagIds: [],
        },
        before,
        'REQUEST_RECONCILED_LINE',
      ),
    ).resolves.toMatchObject({
      body: { Id: '14', SyncToken: '0' },
    });
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

  it('hydrates persisted prepared-write Purchase snapshots with legacy fallback', () => {
    const current = getMockRealm(MOCK_REALM_HARBOR);
    const genericSnapshot = {
      qboId: 'PURCHASE_GENERIC',
      syncToken: '8',
      totalCents: -1_000,
      accountQboId: 'ACCOUNT_PAYMENT_GENERIC',
      date: '2026-07-01',
      direction: 'purchase',
      globalTaxCalculation: 'TaxInclusive',
      totalTaxCents: -48,
      lines: [{
        id: 'LINE_GENERIC',
        amountCents: -952,
        description: 'generic memo',
        accountQboId: 'ACCOUNT_CATEGORY_GENERIC',
        customerQboId: null,
        classQboId: null,
        taxCodeQboId: 'TAX_CODE_STANDARD',
        taxAmountCents: -48,
        taxInclusiveCents: -1_000,
      }],
    } as const;
    const persistedBase = {
      txns: current.txns,
      transfers: current.transfers,
      nextId: current.nextId,
    };

    expect(mergePersistedMockRealm(current, {
      ...persistedBase,
      purchaseSnapshots: [genericSnapshot],
    }).purchaseSnapshots).toEqual([genericSnapshot]);
    expect(mergePersistedMockRealm(current, persistedBase).purchaseSnapshots).toBe(
      current.purchaseSnapshots,
    );
    expect(mergePersistedMockRealm(current, {
      ...persistedBase,
      purchaseSnapshots: [{ ...genericSnapshot, lines: null }],
    }).purchaseSnapshots).toBe(current.purchaseSnapshots);
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
      { qboId: 'STANDARD_RATE', name: 'Standard tax 5%', description: null, active: true, rateValue: 5, sourceUpdatedAt: null },
      { qboId: 'SECONDARY_RATE', name: 'Secondary tax 7%', description: null, active: true, rateValue: 7, sourceUpdatedAt: null },
    ]);
    await expect(bluebird.listTaxCodes()).resolves.toEqual([
      {
        qboId: 'STANDARD',
        name: 'Standard tax',
        description: 'Standard tax code',
        active: true,
        taxable: true,
        purchaseRates: [{ taxRateQboId: 'STANDARD_RATE', taxTypeApplicable: 'TaxOnAmount' }],
        salesRates: [{ taxRateQboId: 'STANDARD_RATE', taxTypeApplicable: 'TaxOnAmount' }],
        sourceUpdatedAt: null,
      },
      {
        qboId: 'COMBINED',
        name: 'Combined tax',
        description: null,
        active: true,
        taxable: true,
        purchaseRates: [
          { taxRateQboId: 'STANDARD_RATE', taxTypeApplicable: 'TaxOnAmount' },
          { taxRateQboId: 'SECONDARY_RATE', taxTypeApplicable: 'TaxOnAmount' },
        ],
        salesRates: [
          { taxRateQboId: 'STANDARD_RATE', taxTypeApplicable: 'TaxOnAmount' },
          { taxRateQboId: 'SECONDARY_RATE', taxTypeApplicable: 'TaxOnAmount' },
        ],
        sourceUpdatedAt: null,
      },
      {
        qboId: 'INACTIVE_STANDARD',
        name: 'Inactive standard tax',
        description: null,
        active: false,
        taxable: true,
        purchaseRates: [{ taxRateQboId: 'STANDARD_RATE', taxTypeApplicable: 'TaxOnAmount' }],
        salesRates: [{ taxRateQboId: 'STANDARD_RATE', taxTypeApplicable: 'TaxOnAmount' }],
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

describe('MockQboClient prepared Purchase writes', () => {
  it('shares exact prepare, replacement, readback, and restore semantics', async () => {
    const realm = getMockRealm(MOCK_REALM_HARBOR);
    realm.accounts.push(
      {
        qboId: 'ACCOUNT_HOLDING_GENERIC',
        name: 'Generic Holding',
        classification: 'Other',
        accountType: 'Other Current Asset',
        fullName: 'Generic Holding',
      },
      {
        qboId: 'ACCOUNT_CATEGORY_GENERIC',
        name: 'Generic Category',
        classification: 'Expenses',
        accountType: 'Expense',
        fullName: 'Expenses:Generic Category',
      },
      {
        qboId: 'ACCOUNT_PAYMENT_GENERIC',
        name: 'Generic Payment',
        classification: 'Bank',
        accountType: 'Bank',
        fullName: 'Generic Payment',
      },
      {
        qboId: 'ACCOUNT_UNTOUCHED_GENERIC',
        name: 'Generic Untouched',
        classification: 'Expenses',
        accountType: 'Expense',
        fullName: 'Expenses:Generic Untouched',
      },
    );
    realm.taxProfile = { usingSalesTax: true, partnerTaxEnabled: false };
    realm.taxRates.push({
      qboId: 'TAX_RATE_STANDARD',
      name: 'Generic standard rate',
      description: null,
      active: true,
      rateValue: 5,
      sourceUpdatedAt: null,
    });
    realm.taxCodes.push(
      {
        qboId: 'TAX_CODE_STANDARD',
        name: 'Generic standard code',
        description: null,
        active: true,
        taxable: true,
        purchaseRates: [{
          taxRateQboId: 'TAX_RATE_STANDARD',
          taxTypeApplicable: 'TaxOnAmount',
        }],
        sourceUpdatedAt: null,
      },
      {
        qboId: 'TAX_CODE_OLD_GENERIC',
        name: 'Generic previous code',
        description: null,
        active: true,
        taxable: true,
        purchaseRates: [{
          taxRateQboId: 'TAX_RATE_STANDARD',
          taxTypeApplicable: 'TaxOnAmount',
        }],
        sourceUpdatedAt: null,
      },
    );
    realm.txns.push({
      qboId: 'PURCHASE_GENERIC',
      qboType: 'Purchase',
      syncToken: 7,
      date: '2026-07-01',
      payee: 'Generic Entity',
      memo: 'generic private note',
      amount: -15,
      bankAccountQboId: 'ACCOUNT_PAYMENT_GENERIC',
      lines: [
        { id: 'LINE_HOLDING_GENERIC', amount: 10, accountQboId: 'ACCOUNT_HOLDING_GENERIC' },
        { id: '1000', amount: 5, accountQboId: 'ACCOUNT_UNTOUCHED_GENERIC' },
      ],
      lastUpdated: '2026-07-01T00:00:00.000Z',
    });
    const raw: RawPurchase = {
      Id: 'PURCHASE_GENERIC',
      SyncToken: '7',
      TxnDate: '2026-07-01',
      TotalAmt: 15,
      PaymentType: 'CreditCard',
      DocNumber: 'DOC_GENERIC',
      PrivateNote: 'generic private note',
      EntityRef: {
        value: 'ENTITY_GENERIC',
        name: 'Generic Entity',
        referenceKind: 'GenericVendor',
      },
      AccountRef: { value: 'ACCOUNT_PAYMENT_GENERIC', name: 'Generic Payment' },
      CurrencyRef: { value: 'CUR', name: 'Generic Currency' },
      ExchangeRate: 1.25,
      DepartmentRef: { value: 'DEPARTMENT_GENERIC', name: 'Generic Department' },
      CustomDocumentProperty: { preserve: true },
      MetaData: { CreateTime: '2026-07-01T00:00:00Z' },
      GlobalTaxCalculation: 'TaxInclusive',
      TxnTaxDetail: { TotalTax: 0.75 },
      Line: [
        {
          Id: 'LINE_HOLDING_GENERIC',
          Amount: 10,
          DetailType: 'AccountBasedExpenseLineDetail',
          Description: 'generic holding',
          AccountBasedExpenseLineDetail: {
            AccountRef: { value: 'ACCOUNT_HOLDING_GENERIC', name: 'Generic Holding' },
            CustomerRef: { value: 'CUSTOMER_OLD_GENERIC', name: 'Generic Customer' },
            ClassRef: { value: 'CLASS_OLD_GENERIC', name: 'Generic Class' },
            TaxCodeRef: { value: 'TAX_CODE_OLD_GENERIC' },
            TaxAmount: 0.5,
            TaxInclusiveAmt: 10,
          },
        },
        {
          Id: '1000',
          Amount: 5,
          DetailType: 'AccountBasedExpenseLineDetail',
          Description: 'generic untouched',
          AccountBasedExpenseLineDetail: {
            AccountRef: {
              value: 'ACCOUNT_UNTOUCHED_GENERIC',
              name: 'Generic Untouched',
            },
            CustomerRef: {
              value: 'CUSTOMER_UNTOUCHED_GENERIC',
              name: 'Generic Customer',
            },
            ClassRef: { value: 'CLASS_UNTOUCHED_GENERIC', name: 'Generic Class' },
            TaxCodeRef: { value: 'TAX_CODE_STANDARD' },
            TaxAmount: 0.25,
          },
          CustomField: [{ Name: 'Generic field', StringValue: 'preserve me' }],
          UnknownLineProperty: { preserve: true },
        },
      ],
    };
    realm.rawPurchases.push(structuredClone(raw));
    const before = {
      qboId: 'PURCHASE_GENERIC',
      syncToken: '7',
      totalCents: -1_500,
      accountQboId: 'ACCOUNT_PAYMENT_GENERIC',
      date: '2026-07-01',
      direction: 'purchase',
      globalTaxCalculation: 'TaxInclusive',
      totalTaxCents: -75,
      lines: [
        {
          id: 'LINE_HOLDING_GENERIC',
          amountCents: -1_000,
          description: 'generic holding',
          accountQboId: 'ACCOUNT_HOLDING_GENERIC',
          customerQboId: 'CUSTOMER_OLD_GENERIC',
          classQboId: 'CLASS_OLD_GENERIC',
          taxCodeQboId: 'TAX_CODE_OLD_GENERIC',
          taxAmountCents: -50,
          taxInclusiveCents: -1_000,
        },
        {
          id: '1000',
          amountCents: -500,
          description: 'generic untouched',
          accountQboId: 'ACCOUNT_UNTOUCHED_GENERIC',
          customerQboId: 'CUSTOMER_UNTOUCHED_GENERIC',
          classQboId: 'CLASS_UNTOUCHED_GENERIC',
          taxCodeQboId: 'TAX_CODE_STANDARD',
          taxAmountCents: -25,
          taxInclusiveCents: null,
        },
      ],
    } as const;
    realm.purchaseSnapshots.push(structuredClone(before));
    const staged = {
      transactionId: '00000000-0000-4000-8000-000000000001',
      revision: 2,
      taxCalculation: 'TaxInclusive',
      totals: { subtotalCents: -952, taxCents: -48, totalCents: -1_000 },
      lines: [{
        idx: 0,
        subtotalCents: -952,
        taxCents: -48,
        totalCents: -1_000,
        categoryQboId: 'ACCOUNT_CATEGORY_GENERIC',
        taxCodeQboId: 'TAX_CODE_STANDARD',
        memo: 'generic memo',
      }],
      tagIds: [],
    } satisfies StagedCategorization;
    const c = new MockQboClient(MOCK_REALM_HARBOR, ['ACCOUNT_HOLDING_GENERIC']);
    const current = await c.fetchTxn('Purchase', 'PURCHASE_GENERIC');
    if (!current) throw new Error('generic fixture missing');
    expect(current.raw).toEqual(raw);

    const prepared = await c.preparePurchaseRecategorization(
      current,
      staged,
      structuredClone(before),
      'REQUEST_GENERIC',
    );
    expect(prepared.body).toMatchObject({
      PaymentType: raw.PaymentType,
      DocNumber: raw.DocNumber,
      PrivateNote: raw.PrivateNote,
      EntityRef: raw.EntityRef,
      AccountRef: raw.AccountRef,
      CurrencyRef: raw.CurrencyRef,
      ExchangeRate: raw.ExchangeRate,
      DepartmentRef: raw.DepartmentRef,
      CustomDocumentProperty: raw.CustomDocumentProperty,
      MetaData: raw.MetaData,
    });
    expect(prepared.body.Line![0]).toEqual(raw.Line![1]);
    const tamperedExpected = {
      ...prepared,
      expected: { ...prepared.expected, totalTaxCents: -9_999 },
    };
    await expect(c.sendPreparedWrite(tamperedExpected)).resolves.toEqual({
      ok: true,
      newSyncToken: '8',
    });
    await expect(c.fetchPurchaseSnapshot('PURCHASE_GENERIC')).resolves.toEqual({
      qboId: prepared.expected.qboId,
      syncToken: '8',
      totalCents: prepared.expected.totalCents,
      accountQboId: prepared.expected.accountQboId,
      date: prepared.expected.date,
      direction: prepared.expected.direction,
      globalTaxCalculation: prepared.expected.globalTaxCalculation,
      totalTaxCents: prepared.expected.totalTaxCents,
      lines: [
        before.lines[1],
        { ...prepared.expected.targetLines[0], id: '1001' },
      ],
    });

    const posted = await c.fetchTxn('Purchase', 'PURCHASE_GENERIC');
    if (!posted) throw new Error('generic posted fixture missing');
    const expectedPostedRaw: RawPurchase = {
      ...prepared.body,
      SyncToken: '8',
      Line: [
        prepared.body.Line![0]!,
        { ...prepared.body.Line![1]!, Id: '1001' },
      ],
    };
    expect(posted.raw).toEqual(expectedPostedRaw);
    const persistedRealm = structuredClone(realm);
    const hydrated = mergePersistedMockRealm(
      { ...structuredClone(realm), rawPurchases: [] } as never,
      persistedRealm,
    ) as typeof realm & { rawPurchases: RawPurchase[] };
    expect(
      hydrated.rawPurchases.find((candidate) => candidate.Id === expectedPostedRaw.Id),
    ).toEqual(expectedPostedRaw);
    const restore = await c.preparePurchaseRestore(posted, prepared, 'REQUEST_RESTORE_GENERIC');
    await expect(c.sendPreparedWrite(restore)).resolves.toEqual({ ok: true, newSyncToken: '9' });
    await expect(c.fetchPurchaseSnapshot('PURCHASE_GENERIC')).resolves.toEqual({
      ...before,
      syncToken: '9',
    });
  });

  it('rejects a stale prepared body before mutating mock state', async () => {
    const realm = getMockRealm(MOCK_REALM_HARBOR);
    const existing = realm.txns.find((txn) => txn.qboType === 'Purchase');
    if (!existing) throw new Error('mock fixture missing');
    const c = client();
    await expect(c.sendPreparedWrite({
      operation: 'recategorize',
      qboType: 'Purchase',
      qboId: existing.qboId,
      requestId: 'REQUEST_GENERIC',
      requestHash: 'hash-generic',
      body: { Id: existing.qboId, SyncToken: '999', Line: [] },
      before: {} as never,
      expected: {} as never,
    })).rejects.toThrow(/SyncToken conflict/);
    expect(existing.syncToken).toBe(0);
  });
});

describe('MockQboClient prepared Deposit writes', () => {
  it('round-trips, replays idempotently, reads back, and restores a Deposit', async () => {
    const realm = getMockRealm(MOCK_REALM_HARBOR);
    realm.accounts.push(
      {
        qboId: 'DEPOSIT_HOLDING_GENERIC',
        name: 'Deposit Holding',
        classification: 'Other',
        accountType: 'Other Current Asset',
        fullName: 'Deposit Holding',
      },
      {
        qboId: 'DEPOSIT_INCOME_GENERIC',
        name: 'Deposit Income',
        classification: 'Income',
        accountType: 'Income',
        fullName: 'Income:Deposit Income',
      },
      {
        qboId: 'DEPOSIT_BANK_GENERIC',
        name: 'Deposit Bank',
        classification: 'Bank',
        accountType: 'Bank',
        fullName: 'Deposit Bank',
      },
    );
    realm.taxProfile = { usingSalesTax: true, partnerTaxEnabled: false };
    realm.taxRates.push({
      qboId: 'DEPOSIT_RATE_GENERIC',
      name: 'Generic sales rate',
      description: null,
      active: true,
      rateValue: 5,
      sourceUpdatedAt: null,
    });
    realm.taxCodes.push({
      qboId: 'DEPOSIT_TAX_GENERIC',
      name: 'Generic sales code',
      description: null,
      active: true,
      taxable: true,
      purchaseRates: [],
      salesRates: [{
        taxRateQboId: 'DEPOSIT_RATE_GENERIC',
        taxTypeApplicable: 'TaxOnAmount',
      }],
      sourceUpdatedAt: null,
    });
    realm.txns.push({
      qboId: 'DEPOSIT_GENERIC',
      qboType: 'Deposit',
      syncToken: 7,
      date: '2026-07-28',
      payee: 'Generic Customer',
      amount: 10.5,
      bankAccountQboId: 'DEPOSIT_BANK_GENERIC',
      lines: [{
        id: 'DEPOSIT_LINE_HOLDING',
        amount: 10.5,
        accountQboId: 'DEPOSIT_HOLDING_GENERIC',
      }],
      lastUpdated: '2026-07-28T00:00:00.000Z',
    });
    const raw: RawDeposit = {
      Id: 'DEPOSIT_GENERIC',
      SyncToken: '7',
      TxnDate: '2026-07-28',
      TotalAmt: 10.5,
      PrivateNote: 'Generic deposit',
      DepositToAccountRef: { value: 'DEPOSIT_BANK_GENERIC' },
      CurrencyRef: { value: 'CUR' },
      ExchangeRate: 1.25,
      UnknownDepositField: { preserve: true },
      Line: [{
        Id: 'DEPOSIT_LINE_HOLDING',
        Amount: 10.5,
        Description: 'Generic holding line',
        DetailType: 'DepositLineDetail',
        DepositLineDetail: {
          AccountRef: { value: 'DEPOSIT_HOLDING_GENERIC' },
          Entity: { value: 'DEPOSIT_ENTITY_GENERIC' },
          PaymentMethodRef: { value: 'DEPOSIT_PAYMENT_GENERIC' },
          ClassRef: { value: 'DEPOSIT_CLASS_GENERIC' },
        },
      }],
    };
    realm.rawDeposits.push(structuredClone(raw));
    const before: QboDepositSnapshot = mapDepositSnapshot(raw);
    const staged = {
      transactionId: '00000000-0000-4000-8000-000000000001',
      revision: 1,
      taxCalculation: 'TaxExcluded',
      totals: { subtotalCents: 1000, taxCents: 50, totalCents: 1050 },
      lines: [{
        idx: 0,
        subtotalCents: 1000,
        taxCents: 50,
        totalCents: 1050,
        categoryQboId: 'DEPOSIT_INCOME_GENERIC',
        taxCodeQboId: 'DEPOSIT_TAX_GENERIC',
        memo: 'Generic sale',
      }],
      tagIds: [],
    } satisfies StagedCategorization;
    const c = new MockQboClient(MOCK_REALM_HARBOR, ['DEPOSIT_HOLDING_GENERIC']);
    const txn = await c.fetchTxn('Deposit', raw.Id);
    if (!txn) throw new Error('generic Deposit fixture missing');

    await expect(c.fetchPreparedSnapshot('Deposit', raw.Id)).resolves.toEqual(before);
    const prepared = await c.prepareRecategorization(
      txn,
      staged,
      before,
      'REQUEST_DEPOSIT_GENERIC',
    );
    expect(prepared).toMatchObject({
      qboType: 'Deposit',
      operation: 'recategorize',
      body: {
        PrivateNote: raw.PrivateNote,
        CurrencyRef: raw.CurrencyRef,
        ExchangeRate: raw.ExchangeRate,
        UnknownDepositField: raw.UnknownDepositField,
      },
    });

    await expect(c.sendPreparedWrite(prepared)).resolves.toEqual({
      ok: true,
      newSyncToken: '8',
    });
    await expect(c.sendPreparedWrite(prepared)).resolves.toEqual({
      ok: true,
      newSyncToken: '8',
    });
    expect(
      realm.txns.find((candidate) => candidate.qboId === raw.Id)?.syncToken,
    ).toBe(8);
    await expect(c.fetchPreparedSnapshot('Deposit', raw.Id)).resolves.toEqual({
      qboId: prepared.expected.qboId,
      syncToken: '8',
      totalCents: prepared.expected.totalCents,
      depositToAccountQboId: prepared.expected.depositToAccountQboId,
      date: prepared.expected.date,
      globalTaxCalculation: prepared.expected.globalTaxCalculation,
      totalTaxCents: prepared.expected.totalTaxCents,
      preservedHash: prepared.expected.preservedHash,
      lines: [{
        ...prepared.expected.targetLines[0]!,
        id: expect.any(String),
        rawHash: expect.any(String),
      }],
    });

    const posted = await c.fetchTxn('Deposit', raw.Id);
    if (!posted) throw new Error('posted Deposit fixture missing');
    await expect(c.preparePurchaseRestore(
      posted,
      prepared,
      'REQUEST_WRONG_COMPATIBILITY_RESTORE',
    )).rejects.toThrow(/Purchase compatibility restore/i);
    const restore = await c.prepareRestore(
      posted,
      prepared,
      'REQUEST_DEPOSIT_RESTORE',
    );
    await expect(c.sendPreparedWrite(restore)).resolves.toEqual({
      ok: true,
      newSyncToken: '9',
    });
    await expect(c.fetchPreparedSnapshot('Deposit', raw.Id)).resolves.toEqual({
      ...before,
      syncToken: '9',
    });

    const hydrated = mergePersistedMockRealm(
      { ...structuredClone(realm), rawDeposits: [], preparedWriteResults: [] },
      structuredClone(realm),
    );
    expect(hydrated.rawDeposits.find((candidate) => candidate.Id === raw.Id)).toEqual(
      realm.rawDeposits.find((candidate) => candidate.Id === raw.Id),
    );
    expect(hydrated.preparedWriteResults).toEqual(realm.preparedWriteResults);

    const appendBody: RawDeposit = {
      ...raw,
      SyncToken: '9',
      TotalAmt: 2,
      Line: [{
        Amount: 2,
        DetailType: 'DepositLineDetail',
        DepositLineDetail: {
          AccountRef: { value: 'DEPOSIT_INCOME_GENERIC' },
        },
      }],
    };
    await expect(c.sendPreparedWrite({
      ...prepared,
      requestId: 'REQUEST_DEPOSIT_APPEND_GENERIC',
      requestHash: 'hash-deposit-append-generic',
      body: appendBody,
    })).resolves.toEqual({
      ok: true,
      newSyncToken: '10',
    });
    await expect(c.fetchPreparedSnapshot('Deposit', raw.Id)).resolves.toMatchObject({
      syncToken: '10',
      totalCents: 1_250,
      lines: [
        { id: 'DEPOSIT_LINE_HOLDING', amountCents: 1_050 },
        { id: expect.any(String), amountCents: 200 },
      ],
    });
  });
});
