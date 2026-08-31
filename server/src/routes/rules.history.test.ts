import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type StoredRule = Record<string, any> & {
  id: string;
  companyId: string;
  priority: number;
  revision: number;
  ruleTags: Array<{ ruleId: string; tagId: string }>;
};

function rule(id: string, priority: number, tagIds: string[] = []): StoredRule {
  return {
    id,
    companyId: 'company-synthetic',
    priority,
    matchField: 'payee',
    matchText: `Synthetic Vendor ${id}`,
    category: 'Synthetic expense',
    categoryQboId: 'account-synthetic',
    taxCalculation: null,
    taxCode: null,
    taxCodeQboId: null,
    autoPost: false,
    enabled: true,
    revision: 0,
    originIntent: null,
    sourceCaseId: null,
    sourceCandidateId: null,
    retiredAt: null,
    createdById: 'user-synthetic',
    createdAt: new Date('2026-08-30T00:00:00.000Z'),
    updatedAt: new Date('2026-08-30T00:00:00.000Z'),
    updatedById: null,
    reviewRequiredAt: null,
    reviewReason: null,
    ruleTags: tagIds.map((tagId) => ({ ruleId: id, tagId })),
    candidateOrigin: null,
  };
}

const state = vi.hoisted(() => ({
  rules: [] as StoredRule[],
  revisions: [] as Array<Record<string, any>>,
}));

const fakePrisma = vi.hoisted(() => ({
  qboAccount: { findFirst: vi.fn(async () => null) },
  tag: {
    count: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
      new Set(where.id.in).size),
  },
  rule: {
    aggregate: vi.fn(async () => ({
      _min: {
        priority: state.rules.length === 0
          ? null
          : Math.min(...state.rules.map((row) => row.priority)),
      },
    })),
    create: vi.fn(async ({ data }: { data: Record<string, any> }) => {
      const created = {
        ...rule(`rule-created-${state.rules.length + 1}`, data.priority),
        ...data,
        ruleTags: (data.ruleTags?.create ?? []).map(({ tagId }: { tagId: string }) => ({
          ruleId: `rule-created-${state.rules.length + 1}`,
          tagId,
        })),
      };
      state.rules.push(created);
      return created;
    }),
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
      state.rules.find((row) => row.id === where.id) ?? null),
    findMany: vi.fn(async () => [...state.rules].sort((a, b) => a.priority - b.priority)),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, any> }) => {
      const current = state.rules.find((row) => row.id === where.id);
      if (current === undefined) throw new Error('Rule not found');
      const next = {
        ...current,
        ...data,
        revision: data.revision?.increment === undefined
          ? current.revision
          : current.revision + data.revision.increment,
      };
      state.rules[state.rules.indexOf(current)] = next;
      return next;
    }),
  },
  ruleTag: {
    deleteMany: vi.fn(async ({ where }: { where: { ruleId: string } }) => {
      const current = state.rules.find((row) => row.id === where.ruleId);
      if (current !== undefined) current.ruleTags = [];
      return { count: 0 };
    }),
    create: vi.fn(async ({ data }: { data: { ruleId: string; tagId: string } }) => {
      const current = state.rules.find((row) => row.id === data.ruleId);
      if (current === undefined) throw new Error('Rule not found');
      const row = { ruleId: data.ruleId, tagId: data.tagId };
      current.ruleTags.push(row);
      return row;
    }),
  },
  ruleRevision: {
    create: vi.fn(async ({ data }: { data: Record<string, any> }) => {
      state.revisions.push(data);
      return data;
    }),
  },
}));

vi.mock('../lib/prisma.js', () => ({ prisma: fakePrisma }));
vi.mock('../middleware/auth.js', () => ({
  requireUser: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    Object.assign(req, { user: { id: 'user-synthetic' } });
    next();
  },
  requireRole: () => (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => next(),
}));
vi.mock('../middleware/company.js', () => ({
  withCompany: () => (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    Object.assign(req, { company: { id: 'company-synthetic' } });
    next();
  },
}));
vi.mock('../services/companyMutationScope.js', () => ({
  runCompanyMutationTransaction: async (
    _client: unknown,
    _companyId: string,
    callback: (tx: typeof fakePrisma) => Promise<unknown>,
  ) => callback(fakePrisma),
}));

import { rulesRouter } from './rules.js';

function app() {
  const value = express();
  value.use(express.json());
  value.use('/api/companies/:companyId/rules', rulesRouter);
  return value;
}

describe('REST rule revision history', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.rules = [];
    state.revisions = [];
  });

  it('creates revision zero with the creator and complete initial tags', async () => {
    const response = await request(app())
      .post('/api/companies/company-synthetic/rules')
      .send({
        matchText: 'Synthetic Vendor',
        category: 'Synthetic expense',
        categoryQboId: 'account-synthetic',
        tagIds: ['tag-b', 'tag-a'],
        autoPost: true,
      });

    expect(response.status).toBe(201);
    expect(state.rules[0]).toMatchObject({ revision: 0, updatedById: 'user-synthetic' });
    expect(state.revisions).toEqual([
      expect.objectContaining({
        ruleId: state.rules[0]?.id,
        revision: 0,
        state: 'enabled',
        changedBy: 'user-synthetic',
        autoPost: true,
        tagIds: ['tag-a', 'tag-b'],
      }),
    ]);
  });

  it('increments revision and snapshots the edited rule after replacing tags', async () => {
    state.rules = [rule('rule-edit', 2, ['tag-old'])];

    const response = await request(app())
      .patch('/api/companies/company-synthetic/rules/rule-edit')
      .send({ matchText: 'Edited Vendor', tagIds: ['tag-new'] });

    expect(response.status).toBe(200);
    expect(state.rules[0]).toMatchObject({
      matchText: 'Edited Vendor',
      revision: 1,
      updatedById: 'user-synthetic',
    });
    expect(state.revisions).toEqual([
      expect.objectContaining({
        ruleId: 'rule-edit',
        revision: 1,
        matchText: 'Edited Vendor',
        tagIds: ['tag-new'],
        changedBy: 'user-synthetic',
      }),
    ]);
  });

  it('versions every rule whose priority changes during ordering', async () => {
    state.rules = [rule('rule-a', 0, ['tag-a']), rule('rule-b', 1, ['tag-b'])];

    const response = await request(app())
      .put('/api/companies/company-synthetic/rules/order')
      .send({ ids: ['rule-b', 'rule-a'] });

    expect(response.status).toBe(200);
    expect(state.rules).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'rule-a', priority: 1, revision: 1, updatedById: 'user-synthetic' }),
      expect.objectContaining({ id: 'rule-b', priority: 0, revision: 1, updatedById: 'user-synthetic' }),
    ]));
    expect(state.revisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: 'rule-a', priority: 1, revision: 1, tagIds: ['tag-a'] }),
      expect.objectContaining({ ruleId: 'rule-b', priority: 0, revision: 1, tagIds: ['tag-b'] }),
    ]));
  });
});
