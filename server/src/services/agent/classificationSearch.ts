import type { ClassificationSearchResult } from '@recat/shared';
import {
  searchClassificationMemoryWithRuntime,
  type ClassificationSearchInput,
} from '../classification/search.js';
import type {
  AgentClassificationSearchRequest,
  AgentToolDependencies,
} from './core/tools.js';

type CanonicalSearch = (
  input: ClassificationSearchInput,
) => Promise<ClassificationSearchResult | unknown>;

export type AgentClassificationSearch = NonNullable<
  AgentToolDependencies['classificationSearch']
>;

/** Bind agent retrieval to the company on the durable job. The transaction
 * context remains on the core dependency seam but is never used to widen the
 * canonical search scope. */
export function classificationSearchForCompany(
  companyId: string,
  search: CanonicalSearch = searchClassificationMemoryWithRuntime,
): AgentClassificationSearch {
  return ({ query, mode, limit, transaction }: AgentClassificationSearchRequest) => search({
    query,
    companyId,
    scope: 'current_company',
    mode,
    limit,
    accessibleCompanyIds: [companyId],
    context: {
      transactionDirection: transaction.transactionDirection,
      ...(transaction.qboType === null ? {} : { qboType: transaction.qboType }),
      ...(transaction.sourceAccountName === null ? {} : {
        sourceAccountName: transaction.sourceAccountName,
      }),
      currency: transaction.currency,
      transactionPeriod: transaction.transactionPeriod,
      ...(transaction.jurisdiction === null ? {} : { jurisdiction: transaction.jurisdiction }),
    },
  });
}
