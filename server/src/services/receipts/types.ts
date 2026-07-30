export type ReceiptErrorCode =
  | 'RECEIPT_FORBIDDEN'
  | 'RECEIPT_NOT_FOUND'
  | 'RECEIPT_INVALID_INPUT'
  | 'RECEIPT_TYPE_UNSUPPORTED'
  | 'RECEIPT_IDEMPOTENCY_CONFLICT'
  | 'RECEIPT_STALE';

export class ReceiptError extends Error {
  constructor(
    readonly code: ReceiptErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ReceiptError';
  }
}
