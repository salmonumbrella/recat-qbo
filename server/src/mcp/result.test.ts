import { describe, expect, it } from 'vitest';
import { HttpError } from '../lib/http.js';
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
});
