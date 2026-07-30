import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  autopilot,
  createCategorizationRequestId,
  transactions,
} from './api';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createCategorizationRequestId', () => {
  it('uses the platform randomUUID implementation when available', () => {
    const randomUUID = vi.fn(() => '00000000-0000-4000-8000-000000000040');
    vi.stubGlobal('crypto', { randomUUID });

    expect(createCategorizationRequestId()).toBe('00000000-0000-4000-8000-000000000040');
    expect(randomUUID).toHaveBeenCalledTimes(1);
  });

  it('falls back to secure random bytes and sets RFC 4122 version and variant bits', () => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      bytes.set(Array.from({ length: 16 }, (_, index) => index));
      return bytes;
    });
    vi.stubGlobal('crypto', { getRandomValues });

    const requestId = createCategorizationRequestId();

    expect(requestId).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f');
    expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(getRandomValues).toHaveBeenCalledTimes(1);
  });

  it('fails explicitly when no cryptographically secure UUID API exists', () => {
    vi.stubGlobal('crypto', {});

    expect(() => createCategorizationRequestId()).toThrow(
      'Secure random UUID generation is unavailable.',
    );
  });
});

describe('structured mutation failures', () => {
  it('preserves only the bounded mutation result on ApiError', async () => {
    const responseBody = {
      transactionId: '00000000-0000-4000-8000-000000000030',
      requestId: '00000000-0000-4000-8000-000000000040',
      ok: false,
      status: 'PENDING',
      outcome: 'RETRYABLE',
      error: {
        code: 'RETRYABLE',
        message: 'The prepared write was not sent.',
        internal: 'excluded',
      },
      requestPayload: { internal: 'excluded' },
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(responseBody), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    })));

    const promise = transactions.commitCategorization(
      '00000000-0000-4000-8000-000000000030',
      3,
      '00000000-0000-4000-8000-000000000040',
    );

    await expect(promise).rejects.toBeInstanceOf(ApiError);
    await promise.catch((error: unknown) => {
      expect(error).toMatchObject({
        status: 409,
        mutationResult: {
          transactionId: '00000000-0000-4000-8000-000000000030',
          requestId: '00000000-0000-4000-8000-000000000040',
          ok: false,
          status: 'PENDING',
          outcome: 'RETRYABLE',
          error: {
            code: 'RETRYABLE',
            message: 'The prepared write was not sent.',
          },
        },
      });
      expect(JSON.stringify((error as ApiError).mutationResult)).not.toMatch(
        /requestPayload|internal/i,
      );
    });
  });

  it.each([
    ['invalid transaction identity', {
      transactionId: 'not-a-uuid',
      error: { code: 'RETRYABLE', message: 'Known failure.' },
    }],
    ['oversized error message', {
      transactionId: '00000000-0000-4000-8000-000000000030',
      error: { code: 'RETRYABLE', message: 'x'.repeat(501) },
    }],
  ])('rejects a mutation result with %s', async (_case, overrides) => {
    const responseBody = Object.assign({
      transactionId: '00000000-0000-4000-8000-000000000030',
      requestId: '00000000-0000-4000-8000-000000000040',
      ok: false,
      status: 'PENDING',
      outcome: 'RETRYABLE',
    }, overrides);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(responseBody), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    })));

    await transactions.commitCategorization(
      '00000000-0000-4000-8000-000000000030',
      3,
      '00000000-0000-4000-8000-000000000040',
    ).catch((error: unknown) => {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).mutationResult).toBeUndefined();
    });
  });
});

describe('strict live control requests', () => {
  it('sends an explicit empty object for pause and opaque reconciliation', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await autopilot.pauseLive('company-1');
    await autopilot.reconcileLive(
      'company-1',
      '00000000-0000-4000-8000-000000000040',
    );

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/companies/company-1/autopilot/pause-live',
      expect.objectContaining({
        method: 'POST',
        body: '{}',
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/companies/company-1/autopilot/reconcile/00000000-0000-4000-8000-000000000040',
      expect.objectContaining({
        method: 'POST',
        body: '{}',
      }),
    );
  });
});
