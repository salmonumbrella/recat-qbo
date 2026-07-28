const DEFAULT_LEASE_TTL_MS = 30_000;

export interface EntityLeaseKey {
  companyId: string;
  qboType: string;
  qboId: string;
}

interface LeaseWhere extends EntityLeaseKey {
  OR: [
    { leaseExpiresAt: { lte: Date } },
    { owner: string },
  ];
}

export interface EntityLeaseDb {
  qboEntityLease: {
    updateMany(args: {
      where: LeaseWhere;
      data: { owner: string; leaseExpiresAt: Date };
    }): Promise<{ count: number }>;
    create(args: {
      data: EntityLeaseKey & { owner: string; leaseExpiresAt: Date };
    }): Promise<unknown>;
    deleteMany(args: {
      where: EntityLeaseKey & { owner: string };
    }): Promise<{ count: number }>;
  };
  $transaction<T>(callback: (tx: EntityLeaseDb) => Promise<T>): Promise<T>;
  $queryRawUnsafe?<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

export interface EntityLeaseFenceDb {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

export interface EntityLeaseDeps {
  db: EntityLeaseDb;
  now?: (tx: EntityLeaseDb) => Promise<Date>;
  ttlMs?: number;
  reportCleanupFailure?: (failure: {
    code: 'LEASE_RELEASE_FAILED';
    message: string;
  }) => void;
}

export class EntityLeaseError extends Error {
  readonly code = 'ENTITY_BUSY';

  constructor(message = 'Another write is already in progress for this QuickBooks entity.') {
    super(message);
    this.name = 'EntityLeaseError';
  }
}

/**
 * Lock the exact entity-lease row in the caller's transaction and verify that
 * it still belongs to `owner`. The row lock is held until that transaction
 * commits or rolls back, so an expired lease cannot be reclaimed across the
 * caller's mutation boundary.
 */
export async function fenceEntityLeaseOwnership(
  key: EntityLeaseKey,
  owner: string,
  deps: { db: EntityLeaseFenceDb },
): Promise<void> {
  const rows = await deps.db.$queryRawUnsafe<{ owner: string }[]>(
    `SELECT "owner"
       FROM "QboEntityLease"
      WHERE "companyId" = $1
        AND "qboType" = $2
        AND "qboId" = $3
      FOR UPDATE`,
    key.companyId,
    key.qboType,
    key.qboId,
  );
  if (rows.length !== 1 || rows[0]?.owner !== owner) {
    throw new EntityLeaseError();
  }
}

function isUniqueConstraint(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

async function databaseNow(tx: EntityLeaseDb): Promise<Date> {
  if (!tx.$queryRawUnsafe) {
    throw new Error('Entity lease database time is unavailable.');
  }
  const rows = await tx.$queryRawUnsafe<{ now: Date | string }[]>(
    'SELECT CURRENT_TIMESTAMP AS "now"',
  );
  const value = rows[0]?.now;
  const now = value instanceof Date ? value : new Date(value ?? Number.NaN);
  if (Number.isNaN(now.getTime())) {
    throw new Error('Entity lease database time was invalid.');
  }
  return now;
}

function boundedTtl(ttlMs: number | undefined): number {
  if (ttlMs === undefined) return DEFAULT_LEASE_TTL_MS;
  if (!Number.isFinite(ttlMs)) return DEFAULT_LEASE_TTL_MS;
  return Math.max(1, Math.min(Math.trunc(ttlMs), DEFAULT_LEASE_TTL_MS));
}

export async function acquireEntityLease(
  key: EntityLeaseKey,
  owner: string,
  deps: EntityLeaseDeps,
): Promise<void> {
  await deps.db.$transaction(async (tx) => {
    const now = await (deps.now ?? databaseNow)(tx);
    const leaseExpiresAt = new Date(now.getTime() + boundedTtl(deps.ttlMs));
    const updated = await tx.qboEntityLease.updateMany({
      where: {
        ...key,
        OR: [
          { leaseExpiresAt: { lte: now } },
          { owner },
        ],
      },
      data: { owner, leaseExpiresAt },
    });
    if (updated.count === 1) return;

    try {
      await tx.qboEntityLease.create({
        data: { ...key, owner, leaseExpiresAt },
      });
    } catch (error) {
      if (isUniqueConstraint(error)) throw new EntityLeaseError();
      throw error;
    }
  });
}

export async function releaseEntityLease(
  key: EntityLeaseKey,
  owner: string,
  deps: Pick<EntityLeaseDeps, 'db'>,
): Promise<boolean> {
  const released = await deps.db.qboEntityLease.deleteMany({
    where: { ...key, owner },
  });
  return released.count === 1;
}

export async function withEntityLease<T>(
  key: EntityLeaseKey,
  owner: string,
  callback: () => Promise<T>,
  deps: EntityLeaseDeps,
): Promise<T> {
  await acquireEntityLease(key, owner, deps);
  let result: T | undefined;
  let primaryError: unknown;
  let callbackFailed = false;
  try {
    result = await callback();
  } catch (error) {
    callbackFailed = true;
    primaryError = error;
  }
  try {
    await releaseEntityLease(key, owner, deps);
  } catch {
    const failure = {
      code: 'LEASE_RELEASE_FAILED' as const,
      message: 'Entity lease cleanup failed.',
    };
    try {
      if (deps.reportCleanupFailure) deps.reportCleanupFailure(failure);
      else console.warn(`[entityLease] ${failure.message}`);
    } catch {
      // Cleanup reporting must never replace the callback result/error either.
    }
  }
  if (callbackFailed) throw primaryError;
  return result as T;
}
