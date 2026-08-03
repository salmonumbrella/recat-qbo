export interface SerializableTransactionRunner<TTransaction> {
  $transaction<T>(
    callback: (transaction: TTransaction) => Promise<T>,
    options: {
      isolationLevel: 'Serializable';
      maxWait: number;
      timeout: number;
    },
  ): Promise<T>;
}

const MAX_SERIALIZABLE_ATTEMPTS = 3;
const TRANSACTION_TIMEOUT_MS = 30_000;

/**
 * Retries Prisma's write-conflict/serialization error with a fresh transaction
 * snapshot. Callbacks must keep external side effects outside this boundary.
 */
export async function runSerializableTransaction<TTransaction, TResult>(
  db: SerializableTransactionRunner<TTransaction>,
  callback: (transaction: TTransaction) => Promise<TResult>,
): Promise<TResult> {
  for (let attempt = 1; attempt <= MAX_SERIALIZABLE_ATTEMPTS; attempt += 1) {
    try {
      return await db.$transaction(callback, {
        isolationLevel: 'Serializable',
        maxWait: TRANSACTION_TIMEOUT_MS,
        timeout: TRANSACTION_TIMEOUT_MS,
      });
    } catch (error) {
      if (!isSerializationConflict(error) || attempt === MAX_SERIALIZABLE_ATTEMPTS) {
        throw error;
      }
    }
  }
  throw new Error('Serializable transaction retry exhausted.');
}

function isSerializationConflict(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'P2034';
}
