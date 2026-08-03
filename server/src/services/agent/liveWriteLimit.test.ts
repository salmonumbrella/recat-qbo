import { describe, expect, it } from 'vitest';
import {
  issueLiveWritePermit,
  type LiveWriteLimitDeps,
} from './liveWriteLimit.js';

function fixture(limit = 100): {
  db: object;
  deps: LiveWriteLimitDeps;
  permits: Map<string, { companyId: string; utcDay: Date; limitAtIssue: number }>;
  setUtcDay(value: string): void;
} {
  const permits = new Map<string, { companyId: string; utcDay: Date; limitAtIssue: number }>();
  let utcDay = new Date('2026-08-02T00:00:00.000Z');
  return {
    db: {},
    permits,
    setUtcDay: (value) => { utcDay = new Date(`${value}T00:00:00.000Z`); },
    deps: {
      loadUtcDay: async () => utcDay,
      loadLimit: async (_db, companyId) => companyId === 'missing' ? null : limit,
      findPermit: async (_db, requestId) => permits.get(requestId) ?? null,
      countPermits: async (_db, companyId, utcDay) => [...permits.values()].filter(
        (permit) => permit.companyId === companyId
          && permit.utcDay.toISOString() === utcDay.toISOString(),
      ).length,
      createPermit: async (_db, permit) => {
        permits.set(permit.requestId, {
          companyId: permit.companyId,
          utcDay: permit.utcDay,
          limitAtIssue: permit.limitAtIssue,
        });
      },
    },
  };
}

describe('daily live-write permits', () => {
  it('allows exactly 100 distinct requests and rejects the 101st', async () => {
    const { db, deps, permits } = fixture();
    for (let index = 1; index <= 100; index += 1) {
      await expect(issueLiveWritePermit(db, {
        companyId: 'company-1',
        requestId: `request-${index}`,
      }, deps)).resolves.toMatchObject({ used: index, limit: 100, utcDay: '2026-08-02' });
    }

    await expect(issueLiveWritePermit(db, {
      companyId: 'company-1',
      requestId: 'request-101',
    }, deps)).rejects.toMatchObject({ code: 'LIVE_DAILY_LIMIT_REACHED' });
    expect(permits).toHaveLength(100);
  });

  it('reuses the same request permit without consuming another slot', async () => {
    const { db, deps, permits } = fixture(1);
    const input = {
      companyId: 'company-1',
      requestId: 'same-request',
    };

    await issueLiveWritePermit(db, input, deps);
    await expect(issueLiveWritePermit(db, input, deps)).resolves.toMatchObject({ used: 1, limit: 1 });
    expect(permits).toHaveLength(1);
  });

  it('isolates companies and resets at midnight UTC', async () => {
    const { db, deps, setUtcDay } = fixture(1);

    await issueLiveWritePermit(db, {
      companyId: 'company-1',
      requestId: 'first-day',
    }, deps);
    await expect(issueLiveWritePermit(db, {
      companyId: 'company-2',
      requestId: 'other-company',
    }, deps)).resolves.toMatchObject({ used: 1, utcDay: '2026-08-02' });
    setUtcDay('2026-08-03');
    await expect(issueLiveWritePermit(db, {
      companyId: 'company-1',
      requestId: 'next-day',
    }, deps)).resolves.toMatchObject({ used: 1, utcDay: '2026-08-03' });
  });

  it('fails closed when the company limit is unavailable', async () => {
    const { db, deps, permits } = fixture();

    await expect(issueLiveWritePermit(db, {
      companyId: 'missing',
      requestId: 'request-1',
    }, deps)).rejects.toMatchObject({ code: 'LIVE_WRITE_LIMIT_UNAVAILABLE' });
    expect(permits).toHaveLength(0);
  });
});
