/**
 * Serializes every same-company mutation-attempt decision and tax-reference
 * replacement. Call only inside an existing database transaction.
 *
 * Global lock order:
 *   scheduler capacity advisory lock -> company advisory locks (sorted)
 *   -> Company -> tax rates -> tax codes -> live facts
 *
 * Paths that do not account for scheduler capacity begin at the company lock.
 * No company-scoped mutation path may acquire the scheduler capacity lock.
 */
export interface CompanyMutationScopeDb {
  $queryRawUnsafe<T = unknown>(
    query: string,
    ...values: unknown[]
  ): Promise<T>;
}

export async function lockCompanyMutationScope(
  db: CompanyMutationScopeDb,
  companyId: string,
): Promise<void> {
  if (typeof companyId !== 'string' || companyId.trim() === '') {
    throw new Error('A company identifier is required for mutation serialization.');
  }
  await db.$queryRawUnsafe(
    `SELECT 1 AS "locked"
       FROM pg_advisory_xact_lock(hashtextextended($1, 880217))`,
    companyId,
  );
}

export async function lockCompanyMutationScopes(
  db: CompanyMutationScopeDb,
  companyIds: readonly string[],
): Promise<void> {
  const ordered = [...new Set(companyIds)].sort();
  for (const companyId of ordered) {
    await lockCompanyMutationScope(db, companyId);
  }
}
