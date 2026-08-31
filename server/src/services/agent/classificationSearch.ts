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
  return ({ query, mode, limit }: AgentClassificationSearchRequest) => search({
    query,
    companyId,
    scope: 'current_company',
    mode,
    limit,
    accessibleCompanyIds: [companyId],
  });
}
