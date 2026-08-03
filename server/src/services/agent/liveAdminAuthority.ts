import { prisma } from '../../lib/prisma.js';

export interface LiveAdminAuthorityDb {
  readonly $queryRawUnsafe: <T = unknown>(
    query: string,
    ...values: unknown[]
  ) => Promise<T>;
}

export interface LiveAdminAuthorityDeps {
  readonly authorizeAdmin: (
    userId: string,
    companyId: string,
  ) => Promise<boolean>;
  readonly authorizeAdminInTransaction?: (
    db: LiveAdminAuthorityDb,
    userId: string,
    companyId: string,
  ) => Promise<boolean>;
}

function validAuthorityId(value: string): boolean {
  return typeof value === 'string'
    && value.trim() !== ''
    && value.length <= 200;
}

export async function authorizeLiveAdminInTransaction(
  db: LiveAdminAuthorityDb,
  userId: string,
  companyId: string,
): Promise<boolean> {
  if (!validAuthorityId(userId) || !validAuthorityId(companyId)) return false;
  const users = await db.$queryRawUnsafe<{ isInstanceAdmin: boolean }[]>(
    `SELECT "isInstanceAdmin"
       FROM "User"
      WHERE "id" = $1
      FOR SHARE`,
    userId,
  );
  if (users[0]?.isInstanceAdmin === true) return true;
  const memberships = await db.$queryRawUnsafe<{ role: string }[]>(
    `SELECT "role"
       FROM "Membership"
      WHERE "userId" = $1
        AND "companyId" = $2
      FOR SHARE`,
    userId,
    companyId,
  );
  return memberships[0]?.role === 'admin';
}

export const liveAdminAuthority: LiveAdminAuthorityDeps = {
  authorizeAdmin: async (userId, companyId) => {
    if (!validAuthorityId(userId) || !validAuthorityId(companyId)) return false;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { isInstanceAdmin: true },
    });
    if (user?.isInstanceAdmin === true) return true;
    const membership = await prisma.membership.findUnique({
      where: { userId_companyId: { userId, companyId } },
      select: { role: true },
    });
    return membership?.role === 'admin';
  },
  authorizeAdminInTransaction: authorizeLiveAdminInTransaction,
};
