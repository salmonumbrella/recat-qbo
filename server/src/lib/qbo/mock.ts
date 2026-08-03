// MockQboClient — the in-memory "Intuit" behind demo companies. Any Company
// row whose realmId is one of the two mock realms routes here (see
// lib/qbo/factory.ts) — demo is a per-connection user choice, not an env var.
//
// Two realms mirror the design prototype's demo data exactly
// (design_handoff_recat/Recat.dc.html): Harbor & Main Coffee Co. and
// Bluebird Salon LLC. State is a module-level singleton so it survives across
// requests within one server process, and it is MUTABLE: recategorize moves a
// txn's lines out of the holding account, moveToAccount puts them back,
// createTransfer records an entity, and every write bumps the SyncToken —
// stale tokens throw QboSyncTokenConflict just like the real API.

import { randomUUID } from 'node:crypto';
import {
  QboRequestTimeout,
  QboSyncTokenConflict,
  type QboAccountInfo,
  type QboAccountTxn,
  type QboAttachable,
  type QboAttachmentDownload,
  type QboAttachmentRef,
  type QboAttachmentUploadFile,
  type QboAttachmentUploadOutcome,
  type QboLogTxn,
  type QboClient,
  type QboCompanyInfo,
  type QboLineWriteResult,
  type QboLineWriteSnapshot,
  type QboPreparedLineWrite,
  type QboPreparedWrite,
  type QboStatement,
  type QboPurchaseSnapshot,
  type QboTaxCodeInfo,
  type QboTaxProfile,
  type QboTaxRateInfo,
  type QboTokenSet,
  type QboTxn,
  type QboWriteResult,
  type RawDeposit,
  type RawJournalEntry,
  type RawPurchase,
  type RawPurchaseLine,
} from './types.js';

import { MOCK_REALM_IDS, type StagedCategorization } from '@recat/shared';
import {
  preparePurchaseRecategorization as preparePurchaseRecategorizationBody,
  preparePurchaseRestore as preparePurchaseRestoreBody,
} from './purchaseTax.js';
import {
  buildPreparedLineWrite,
  hashLineWriteContent,
  rebuildDepositLines,
  rebuildJournalEntryLines,
  rebuildPurchaseLines,
  validatePreparedLineWrite,
  verifyLineWriteResult,
} from './lineWrite.js';

export const MOCK_REALM_HARBOR = MOCK_REALM_IDS[0];
export const MOCK_REALM_BLUEBIRD = MOCK_REALM_IDS[1];

// ---------------------------------------------------------------------------
// Realm state
// ---------------------------------------------------------------------------

interface MockAccount {
  qboId: string;
  name: string;
  /** normalized bucket (Income | COGS | Expenses | Bank | CreditCard) */
  classification: string;
  accountType: string;
  /** colon path, per QBO FullyQualifiedName convention */
  fullName: string;
}

interface MockLine {
  id: string;
  /** positive, QBO line convention */
  amount: number;
  accountQboId: string;
  memo?: string;
}

interface MockTxnEntity {
  qboId: string;
  qboType: QboTxn['qboType'];
  syncToken: number;
  date: string; // YYYY-MM-DD
  payee: string;
  memo?: string;
  /** signed; + = money in */
  amount: number;
  bankAccountQboId: string;
  /** ALL category-side lines; writes replace only the holding-account ones */
  lines: MockLine[];
  /** Exact last provider body for non-Purchase prepared line writes. */
  rawLineWriteBody?: Record<string, unknown>;
  lastUpdated: string; // ISO
  deleted?: boolean;
}

interface MockTransfer {
  qboId: string;
  amount: number;
  fromAccountQboId: string;
  toAccountQboId: string;
  date: string;
  memo?: string;
  lastUpdated: string;
}

export interface MockAttachmentRecord extends QboAttachable {
  contentBase64: string;
}

export interface MockRealm {
  realmId: string;
  legalName: string;
  accounts: MockAccount[];
  txns: MockTxnEntity[];
  taxProfile: QboTaxProfile;
  taxCodes: QboTaxCodeInfo[];
  taxRates: QboTaxRateInfo[];
  purchaseSnapshots: QboPurchaseSnapshot[];
  /** Authoritative full QBO-shaped Purchase bodies, including unknown fields. */
  rawPurchases: RawPurchase[];
  transfers: MockTransfer[];
  attachments: MockAttachmentRecord[];
  attachmentUploadFaults: Record<string, { code: string; message: string }>;
  attachmentTimeoutAfterAccept: boolean;
  nextId: number;
}

function acct(qboId: string, name: string, classification: string, accountType: string): MockAccount {
  // Bank/credit-card/holding accounts are top-level in QBO, so their
  // FullyQualifiedName is just the name; category accounts get a group path.
  const grouped = classification === 'Income' || classification === 'COGS' || classification === 'Expenses';
  const holding = name === 'Ask My Accountant' || name.startsWith('Uncategorized');
  return {
    qboId,
    name,
    classification,
    accountType,
    fullName: grouped && !holding ? `${classification}:${name}` : name,
  };
}

interface TxnSeed {
  id: string;
  type: QboTxn['qboType'];
  date: string;
  payee: string;
  memo: string;
  amount: number;
  bankId: string;
}

function seedTxn(seed: TxnSeed, holdingId: string): MockTxnEntity {
  return {
    qboId: seed.id,
    qboType: seed.type,
    syncToken: 0,
    date: seed.date,
    payee: seed.payee,
    memo: seed.memo || undefined,
    amount: seed.amount,
    bankAccountQboId: seed.bankId,
    // Every pending demo txn sits in 'Ask My Accountant', exactly as in the
    // prototype.
    lines: [{ id: '1', amount: Math.abs(seed.amount), accountQboId: holdingId }],
    lastUpdated: `${seed.date}T08:00:00.000Z`,
  };
}

function buildHarborRealm(): MockRealm {
  const accounts: MockAccount[] = [
    acct('1', 'Checking ·4821', 'Bank', 'Bank'),
    acct('2', 'Visa ·0392', 'CreditCard', 'Credit Card'),
    acct('3', 'Savings ·9917', 'Bank', 'Bank'),
    acct('4', 'Ask My Accountant', 'Expenses', 'Other Expense'),
    acct('5', 'Uncategorized Expense', 'Expenses', 'Other Expense'),
    acct('6', 'Uncategorized Income', 'Income', 'Other Income'),
    acct('7', 'Sales — food', 'Income', 'Income'),
    acct('8', 'Sales — beverage', 'Income', 'Income'),
    acct('9', 'Catering income', 'Income', 'Income'),
    acct('10', 'Food purchases', 'COGS', 'Cost of Goods Sold'),
    acct('11', 'Beverage purchases', 'COGS', 'Cost of Goods Sold'),
    acct('12', 'Packaging & supplies', 'COGS', 'Cost of Goods Sold'),
    acct('13', 'Advertising & marketing', 'Expenses', 'Expense'),
    acct('14', 'Bank fees', 'Expenses', 'Expense'),
    acct('15', 'Equipment rental', 'Expenses', 'Expense'),
    acct('16', 'Insurance', 'Expenses', 'Expense'),
    acct('17', 'Meals & entertainment', 'Expenses', 'Expense'),
    acct('18', 'Merchant fees', 'Expenses', 'Expense'),
    acct('19', 'Office supplies', 'Expenses', 'Expense'),
    acct('20', 'Payroll wages', 'Expenses', 'Expense'),
    acct('21', 'Payroll taxes', 'Expenses', 'Expense'),
    acct('22', 'Professional services', 'Expenses', 'Expense'),
    acct('23', 'Rent', 'Expenses', 'Expense'),
    acct('24', 'Repairs & maintenance', 'Expenses', 'Expense'),
    acct('25', 'Software subscriptions', 'Expenses', 'Expense'),
    acct('26', 'Utilities', 'Expenses', 'Expense'),
    acct('27', 'Vehicle fuel', 'Expenses', 'Expense'),
  ];
  const HOLDING = '4'; // Ask My Accountant
  const seeds: TxnSeed[] = [
    { id: '1', type: 'Deposit', date: '2026-06-30', payee: 'SQ *SQUARE INC', memo: 'Daily card settlement', amount: 1842.5, bankId: '1' },
    { id: '2', type: 'Purchase', date: '2026-07-01', payee: 'SYSCO FOODS #212', memo: 'Weekly order', amount: -486.12, bankId: '1' },
    { id: '3', type: 'Purchase', date: '2026-07-01', payee: 'SHELL OIL 5742', memo: '', amount: -52.4, bankId: '2' },
    { id: '4', type: 'Purchase', date: '2026-07-02', payee: 'AMZN MKTP US*2K4', memo: 'Espresso machine gaskets', amount: -128.99, bankId: '2' },
    { id: '5', type: 'Purchase', date: '2026-07-03', payee: 'GUSTO PAYROLL', memo: '', amount: -3214.77, bankId: '1' },
    { id: '6', type: 'Purchase', date: '2026-07-05', payee: 'WEBFLOW.COM', memo: '', amount: -29.0, bankId: '2' },
    { id: '7', type: 'Purchase', date: '2026-07-07', payee: 'TST* THE LOCAL TAP', memo: '', amount: -84.6, bankId: '2' },
    { id: '8', type: 'Purchase', date: '2026-07-08', payee: 'USPS PO 4471', memo: '', amount: -18.4, bankId: '2' },
    { id: '9', type: 'Purchase', date: '2026-07-09', payee: 'COMCAST BUSINESS', memo: '', amount: -149.85, bankId: '1' },
    { id: '10', type: 'Deposit', date: '2026-07-10', payee: 'SQ *SQUARE INC', memo: 'Daily card settlement', amount: 2103.2, bankId: '1' },
    { id: '11', type: 'Purchase', date: '2026-07-11', payee: 'ULINE SHIP SUPPLIES', memo: '', amount: -212.06, bankId: '2' },
    { id: '12', type: 'Deposit', date: '2026-07-12', payee: 'STRIPE PAYOUT', memo: '', amount: 640.0, bankId: '1' },
    { id: '17', type: 'Purchase', date: '2026-07-13', payee: 'ONLINE TRANSFER REF #8841', memo: 'Card payment', amount: -750.0, bankId: '1' },
    { id: '18', type: 'Deposit', date: '2026-07-13', payee: 'ONLINE TRANSFER REF #8841', memo: 'Card payment', amount: 750.0, bankId: '2' },
  ];
  return {
    realmId: MOCK_REALM_HARBOR,
    legalName: 'Harbor & Main Coffee Co.',
    accounts,
    txns: seeds.map((s) => seedTxn(s, HOLDING)),
    taxProfile: { usingSalesTax: false, partnerTaxEnabled: null },
    taxCodes: [],
    taxRates: [],
    purchaseSnapshots: [],
    rawPurchases: [],
    transfers: [],
    attachments: [],
    attachmentUploadFaults: {},
    attachmentTimeoutAfterAccept: false,
    nextId: 1000,
  };
}

function buildBluebirdRealm(): MockRealm {
  const accounts: MockAccount[] = [
    acct('1', 'Checking ·7702', 'Bank', 'Bank'),
    acct('2', 'Visa ·5518', 'CreditCard', 'Credit Card'),
    acct('3', 'Ask My Accountant', 'Expenses', 'Other Expense'),
    acct('4', 'Uncategorized Expense', 'Expenses', 'Other Expense'),
    acct('5', 'Uncategorized Income', 'Income', 'Other Income'),
    acct('6', 'Service revenue', 'Income', 'Income'),
    acct('7', 'Retail sales', 'Income', 'Income'),
    acct('8', 'Salon supplies', 'COGS', 'Cost of Goods Sold'),
    acct('9', 'Retail products', 'COGS', 'Cost of Goods Sold'),
    acct('10', 'Advertising & marketing', 'Expenses', 'Expense'),
    acct('11', 'Education & training', 'Expenses', 'Expense'),
    acct('12', 'Insurance', 'Expenses', 'Expense'),
    acct('13', 'Laundry & linens', 'Expenses', 'Expense'),
    acct('14', 'Merchant fees', 'Expenses', 'Expense'),
    acct('15', 'Payroll wages', 'Expenses', 'Expense'),
    acct('16', 'Rent', 'Expenses', 'Expense'),
    acct('17', 'Software subscriptions', 'Expenses', 'Expense'),
    acct('18', 'Utilities', 'Expenses', 'Expense'),
  ];
  const HOLDING = '3'; // Ask My Accountant
  const seeds: TxnSeed[] = [
    { id: '13', type: 'Deposit', date: '2026-07-09', payee: 'SQ *SQUARE INC', memo: 'Daily card settlement', amount: 987.4, bankId: '1' },
    { id: '14', type: 'Purchase', date: '2026-07-10', payee: 'SALLY BEAUTY 442', memo: 'Color stock', amount: -214.3, bankId: '1' },
    { id: '15', type: 'Purchase', date: '2026-07-11', payee: 'CINTAS CORP', memo: 'Towel service', amount: -89.0, bankId: '1' },
    { id: '16', type: 'Purchase', date: '2026-07-12', payee: 'META ADS', memo: 'July boost', amount: -150.0, bankId: '2' },
  ];
  return {
    realmId: MOCK_REALM_BLUEBIRD,
    legalName: 'Bluebird Salon LLC',
    accounts,
    txns: seeds.map((s) => seedTxn(s, HOLDING)),
    taxProfile: { usingSalesTax: true, partnerTaxEnabled: false },
    taxRates: [
      { qboId: 'GST5', name: 'GST 5%', description: null, active: true, rateValue: 5, sourceUpdatedAt: null },
      { qboId: 'PST7', name: 'PST 7%', description: null, active: true, rateValue: 7, sourceUpdatedAt: null },
    ],
    taxCodes: [
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
    ],
    purchaseSnapshots: [
      {
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
      },
      {
        qboId: 'refund-14',
        syncToken: '0',
        totalCents: 21430,
        accountQboId: '1',
        date: '2026-07-11',
        direction: 'refund',
        globalTaxCalculation: 'TaxExcluded',
        totalTaxCents: 2572,
        lines: [
          {
            id: '1',
            amountCents: 21430,
            description: 'Returned color stock',
            accountQboId: '3',
            customerQboId: 'customer-1',
            classQboId: 'class-1',
            taxCodeQboId: 'GST',
            taxAmountCents: 2572,
            taxInclusiveCents: null,
          },
        ],
      },
    ],
    rawPurchases: [],
    transfers: [],
    attachments: [],
    attachmentUploadFaults: {},
    attachmentTimeoutAfterAccept: false,
    nextId: 1000,
  };
}

function buildRealms(): Map<string, MockRealm> {
  const built = [buildHarborRealm(), buildBluebirdRealm()];
  for (const realm of built) {
    realm.rawPurchases = realm.txns
      .filter((txn) => txn.qboType === 'Purchase')
      .map((txn) =>
        rawPurchaseFromMock(
          txn,
          realm.purchaseSnapshots.find((snapshot) => snapshot.qboId === txn.qboId),
        ));
  }
  return new Map(built.map((realm) => [realm.realmId, realm]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPersistedLine(value: unknown): value is MockLine {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.amount === 'number' &&
    Number.isFinite(value.amount) &&
    typeof value.accountQboId === 'string' &&
    (value.memo === undefined || typeof value.memo === 'string')
  );
}

function isPersistedRawLineWriteBody(
  value: unknown,
  qboId: string,
  syncToken: number,
): value is Record<string, unknown> {
  if (
    !isRecord(value) ||
    value.Id !== qboId ||
    value.SyncToken !== String(syncToken)
  ) {
    return false;
  }
  try {
    hashLineWriteContent(value);
    return true;
  } catch {
    return false;
  }
}

function isPersistedTxn(value: unknown): value is MockTxnEntity {
  return (
    isRecord(value) &&
    typeof value.qboId === 'string' &&
    typeof value.qboType === 'string' &&
    typeof value.syncToken === 'number' &&
    Number.isSafeInteger(value.syncToken) &&
    typeof value.date === 'string' &&
    typeof value.payee === 'string' &&
    (value.memo === undefined || typeof value.memo === 'string') &&
    typeof value.amount === 'number' &&
    Number.isFinite(value.amount) &&
    typeof value.bankAccountQboId === 'string' &&
    Array.isArray(value.lines) &&
    value.lines.every(isPersistedLine) &&
    (value.rawLineWriteBody === undefined ||
      isPersistedRawLineWriteBody(
        value.rawLineWriteBody,
        value.qboId,
        value.syncToken,
      )) &&
    typeof value.lastUpdated === 'string' &&
    (value.deleted === undefined || typeof value.deleted === 'boolean')
  );
}

function isPersistedTransfer(value: unknown): value is MockTransfer {
  return (
    isRecord(value) &&
    typeof value.qboId === 'string' &&
    typeof value.amount === 'number' &&
    Number.isFinite(value.amount) &&
    typeof value.fromAccountQboId === 'string' &&
    typeof value.toAccountQboId === 'string' &&
    typeof value.date === 'string' &&
    (value.memo === undefined || typeof value.memo === 'string') &&
    typeof value.lastUpdated === 'string'
  );
}

function isPersistedAttachment(value: unknown): value is MockAttachmentRecord {
  return (
    isRecord(value)
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.syncToken)
    && isNonEmptyString(value.filename)
    && isNonEmptyString(value.contentType)
    && typeof value.sizeBytes === 'number'
    && Number.isSafeInteger(value.sizeBytes)
    && value.sizeBytes >= 0
    && isNullableString(value.note)
    && Array.isArray(value.refs)
    && value.refs.length > 0
    && value.refs.every((ref) => (
      isRecord(ref)
      && (
        ref.qboType === 'Purchase'
        || ref.qboType === 'Deposit'
        || ref.qboType === 'JournalEntry'
      )
      && isNonEmptyString(ref.qboId)
    ))
    && typeof value.contentBase64 === 'string'
  );
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNullableSafeInteger(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value));
}

function isPersistedPurchaseSnapshotLine(
  value: unknown,
): value is QboPurchaseSnapshot['lines'][number] {
  return (
    isRecord(value) &&
    isNullableString(value.id) &&
    typeof value.amountCents === 'number' &&
    Number.isSafeInteger(value.amountCents) &&
    isNullableString(value.description) &&
    isNullableString(value.accountQboId) &&
    isNullableString(value.customerQboId) &&
    isNullableString(value.classQboId) &&
    isNullableString(value.taxCodeQboId) &&
    isNullableSafeInteger(value.taxAmountCents) &&
    isNullableSafeInteger(value.taxInclusiveCents)
  );
}

function isPersistedPurchaseSnapshot(value: unknown): value is QboPurchaseSnapshot {
  return (
    isRecord(value) &&
    typeof value.qboId === 'string' &&
    typeof value.syncToken === 'string' &&
    typeof value.totalCents === 'number' &&
    Number.isSafeInteger(value.totalCents) &&
    isNullableString(value.accountQboId) &&
    typeof value.date === 'string' &&
    (value.direction === 'purchase' || value.direction === 'refund') &&
    isNullableString(value.globalTaxCalculation) &&
    isNullableSafeInteger(value.totalTaxCents) &&
    Array.isArray(value.lines) &&
    value.lines.every(isPersistedPurchaseSnapshotLine)
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPersistedReference(value: unknown): boolean {
  return isRecord(value) && isNonEmptyString(value.value);
}

function isOptionalPersistedReference(value: unknown): boolean {
  return value === undefined || isPersistedReference(value);
}

function isPersistedRawPurchaseLine(value: unknown): value is RawPurchaseLine {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.Id) ||
    !isFiniteNumber(value.Amount) ||
    value.DetailType !== 'AccountBasedExpenseLineDetail' ||
    !isRecord(value.AccountBasedExpenseLineDetail)
  ) {
    return false;
  }
  const detail = value.AccountBasedExpenseLineDetail;
  return (
    isPersistedReference(detail.AccountRef) &&
    isOptionalPersistedReference(detail.TaxCodeRef) &&
    isOptionalPersistedReference(detail.ClassRef) &&
    isOptionalPersistedReference(detail.CustomerRef) &&
    (detail.TaxAmount === undefined || isFiniteNumber(detail.TaxAmount)) &&
    (detail.TaxInclusiveAmt === undefined ||
      isFiniteNumber(detail.TaxInclusiveAmt))
  );
}

function isPersistedRawPurchase(value: unknown): value is RawPurchase {
  return (
    isRecord(value) &&
    isNonEmptyString(value.Id) &&
    isNonEmptyString(value.SyncToken) &&
    isNonEmptyString(value.TxnDate) &&
    isFiniteNumber(value.TotalAmt) &&
    isPersistedReference(value.AccountRef) &&
    Array.isArray(value.Line) &&
    value.Line.length > 0 &&
    value.Line.every(isPersistedRawPurchaseLine)
  );
}

function isPersistedTxnArray(value: unknown): value is MockTxnEntity[] {
  return Array.isArray(value) && value.every(isPersistedTxn);
}

function isPersistedPurchaseSnapshotArray(
  value: unknown,
): value is QboPurchaseSnapshot[] {
  return Array.isArray(value) && value.every(isPersistedPurchaseSnapshot);
}

function isPersistedRawPurchaseArray(value: unknown): value is RawPurchase[] {
  return Array.isArray(value) && value.every(isPersistedRawPurchase);
}

function activePurchaseEntities(txns: readonly MockTxnEntity[]): MockTxnEntity[] {
  return txns.filter((txn) => txn.qboType === 'Purchase' && !txn.deleted);
}

function rawPurchasesMatchEntities(
  rawPurchases: readonly RawPurchase[],
  txns: readonly MockTxnEntity[],
): boolean {
  const purchases = activePurchaseEntities(txns);
  const byId = new Map(rawPurchases.map((raw) => [raw.Id, raw]));
  const purchaseIds = new Set(purchases.map((entity) => entity.qboId));
  return (
    rawPurchases.length === purchases.length &&
    byId.size === rawPurchases.length &&
    purchaseIds.size === purchases.length &&
    purchases.every(
      (entity) =>
        byId.get(entity.qboId)?.SyncToken === String(entity.syncToken),
    )
  );
}

function reconcileRawPurchases(
  txns: readonly MockTxnEntity[],
  snapshots: readonly QboPurchaseSnapshot[],
  persistedCandidates: readonly RawPurchase[],
): RawPurchase[] {
  return activePurchaseEntities(txns).map((entity) => {
    const matches = persistedCandidates.filter(
      (raw) =>
        raw.Id === entity.qboId &&
        raw.SyncToken === String(entity.syncToken),
    );
    return matches.length === 1
      ? matches[0]!
      : rawPurchaseFromMock(
          entity,
          snapshots.find((snapshot) => snapshot.qboId === entity.qboId),
        );
  });
}

/**
 * Migrate persisted demo mutations onto the current fixture shape. Fixture
 * metadata is deliberately not persisted state: retaining the current values
 * lets additive fields survive upgrades from older AppConfig JSON.
 */
export function mergePersistedMockRealm(current: MockRealm, persisted: unknown): MockRealm {
  if (!isRecord(persisted)) return current;

  const persistedTxns = isPersistedTxnArray(persisted.txns)
    ? persisted.txns
    : null;
  const txns = persistedTxns ?? current.txns;
  const transfers =
    Array.isArray(persisted.transfers) && persisted.transfers.every(isPersistedTransfer)
      ? persisted.transfers
      : current.transfers;
  const attachments =
    Array.isArray(persisted.attachments)
    && persisted.attachments.every(isPersistedAttachment)
      ? persisted.attachments
      : current.attachments;
  const persistedPurchaseSnapshots = isPersistedPurchaseSnapshotArray(
    persisted.purchaseSnapshots,
  )
    ? persisted.purchaseSnapshots
    : null;
  const purchaseSnapshots =
    persistedPurchaseSnapshots ?? current.purchaseSnapshots;
  const persistedRawPurchases = isPersistedRawPurchaseArray(
    persisted.rawPurchases,
  )
    ? persisted.rawPurchases
    : null;
  const usablePersistedRawPurchases = Array.isArray(persisted.rawPurchases)
    ? persisted.rawPurchases.filter(isPersistedRawPurchase)
    : [];
  const rawPurchases =
    persistedRawPurchases !== null &&
    rawPurchasesMatchEntities(persistedRawPurchases, txns)
      ? persistedRawPurchases
      : Array.isArray(persisted.rawPurchases) ||
          persistedTxns !== null ||
          persistedPurchaseSnapshots !== null
        ? reconcileRawPurchases(
            txns,
            purchaseSnapshots,
            usablePersistedRawPurchases,
          )
        : current.rawPurchases;
  const nextId =
    typeof persisted.nextId === 'number' &&
    Number.isSafeInteger(persisted.nextId) &&
    persisted.nextId >= 0
      ? persisted.nextId
      : current.nextId;

  if (
    txns === current.txns &&
    transfers === current.transfers &&
    purchaseSnapshots === current.purchaseSnapshots &&
    rawPurchases === current.rawPurchases &&
    attachments === current.attachments &&
    nextId === current.nextId
  ) {
    return current;
  }
  return {
    ...current,
    txns,
    purchaseSnapshots,
    rawPurchases,
    transfers,
    attachments,
    nextId,
  };
}

// Module-level singleton — one fake Intuit per server process. Mutations are
// additionally persisted to the database (AppConfig `mock:realm:<realmId>`)
// so demo state stays coherent across server restarts and between the seed
// process and the dev server. Persistence is best-effort and disabled under
// tests (pure in-memory there).
let realms = buildRealms();
let hydrated = false;

function persistenceEnabled(): boolean {
  return process.env.NODE_ENV !== 'test' && process.env.VITEST === undefined;
}

const realmKey = (realmId: string) => `mock:realm:${realmId}`;

/** Load persisted realm mutations once per process (lazy, best-effort). */
export async function ensureMockRealmsHydrated(): Promise<void> {
  if (hydrated || !persistenceEnabled()) return;
  hydrated = true;
  try {
    const { prisma } = await import('../prisma.js');
    for (const realmId of [MOCK_REALM_HARBOR, MOCK_REALM_BLUEBIRD]) {
      const row = await prisma.appConfig.findUnique({ where: { key: realmKey(realmId) } });
      const current = realms.get(realmId);
      if (row && current) {
        realms.set(realmId, mergePersistedMockRealm(current, JSON.parse(row.value)));
      }
    }
  } catch (err) {
    console.warn('[mock-qbo] could not hydrate persisted realm state:', err);
  }
}

/** Write-through after a mutation (best-effort). */
export async function persistMockRealm(realmId: string): Promise<void> {
  if (!persistenceEnabled()) return;
  try {
    const { prisma } = await import('../prisma.js');
    const value = JSON.stringify(realms.get(realmId));
    await prisma.appConfig.upsert({
      where: { key: realmKey(realmId) },
      create: { key: realmKey(realmId), value, encrypted: false },
      update: { value },
    });
  } catch (err) {
    console.warn('[mock-qbo] could not persist realm state:', err);
  }
}

export function getMockRealm(realmId: string): MockRealm {
  const realm = realms.get(realmId);
  if (!realm) {
    throw new Error(
      `Unknown mock realm "${realmId}" — mock mode only knows ${MOCK_REALM_HARBOR} (Harbor & Main) and ${MOCK_REALM_BLUEBIRD} (Bluebird Salon)`,
    );
  }
  return realm;
}

/** Reset all mock realm state (tests). */
export function resetMockRealms(): void {
  realms = buildRealms();
  hydrated = false;
}

// ---------------------------------------------------------------------------
// Mock OAuth
// ---------------------------------------------------------------------------

/**
 * Mock consent URL — relative on purpose; the routes layer renders a fake
 * consent page at this path and redirects back to /auth/qbo/callback.
 */
export function mockAuthorizeUrl(state: string): string {
  return `/auth/qbo/mock-consent?state=${encodeURIComponent(state)}`;
}

/**
 * Which realm a mock auth code connects: 'mock-harbor' / 'mock-bluebird' pick
 * explicitly; anything else connects Harbor first, then Bluebird.
 */
export function resolveMockRealmId(code: string, connectedRealmIds: string[]): string {
  if (code === 'mock-harbor') return MOCK_REALM_HARBOR;
  if (code === 'mock-bluebird') return MOCK_REALM_BLUEBIRD;
  return connectedRealmIds.includes(MOCK_REALM_HARBOR) ? MOCK_REALM_BLUEBIRD : MOCK_REALM_HARBOR;
}

export function mockTokenSet(): QboTokenSet {
  return {
    accessToken: 'mock-access-token',
    refreshToken: 'mock-refresh-token',
    expiresAt: Date.now() + 60 * 60 * 1000,
  };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function snapshotLineToRaw(line: QboPurchaseSnapshot['lines'][number]): RawPurchaseLine {
  return {
    ...(line.id === null ? {} : { Id: line.id }),
    Amount: Math.abs(line.amountCents) / 100,
    DetailType: 'AccountBasedExpenseLineDetail',
    ...(line.description === null ? {} : { Description: line.description }),
    AccountBasedExpenseLineDetail: {
      ...(line.accountQboId === null ? {} : { AccountRef: { value: line.accountQboId } }),
      ...(line.customerQboId === null ? {} : { CustomerRef: { value: line.customerQboId } }),
      ...(line.classQboId === null ? {} : { ClassRef: { value: line.classQboId } }),
      ...(line.taxCodeQboId === null ? {} : { TaxCodeRef: { value: line.taxCodeQboId } }),
      ...(line.taxAmountCents === null ? {} : { TaxAmount: Math.abs(line.taxAmountCents) / 100 }),
      ...(line.taxInclusiveCents === null
        ? {}
        : { TaxInclusiveAmt: Math.abs(line.taxInclusiveCents) / 100 }),
    },
  };
}

function rawPurchaseFromMock(
  entity: MockTxnEntity,
  snapshot: QboPurchaseSnapshot | undefined,
): RawPurchase {
  const direction = entity.amount > 0 ? 'refund' : 'purchase';
  const lines = entity.lines.map((line): RawPurchaseLine => {
    const normalized = snapshot?.lines.find(
      (candidate) =>
        candidate.id === line.id &&
        Math.abs(candidate.amountCents) === Math.round(Math.abs(line.amount) * 100) &&
        candidate.accountQboId === line.accountQboId,
    );
    if (normalized) {
      return {
        ...snapshotLineToRaw(normalized),
        ...(line.memo === undefined ? {} : { Description: line.memo }),
      };
    }
    return {
      Id: line.id,
      Amount: line.amount,
      DetailType: 'AccountBasedExpenseLineDetail',
      ...(line.memo === undefined ? {} : { Description: line.memo }),
      AccountBasedExpenseLineDetail: {
        AccountRef: { value: line.accountQboId },
      },
    };
  });
  return {
    Id: entity.qboId,
    SyncToken: String(entity.syncToken),
    TxnDate: entity.date,
    TotalAmt: Math.abs(entity.amount),
    ...(direction === 'refund' ? { Credit: true } : {}),
    ...(entity.memo === undefined ? {} : { PrivateNote: entity.memo }),
    EntityRef: { value: `ENTITY_${entity.qboId}`, name: entity.payee },
    AccountRef: { value: entity.bankAccountQboId },
    ...(snapshot?.globalTaxCalculation === null || snapshot?.globalTaxCalculation === undefined
      ? {}
      : { GlobalTaxCalculation: snapshot.globalTaxCalculation }),
    ...(snapshot?.totalTaxCents === null || snapshot?.totalTaxCents === undefined
      ? {}
      : { TxnTaxDetail: { TotalTax: Math.abs(snapshot.totalTaxCents) / 100 } }),
    Line: lines,
  };
}

function rawPurchaseSnapshot(
  raw: RawPurchase,
  syncToken: string,
  realm: Pick<MockRealm, 'taxCodes' | 'taxRates'>,
): QboPurchaseSnapshot {
  const sign = raw.Credit === true ? 1 : -1;
  const lineTaxCents = (line: RawPurchaseLine): number => {
    const detail = line.AccountBasedExpenseLineDetail;
    if (typeof detail?.TaxAmount === 'number' && Number.isFinite(detail.TaxAmount)) {
      return Math.round(detail.TaxAmount * 100);
    }
    const taxCodeQboId = detail?.TaxCodeRef?.value;
    if (!taxCodeQboId) return 0;
    const code = realm.taxCodes.find(
      (candidate) => candidate.qboId === taxCodeQboId && candidate.active,
    );
    if (!code?.taxable) return 0;
    const ratePercent = code.purchaseRates.reduce((sum, reference) => {
      if (reference.taxTypeApplicable !== 'TaxOnAmount') return sum;
      const rate = realm.taxRates.find(
        (candidate) =>
          candidate.qboId === reference.taxRateQboId && candidate.active,
      );
      return sum + (rate?.rateValue ?? 0);
    }, 0);
    return Math.round(Math.round((line.Amount ?? 0) * 100) * ratePercent / 100);
  };
  const unsignedTotalTaxCents =
    raw.GlobalTaxCalculation === undefined
      ? null
      : (raw.Line ?? []).reduce((sum, line) => sum + lineTaxCents(line), 0);
  return {
    qboId: raw.Id,
    syncToken,
    totalCents: sign * Math.round((raw.TotalAmt ?? 0) * 100),
    accountQboId: raw.AccountRef?.value ?? null,
    date: raw.TxnDate ?? '',
    direction: sign === 1 ? 'refund' : 'purchase',
    globalTaxCalculation: raw.GlobalTaxCalculation ?? null,
    totalTaxCents:
      unsignedTotalTaxCents === null ? null : sign * unsignedTotalTaxCents,
    lines: (raw.Line ?? []).map((line, index) => ({
      id: line.Id ?? String(index + 1),
      amountCents: sign * Math.round((line.Amount ?? 0) * 100),
      description: line.Description ?? null,
      accountQboId: line.AccountBasedExpenseLineDetail?.AccountRef?.value ?? null,
      customerQboId: line.AccountBasedExpenseLineDetail?.CustomerRef?.value ?? null,
      classQboId: line.AccountBasedExpenseLineDetail?.ClassRef?.value ?? null,
      taxCodeQboId: line.AccountBasedExpenseLineDetail?.TaxCodeRef?.value ?? null,
      taxAmountCents:
        line.AccountBasedExpenseLineDetail?.TaxAmount === undefined
          ? null
          : sign * Math.round(line.AccountBasedExpenseLineDetail.TaxAmount * 100),
      taxInclusiveCents:
        line.AccountBasedExpenseLineDetail?.TaxInclusiveAmt === undefined
          ? null
          : sign * Math.round(line.AccountBasedExpenseLineDetail.TaxInclusiveAmt * 100),
    })),
  };
}

export class MockQboClient implements QboClient {
  readonly realmId: string;
  private readonly holdingIds: ReadonlySet<string>;

  constructor(realmId: string, holdingAccountQboIds: string[]) {
    // Validates eagerly so a bad Company row fails loudly at construction.
    getMockRealm(realmId);
    this.realmId = realmId;
    this.holdingIds = new Set(holdingAccountQboIds);
  }

  private get realm(): MockRealm {
    return getMockRealm(this.realmId);
  }

  private accountById(qboId: string): MockAccount | undefined {
    return this.realm.accounts.find((a) => a.qboId === qboId);
  }

  private rawPurchaseById(qboId: string): RawPurchase | undefined {
    return this.realm.rawPurchases.find((purchase) => purchase.Id === qboId);
  }

  private lineWriteBody(entity: MockTxnEntity): Record<string, unknown> {
    if (entity.qboType === 'Purchase') {
      const raw = this.rawPurchaseById(entity.qboId) ??
        rawPurchaseFromMock(
          entity,
          this.realm.purchaseSnapshots.find(
            (snapshot) => snapshot.qboId === entity.qboId,
          ),
        );
      const reconciledLines = entity.lines.map((line): RawPurchaseLine => {
        const preserved = raw.Line?.find(
          (candidate) =>
            candidate.Id === line.id &&
            candidate.Amount === line.amount &&
            candidate.AccountBasedExpenseLineDetail?.AccountRef?.value ===
              line.accountQboId,
        );
        if (preserved) {
          return {
            ...structuredClone(preserved),
            ...(line.memo === undefined ? {} : { Description: line.memo }),
          };
        }
        return {
          Id: line.id,
          Amount: line.amount,
          ...(line.memo === undefined ? {} : { Description: line.memo }),
          DetailType: 'AccountBasedExpenseLineDetail',
          AccountBasedExpenseLineDetail: {
            AccountRef: { value: line.accountQboId },
          },
        };
      });
      return {
        ...structuredClone(raw),
        Id: entity.qboId,
        SyncToken: String(entity.syncToken),
        TxnDate: entity.date,
        TotalAmt: Math.abs(entity.amount),
        ...(entity.memo === undefined ? {} : { PrivateNote: entity.memo }),
        Line: reconciledLines,
      };
    }
    if (entity.rawLineWriteBody) {
      return structuredClone(entity.rawLineWriteBody);
    }

    const accountRef = (qboId: string): { value: string; name?: string } => {
      const name = this.accountById(qboId)?.name;
      return {
        value: qboId,
        ...(name === undefined ? {} : { name }),
      };
    };
    if (entity.qboType === 'Deposit') {
      const body: RawDeposit = {
        Id: entity.qboId,
        SyncToken: String(entity.syncToken),
        TxnDate: entity.date,
        TotalAmt: Math.abs(entity.amount),
        ...(entity.memo === undefined ? {} : { PrivateNote: entity.memo }),
        DepositToAccountRef: accountRef(entity.bankAccountQboId),
        Line: entity.lines.map((line) => ({
          Id: line.id,
          Amount: line.amount,
          ...(line.memo === undefined ? {} : { Description: line.memo }),
          DetailType: 'DepositLineDetail',
          DepositLineDetail: { AccountRef: accountRef(line.accountQboId) },
        })),
      };
      return body as unknown as Record<string, unknown>;
    }

    const debitTotal = round2(
      entity.lines.reduce((total, line) => total + line.amount, 0),
    );
    const body: RawJournalEntry = {
      Id: entity.qboId,
      SyncToken: String(entity.syncToken),
      TxnDate: entity.date,
      ...(entity.memo === undefined ? {} : { PrivateNote: entity.memo }),
      Line: [
        ...entity.lines.map((line) => ({
          Id: line.id,
          Amount: line.amount,
          ...(line.memo === undefined ? {} : { Description: line.memo }),
          DetailType: 'JournalEntryLineDetail',
          JournalEntryLineDetail: {
            PostingType: 'Debit' as const,
            AccountRef: accountRef(line.accountQboId),
          },
        })),
        {
          Id: `FUNDING_${entity.qboId}`,
          Amount: debitTotal,
          DetailType: 'JournalEntryLineDetail',
          JournalEntryLineDetail: {
            PostingType: 'Credit',
            AccountRef: accountRef(entity.bankAccountQboId),
          },
        },
      ],
    };
    return body as unknown as Record<string, unknown>;
  }

  /**
   * Mirror the real client's mapping: QboTxn.lines is ONLY the lines posting
   * to `filterIds` (holding accounts), and amount is the signed sum of those
   * lines — not the entity total.
   */
  private toQboTxn(e: MockTxnEntity, filterIds: ReadonlySet<string>): QboTxn {
    const holdingLines = e.lines.filter((l) => filterIds.has(l.accountQboId));
    const sum = round2(holdingLines.reduce((a, l) => a + l.amount, 0));
    return {
      qboId: e.qboId,
      qboType: e.qboType,
      syncToken: String(e.syncToken),
      date: e.date,
      payee: e.payee,
      memo: e.memo,
      // Keep the entity's natural sign (+ = money in).
      amount: e.amount < 0 ? -sum : sum,
      bankAccount: this.accountById(e.bankAccountQboId)?.name ?? '',
      lines: holdingLines.map((l) => ({
        id: l.id,
        amount: l.amount,
        accountQboId: l.accountQboId,
        accountName: this.accountById(l.accountQboId)?.name ?? '',
        memo: l.memo,
      })),
      raw:
        this.lineWriteBody(e),
    };
  }

  private findEntity(qboType: QboTxn['qboType'], qboId: string): MockTxnEntity | undefined {
    return this.realm.txns.find((t) => t.qboType === qboType && t.qboId === qboId && !t.deleted);
  }

  // ---- reads ----

  async getCompanyInfo(): Promise<QboCompanyInfo> {
    await ensureMockRealmsHydrated();
    return { realmId: this.realmId, legalName: this.realm.legalName };
  }

  async listAccounts(): Promise<QboAccountInfo[]> {
    await ensureMockRealmsHydrated();
    return this.realm.accounts.map((a) => ({
      qboId: a.qboId,
      name: a.name,
      fullName: a.fullName,
      classification: a.classification,
      accountType: a.accountType,
      active: true,
    }));
  }

  async getTaxProfile(): Promise<QboTaxProfile> {
    await ensureMockRealmsHydrated();
    return { ...this.realm.taxProfile };
  }

  async listTaxCodes(): Promise<QboTaxCodeInfo[]> {
    await ensureMockRealmsHydrated();
    return this.realm.taxCodes.map((code) => ({ ...code, purchaseRates: code.purchaseRates.map((rate) => ({ ...rate })) }));
  }

  async listTaxRates(): Promise<QboTaxRateInfo[]> {
    await ensureMockRealmsHydrated();
    return this.realm.taxRates.map((rate) => ({ ...rate }));
  }

  async uploadAttachments(
    ref: QboAttachmentRef,
    files: QboAttachmentUploadFile[],
    _requestId: string,
  ): Promise<QboAttachmentUploadOutcome[]> {
    await ensureMockRealmsHydrated();
    if (!this.findEntity(ref.qboType, ref.qboId)) {
      throw new Error(`Mock QBO: ${ref.qboType} ${ref.qboId} not found`);
    }
    const outcomes: QboAttachmentUploadOutcome[] = [];
    for (const file of files) {
      const configuredFault =
        this.realm.attachmentUploadFaults[String(file.ordinal)];
      if (configuredFault) {
        outcomes.push({
          ordinal: file.ordinal,
          outcome: 'FAILED',
          ...configuredFault,
        });
        continue;
      }
      const reader = await file.openContent();
      if (
        reader.sizeBytes !== file.sizeBytes
        || reader.contentType !== file.contentType
      ) {
        throw new Error('Mock QBO: attachment content metadata changed');
      }
      const chunks: Buffer[] = [];
      let sizeBytes = 0;
      for await (const chunk of reader.chunks()) {
        const copied = Buffer.from(chunk);
        sizeBytes += copied.byteLength;
        if (sizeBytes > file.sizeBytes) {
          throw new Error('Mock QBO: attachment content exceeded its declared size');
        }
        chunks.push(copied);
      }
      if (sizeBytes !== file.sizeBytes) {
        throw new Error('Mock QBO: attachment content did not match its declared size');
      }
      const record: MockAttachmentRecord = {
        id: `attachable-${this.realm.nextId++}`,
        syncToken: '0',
        filename: file.filename,
        contentType: file.contentType,
        sizeBytes,
        note: `Recat reference: ${file.marker}`,
        refs: [{ ...ref }],
        contentBase64: Buffer.concat(chunks).toString('base64'),
      };
      this.realm.attachments.push(record);
      outcomes.push({
        ordinal: file.ordinal,
        outcome: 'ATTACHED',
        attachable: structuredClone(record),
      });
    }
    await persistMockRealm(this.realmId);
    if (this.realm.attachmentTimeoutAfterAccept) {
      this.realm.attachmentTimeoutAfterAccept = false;
      throw new QboRequestTimeout(
        'Mock QBO accepted the attachment batch but did not confirm it.',
      );
    }
    return outcomes;
  }

  async listAttachments(ref: QboAttachmentRef): Promise<QboAttachable[]> {
    await ensureMockRealmsHydrated();
    return this.realm.attachments
      .filter((attachment) =>
        attachment.refs.some(
          (candidate) =>
            candidate.qboType === ref.qboType
            && candidate.qboId === ref.qboId,
        ))
      .map(({ contentBase64: _contentBase64, ...attachment }) =>
        structuredClone(attachment));
  }

  async getAttachment(id: string): Promise<QboAttachable | null> {
    await ensureMockRealmsHydrated();
    const record = this.realm.attachments.find(
      (attachment) => attachment.id === id,
    );
    if (!record) return null;
    const { contentBase64: _contentBase64, ...attachment } = record;
    return structuredClone(attachment);
  }

  async openAttachmentDownload(id: string): Promise<QboAttachmentDownload> {
    await ensureMockRealmsHydrated();
    const record = this.realm.attachments.find(
      (attachment) => attachment.id === id,
    );
    if (!record) throw new Error(`Mock QBO: attachment ${id} not found`);
    const content = Buffer.from(record.contentBase64, 'base64');
    return {
      contentType: record.contentType,
      sizeBytes: record.sizeBytes,
      body: (async function* () {
        yield content;
      })(),
    };
  }

  async deleteAttachment(input: {
    id: string;
    syncToken: string;
    requestId: string;
  }): Promise<void> {
    await ensureMockRealmsHydrated();
    const index = this.realm.attachments.findIndex(
      (attachment) => attachment.id === input.id,
    );
    if (index === -1) throw new Error(`Mock QBO: attachment ${input.id} not found`);
    if (this.realm.attachments[index]!.syncToken !== input.syncToken) {
      throw new QboSyncTokenConflict();
    }
    this.realm.attachments.splice(index, 1);
    await persistMockRealm(this.realmId);
  }

  async fetchPurchaseSnapshot(qboId: string): Promise<QboPurchaseSnapshot | null> {
    await ensureMockRealmsHydrated();
    const raw = this.rawPurchaseById(qboId);
    if (raw) {
      return rawPurchaseSnapshot(raw, raw.SyncToken, this.realm);
    }
    const snapshot = this.realm.purchaseSnapshots.find((purchase) => purchase.qboId === qboId);
    return snapshot ? { ...snapshot, lines: snapshot.lines.map((line) => ({ ...line })) } : null;
  }

  async fetchLineWriteSnapshot(
    qboType: QboTxn['qboType'],
    qboId: string,
  ): Promise<QboLineWriteSnapshot | null> {
    await ensureMockRealmsHydrated();
    const entity = this.findEntity(qboType, qboId);
    if (!entity) return null;
    return {
      qboType,
      qboId,
      syncToken: String(entity.syncToken),
      contentHash: hashLineWriteContent(this.lineWriteBody(entity)),
    };
  }

  async preparePurchaseRecategorization(
    txn: QboTxn,
    staged: StagedCategorization,
    before: QboPurchaseSnapshot,
    requestId: string,
  ): Promise<QboPreparedWrite> {
    await ensureMockRealmsHydrated();
    if (txn.qboType !== 'Purchase') {
      throw new Error('Prepared tax-aware writes support Purchase transactions only.');
    }
    const entity = this.findEntity('Purchase', txn.qboId);
    if (!entity) throw new Error(`Mock QBO: Purchase ${txn.qboId} not found`);
    if (String(entity.syncToken) !== txn.syncToken) throw new QboSyncTokenConflict();
    const raw = this.rawPurchaseById(txn.qboId);
    if (!raw) throw new Error(`Mock QBO: raw Purchase ${txn.qboId} not found`);
    if (raw.SyncToken !== txn.syncToken) throw new QboSyncTokenConflict();
    return preparePurchaseRecategorizationBody({
      current: structuredClone(raw),
      holdingAccountQboIds: [...this.holdingIds],
      staged,
      before,
      requestId,
    });
  }

  async sendPreparedWrite(prepared: QboPreparedWrite): Promise<QboWriteResult> {
    await ensureMockRealmsHydrated();
    const entity = this.findEntity('Purchase', prepared.qboId);
    if (!entity) throw new Error(`Mock QBO: Purchase ${prepared.qboId} not found`);
    const currentRaw = this.rawPurchaseById(prepared.qboId);
    if (!currentRaw) throw new Error(`Mock QBO: raw Purchase ${prepared.qboId} not found`);
    if (
      prepared.body.Id !== prepared.qboId ||
      String(entity.syncToken) !== prepared.body.SyncToken ||
      currentRaw.SyncToken !== prepared.body.SyncToken
    ) {
      throw new QboSyncTokenConflict();
    }
    const responseBody = structuredClone(prepared.body);
    const lines = responseBody.Line;
    if (!Array.isArray(lines)) throw new Error('Mock QBO: prepared Purchase Line array is missing');
    const reservedLineIds = new Set(
      lines.flatMap((line) =>
        typeof line.Id === 'string' && line.Id !== '' ? [line.Id] : []),
    );
    for (const line of lines) {
      if (line.Id !== undefined && line.Id !== '') continue;
      let candidate: string;
      do {
        candidate = String(this.realm.nextId++);
      } while (reservedLineIds.has(candidate));
      line.Id = candidate;
      reservedLineIds.add(candidate);
    }
    const mappedLines = lines.map((line): MockLine => {
      const accountQboId = line.AccountBasedExpenseLineDetail?.AccountRef?.value;
      if (!accountQboId || !this.accountById(accountQboId)) {
        throw new Error(`Mock QBO: unknown prepared Purchase account id "${accountQboId ?? ''}"`);
      }
      return {
        id: line.Id!,
        amount: round2(line.Amount ?? 0),
        accountQboId,
        ...(line.Description === undefined ? {} : { memo: line.Description }),
      };
    });

    entity.lines = mappedLines;
    entity.amount = responseBody.Credit === true
      ? Math.abs(responseBody.TotalAmt ?? entity.amount)
      : -Math.abs(responseBody.TotalAmt ?? entity.amount);
    entity.syncToken += 1;
    entity.lastUpdated = new Date().toISOString();
    responseBody.SyncToken = String(entity.syncToken);
    const rawIndex = this.realm.rawPurchases.findIndex(
      (purchase) => purchase.Id === prepared.qboId,
    );
    this.realm.rawPurchases[rawIndex] = responseBody;
    const responseSnapshot = rawPurchaseSnapshot(
      responseBody,
      String(entity.syncToken),
      this.realm,
    );
    const snapshotIndex = this.realm.purchaseSnapshots.findIndex(
      (snapshot) => snapshot.qboId === prepared.qboId,
    );
    if (snapshotIndex === -1) this.realm.purchaseSnapshots.push(responseSnapshot);
    else this.realm.purchaseSnapshots[snapshotIndex] = responseSnapshot;
    await persistMockRealm(this.realmId);
    return { ok: true, newSyncToken: String(entity.syncToken) };
  }

  async prepareLineRecategorization(
    txn: QboTxn,
    splits: { amount: number; accountQboId: string; memo?: string }[],
    requestId: string,
  ): Promise<QboPreparedLineWrite> {
    await ensureMockRealmsHydrated();
    const entity = this.findEntity(txn.qboType, txn.qboId);
    if (!entity) {
      throw new Error(`Mock QBO: ${txn.qboType} ${txn.qboId} not found`);
    }
    if (String(entity.syncToken) !== txn.syncToken) {
      throw new QboSyncTokenConflict();
    }
    const raw = this.lineWriteBody(entity);
    return buildPreparedLineWrite({
      txn: { ...txn, raw },
      splits,
      requestId,
      holdingAccountQboIds: [...this.holdingIds],
    });
  }

  async sendPreparedLineWrite(
    preparedValue: QboPreparedLineWrite,
    beforeSend?: () => Promise<void>,
  ): Promise<QboLineWriteResult> {
    const prepared = structuredClone(validatePreparedLineWrite(preparedValue));
    const responseBody = structuredClone(prepared.body);
    await ensureMockRealmsHydrated();
    const entity = this.findEntity(prepared.qboType, prepared.qboId);
    if (!entity) {
      throw new Error(
        `Mock QBO: ${prepared.qboType} ${prepared.qboId} not found`,
      );
    }
    const currentBody = this.lineWriteBody(entity);
    if (
      String(entity.syncToken) !== prepared.before.syncToken ||
      hashLineWriteContent(currentBody) !== prepared.before.contentHash
    ) {
      throw new QboSyncTokenConflict();
    }

    const rawLines = responseBody.Line;
    if (
      !Array.isArray(rawLines) ||
      !rawLines.every(
        (line) => typeof line === 'object' && line !== null && !Array.isArray(line),
      )
    ) {
      throw new Error(
        `Mock QBO: prepared ${prepared.qboType} Line array is missing`,
      );
    }
    const lines = rawLines as Record<string, unknown>[];
    const reservedLineIds = new Set(
      lines.flatMap((line) =>
        typeof line.Id === 'string' && line.Id !== '' ? [line.Id] : []),
    );
    let nextId = this.realm.nextId;
    for (const line of lines) {
      if (typeof line.Id === 'string' && line.Id !== '') continue;
      let candidate: string;
      do {
        candidate = String(nextId);
        nextId += 1;
      } while (reservedLineIds.has(candidate));
      line.Id = candidate;
      reservedLineIds.add(candidate);
    }

    const mapLine = (
      line: Record<string, unknown>,
      detailName:
        | 'AccountBasedExpenseLineDetail'
        | 'DepositLineDetail'
        | 'JournalEntryLineDetail',
    ): MockLine => {
      const detail = line[detailName];
      const accountRef =
        isRecord(detail) && isRecord(detail.AccountRef)
          ? detail.AccountRef
          : null;
      const accountQboId =
        accountRef && typeof accountRef.value === 'string'
          ? accountRef.value
          : '';
      if (
        typeof line.Id !== 'string' ||
        typeof line.Amount !== 'number' ||
        !this.accountById(accountQboId)
      ) {
        throw new Error(
          `Mock QBO: invalid prepared ${prepared.qboType} line account`,
        );
      }
      return {
        id: line.Id,
        amount: round2(line.Amount),
        accountQboId,
        ...(line.Description === undefined
          ? {}
          : { memo: String(line.Description) }),
      };
    };

    let mappedLines: MockLine[];
    let bankAccountQboId = entity.bankAccountQboId;
    if (prepared.qboType === 'Purchase') {
      mappedLines = lines.map((line) =>
        mapLine(line, 'AccountBasedExpenseLineDetail'));
      const accountRef = responseBody.AccountRef;
      if (isRecord(accountRef) && typeof accountRef.value === 'string') {
        bankAccountQboId = accountRef.value;
      }
    } else if (prepared.qboType === 'Deposit') {
      mappedLines = lines.map((line) => mapLine(line, 'DepositLineDetail'));
      const accountRef = responseBody.DepositToAccountRef;
      if (isRecord(accountRef) && typeof accountRef.value === 'string') {
        bankAccountQboId = accountRef.value;
      }
    } else {
      const debitLines: Record<string, unknown>[] = [];
      for (const line of lines) {
        const detail = line.JournalEntryLineDetail;
        if (!isRecord(detail)) {
          throw new Error('Mock QBO: invalid prepared JournalEntry detail');
        }
        if (detail.PostingType === 'Debit') {
          debitLines.push(line);
        } else if (detail.PostingType === 'Credit') {
          const accountRef = detail.AccountRef;
          if (
            !isRecord(accountRef) ||
            typeof accountRef.value !== 'string' ||
            !this.accountById(accountRef.value)
          ) {
            throw new Error(
              'Mock QBO: invalid prepared JournalEntry credit account',
            );
          }
          bankAccountQboId = accountRef.value;
        } else {
          throw new Error('Mock QBO: invalid prepared JournalEntry posting type');
        }
      }
      mappedLines = debitLines.map((line) =>
        mapLine(line, 'JournalEntryLineDetail'));
    }

    const nextSyncToken = String(entity.syncToken + 1);
    responseBody.SyncToken = nextSyncToken;
    const result = verifyLineWriteResult(prepared, {
      qboType: prepared.qboType,
      qboId: prepared.qboId,
      syncToken: nextSyncToken,
      contentHash: hashLineWriteContent(responseBody),
    });

    await beforeSend?.();
    entity.lines = mappedLines;
    entity.syncToken += 1;
    entity.bankAccountQboId = bankAccountQboId;
    if (typeof responseBody.TxnDate === 'string') {
      entity.date = responseBody.TxnDate;
    }
    entity.memo =
      typeof responseBody.PrivateNote === 'string'
        ? responseBody.PrivateNote
        : undefined;
    if (prepared.qboType === 'Purchase') {
      entity.amount =
        responseBody.Credit === true
          ? Math.abs(
              typeof responseBody.TotalAmt === 'number'
                ? responseBody.TotalAmt
                : entity.amount,
            )
          : -Math.abs(
              typeof responseBody.TotalAmt === 'number'
                ? responseBody.TotalAmt
                : entity.amount,
            );
      const rawIndex = this.realm.rawPurchases.findIndex(
        (purchase) => purchase.Id === prepared.qboId,
      );
      const purchaseBody = responseBody as unknown as RawPurchase;
      if (rawIndex === -1) this.realm.rawPurchases.push(purchaseBody);
      else this.realm.rawPurchases[rawIndex] = purchaseBody;
      const responseSnapshot = rawPurchaseSnapshot(
        purchaseBody,
        nextSyncToken,
        this.realm,
      );
      const snapshotIndex = this.realm.purchaseSnapshots.findIndex(
        (snapshot) => snapshot.qboId === prepared.qboId,
      );
      if (snapshotIndex === -1) {
        this.realm.purchaseSnapshots.push(responseSnapshot);
      } else {
        this.realm.purchaseSnapshots[snapshotIndex] = responseSnapshot;
      }
    } else if (prepared.qboType === 'Deposit') {
      entity.amount = Math.abs(
        typeof responseBody.TotalAmt === 'number'
          ? responseBody.TotalAmt
          : entity.amount,
      );
      entity.rawLineWriteBody = responseBody;
    } else {
      entity.amount = -round2(
        mappedLines.reduce((total, line) => total + line.amount, 0),
      );
      entity.rawLineWriteBody = responseBody;
    }
    entity.lastUpdated = new Date().toISOString();
    this.realm.nextId = nextId;
    await persistMockRealm(this.realmId);
    return result;
  }

  async preparePurchaseRestore(
    txn: QboTxn,
    prepared: QboPreparedWrite,
    requestId: string,
  ): Promise<QboPreparedWrite> {
    await ensureMockRealmsHydrated();
    if (txn.qboType !== 'Purchase') {
      throw new Error('Prepared restore supports Purchase transactions only.');
    }
    const entity = this.findEntity('Purchase', txn.qboId);
    if (!entity) throw new Error(`Mock QBO: Purchase ${txn.qboId} not found`);
    if (String(entity.syncToken) !== txn.syncToken) throw new QboSyncTokenConflict();
    const raw = this.rawPurchaseById(txn.qboId);
    if (!raw) throw new Error(`Mock QBO: raw Purchase ${txn.qboId} not found`);
    if (raw.SyncToken !== txn.syncToken) throw new QboSyncTokenConflict();
    return preparePurchaseRestoreBody({
      current: structuredClone(raw),
      prepared,
      requestId,
    });
  }

  async listTxnsInAccounts(accountQboIds: string[]): Promise<QboTxn[]> {
    await ensureMockRealmsHydrated();
    // Like the real client: the caller's ids (not the instance holding set)
    // are the line filter, so the setup wizard can probe candidate accounts.
    const ids = new Set(accountQboIds);
    return this.realm.txns
      .filter((t) => !t.deleted && t.lines.some((l) => ids.has(l.accountQboId)))
      .map((t) => this.toQboTxn(t, ids));
  }

  async changedSince(isoTimestamp: string): Promise<{ txns: QboTxn[]; deletedQboIds: { qboType: string; qboId: string }[] }> {
    await ensureMockRealmsHydrated();
    const since = Date.parse(isoTimestamp);
    const changed = this.realm.txns.filter((t) => Date.parse(t.lastUpdated) > since);
    return {
      txns: changed.filter((t) => !t.deleted).map((t) => this.toQboTxn(t, this.holdingIds)),
      deletedQboIds: changed.filter((t) => t.deleted).map((t) => ({ qboType: t.qboType, qboId: t.qboId })),
    };
  }

  async fetchTxn(qboType: QboTxn['qboType'], qboId: string): Promise<QboTxn | null> {
    await ensureMockRealmsHydrated();
    const entity = this.findEntity(qboType, qboId);
    return entity ? this.toQboTxn(entity, this.holdingIds) : null;
  }

  async getStatement(): Promise<QboStatement> {
    // Demo statements are synthesized in services/reports.ts from the seeded
    // series (demo:plBases / demo:bs) so every screen matches the design
    // prototype — the service never routes here in mock mode.
    throw new Error('MockQboClient.getStatement is not used in mock mode — demo statements come from services/reports.ts');
  }

  async getAccountTransactions(params: {
    accountQboId: string;
    startDate: string;
    endDate: string;
  }): Promise<QboAccountTxn[]> {
    await ensureMockRealmsHydrated();
    // Entities whose CATEGORY lines post to the account within the range —
    // i.e. what a categorization already moved there. Demo P&L rows without a
    // mirrored entity return [] (expected demo artifact before posts).
    return this.realm.txns
      .filter(
        (t) =>
          !t.deleted &&
          t.date >= params.startDate &&
          t.date <= params.endDate &&
          t.lines.some((l) => l.accountQboId === params.accountQboId),
      )
      .map((t) => {
        const sum = round2(
          t.lines.reduce((a, l) => (l.accountQboId === params.accountQboId ? a + l.amount : a), 0),
        );
        return {
          date: t.date,
          payee: t.payee,
          ...(t.memo !== undefined ? { memo: t.memo } : {}),
          // Keep the entity's natural sign (+ = money in), like toQboTxn.
          amount: t.amount < 0 ? -sum : sum,
          txnType: t.qboType,
          qboId: t.qboId,
        };
      });
  }

  async listTransactions(params: { startDate: string; endDate: string }): Promise<QboLogTxn[]> {
    await ensureMockRealmsHydrated();
    const nameOf = (qboId: string): string =>
      this.realm.accounts.find((a) => a.qboId === qboId)?.name ?? qboId;
    return this.realm.txns
      .filter((t) => !t.deleted && t.date >= params.startDate && t.date <= params.endDate)
      .map((t) => {
        const categoryIds = [...new Set(t.lines.map((l) => l.accountQboId))];
        return {
          date: t.date,
          txnType: t.qboType,
          payee: t.payee,
          ...(t.memo !== undefined ? { memo: t.memo } : {}),
          account: nameOf(t.bankAccountQboId),
          // Same convention as QBO's TransactionList Split column: one row per
          // entity, with multi-line entities reading '- Split -'.
          category: categoryIds.length === 1 ? nameOf(categoryIds[0]!) : '- Split -',
          amount: t.amount,
          qboId: t.qboId,
        };
      })
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }

  // ---- writes (all bump SyncToken; stale tokens conflict, like real QBO) ----

  /**
   * Shared write path mirroring RealQboClient.replaceLines: replace ONLY the
   * lines posting to `replaceIds`, preserving every other line verbatim.
   */
  private replaceLines(
    txn: QboTxn,
    replaceIds: ReadonlySet<string>,
    newLines: { amount: number; accountQboId: string; memo?: string }[],
  ): QboWriteResult {
    const entity = this.findEntity(txn.qboType, txn.qboId);
    if (!entity) throw new Error(`Mock QBO: ${txn.qboType} ${txn.qboId} not found`);
    if (String(entity.syncToken) !== txn.syncToken) throw new QboSyncTokenConflict();
    for (const s of newLines) {
      if (!this.accountById(s.accountQboId)) {
        throw new Error(`Mock QBO: unknown account id "${s.accountQboId}" in realm ${this.realmId}`);
      }
    }
    const currentRaw =
      txn.qboType === 'Deposit' || txn.qboType === 'JournalEntry'
        ? this.lineWriteBody(entity)
        : null;
    const keep = entity.lines.filter((l) => !replaceIds.has(l.accountQboId));
    const nextLines = [
      ...keep,
      ...newLines.map((s, i) => ({
        id: String(keep.length + i + 1),
        amount: round2(Math.abs(s.amount)),
        accountQboId: s.accountQboId,
        memo: s.memo,
      })),
    ];
    if (currentRaw) {
      const rebuiltLines =
        txn.qboType === 'Deposit'
          ? rebuildDepositLines(
              currentRaw as unknown as RawDeposit,
              replaceIds,
              newLines,
            )
          : rebuildJournalEntryLines(
              currentRaw as unknown as RawJournalEntry,
              replaceIds,
              newLines,
            );
      const firstNewRawIndex = rebuiltLines.length - newLines.length;
      const nextRawLines = rebuiltLines.map((line, index) => {
        if (index < firstNewRawIndex) return line;
        const newLineIndex = index - firstNewRawIndex;
        return {
          ...line,
          Id: nextLines[keep.length + newLineIndex]!.id,
        };
      });
      entity.rawLineWriteBody = {
        ...currentRaw,
        SyncToken: String(entity.syncToken + 1),
        Line: nextRawLines,
      };
    }
    entity.lines = nextLines;
    entity.syncToken += 1;
    entity.lastUpdated = new Date().toISOString();
    return { ok: true, newSyncToken: String(entity.syncToken) };
  }

  async recategorize(
    txn: QboTxn,
    splits: { amount: number; accountQboId: string; memo?: string }[],
  ): Promise<QboWriteResult> {
    const prepared = await this.prepareLineRecategorization(
      txn,
      splits,
      randomUUID(),
    );
    const result = await this.sendPreparedLineWrite(prepared);
    return { ok: true, newSyncToken: result.newSyncToken };
  }

  async moveToAccount(txn: QboTxn, accountQboId: string, fromAccountQboIds: string[]): Promise<QboWriteResult> {
    await ensureMockRealmsHydrated();
    const replaceIds = new Set(fromAccountQboIds);
    const entity = this.findEntity(txn.qboType, txn.qboId);
    if (!entity) throw new Error(`Mock QBO: ${txn.qboType} ${txn.qboId} not found`);
    const sum = round2(
      entity.lines.reduce((a, l) => (replaceIds.has(l.accountQboId) ? a + l.amount : a), 0),
    );
    if (sum <= 0) {
      throw new Error(
        'Undo found no lines posting to the previously chosen categories — this transaction was edited in QuickBooks. Verify it there.',
      );
    }
    const result = this.replaceLines(txn, replaceIds, [{ amount: sum, accountQboId }]);
    await persistMockRealm(this.realmId);
    return result;
  }

  async createTransfer(args: {
    amount: number;
    fromAccountQboId: string;
    toAccountQboId: string;
    date: string;
    memo?: string;
  }): Promise<{ qboId: string }> {
    await ensureMockRealmsHydrated();
    const realm = this.realm;
    const qboId = `transfer-${realm.nextId++}`;
    realm.transfers.push({
      qboId,
      amount: round2(Math.abs(args.amount)),
      fromAccountQboId: args.fromAccountQboId,
      toAccountQboId: args.toAccountQboId,
      date: args.date,
      memo: args.memo,
      lastUpdated: new Date().toISOString(),
    });
    await persistMockRealm(this.realmId);
    return { qboId };
  }
}
