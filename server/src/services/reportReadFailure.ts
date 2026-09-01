import { randomUUID } from 'node:crypto';
import { HttpError } from '../lib/http.js';
import { QboAuthError, QboHttpError, QboRequestTimeout } from '../lib/qbo/types.js';

export function reportReadFailure(
  error: unknown,
  operation: 'profit_and_loss' | 'balance_sheet' | 'transaction_log' | 'dashboard',
): HttpError {
  const requestId = randomUUID();
  console.error(`[read:${operation}] requestId=${requestId}`, error);
  if (operation === 'dashboard') {
    return new HttpError(503, 'Dashboard data is temporarily unavailable.', 'DASHBOARD_UNAVAILABLE', requestId);
  }
  if (error instanceof QboRequestTimeout) {
    return new HttpError(504, 'QuickBooks did not respond before this report request timed out.', 'QBO_REPORT_TIMEOUT', requestId);
  }
  if (error instanceof QboAuthError) {
    return new HttpError(503, 'QuickBooks access needs attention before this report can be loaded.', 'QBO_REPORT_AUTH', requestId);
  }
  if (error instanceof QboHttpError && [400, 404, 405, 501].includes(error.status)) {
    return new HttpError(422, 'QuickBooks cannot provide this report with the selected options.', 'QBO_REPORT_UNSUPPORTED', requestId);
  }
  return new HttpError(502, 'QuickBooks could not provide this report right now.', 'QBO_REPORT_UNAVAILABLE', requestId);
}
