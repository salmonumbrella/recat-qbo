import { describe, expect, it, vi } from 'vitest';
import {
  EntityLeaseError,
  acquireEntityLease,
  renewEntityLease,
  releaseEntityLease,
  withEntityLease,
  type EntityLeaseDb,
} from './entityLease.js';
import * as entityLeaseModule from './entityLease.js';

interface LeaseRow {
  companyId: string;
  qboType: string;
  qboId: string;
  owner: string;
  leaseExpiresAt: Date;
}

class FakeLeaseDb implements EntityLeaseDb {
  rows: LeaseRow[] = [];
  failRelease = false;
  private transactionTail: Promise<void> = Promise.resolve();

  qboEntityLease: EntityLeaseDb['qboEntityLease'] = {
    updateMany: async ({ where, data }) => {
      const row = this.rows.find(
        (candidate) =>
          candidate.companyId === where.companyId &&
          candidate.qboType === where.qboType &&
          candidate.qboId === where.qboId &&
          ('OR' in where
            ? (
                candidate.owner === where.OR[1]!.owner ||
                candidate.leaseExpiresAt.getTime() <= where.OR[0]!.leaseExpiresAt.lte.getTime()
              )
            : (
                candidate.owner === where.owner
                && candidate.leaseExpiresAt.getTime() > where.leaseExpiresAt.gt.getTime()
              )),
      );
      if (!row) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    },
    create: async ({ data }) => {
      if (
        this.rows.some(
          (row) =>
            row.companyId === data.companyId &&
            row.qboType === data.qboType &&
            row.qboId === data.qboId,
        )
      ) {
        const error = new Error('unique');
        Object.assign(error, { code: 'P2002' });
        throw error;
      }
      const row = { ...data };
      this.rows.push(row);
      return row;
    },
    deleteMany: async ({ where }) => {
      if (this.failRelease) throw new Error('lease cleanup storage failed');
      const before = this.rows.length;
      this.rows = this.rows.filter(
        (row) =>
          !(
            row.companyId === where.companyId &&
            row.qboType === where.qboType &&
            row.qboId === where.qboId &&
            row.owner === where.owner
          ),
      );
      return { count: before - this.rows.length };
    },
  };

  async $transaction<T>(callback: (tx: EntityLeaseDb) => Promise<T>): Promise<T> {
    const predecessor = this.transactionTail;
    let release!: () => void;
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;
    const before = structuredClone(this.rows);
    try {
      return await callback(this);
    } catch (error) {
      this.rows = before;
      throw error;
    } finally {
      release();
    }
  }
}

const key = { companyId: 'company-generic', qboType: 'Purchase', qboId: 'purchase-generic' };
const at = new Date('2026-07-28T12:00:00.000Z');

describe('entity leases', () => {
  it('locks and verifies the exact parameterized lease owner before fenced work', async () => {
    const query = vi.fn(async () => [{ owner: 'owner-a' }]);
    const fenceEntityLeaseOwnership = (
      entityLeaseModule as unknown as {
        fenceEntityLeaseOwnership(
          key: typeof key,
          owner: string,
          deps: { db: { $queryRawUnsafe: typeof query } },
        ): Promise<void>;
      }
    ).fenceEntityLeaseOwnership;

    await fenceEntityLeaseOwnership(key, 'owner-a', {
      db: { $queryRawUnsafe: query },
    });

    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(/"leaseExpiresAt" > CURRENT_TIMESTAMP[\s\S]*FOR UPDATE/),
      key.companyId,
      key.qboType,
      key.qboId,
    );
  });

  it.each([
    ['missing', []],
    ['stolen', [{ owner: 'owner-b' }]],
  ] as const)('rejects a %s lease row at the ownership fence', async (_case, rows) => {
    const fenceEntityLeaseOwnership = (
      entityLeaseModule as unknown as {
        fenceEntityLeaseOwnership(
          key: typeof key,
          owner: string,
          deps: { db: { $queryRawUnsafe: (...values: unknown[]) => Promise<unknown> } },
        ): Promise<void>;
      }
    ).fenceEntityLeaseOwnership;

    await expect(fenceEntityLeaseOwnership(key, 'owner-a', {
      db: { $queryRawUnsafe: async () => rows },
    })).rejects.toMatchObject<EntityLeaseError>({
      name: 'EntityLeaseError',
      code: 'ENTITY_BUSY',
    });
  });

  it('atomically allows exactly one owner when two acquisitions leave the same barrier', async () => {
    const db = new FakeLeaseDb();
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const contenders = ['owner-a', 'owner-b'].map(async (owner) => {
      await barrier;
      return acquireEntityLease(key, owner, { db, now: async () => at });
    });
    releaseBarrier();
    const results = await Promise.allSettled(contenders);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject<EntityLeaseError>({ code: 'ENTITY_BUSY' });
    expect(db.rows).toHaveLength(1);
    expect(['owner-a', 'owner-b']).toContain(db.rows[0]?.owner);
  });

  it('atomically allows exactly one takeover owner for an expired lease', async () => {
    const db = new FakeLeaseDb();
    db.rows.push({
      ...key,
      owner: 'expired-owner',
      leaseExpiresAt: new Date(at.getTime() - 1),
    });

    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const contenders = ['owner-a', 'owner-b'].map(async (owner) => {
      await barrier;
      return acquireEntityLease(key, owner, { db, now: async () => at });
    });
    releaseBarrier();
    const results = await Promise.allSettled(contenders);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject<EntityLeaseError>({ code: 'ENTITY_BUSY' });
    expect(['owner-a', 'owner-b']).toContain(db.rows[0]?.owner);
    expect(db.rows[0]?.leaseExpiresAt.getTime()).toBe(at.getTime() + 30_000);
  });

  it('lets the same owner renew a live lease', async () => {
    const db = new FakeLeaseDb();
    await acquireEntityLease(key, 'owner-b', { db, now: async () => at });
    await acquireEntityLease(key, 'owner-b', {
      db,
      now: async () => new Date(at.getTime() + 1_000),
    });
    expect(db.rows[0]?.leaseExpiresAt.getTime()).toBe(at.getTime() + 31_000);
  });

  it('strict renewal refuses to resurrect an expired same-owner lease', async () => {
    const db = new FakeLeaseDb();
    await acquireEntityLease(key, 'owner-b', { db, now: async () => at });

    await expect(renewEntityLease(key, 'owner-b', {
      db,
      now: async () => new Date(at.getTime() + 30_001),
    })).rejects.toMatchObject<EntityLeaseError>({ code: 'ENTITY_BUSY' });
  });

  it('keeps an outer lease held when the same async owner reenters and releases once', async () => {
    const db = new FakeLeaseDb();
    let releases = 0;
    const originalDelete = db.qboEntityLease.deleteMany;
    db.qboEntityLease.deleteMany = async (args) => {
      releases += 1;
      return originalDelete(args);
    };

    await withEntityLease(key, 'owner-a', async () => {
      expect(db.rows).toHaveLength(1);
      await Promise.resolve();
      await withEntityLease(key, 'owner-a', async () => {
        expect(db.rows).toMatchObject([{ owner: 'owner-a' }]);
      }, { db, now: async () => at });
      expect(db.rows).toMatchObject([{ owner: 'owner-a' }]);
      expect(releases).toBe(0);
    }, { db, now: async () => at });

    expect(releases).toBe(1);
    expect(db.rows).toHaveLength(0);
  });

  it('does not let a different owner bypass a propagated reentrant context', async () => {
    const db = new FakeLeaseDb();
    await withEntityLease(key, 'owner-a', async () => {
      await Promise.resolve();
      await expect(withEntityLease(
        key,
        'owner-b',
        async () => undefined,
        { db, now: async () => at },
      )).rejects.toMatchObject<EntityLeaseError>({ code: 'ENTITY_BUSY' });
      expect(db.rows).toMatchObject([{ owner: 'owner-a' }]);
    }, { db, now: async () => at });
  });

  it('strictly renews and DB-fences a reentrant owner before nested mutation', async () => {
    const db = new FakeLeaseDb();
    let now = at;
    await expect(withEntityLease(key, 'owner-a', async () => {
      now = new Date(at.getTime() + 30_001);
      await withEntityLease(key, 'owner-a', async () => undefined, {
        db,
        now: async () => now,
      });
    }, { db, now: async () => now })).rejects.toMatchObject<EntityLeaseError>({
      code: 'ENTITY_BUSY',
    });
  });

  it('does not treat an inherited but detached async context as lease authority', async () => {
    const db = new FakeLeaseDb();
    let releaseDetached!: () => void;
    const detachedGate = new Promise<void>((resolve) => {
      releaseDetached = resolve;
    });
    let detached!: Promise<void>;

    await withEntityLease(key, 'owner-a', async () => {
      detached = Promise.resolve().then(async () => {
        await detachedGate;
        await withEntityLease(key, 'owner-a', async () => undefined, {
          db,
          now: async () => at,
        });
      });
    }, { db, now: async () => at });

    releaseDetached();
    await expect(detached).rejects.toMatchObject<EntityLeaseError>({
      code: 'ENTITY_BUSY',
    });
    expect(db.rows).toHaveLength(0);
  });

  it('releases only for the matching owner', async () => {
    const db = new FakeLeaseDb();
    await acquireEntityLease(key, 'owner-a', { db, now: async () => at });

    expect(await releaseEntityLease(key, 'owner-b', { db })).toBe(false);
    expect(db.rows).toHaveLength(1);
    expect(await releaseEntityLease(key, 'owner-a', { db })).toBe(true);
    expect(db.rows).toHaveLength(0);
  });

  it('releases the owner lease when the callback throws', async () => {
    const db = new FakeLeaseDb();

    await expect(
      withEntityLease(
        key,
        'owner-a',
        async () => {
          throw new Error('callback failed');
        },
        { db, now: async () => at },
      ),
    ).rejects.toThrow('callback failed');
    expect(db.rows).toHaveLength(0);
  });

  it('preserves a callback result when release fails and reports bounded cleanup metadata', async () => {
    const db = new FakeLeaseDb();
    const reportCleanupFailure = vi.fn();
    db.failRelease = true;
    const uncertain = {
      outcome: 'UNCERTAIN',
      error: { message: 'verify in QuickBooks' },
    };

    const result = await withEntityLease(
      key,
      'owner-a',
      async () => uncertain,
      { db, now: async () => at, reportCleanupFailure },
    );

    expect(result).toBe(uncertain);
    expect(reportCleanupFailure).toHaveBeenCalledWith({
      code: 'LEASE_RELEASE_FAILED',
      message: 'Entity lease cleanup failed.',
    });
    expect(JSON.stringify(reportCleanupFailure.mock.calls)).not.toContain('storage failed');
  });

  it('preserves the primary callback error when release also fails', async () => {
    const db = new FakeLeaseDb();
    const reportCleanupFailure = vi.fn();
    const primary = new Error('primary callback failed');
    db.failRelease = true;

    await expect(
      withEntityLease(
        key,
        'owner-a',
        async () => {
          throw primary;
        },
        { db, now: async () => at, reportCleanupFailure },
      ),
    ).rejects.toBe(primary);
    expect(reportCleanupFailure).toHaveBeenCalledWith({
      code: 'LEASE_RELEASE_FAILED',
      message: 'Entity lease cleanup failed.',
    });
  });
});
