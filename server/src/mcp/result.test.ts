import { describe, expect, it } from 'vitest';
import { HttpError } from '../lib/http.js';
import { QboRateLimitError } from '../lib/qbo/types.js';
import { QboWriteSafetyError } from '../lib/qbo/writeSafety.js';
import { CategorizationError } from '../services/categorization.js';
import { McpCategorizationError } from '../services/mcp/categorization.js';
import { McpOperationError } from '../services/mcp/operations.js';
import { McpOperationExecutionError } from '../services/mcp/reconciliation.js';
import { McpRuleChangeError } from '../services/mcp/rules.js';
import { McpUndoError } from '../services/mcp/undo.js';
import { RuleCandidateError } from '../services/ruleCandidates.js';
import { McpTransferExecutionError } from '../services/mcp/transfers.js';
import { TransferExecutionError } from '../services/transferExecution.js';
import { TransferOperationError } from '../services/transferOperations.js';
import { WritebackLifecycleError } from '../services/writeback.js';
import { AttachmentError } from '../services/attachments/types.js';
import { ReceiptError } from '../services/receipts/types.js';
import { safeToolFailure, toolSuccess } from './result.js';

describe('MCP tool results', () => {
  it('maps attachment failures without exposing private detail', () => {
    const forbidden = safeToolFailure(
      new AttachmentError(
        'ATTACHMENT_FORBIDDEN',
        'private attachment filename sentinel.pdf',
      ),
      'request-attachment',
    );
    const missing = safeToolFailure(
      new AttachmentError(
        'ATTACHMENT_NOT_FOUND',
        'private provider id sentinel',
      ),
      'request-attachment',
    );

    expect(forbidden.structuredContent).toMatchObject({
      error: { code: 'FORBIDDEN' },
    });
    expect(missing.structuredContent).toMatchObject({
      error: { code: 'NOT_FOUND' },
    });
    expect(JSON.stringify([forbidden, missing])).not.toContain('sentinel');
  });

  it.each([
    ['RECEIPT_FORBIDDEN', 'FORBIDDEN'],
    ['RECEIPT_NOT_FOUND', 'NOT_FOUND'],
    ['RECEIPT_INVALID_INPUT', 'INVALID_INPUT'],
    ['RECEIPT_TYPE_UNSUPPORTED', 'INVALID_INPUT'],
    ['RECEIPT_IDEMPOTENCY_CONFLICT', 'INVALID_INPUT'],
    ['RECEIPT_STALE', 'INVALID_INPUT'],
  ] as const)('maps %s without exposing receipt detail', (receiptCode, safeCode) => {
    const result = safeToolFailure(
      new ReceiptError(receiptCode, 'SENTINEL_PRIVATE_RECEIPT_DETAIL'),
      'request-receipt',
    );

    expect(result.structuredContent).toMatchObject({
      error: { code: safeCode },
    });
    expect(JSON.stringify(result)).not.toContain('SENTINEL_PRIVATE_RECEIPT_DETAIL');
  });

  it('returns matching text and structured content', () => {
    const result = toolSuccess({ items: [{ id: 'company-a' }] });

    expect(result).toMatchObject({
      content: [{ type: 'text', text: '{"items":[{"id":"company-a"}]}' }],
      structuredContent: { items: [{ id: 'company-a' }] },
    });
  });

  it.each([
    [new HttpError(403, 'PRIVATE_PROVIDER_SENTINEL', 'SOME_PROVIDER_CODE'), 'FORBIDDEN'],
    [new HttpError(404, 'PRIVATE_ID_SENTINEL', 'TRANSACTION_NOT_FOUND'), 'NOT_FOUND'],
    [new HttpError(400, 'PRIVATE_CURSOR_SENTINEL', 'INVALID_CURSOR'), 'INVALID_INPUT'],
    [new HttpError(503, 'PRIVATE_COMPANY_SENTINEL', 'COMPANY_UNAVAILABLE'), 'COMPANY_UNAVAILABLE'],
    [new HttpError(409, 'PRIVATE_QBO_SENTINEL', 'QBO_DISCONNECTED'), 'QBO_DISCONNECTED'],
    [new HttpError(429, 'PRIVATE_RATE_SENTINEL', 'ANY_CODE'), 'RATE_LIMITED'],
    [new QboWriteSafetyError('QBO_PERIOD_CLOSED', 'PRIVATE_CLOSE_SENTINEL'), 'QBO_PERIOD_CLOSED'],
    [new QboWriteSafetyError('QBO_TRANSACTION_LOCKED', 'PRIVATE_LOCK_SENTINEL'), 'QBO_TRANSACTION_LOCKED'],
    [new QboWriteSafetyError('QBO_WRITE_SAFETY_UNAVAILABLE', 'PRIVATE_SAFETY_SENTINEL'), 'QBO_WRITE_SAFETY_UNAVAILABLE'],
  ])('maps an expected failure to stable safe code %s', (error, code) => {
    const result = safeToolFailure(error, 'request-safe');

    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code,
          message: expect.any(String),
          requestId: 'request-safe',
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain(error.message);
  });

  it('maps a typed QuickBooks rate limit and preserves only its bounded retry hint', () => {
    const result = safeToolFailure(
      new QboRateLimitError(7, 'PRIVATE_QBO_RATE_DETAIL'),
      'request-rate',
    );

    expect(result.structuredContent).toEqual({
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many requests were made. Wait briefly and try again.',
        requestId: 'request-rate',
        retryAfterSeconds: 7,
      },
    });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_QBO_RATE_DETAIL');

    const bounded = safeToolFailure(
      new QboRateLimitError(Number.POSITIVE_INFINITY, 'PRIVATE_QBO_RATE_DETAIL'),
      'request-rate-bounded',
    );
    expect(bounded.structuredContent).toMatchObject({
      error: { code: 'RATE_LIMITED', retryAfterSeconds: 5 },
    });
  });

  it('maps unexpected details to the approved company-unavailable fallback', () => {
    const hidden = safeToolFailure(
      new Error('TOKEN_SENTINEL stack trace'),
      'request-internal',
    );
    expect(JSON.stringify(hidden)).not.toContain('TOKEN_SENTINEL');
    expect(hidden.structuredContent).toEqual({
      error: {
        code: 'COMPANY_UNAVAILABLE',
        message: 'The company data is temporarily unavailable. Try again later.',
        requestId: 'request-internal',
      },
    });
  });

  it.each([
    [new McpCategorizationError('MCP_UNAUTHORIZED'), 'FORBIDDEN'],
    [new McpCategorizationError('MCP_FORBIDDEN'), 'FORBIDDEN'],
    [new McpCategorizationError('COMPANY_DISCONNECTED'), 'QBO_DISCONNECTED'],
    [new McpCategorizationError('ENTITY_BUSY'), 'COMPANY_UNAVAILABLE'],
    [new McpOperationError('OPERATION_INVALID_INPUT'), 'INVALID_INPUT'],
    [new McpOperationError('OPERATION_NOT_FOUND'), 'NOT_FOUND'],
    [new McpOperationError('IDEMPOTENCY_CONFLICT'), 'INVALID_INPUT'],
    [new McpOperationError('OPERATION_CONFLICT'), 'COMPANY_UNAVAILABLE'],
    [new McpOperationExecutionError('OPERATION_NOT_FOUND'), 'NOT_FOUND'],
    [new McpOperationExecutionError('OPERATION_EXPIRED'), 'INVALID_INPUT'],
    [new McpOperationExecutionError('OPERATION_CANCELLED'), 'INVALID_INPUT'],
    [new McpOperationExecutionError('IDEMPOTENCY_CONFLICT'), 'INVALID_INPUT'],
    [new McpOperationExecutionError('RETRY_NOT_ALLOWED'), 'INVALID_INPUT'],
    [new McpOperationExecutionError('OPERATION_CORRUPT'), 'OPERATION_RECONCILIATION_REQUIRED'],
    [new McpTransferExecutionError('OPERATION_NOT_FOUND'), 'NOT_FOUND'],
    [new McpTransferExecutionError('IDEMPOTENCY_CONFLICT'), 'INVALID_INPUT'],
    [new McpTransferExecutionError('OPERATION_CORRUPT'), 'OPERATION_RECONCILIATION_REQUIRED'],
    [new TransferOperationError('FORBIDDEN'), 'FORBIDDEN'],
    [new TransferOperationError('TRANSACTION_NOT_FOUND'), 'NOT_FOUND'],
    [new TransferOperationError('COMPANY_DISCONNECTED'), 'QBO_DISCONNECTED'],
    [new TransferOperationError('INVALID_TRANSFER_PAIR'), 'INVALID_INPUT'],
    [new TransferExecutionError('FORBIDDEN'), 'FORBIDDEN'],
    [new TransferExecutionError('OPERATION_NOT_FOUND'), 'NOT_FOUND'],
    [new TransferExecutionError('OPERATION_EXPIRED'), 'INVALID_INPUT'],
    [new McpUndoError('UNDO_NOT_ALLOWED'), 'INVALID_INPUT'],
    [new McpUndoError('OPERATION_CORRUPT'), 'OPERATION_RECONCILIATION_REQUIRED'],
    [
      new CategorizationError(
        'TRANSACTION_NOT_FOUND',
        'PRIVATE_CATEGORY_NOT_FOUND_SENTINEL',
      ),
      'NOT_FOUND',
    ],
    [
      new CategorizationError(
        'INVALID_ACCOUNT',
        'PRIVATE_CATEGORY_INPUT_SENTINEL',
      ),
      'INVALID_INPUT',
    ],
    [
      new CategorizationError(
        'TAX_RATE_UNSUPPORTED',
        'PRIVATE_TAX_INPUT_SENTINEL',
      ),
      'INVALID_INPUT',
    ],
    ...[
      'TAX_AMOUNT_SIGN_MISMATCH',
      'TAX_CODE_MALFORMED',
      'TAX_COMPANY_MISMATCH',
      'TAX_RATE_MALFORMED',
    ].map((code) => [
      new CategorizationError(code, 'PRIVATE_TAX_INPUT_SENTINEL'),
      'INVALID_INPUT',
    ]),
    [
      new CategorizationError(
        'MUTATION_BLOCKED',
        'PRIVATE_CATEGORY_BUSY_SENTINEL',
      ),
      'COMPANY_UNAVAILABLE',
    ],
    [
      new WritebackLifecycleError(
        'FORBIDDEN',
        'PRIVATE_WRITE_FORBIDDEN_SENTINEL',
      ),
      'FORBIDDEN',
    ],
    [
      new WritebackLifecycleError(
        'TRANSACTION_NOT_FOUND',
        'PRIVATE_WRITE_NOT_FOUND_SENTINEL',
      ),
      'NOT_FOUND',
    ],
    [
      new WritebackLifecycleError(
        'COMPANY_DISCONNECTED',
        'PRIVATE_WRITE_DISCONNECTED_SENTINEL',
      ),
      'QBO_DISCONNECTED',
    ],
    [
      new WritebackLifecycleError(
        'STALE_REVISION',
        'PRIVATE_WRITE_INPUT_SENTINEL',
      ),
      'INVALID_INPUT',
    ],
    [
      new WritebackLifecycleError(
        'ATTEMPT_CORRUPT',
        'PRIVATE_WRITE_CORRUPT_SENTINEL',
      ),
      'COMPANY_UNAVAILABLE',
    ],
    [
      new WritebackLifecycleError(
        'QBO_PERIOD_CLOSED',
        'PRIVATE_WRITE_CLOSE_SENTINEL',
      ),
      'QBO_PERIOD_CLOSED',
    ],
    [
      new WritebackLifecycleError(
        'QBO_TRANSACTION_LOCKED',
        'PRIVATE_WRITE_LOCK_SENTINEL',
      ),
      'QBO_TRANSACTION_LOCKED',
    ],
    [
      new WritebackLifecycleError(
        'QBO_WRITE_SAFETY_UNAVAILABLE',
        'PRIVATE_WRITE_SAFETY_SENTINEL',
      ),
      'QBO_WRITE_SAFETY_UNAVAILABLE',
    ],
    [
      new WritebackLifecycleError(
        'PRIVATE_UNKNOWN_CODE',
        'PRIVATE_WRITE_UNKNOWN_SENTINEL',
      ),
      'COMPANY_UNAVAILABLE',
    ],
  ])('maps an MCP mutation failure to fixed safe code %s', (error, code) => {
    const result = safeToolFailure(error, 'request-mutation');

    expect(result.structuredContent).toMatchObject({
      error: {
        code,
        message: expect.any(String),
        requestId: 'request-mutation',
      },
    });
    expect(JSON.stringify(result)).not.toContain(error.message);
  });

  it.each([
    [new McpRuleChangeError('NOT_FOUND'), 'NOT_FOUND'],
    [new McpRuleChangeError('INVALID_INPUT'), 'INVALID_INPUT'],
    [new McpRuleChangeError('CONFLICT'), 'INVALID_INPUT'],
    [new McpRuleChangeError('STALE_REVISION'), 'INVALID_INPUT'],
    [new McpRuleChangeError('OPERATION_EXPIRED'), 'INVALID_INPUT'],
    [new McpRuleChangeError('OPERATION_CORRUPT'), 'INVALID_INPUT'],
    [new McpRuleChangeError('IDEMPOTENCY_CONFLICT'), 'INVALID_INPUT'],
    [new RuleCandidateError('CANDIDATE_NOT_FOUND', 'PRIVATE_CANDIDATE'), 'NOT_FOUND'],
    [new RuleCandidateError('CANDIDATE_NOT_READY', 'PRIVATE_CANDIDATE'), 'INVALID_INPUT'],
    [new RuleCandidateError('CANDIDATE_STALE', 'PRIVATE_CANDIDATE'), 'INVALID_INPUT'],
  ])('maps rule lifecycle rejection to authored safe code %s', (error, code) => {
    const result = safeToolFailure(error, 'request-rule-rejection');

    expect(result.structuredContent).toMatchObject({
      error: { code, requestId: 'request-rule-rejection' },
    });
    expect(JSON.stringify(result)).not.toContain(error.message);
  });
});
