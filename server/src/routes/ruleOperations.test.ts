import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errorMiddleware } from '../lib/http.js';

const mocks = vi.hoisted(() => ({
  session: vi.fn(), company: vi.fn(), membership: vi.fn(), prepare: vi.fn(), commit: vi.fn(), fromCase: vi.fn(),
}));
vi.mock('../lib/prisma.js', () => ({ prisma: {
  session: { findUnique: mocks.session }, company: { findUnique: mocks.company }, membership: { findUnique: mocks.membership },
} }));
vi.mock('../services/publicUrl.js', () => ({ allowedOrigins: async () => new Set(['http://localhost:5173']) }));
vi.mock('../services/ruleChanges.js', () => ({
  prepareRuleChange: mocks.prepare, commitRuleChange: mocks.commit, prepareRuleChangeFromCase: mocks.fromCase,
  RuleChangeError: class RuleChangeError extends Error {},
}));

import { ruleOperationsRouter } from './ruleOperations.js';

function app() { const value = express(); value.use(cookieParser()); value.use(express.json());
  value.use('/api/companies/:companyId/rule-operations', ruleOperationsRouter); value.use(errorMiddleware); return value; }
const auth = { Cookie: 'recat_session=x', Origin: 'http://localhost:5173' };
beforeEach(() => {
  vi.clearAllMocks(); mocks.session.mockResolvedValue({ id: 'session-a', expiresAt: new Date(Date.now() + 60_000), user: {
    id: 'user-a', email: 'a@example.invalid', name: null, isInstanceAdmin: false, memberships: [],
  } }); mocks.company.mockResolvedValue({ id: 'company-a', disconnectedAt: null });
  mocks.membership.mockResolvedValue({ role: 'categorizer' });
  mocks.prepare.mockResolvedValue({ status: 'PREPARED' }); mocks.commit.mockResolvedValue({ status: 'COMMITTED' });
  mocks.fromCase.mockResolvedValue({ status: 'PREPARED' });
});

describe('browser two-phase rule operations', () => {
  it('binds prepare and commit to the exact authenticated session and route company', async () => {
    const prepare = await request(app()).post('/api/companies/company-a/rule-operations/prepare').set(auth).send({
      mutation: 'disable', ruleId: 'rule-a', expectedRevision: 4, idempotencyKey: 'disable-a',
    });
    const commit = await request(app()).post('/api/companies/company-a/rule-operations/op-a/commit').set(auth).send({ idempotencyKey: 'disable-a' });
    expect(prepare.status).toBe(200); expect(commit.status).toBe(200);
    expect(mocks.prepare).toHaveBeenCalledWith(
      { kind: 'session', sessionId: 'session-a', userId: 'user-a' },
      { companyId: 'company-a', mutation: 'disable', ruleId: 'rule-a', expectedRevision: 4, idempotencyKey: 'disable-a' },
    );
    expect(mocks.commit).toHaveBeenCalledWith(
      { kind: 'session', sessionId: 'session-a', userId: 'user-a' },
      { companyId: 'company-a', operationId: 'op-a', idempotencyKey: 'disable-a' },
    );
  });

  it('requires an allowed Origin and rejects generic recurring creation', async () => {
    const noOrigin = await request(app()).post('/api/companies/company-a/rule-operations/prepare')
      .set('Cookie', auth.Cookie).send({ mutation: 'disable', ruleId: 'rule-a', expectedRevision: 4, idempotencyKey: 'x' });
    const genericCreate = await request(app()).post('/api/companies/company-a/rule-operations/prepare').set(auth)
      .send({ mutation: 'create', expectedRevision: 0, idempotencyKey: 'x', proposal: {} });
    expect(noOrigin.status).toBe(403); expect(genericCreate.status).toBe(400);
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it('uses the specialized server-derived verified-case preparation', async () => {
    const response = await request(app()).post('/api/companies/company-a/rule-operations/from-case/case-a/prepare').set(auth)
      .send({ matchText: 'Chevron', priority: 3, idempotencyKey: 'case-a' });
    expect(response.status).toBe(200);
    expect(mocks.fromCase).toHaveBeenCalledWith(
      { kind: 'session', sessionId: 'session-a', userId: 'user-a' }, 'company-a', 'case-a',
      { matchText: 'Chevron', priority: 3, idempotencyKey: 'case-a' },
    );
  });
});
