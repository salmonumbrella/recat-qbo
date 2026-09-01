/** Auth-channel-neutral rule lifecycle API. MCP and browser routes use the
 * same preparation, validation, durable envelope, commit, and readback core. */
import type { RuleMutationResult } from '@recat/shared';
import { getClassificationCase } from './companyReads.js';
import {
  McpRuleChangeError,
  prepareRuleChange,
  type McpRuleChangeDependencies,
  type RuleChangePrincipal,
} from './mcp/rules.js';

export {
  McpRuleChangeError as RuleChangeError,
  commitRuleChange,
  prepareRuleChange,
  type CommitRuleChangeInput,
  type McpRuleChangeDependencies as RuleChangeDependencies,
  type PrepareRuleChangeInput,
  type RuleChangePrincipal,
  type RuleChangeProposal,
} from './mcp/rules.js';

export interface PrepareRuleChangeFromCaseInput {
  matchText: string;
  priority: number;
  idempotencyKey: string;
  retryOfId?: string;
}

export async function prepareRuleChangeFromCase(
  principal: RuleChangePrincipal,
  companyId: string,
  caseId: string,
  input: PrepareRuleChangeFromCaseInput,
  dependencies: McpRuleChangeDependencies = {},
): Promise<RuleMutationResult> {
  const source = await getClassificationCase(principal.userId, companyId, caseId);
  if (source.invalidatedAt !== null) throw new McpRuleChangeError('NOT_FOUND');
  return prepareRuleChange(principal, {
    companyId,
    mutation: 'create',
    expectedRevision: 0,
    idempotencyKey: input.idempotencyKey,
    ...(input.retryOfId === undefined ? {} : { retryOfId: input.retryOfId }),
    proposal: {
      matchText: input.matchText,
      categoryQboId: source.action.categoryQboId,
      taxCalculation: source.action.taxCalculation,
      taxCodeQboId: source.action.taxCodeQboId,
      tagIds: source.action.tagIds,
      priority: input.priority,
      autoPost: false,
      sourceCaseId: source.id,
    },
  }, dependencies);
}
