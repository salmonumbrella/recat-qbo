import { prisma } from '../../lib/prisma.js';
import { qboFactory } from '../../lib/qbo/factory.js';
import type { QboClient } from '../../lib/qbo/types.js';
import type { McpPrincipal } from '../../mcp/auth.js';
import { moneyToCents } from '../tax/model.js';
import {
  createPreparedOperation,
  normalizeMcpOperationIdempotencyKey,
  type CreatePreparedOperationInput,
  type McpOperationRecord,
} from './operations.js';
import {
  assertCurrentMcpCategorizationAuthorization,
  type McpCategorizationAuthorizationStore,
} from './categorization.js';

const TOOL_NAME = 'prepare_tax_refund';
const SHA256 = /^[0-9a-f]{64}$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const MAX_REFERENCE = 120;

export interface PrepareMcpTaxRefundInput {
  companyId: string;
  transactionId: string;
  expectedRevision: number;
  idempotencyKey: string;
  taxAgencyQboId: string;
  filedReturnRef: string;
  filingEvidenceSha256: string;
  suspenseAccountQboId: string;
  bankAccountQboId: string;
  refundDate: string;
  principalCents: number;
  interestCents?: number;
  interestAccountQboId?: string;
}

export interface PreparedMcpTaxRefundDto {
  operationId: string;
  expiresAt: string;
  capability: 'manual_required';
  preview: {
    action: 'record_gst_hst_refund';
    operatorPath: 'Sales Tax > Filed > Record refund';
    sourceDepositQboId: string;
    taxAgencyQboId: string;
    filedReturnRef: string;
    filingEvidenceSha256: string;
    suspenseAccountQboId: string;
    bankAccountQboId: string;
    refundDate: string;
    principalCents: number;
    interestCents: number;
    interestAccountQboId: string | null;
    totalBankCreditCents: number;
    existingDepositTreatment: 'replace_or_match_before_verification';
  };
  warnings: string[];
}

export type McpTaxRefundErrorCode =
  | 'INVALID_INPUT'
  | 'SOURCE_NOT_FOUND'
  | 'SOURCE_NOT_DEPOSIT'
  | 'SOURCE_NOT_PENDING'
  | 'STALE_SOURCE'
  | 'QBO_SOURCE_CHANGED'
  | 'AMOUNT_MISMATCH'
  | 'SYSTEM_SUSPENSE_REQUIRED'
  | 'BANK_ACCOUNT_REQUIRED'
  | 'INTEREST_ACCOUNT_REQUIRED';

export class McpTaxRefundError extends Error {
  constructor(readonly code: McpTaxRefundErrorCode) {
    super('GST/HST refund preparation failed.');
    this.name = 'McpTaxRefundError';
  }
}

interface TaxRefundTransaction {
  id: string;
  companyId: string;
  qboId: string;
  qboType: string;
  qboSyncToken: string;
  revision: number;
  status: string;
  amount: unknown;
  date: Date;
}

export interface McpTaxRefundDeps {
  authorize?: (
    principal: McpPrincipal,
    companyId: string,
    checkedAt: Date,
  ) => Promise<void>;
  loadTransaction?: (companyId: string, transactionId: string) => Promise<TaxRefundTransaction | null>;
  getClient?: (companyId: string) => Promise<QboClient>;
  createOperation?: (
    input: CreatePreparedOperationInput,
    dependencies?: { now?: () => Date },
  ) => Promise<McpOperationRecord>;
  now?: () => Date;
}

export async function prepareMcpTaxRefund(
  principal: McpPrincipal,
  input: PrepareMcpTaxRefundInput,
  dependencies: McpTaxRefundDeps = {},
): Promise<PreparedMcpTaxRefundDto> {
  const now = dependencies.now?.() ?? new Date();
  validateInput(input, now);
  const idempotencyKey = normalizeMcpOperationIdempotencyKey(input.idempotencyKey);
  if (idempotencyKey === null) throw new McpTaxRefundError('INVALID_INPUT');

  const authorize = dependencies.authorize ?? (async (actor, companyId, checkedAt) => {
    await assertCurrentMcpCategorizationAuthorization(
      prisma as unknown as McpCategorizationAuthorizationStore,
      actor,
      companyId,
      checkedAt,
    );
  });
  await authorize(principal, input.companyId, now);

  const loadTransaction = dependencies.loadTransaction ?? (async (companyId, transactionId) => (
    prisma.transaction.findFirst({ where: { id: transactionId, companyId } })
  ));
  const source = await loadTransaction(input.companyId, input.transactionId);
  if (source === null) throw new McpTaxRefundError('SOURCE_NOT_FOUND');
  if (source.qboType !== 'Deposit') throw new McpTaxRefundError('SOURCE_NOT_DEPOSIT');
  if (source.status !== 'PENDING') throw new McpTaxRefundError('SOURCE_NOT_PENDING');
  if (source.revision !== input.expectedRevision) throw new McpTaxRefundError('STALE_SOURCE');

  const client = await (dependencies.getClient ?? qboFactory.forCompany)(input.companyId);
  const [capability, accounts, snapshot] = await Promise.all([
    client.probeTaxRefundCapability(),
    client.listAccounts(),
    client.fetchPreparedSnapshot('Deposit', source.qboId),
  ]);
  if (
    snapshot === null
    || !('depositToAccountQboId' in snapshot)
    || snapshot.syncToken !== source.qboSyncToken
    || snapshot.date !== input.refundDate
    || snapshot.depositToAccountQboId !== input.bankAccountQboId
  ) {
    throw new McpTaxRefundError('QBO_SOURCE_CHANGED');
  }

  const suspense = accounts.find((account) => account.qboId === input.suspenseAccountQboId);
  if (
    suspense?.active !== true
    || suspense.accountSubType !== 'GlobalTaxSuspense'
  ) {
    throw new McpTaxRefundError('SYSTEM_SUSPENSE_REQUIRED');
  }
  const bank = accounts.find((account) => account.qboId === input.bankAccountQboId);
  if (bank?.active !== true || bank.classification !== 'Bank') {
    throw new McpTaxRefundError('BANK_ACCOUNT_REQUIRED');
  }

  const interestCents = input.interestCents ?? 0;
  if (interestCents > 0) {
    const interestAccount = accounts.find(
      (account) => account.qboId === input.interestAccountQboId,
    );
    if (interestAccount?.active !== true) {
      throw new McpTaxRefundError('INTEREST_ACCOUNT_REQUIRED');
    }
  }
  const totalBankCreditCents = input.principalCents + interestCents;
  if (
    moneyToCents(Number(source.amount)) !== totalBankCreditCents
    || snapshot.totalCents !== totalBankCreditCents
  ) {
    throw new McpTaxRefundError('AMOUNT_MISMATCH');
  }

  const preview: PreparedMcpTaxRefundDto['preview'] = {
    action: 'record_gst_hst_refund',
    operatorPath: 'Sales Tax > Filed > Record refund',
    sourceDepositQboId: source.qboId,
    taxAgencyQboId: input.taxAgencyQboId,
    filedReturnRef: input.filedReturnRef,
    filingEvidenceSha256: input.filingEvidenceSha256,
    suspenseAccountQboId: input.suspenseAccountQboId,
    bankAccountQboId: input.bankAccountQboId,
    refundDate: input.refundDate,
    principalCents: input.principalCents,
    interestCents,
    interestAccountQboId: input.interestAccountQboId ?? null,
    totalBankCreditCents,
    existingDepositTreatment: 'replace_or_match_before_verification',
  };
  const warnings = [
    'Manual QuickBooks Tax Centre action required; preparation does not post the refund.',
    'The existing Deposit must be replaced or matched before verification so cash is not duplicated.',
  ];
  const createOperation = dependencies.createOperation ?? createPreparedOperation;
  const operation = await createOperation({
    principal,
    companyId: input.companyId,
    transactionId: source.id,
    toolName: TOOL_NAME,
    kind: 'tax_refund',
    idempotencyKey,
    payload: { capability: capability.mode, preview, warnings },
    sourceRevision: source.revision,
    preparedRevision: source.revision,
    qboType: source.qboType,
    qboId: source.qboId,
    qboSyncToken: source.qboSyncToken,
    retryOfId: null,
  }, { now: () => now });

  return {
    operationId: operation.id,
    expiresAt: operation.expiresAt.toISOString(),
    capability: capability.mode,
    preview,
    warnings,
  };
}

function validateInput(input: PrepareMcpTaxRefundInput, now: Date): void {
  const bounded = (value: unknown) => (
    typeof value === 'string'
    && value.trim().length > 0
    && value.length <= MAX_REFERENCE
  );
  const safePositive = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;
  const safeNonNegative = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
  const interestCents = input.interestCents ?? 0;
  if (
    !Number.isFinite(now.getTime())
    || !bounded(input.companyId)
    || !bounded(input.transactionId)
    || !Number.isInteger(input.expectedRevision)
    || input.expectedRevision < 0
    || !bounded(input.taxAgencyQboId)
    || !bounded(input.filedReturnRef)
    || !SHA256.test(input.filingEvidenceSha256)
    || !bounded(input.suspenseAccountQboId)
    || !bounded(input.bankAccountQboId)
    || !DATE.test(input.refundDate)
    || !safePositive(input.principalCents)
    || !safeNonNegative(interestCents)
    || (interestCents > 0 && !bounded(input.interestAccountQboId))
    || (interestCents === 0 && input.interestAccountQboId !== undefined)
  ) {
    throw new McpTaxRefundError('INVALID_INPUT');
  }
}
