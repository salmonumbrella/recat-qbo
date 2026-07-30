import { describe, expect, it, vi } from 'vitest';
import { runSerializableTransaction } from './serializableTransaction.js';

describe('serializable transaction authority', () => {
  it('retries a serialization conflict and preserves serializable isolation', async () => {
    const transaction = vi.fn()
      .mockRejectedValueOnce({ code: 'P2034' })
      .mockImplementationOnce(async (callback) => callback({ attempt: 2 }));
    const callback = vi.fn(async (tx: { attempt: number }) => tx.attempt);

    await expect(runSerializableTransaction({ $transaction: transaction }, callback))
      .resolves.toBe(2);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(transaction).toHaveBeenNthCalledWith(
      1,
      expect.any(Function),
      expect.objectContaining({ isolationLevel: 'Serializable' }),
    );
    expect(transaction).toHaveBeenNthCalledWith(
      2,
      expect.any(Function),
      expect.objectContaining({ isolationLevel: 'Serializable' }),
    );
  });

  it('does not retry an unrelated transaction failure', async () => {
    const failure = new Error('database unavailable');
    const transaction = vi.fn().mockRejectedValue(failure);

    await expect(runSerializableTransaction(
      { $transaction: transaction },
      async () => undefined,
    )).rejects.toBe(failure);
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});
