import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errorMiddleware } from '../lib/http.js';

const mocks = vi.hoisted(() => ({
  session: vi.fn(), company: vi.fn(), membership: vi.fn(), list: vi.fn(),
  detail: vi.fn(), history: vi.fn(), test: vi.fn(),
}));
vi.mock('../lib/prisma.js', () => ({ prisma: {
  session: { findUnique: mocks.session }, company: { findUnique: mocks.company },
  membership: { findUnique: mocks.membership },
} }));
vi.mock('../services/companyReads.js', () => ({
  listRules: mocks.list, getRule: mocks.detail, listRuleRevisions: mocks.history,
}));
vi.mock('../services/rules.js', async (original) => ({
  ...(await original<typeof import('../services/rules.js')>()), testRule: mocks.test,
}));

import { rulesRouter } from './rules.js';

function app() { const value = express(); value.use(cookieParser()); value.use(express.json());
  value.use('/api/companies/:companyId/rules', rulesRouter); value.use(errorMiddleware); return value; }
beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({ id: 'session-a', expiresAt: new Date(Date.now() + 60_000), user: {
    id: 'user-a', email: 'a@example.invalid', name: null, isInstanceAdmin: false, memberships: [],
  } });
  mocks.company.mockResolvedValue({ id: 'company-a', disconnectedAt: new Date() });
  mocks.membership.mockResolvedValue({ role: 'categorizer' });
  mocks.detail.mockResolvedValue({ revision: { revision: 4, state: 'disabled' } });
  mocks.history.mockResolvedValue({ items: [], nextCursor: null });
});

describe('governed rule REST', () => {
  it('reads canonical detail and signed-cursor history while disconnected', async () => {
    const detail = await request(app()).get('/api/companies/company-a/rules/rule-a').set('Cookie', 'recat_session=x');
    const history = await request(app()).get('/api/companies/company-a/rules/rule-a/revisions?limit=10').set('Cookie', 'recat_session=x');
    expect(detail.status).toBe(200); expect(history.status).toBe(200);
    expect(mocks.detail).toHaveBeenCalledWith('user-a', 'company-a', 'rule-a');
    expect(mocks.history).toHaveBeenCalledWith('user-a', 'company-a', 'rule-a', { limit: 10 });
  });

  it.each([
    ['post', '/api/companies/company-a/rules'],
    ['patch', '/api/companies/company-a/rules/rule-a'],
    ['delete', '/api/companies/company-a/rules/rule-a'],
    ['put', '/api/companies/company-a/rules/order'],
  ] as const)('rejects legacy %s policy writes with a stable migration code', async (method, path) => {
    const response = await request(app())[method](path).set('Cookie', 'recat_session=x').send({});
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('RULE_OPERATION_REQUIRED');
  });
});
