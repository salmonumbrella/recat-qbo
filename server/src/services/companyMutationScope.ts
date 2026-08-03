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

export interface CompanyMutationTransactionRunner<TTransaction> {
  $transaction<T>(
    callback: (transaction: TTransaction) => Promise<T>,
    options: { maxWait: number; timeout: number },
  ): Promise<T>;
}

const COMPANY_MUTATION_TRANSACTION_TIMEOUT_MS = 30_000;

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

/**
 * Runs a company-scoped local mutation after acquiring the shared advisory
 * fence. The default READ COMMITTED isolation is deliberate: a transaction
 * that waited for the fence must observe the preceding mutation's committed
 * Rule/candidate rows before it revalidates.
 */
export function runCompanyMutationTransaction<TTransaction, TResult>(
  db: CompanyMutationTransactionRunner<TTransaction>,
  companyId: string,
  callback: (transaction: TTransaction) => Promise<TResult>,
): Promise<TResult> {
  return db.$transaction(async (transaction) => {
    await lockCompanyMutationScope(
      transaction as unknown as CompanyMutationScopeDb,
      companyId,
    );
    return callback(transaction);
  }, {
    maxWait: COMPANY_MUTATION_TRANSACTION_TIMEOUT_MS,
    timeout: COMPANY_MUTATION_TRANSACTION_TIMEOUT_MS,
  });
}
