import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errorMiddleware } from '../lib/http.js';
import { receiptSettingsRouter } from './receiptSettings.js';

const mocks = vi.hoisted(() => ({
  companyFindUnique: vi.fn(),
  getReceiptSettings: vi.fn(),
  membershipFindUnique: vi.fn(),
  sessionFindUnique: vi.fn(),
  updateReceiptSettings: vi.fn(),
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    company: { findUnique: mocks.companyFindUnique },
    membership: { findUnique: mocks.membershipFindUnique },
    session: { findUnique: mocks.sessionFindUnique },
  },
}));

vi.mock('../services/receipts/settings.js', async (importOriginal) => {
  const original = await importOriginal<
    typeof import('../services/receipts/settings.js')
  >();
  return {
    ...original,
    getReceiptSettings: mocks.getReceiptSettings,
    updateReceiptSettings: mocks.updateReceiptSettings,
  };
});

function testApp(): Express {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use(
    '/api/companies/:companyId/receipt-settings',
    receiptSettingsRouter,
  );
  app.use(errorMiddleware);
  return app;
}

const sessionHeaders = { Cookie: 'recat_session=receipt-settings-test' };
let role: 'viewer' | 'categorizer' | 'admin' = 'viewer';

beforeEach(() => {
  vi.clearAllMocks();
  role = 'viewer';
  mocks.sessionFindUnique.mockResolvedValue({
    expiresAt: new Date(Date.now() + 60_000),
    user: {
      id: 'settings-user',
      isInstanceAdmin: false,
      memberships: [],
    },
  });
  mocks.companyFindUnique.mockImplementation(
    async ({ where }: { where: { id: string } }) => ({
      id: where.id,
      disconnectedAt: null,
    }),
  );
  mocks.membershipFindUnique.mockImplementation(
    async ({
      where,
    }: {
      where: { userId_companyId: { companyId: string } };
    }) => (
      where.userId_companyId.companyId === 'company-1' ? { role } : null
    ),
  );
  mocks.getReceiptSettings.mockResolvedValue({
    enabled: true,
    provider: 'openrouter',
    model: 'openai/gpt-4o-mini',
    confidenceThreshold: 0.8,
    autoMatchThreshold: 85,
    autoMatchMargin: 15,
    maxPages: 20,
    configVersion: 'a'.repeat(64),
  });
  mocks.updateReceiptSettings.mockImplementation(
    async (_companyId: string, patch: Record<string, unknown>) => ({
      ...await mocks.getReceiptSettings(),
      ...patch,
      configVersion: 'b'.repeat(64),
    }),
  );
});

describe('receipt processing settings routes', () => {
  it('lets a viewer read only its company settings', async () => {
    const app = testApp();
    const allowed = await request(app)
      .get('/api/companies/company-1/receipt-settings')
      .set(sessionHeaders);
    const forbidden = await request(app)
      .get('/api/companies/company-2/receipt-settings')
      .set(sessionHeaders);

    expect(allowed.status).toBe(200);
    expect(allowed.body).not.toHaveProperty('apiKey');
    expect(forbidden.status).toBe(403);
    expect(mocks.getReceiptSettings).toHaveBeenCalledWith('company-1');
  });

  it('requires a company admin to update settings', async () => {
    role = 'categorizer';
    const response = await request(testApp())
      .patch('/api/companies/company-1/receipt-settings')
      .set(sessionHeaders)
      .send({ maxPages: 5 });

    expect(response.status).toBe(403);
    expect(mocks.updateReceiptSettings).not.toHaveBeenCalled();
  });

  it('lets an admin apply a strict bounded patch', async () => {
    role = 'admin';
    const response = await request(testApp())
      .patch('/api/companies/company-1/receipt-settings')
      .set(sessionHeaders)
      .send({ maxPages: 5, autoMatchThreshold: 90 });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      maxPages: 5,
      autoMatchThreshold: 90,
    });
    expect(mocks.updateReceiptSettings).toHaveBeenCalledWith(
      'company-1',
      { maxPages: 5, autoMatchThreshold: 90 },
    );
  });

  it('rejects secrets, unknown fields, and excessive page limits', async () => {
    role = 'admin';
    const app = testApp();
    const secret = await request(app)
      .patch('/api/companies/company-1/receipt-settings')
      .set(sessionHeaders)
      .send({ apiKey: 'route-private-secret' });
    const excessive = await request(app)
      .patch('/api/companies/company-1/receipt-settings')
      .set(sessionHeaders)
      .send({ maxPages: 51 });

    expect(secret.status).toBe(400);
    expect(excessive.status).toBe(400);
    expect(JSON.stringify(secret.body)).not.toContain('route-private-secret');
    expect(mocks.updateReceiptSettings).not.toHaveBeenCalled();
  });
});
