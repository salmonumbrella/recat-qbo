import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errorMiddleware, HttpError } from '../lib/http.js';

const mocks = vi.hoisted(() => ({
  session: vi.fn(), company: vi.fn(), membership: vi.fn(),
  search: vi.fn(), caseDetail: vi.fn(), currentCase: vi.fn(),
}));

vi.mock('../lib/prisma.js', () => ({ prisma: {
  session: { findUnique: mocks.session }, company: { findUnique: mocks.company },
  membership: { findUnique: mocks.membership },
} }));
vi.mock('../services/companyReads.js', () => ({
  searchClassificationKnowledge: mocks.search,
  getClassificationCase: mocks.caseDetail,
  getCurrentClassificationCase: mocks.currentCase,
}));

import { classificationRouter } from './classification.js';

function app() {
  const value = express();
  value.use(cookieParser()); value.use(express.json());
  value.use('/api/companies/:companyId/classification', classificationRouter);
  value.use(errorMiddleware);
  return value;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({ id: 'session-a', expiresAt: new Date(Date.now() + 60_000), user: {
    id: 'user-a', email: 'a@example.invalid', name: null, isInstanceAdmin: false, memberships: [],
  } });
  mocks.company.mockResolvedValue({ id: 'company-a', disconnectedAt: new Date() });
  mocks.membership.mockResolvedValue({ role: 'viewer' });
  mocks.search.mockResolvedValue({ items: [], nextCursor: null, status: 'no_match' });
  mocks.caseDetail.mockResolvedValue({ id: 'case-a' });
  mocks.currentCase.mockResolvedValue({ id: 'case-current' });
});

describe('session classification reads', () => {
  it('passes only a company-owned transaction identifier for server-derived search context', async () => {
    const response = await request(app()).get('/api/companies/company-a/classification/search')
      .query({ query: 'fuel', mode: 'hybrid', transactionId: 'txn-a' })
      .set('Cookie', 'recat_session=test');

    expect(response.status).toBe(200);
    expect(mocks.search).toHaveBeenCalledWith('user-a', 'company-a', {
      query: 'fuel', mode: 'hybrid', scope: 'current_company', transactionId: 'txn-a',
    });
  });

  it('returns the safe semantic-unavailable search error', async () => {
    mocks.search.mockRejectedValueOnce(
      new HttpError(503, 'Semantic classification search is unavailable.', 'SEMANTIC_UNAVAILABLE'),
    );
    const response = await request(app())
      .get('/api/companies/company-a/classification/search')
      .query({ query: 'fuel', mode: 'semantic' })
      .set('Cookie', 'recat_session=test');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: 'Semantic classification search is unavailable.',
      code: 'SEMANTIC_UNAVAILABLE',
    });
  });

  it('exposes historical case detail and the active verified case for a transaction', async () => {
    const historical = await request(app()).get('/api/companies/company-a/classification/cases/case-a')
      .set('Cookie', 'recat_session=test');
    const current = await request(app()).get('/api/companies/company-a/classification/cases/current')
      .query({ transactionId: 'txn-a' }).set('Cookie', 'recat_session=test');

    expect(historical.status).toBe(200);
    expect(current.status).toBe(200);
    expect(mocks.caseDetail).toHaveBeenCalledWith('user-a', 'company-a', 'case-a');
    expect(mocks.currentCase).toHaveBeenCalledWith('user-a', 'company-a', 'txn-a');
  });
});
