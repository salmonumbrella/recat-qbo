import { describe, expect, it, vi } from 'vitest';
import {
  claimShadowJobs,
  finishAgentJob,
  retryDelayMs,
} from './jobs.js';

describe('shadow agent job lifecycle guards', () => {
  it('uses the specified bounded retry schedule', () => {
    expect(retryDelayMs(1)).toBe(30_000);
    expect(retryDelayMs(2)).toBe(120_000);
    expect(retryDelayMs(3)).toBe(600_000);
  });

  it('rejects unrecognized error codes instead of persisting caller text', async () => {
    await expect(finishAgentJob('job-1', 'worker-1', 1, {
      kind: 'failed',
      transient: true,
      errorCode: 'provider said: customer transaction content' as never,
    }, {
      db: {} as never,
      now: async () => new Date('2026-07-29T00:00:00.000Z'),
    })).rejects.toMatchObject({ code: 'AGENT_JOB_INVALID' });
  });

  it('never claims more than a non-positive requested limit', async () => {
    const transaction = vi.fn();
    await expect(claimShadowJobs('worker-1', 0, {
      db: { $transaction: transaction } as never,
    })).resolves.toEqual([]);
    expect(transaction).not.toHaveBeenCalled();
  });
});
