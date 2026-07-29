import { describe, expect, it } from 'vitest';
import { HttpError } from '../lib/http.js';
import { CategorizationError } from '../services/categorization.js';
import { McpCategorizationError } from '../services/mcp/categorization.js';
import { McpOperationError } from '../services/mcp/operations.js';
import { McpOperationExecutionError } from '../services/mcp/reconciliation.js';
import { McpUndoError } from '../services/mcp/undo.js';
import { WritebackLifecycleError } from '../services/writeback.js';
import { safeToolFailure, toolSuccess } from './result.js';

describe('MCP tool results', () => {
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
    [new McpOperationExecutionError('OPERATION_CORRUPT'), 'COMPANY_UNAVAILABLE'],
    [new McpUndoError('UNDO_NOT_ALLOWED'), 'INVALID_INPUT'],
    [new McpUndoError('OPERATION_CORRUPT'), 'COMPANY_UNAVAILABLE'],
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
});
