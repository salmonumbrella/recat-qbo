import { describe, expect, it } from 'vitest';
import { RealQboClient } from '../lib/qbo/real.js';
import { QboAuthError, QboHttpError, QboRequestTimeout } from '../lib/qbo/types.js';
import { reportReadFailure } from './reportReadFailure.js';

type RealQboErrorFactory = {
  toError(status: number, bodyText: string): Error;
};

function realQboError(status: number, bodyText: string): Error {
  return (Object.create(RealQboClient.prototype) as RealQboErrorFactory).toError(status, bodyText);
}

describe('reportReadFailure', () => {
  it('maps timeout to safe copy and correlation ID', () => {
    const error = reportReadFailure(new QboRequestTimeout('RAW_QBO_BODY_SENTINEL'), 'profit_and_loss');
    expect(error).toMatchObject({
      status: 504,
      code: 'QBO_REPORT_TIMEOUT',
      message: 'QuickBooks did not respond before this report request timed out.',
    });
    expect(error.requestId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(error.message).not.toContain('RAW_QBO_BODY_SENTINEL');
  });

  it.each([
    [new QboAuthError('RAW_QBO_BODY_SENTINEL'), 'balance_sheet', 503, 'QBO_REPORT_AUTH'],
    [new QboHttpError(501, 'RAW_QBO_BODY_SENTINEL'), 'transaction_log', 422, 'QBO_REPORT_UNSUPPORTED'],
    [new QboHttpError(500, 'RAW_QBO_BODY_SENTINEL'), 'profit_and_loss', 502, 'QBO_REPORT_UNAVAILABLE'],
    [new Error('RAW_QBO_BODY_SENTINEL'), 'dashboard', 503, 'DASHBOARD_UNAVAILABLE'],
  ] as const)('redacts source %s', (source, operation, status, code) => {
    const error = reportReadFailure(source, operation);
    expect(error.status).toBe(status);
    expect(error.code).toBe(code);
    expect(error.message).not.toContain('RAW_QBO_BODY_SENTINEL');
  });

  it.each([
    [
      'HTTP 400 with QBO error 610',
      realQboError(400, JSON.stringify({ Fault: { Error: [{ code: '610', Detail: 'RAW_QBO_BODY_SENTINEL' }] } })),
      'QboObjectNotFoundError',
    ],
    ['HTTP 404', realQboError(404, 'RAW_QBO_BODY_SENTINEL'), 'QboHttpNotFoundError'],
  ] as const)('maps real %s specialized error to unsupported report', (_case, source, errorName) => {
    expect(source.name).toBe(errorName);

    const error = reportReadFailure(source, 'profit_and_loss');

    expect(error).toMatchObject({
      status: 422,
      code: 'QBO_REPORT_UNSUPPORTED',
      message: 'QuickBooks cannot provide this report with the selected options.',
    });
    expect(error.requestId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(error.message).not.toContain('RAW_QBO_BODY_SENTINEL');
  });
});
