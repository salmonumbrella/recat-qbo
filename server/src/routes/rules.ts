// Rule CRUD — /api/companies/:companyId/rules (categorizer+).
// REST and MCP deliberately share the same company-scoped lifecycle service.

import type { Company } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, HttpError, validate } from '../lib/http.js';
import { requireRole, requireUser } from '../middleware/auth.js';
import { withCompany } from '../middleware/company.js';
import {
  listRules,
  RuleServiceError,
  testRule,
  toRuleDto,
} from '../services/rules.js';
import { getRule, listRuleLifecycle, listRuleRevisions } from '../services/companyReads.js';

export { toRuleDto } from '../services/rules.js';

const withReadableCompany = withCompany({ allowDisconnected: true });

const testBody = z.object({
  matchText: z.string().trim().min(1).max(200),
  priorityTop: z.boolean().optional().default(true),
});

const lifecycleQuery = z.object({
  state: z.enum(['enabled', 'disabled', 'retired', 'all']).default('all'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(2_048).optional(),
}).strict();

function scopedCompany(req: { company?: Company }): Company {
  if (!req.company) throw new HttpError(404, 'Company not found', 'COMPANY_NOT_FOUND');
  return req.company;
}

function operationRequired(): never {
  throw new HttpError(409, 'Use the two-phase rule operation API', 'RULE_OPERATION_REQUIRED');
}

async function mapped<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!(error instanceof RuleServiceError)) throw error;
    if (error.code === 'NOT_FOUND') {
      throw new HttpError(404, error.message, 'RULE_NOT_FOUND');
    }
    if (error.code === 'INVALID_INPUT') {
      throw new HttpError(400, error.message, 'BAD_REQUEST');
    }
    throw new HttpError(409, error.message, error.code);
  }
}

export const rulesRouter = Router({ mergeParams: true });
rulesRouter.use(requireUser);

rulesRouter.get('/', requireRole('categorizer'), withReadableCompany, asyncHandler(async (req, res) => {
  const company = scopedCompany(req);
  res.json((await listRules(company.id)).map(toRuleDto));
}));

rulesRouter.post('/', requireRole('categorizer'), withReadableCompany, asyncHandler(async (req, res) => {
  operationRequired();
}));

rulesRouter.post('/test', requireRole('categorizer'), withReadableCompany, asyncHandler(async (req, res) => {
  const company = scopedCompany(req);
  const body = validate(testBody)(req.body);
  res.json(await mapped(() => testRule(company.id, body.matchText, body.priorityTop)));
}));

rulesRouter.put('/order', requireRole('categorizer'), withReadableCompany, asyncHandler(async (req, res) => {
  operationRequired();
}));

rulesRouter.get('/lifecycle', requireRole('categorizer'), withReadableCompany, asyncHandler(async (req, res) => {
  if (!req.user) throw new HttpError(401, 'Not signed in', 'UNAUTHENTICATED');
  const query = validate(lifecycleQuery)(req.query);
  res.json(await listRuleLifecycle(req.user.id, scopedCompany(req).id, query));
}));

rulesRouter.get('/:id/revisions', requireRole('viewer'), withReadableCompany, asyncHandler(async (req, res) => {
  if (!req.user) throw new HttpError(401, 'Not signed in', 'UNAUTHENTICATED');
  const limit = req.query.limit === undefined ? undefined : Number(req.query.limit);
  res.json(await listRuleRevisions(req.user.id, scopedCompany(req).id, req.params.id ?? '', {
    ...(limit === undefined ? {} : { limit }),
    ...(typeof req.query.cursor === 'string' ? { cursor: req.query.cursor } : {}),
  }));
}));

rulesRouter.get('/:id', requireRole('viewer'), withReadableCompany, asyncHandler(async (req, res) => {
  if (!req.user) throw new HttpError(401, 'Not signed in', 'UNAUTHENTICATED');
  res.json(await getRule(req.user.id, scopedCompany(req).id, req.params.id ?? ''));
}));

rulesRouter.patch('/:id', requireRole('categorizer'), withReadableCompany, asyncHandler(async (req, res) => {
  operationRequired();
}));

rulesRouter.delete('/:id', requireRole('categorizer'), withReadableCompany, asyncHandler(async (req, res) => {
  operationRequired();
}));
