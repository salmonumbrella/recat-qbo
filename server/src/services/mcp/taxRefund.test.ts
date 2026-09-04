import { describe, expect, it, vi } from 'vitest';
import type { McpPrincipal } from '../../mcp/auth.js';
import type { QboClient } from '../../lib/qbo/types.js';
import {
  McpTaxRefundError,
  prepareMcpTaxRefund,
  type PrepareMcpTaxRefundInput,
} from './taxRefund.js';

const COMPANY_ID = '11111111-1111-4111-8111-111111111111';
const TRANSACTION_ID = '22222222-2222-4222-8222-222222222222';
const principal: McpPrincipal = {
  tokenId: '33333333-3333-4333-8333-333333333333',
  tokenPrefix: 'rct_refund',
  userId: '44444444-4444-4444-8444-444444444444',
  isInstanceAdmin: false,
  memberships: [{ companyId: COMPANY_ID, role: 'categorizer' }],
};

function input(overrides: Partial<PrepareMcpTaxRefundInput> = {}): PrepareMcpTaxRefundInput {
  return {
    companyId: COMPANY_ID,
    transactionId: TRANSACTION_ID,
    expectedRevision: 0,
    idempotencyKey: 'gst-refund-test-deposit-1',
    taxAgencyQboId: 'CRA',
    filedReturnRef: '2025-Q4',
    filingEvidenceSha256: 'a'.repeat(64),
    suspenseAccountQboId: '55',
    bankAccountQboId: 'BANK-1',
    refundDate: '2026-01-15',
    principalCents: 123_456,
    ...overrides,
  };
}

function transaction(overrides: Record<string, unknown> = {}) {
  return {
    id: TRANSACTION_ID,
    companyId: COMPANY_ID,
    qboId: 'TEST-DEPOSIT-1',
    qboType: 'Deposit',
    qboSyncToken: '0',
    revision: 0,
    status: 'PENDING',
    amount: 1_234.56,
    date: new Date('2026-01-15T00:00:00.000Z'),
    ...overrides,
  };
}

function qboClient(overrides: Partial<QboClient> = {}): QboClient {
  return {
    realmId: 'realm-1',
    probeTaxRefundCapability: vi.fn().mockResolvedValue({
      mode: 'manual_required',
      reason: 'UNSUPPORTED_PUBLIC_API',
      api: 'intuit-accounting-v3',
      minorVersion: '75',
    }),
    listAccounts: vi.fn().mockResolvedValue([
      {
        qboId: '55',
        name: 'GST/HST Suspense',
        fullName: 'GST/HST Suspense',
        classification: 'Liability',
        accountType: 'Other Current Liabilities',
        accountSubType: 'GlobalTaxSuspense',
        active: true,
      },
      {
        qboId: 'BANK-1',
        name: 'Operating',
        fullName: 'Operating',
        classification: 'Bank',
        accountType: 'Bank',
        accountSubType: 'Checking',
        active: true,
      },
    ]),
    fetchPreparedSnapshot: vi.fn().mockResolvedValue({
      qboId: 'TEST-DEPOSIT-1',
      syncToken: '0',
      totalCents: 123_456,
      depositToAccountQboId: 'BANK-1',
      date: '2026-01-15',
      globalTaxCalculation: 'NotApplicable',
      totalTaxCents: 0,
      preservedHash: 'b'.repeat(64),
      lines: [],
    }),
    ...overrides,
  } as unknown as QboClient;
}

function dependencies(client = qboClient(), txn = transaction()) {
  const createOperation = vi.fn().mockImplementation(async (request) => ({
    id: '55555555-5555-4555-8555-555555555555',
    expiresAt: new Date('2026-09-04T22:15:00.000Z'),
    sourceRevision: request.sourceRevision,
    payload: request.payload,
  }));
  return {
    authorize: vi.fn().mockResolvedValue(undefined),
    loadTransaction: vi.fn().mockResolvedValue(txn),
    getClient: vi.fn().mockResolvedValue(client),
    createOperation,
    now: () => new Date('2026-09-04T22:00:00.000Z'),
  };
}

describe('prepareMcpTaxRefund', () => {
  it('prepares an immutable manual Tax Centre action without posting the Deposit', async () => {
    const deps = dependencies();

    const prepared = await prepareMcpTaxRefund(principal, input(), deps);

    expect(prepared).toMatchObject({
      operationId: '55555555-5555-4555-8555-555555555555',
      capability: 'manual_required',
      preview: {
        action: 'record_gst_hst_refund',
        operatorPath: 'Sales Tax > Filed > Record refund',
        sourceDepositQboId: 'TEST-DEPOSIT-1',
        suspenseAccountQboId: '55',
        bankAccountQboId: 'BANK-1',
        principalCents: 123_456,
        totalBankCreditCents: 123_456,
        existingDepositTreatment: 'replace_or_match_before_verification',
      },
    });
    expect(deps.createOperation).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'prepare_tax_refund',
      kind: 'tax_refund',
      qboType: 'Deposit',
      qboId: 'TEST-DEPOSIT-1',
      qboSyncToken: '0',
    }), expect.anything());
  });

  it.each([
    ['non-Deposit source', transaction({ qboType: 'Purchase' }), input(), 'SOURCE_NOT_DEPOSIT'],
    ['stale revision', transaction({ revision: 1 }), input(), 'STALE_SOURCE'],
    ['amount mismatch', transaction(), input({ principalCents: 123_455 }), 'AMOUNT_MISMATCH'],
  ])('rejects %s', async (_label, txn, request, code) => {
    const caught = await prepareMcpTaxRefund(
      principal,
      request as PrepareMcpTaxRefundInput,
      dependencies(qboClient(), txn),
    ).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(McpTaxRefundError);
    expect(caught).toMatchObject({ code });
  });

  it('rejects a lookalike liability account instead of creating generic suspense', async () => {
    const client = qboClient({
      listAccounts: vi.fn().mockResolvedValue([{
        qboId: '55',
        name: 'GST suspense',
        fullName: 'GST suspense',
        classification: 'Liability',
        accountType: 'Other Current Liabilities',
        accountSubType: 'OtherCurrentLiabilities',
        active: true,
      }]),
    });

    const caught = await prepareMcpTaxRefund(
      principal,
      input(),
      dependencies(client),
    ).catch((error: unknown) => error);

    expect(caught).toMatchObject({ code: 'SYSTEM_SUSPENSE_REQUIRED' });
  });
});
