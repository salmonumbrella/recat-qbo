import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  embeddingTick: vi.fn(),
}));

vi.mock('../services/classification/embedding/reconciler.js', () => ({
  runClassificationEmbeddingTick: mocks.embeddingTick,
}));

const { runClassificationSearchEmbeddingTick } = await import('./scheduler.js');

describe('classification embedding scheduler', () => {
  beforeEach(() => {
    mocks.embeddingTick.mockReset();
    mocks.embeddingTick.mockResolvedValue({
      configured: true,
      processed: 1,
      published: 1,
      failed: 0,
      unavailable: 0,
    });
  });

  it('runs at most once per ten-minute window', async () => {
    await runClassificationSearchEmbeddingTick(new Date('2026-08-31T00:00:00.000Z'));
    await runClassificationSearchEmbeddingTick(new Date('2026-08-31T00:09:59.999Z'));
    await runClassificationSearchEmbeddingTick(new Date('2026-08-31T00:10:00.000Z'));

    expect(mocks.embeddingTick).toHaveBeenCalledTimes(2);
  });
});
