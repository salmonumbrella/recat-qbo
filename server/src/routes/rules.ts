// Rule CRUD — /api/companies/:companyId/rules (categorizer+).
// REST and MCP deliberately share the same company-scoped lifecycle service.

import type { Company } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, HttpError, validate } from '../lib/http.js';
import { prisma } from '../lib/prisma.js';
import { requireRole, requireUser } from '../middleware/auth.js';
import { withCompany } from '../middleware/company.js';
import {
  createRule,
  listRules,
  reorderRules,
  resolveCategoryReference,
  retireRule,
  RuleServiceError,
  testRule,
  toRuleDto,
  updateRule,
  type RuleActor,
} from '../services/rules.js';

export { toRuleDto } from '../services/rules.js';

const createBody = z.object({
  matchText: z.string().trim().min(1).max(200),
  category: z.string().trim().min(1).max(200),
  categoryQboId: z.string().min(1).nullish(),
  tagIds: z.array(z.string().min(1)).optional(),
  autoPost: z.boolean().optional(),
});
const patchBody = z.object({
  matchText: z.string().trim().min(1).max(200).optional(),
  category: z.string().trim().min(1).max(200).optional(),
  categoryQboId: z.string().min(1).nullish(),
  tagIds: z.array(z.string().min(1)).optional(),
  autoPost: z.boolean().optional(),
  priority: z.number().int().optional(),
});
const orderBody = z.object({ ids: z.array(z.string().min(1)).min(1) });
const testBody = z.object({
  matchText: z.string().trim().min(1).max(200),
  priorityTop: z.boolean().optional().default(true),
});

function scopedCompany(req: { company?: Company }): Company {
  if (!req.company) throw new HttpError(404, 'Company not found', 'COMPANY_NOT_FOUND');
  return req.company;
}

function actor(req: Express.Request): RuleActor {
  return {
    id: req.user?.id ?? null,
    label: req.user?.name?.trim() || req.user?.email || 'system',
  };
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
rulesRouter.use(requireUser, requireRole('categorizer'), withCompany({ allowDisconnected: true }));

rulesRouter.get('/', asyncHandler(async (req, res) => {
  const company = scopedCompany(req);
  res.json((await listRules(company.id)).map(toRuleDto));
}));

rulesRouter.post('/', asyncHandler(async (req, res) => {
  const company = scopedCompany(req);
  const body = validate(createBody)(req.body);
  const categoryQboId = await mapped(() => resolveCategoryReference(
    prisma,
    company.id,
    body.category,
    body.categoryQboId,
  ));
  const rule = await mapped(() => createRule(company.id, actor(req), {
    matchText: body.matchText,
    categoryQboId,
    taxCalculation: 'NotApplicable',
    taxCodeQboId: null,
    tagIds: [...new Set(body.tagIds ?? [])],
    autoPost: body.autoPost ?? false,
    originIntent: null,
    sourceCaseId: null,
    sourceCandidateId: null,
  }));
  res.status(201).json(toRuleDto(rule));
}));

rulesRouter.post('/test', asyncHandler(async (req, res) => {
  const company = scopedCompany(req);
  const body = validate(testBody)(req.body);
  res.json(await mapped(() => testRule(company.id, body.matchText, body.priorityTop)));
}));

rulesRouter.put('/order', asyncHandler(async (req, res) => {
  const company = scopedCompany(req);
  const { ids } = validate(orderBody)(req.body);
  const rules = await mapped(() => reorderRules(company.id, ids, actor(req)));
  res.json(rules.map(toRuleDto));
}));

rulesRouter.patch('/:id', asyncHandler(async (req, res) => {
  const company = scopedCompany(req);
  const patch = validate(patchBody)(req.body);
  const categoryQboId = patch.category !== undefined || patch.categoryQboId !== undefined
    ? await mapped(() => resolveCategoryReference(
        prisma,
        company.id,
        patch.category ?? '',
        patch.categoryQboId,
      ))
    : undefined;
  const updated = await mapped(() => updateRule(
    company.id,
    req.params.id ?? '',
    actor(req),
    {
      ...(patch.matchText !== undefined ? { matchText: patch.matchText } : {}),
      ...(categoryQboId !== undefined ? { categoryQboId } : {}),
      ...(patch.tagIds !== undefined ? { tagIds: [...new Set(patch.tagIds)] } : {}),
      ...(patch.autoPost !== undefined ? { autoPost: patch.autoPost } : {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
    },
  ));
  res.json(toRuleDto(updated));
}));

rulesRouter.delete('/:id', asyncHandler(async (req, res) => {
  const company = scopedCompany(req);
  await mapped(() => retireRule(company.id, req.params.id ?? '', actor(req)));
  res.json({ ok: true });
}));
