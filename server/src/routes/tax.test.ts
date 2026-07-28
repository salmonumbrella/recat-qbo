import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorMiddleware } from '../lib/http.js';
import { taxRouter } from './tax.js';

const mocks = vi.hoisted(() => ({
  companyFindUnique: vi.fn(),
  getTaxReadiness: vi.fn(),
  membershipFindUnique: vi.fn(),
  refreshTaxReference: vi.fn(),
  sessionFindUnique: vi.fn(),
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    company: { findUnique: mocks.companyFindUnique },
    membership: { findUnique: mocks.membershipFindUnique },
    session: { findUnique: mocks.sessionFindUnique },
  },
}));

vi.mock('../services/tax/reference.js', () => ({
  getTaxReadiness: mocks.getTaxReadiness,
  refreshTaxReference: mocks.refreshTaxReference,
}));

function testApp(): Express {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api/companies/:companyId/tax', taxRouter);
  app.use(errorMiddleware);
  return app;
}

const sessionHeaders = { Cookie: 'recat_session=tax-route-test' };
let role: 'viewer' | 'categorizer' | 'admin' = 'viewer';

beforeEach(() => {
  vi.clearAllMocks();
  role = 'viewer';
  mocks.sessionFindUnique.mockResolvedValue({
    expiresAt: new Date(Date.now() + 60_000),
    user: { id: 'tax-route-user', isInstanceAdmin: false, memberships: [] },
  });
  mocks.companyFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({
    id: where.id,
    disconnectedAt: null,
  }));
  mocks.membershipFindUnique.mockImplementation(async ({ where }: { where: { userId_companyId: { companyId: string } } }) =>
    where.userId_companyId.companyId === 'company-1' ? { role } : null,
  );
  mocks.getTaxReadiness.mockResolvedValue({
    status: 'ready',
    reason: null,
    usingSalesTax: true,
    refreshedAt: '2026-07-27T00:00:00.000Z',
    taxCodes: [
      { qboId: 'GST5', name: 'GST 5%', active: true, taxable: true, combinedPurchaseRate: 5 },
      { qboId: 'OOS', name: 'Out of scope', active: true, taxable: false, combinedPurchaseRate: null },
    ],
  });
  mocks.refreshTaxReference.mockImplementation(async () => ({
    readiness: await mocks.getTaxReadiness(),
    refreshed: true,
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('tax reference routes', () => {
  it('lets a viewer read only its company tax readiness', async () => {
    const app = testApp();

    const allowed = await request(app).get('/api/companies/company-1/tax').set(sessionHeaders);
    const forbidden = await request(app).get('/api/companies/company-2/tax').set(sessionHeaders);

    expect(allowed.status).toBe(200);
    expect(allowed.body.taxCodes).toHaveLength(2);
    expect(forbidden.status).toBe(403);
    expect(mocks.getTaxReadiness).toHaveBeenCalledWith('company-1');
  });

  it('rejects signed-out requests', async () => {
    const response = await request(testApp()).get('/api/companies/company-1/tax');

    expect(response.status).toBe(401);
    expect(mocks.getTaxReadiness).not.toHaveBeenCalled();
  });

  it('requires a company admin for a forced refresh', async () => {
    role = 'categorizer';
    const response = await request(testApp()).post('/api/companies/company-1/tax/refresh').set(sessionHeaders);

    expect(response.status).toBe(403);
    expect(mocks.refreshTaxReference).not.toHaveBeenCalled();
  });

  it('keeps cached reads available but rejects refreshes for disconnected companies', async () => {
    mocks.companyFindUnique.mockResolvedValue({ id: 'company-1', disconnectedAt: new Date() });
    role = 'admin';
    const app = testApp();

    const read = await request(app).get('/api/companies/company-1/tax').set(sessionHeaders);
    const refresh = await request(app).post('/api/companies/company-1/tax/refresh').set(sessionHeaders);

    expect(read.status).toBe(200);
    expect(refresh.status).toBe(404);
    expect(mocks.refreshTaxReference).not.toHaveBeenCalled();
  });

  it('returns no more than 100 tax codes in cached qboId order without mutating the cached result', async () => {
    const readiness = {
      status: 'ready' as const,
      reason: null,
      usingSalesTax: true,
      refreshedAt: '2026-07-27T00:00:00.000Z',
      taxCodes: Array.from({ length: 101 }, (_, index) => ({
        qboId: String(index).padStart(3, '0'),
        name: `Tax ${index}`,
        active: true,
        taxable: true,
        combinedPurchaseRate: 5,
      })),
    };
    mocks.getTaxReadiness.mockResolvedValue(readiness);

    const response = await request(testApp()).get('/api/companies/company-1/tax').set(sessionHeaders);

    expect(response.status).toBe(200);
    expect(response.body.taxCodes).toHaveLength(100);
    expect(response.body.taxCodes[0].qboId).toBe('000');
    expect(response.body.taxCodes.at(-1).qboId).toBe('099');
    expect(readiness.taxCodes).toHaveLength(101);
  });

  it('filters unsupported codes before applying the 100-code response cap', async () => {
    const unsupported = Array.from({ length: 101 }, (_, index) => ({
      qboId: `A${String(index).padStart(3, '0')}`,
      name: `Inactive ${index}`,
      active: false,
      taxable: true,
      combinedPurchaseRate: 5,
    }));
    const usable = Array.from({ length: 101 }, (_, index) => ({
      qboId: `Z${String(index).padStart(3, '0')}`,
      name: `Usable ${index}`,
      active: true,
      taxable: true,
      combinedPurchaseRate: 0,
    }));
    mocks.getTaxReadiness.mockResolvedValue({
      status: 'ready',
      reason: null,
      usingSalesTax: true,
      refreshedAt: '2026-07-27T00:00:00.000Z',
      taxCodes: [...unsupported, ...usable],
    });

    const response = await request(testApp()).get('/api/companies/company-1/tax').set(sessionHeaders);

    expect(response.status).toBe(200);
    expect(response.body.taxCodes).toHaveLength(100);
    expect(response.body.taxCodes[0].qboId).toBe('Z000');
    expect(response.body.taxCodes.at(-1).qboId).toBe('Z099');
  });

  it('forces a refresh only for the requested company and bounds its response', async () => {
    role = 'admin';
    const readiness = {
      status: 'ready' as const,
      reason: null,
      usingSalesTax: true,
      refreshedAt: '2026-07-27T00:00:00.000Z',
      taxCodes: Array.from({ length: 101 }, (_, index) => ({
        qboId: String(index).padStart(3, '0'),
        name: `Tax ${index}`,
        active: true,
        taxable: true,
        combinedPurchaseRate: 5,
      })),
    };
    mocks.refreshTaxReference.mockResolvedValue({ readiness, refreshed: true });

    const response = await request(testApp()).post('/api/companies/company-1/tax/refresh').set(sessionHeaders);

    expect(response.status).toBe(200);
    expect(response.body.readiness.taxCodes).toHaveLength(100);
    expect(readiness.taxCodes).toHaveLength(101);
    expect(mocks.refreshTaxReference).toHaveBeenCalledWith('company-1', { force: true });
  });
});
