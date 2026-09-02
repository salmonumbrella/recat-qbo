import { describe, expect, it, vi } from 'vitest';
import { classificationSearchForCompany } from './classificationSearch.js';

describe('classificationSearchForCompany', () => {
  it('rejects a non-canonical injected dependency result at the outer boundary', async () => {
    const bound = classificationSearchForCompany('company-a', async () => ({ hits: [] }));
    await expect(bound({
      query: 'Coffee', mode: 'auto', limit: 1,
      transaction: {
        transactionId: 'transaction-a', date: '2026-08-31', signedAmountCents: -1,
        currency: 'CAD', sourceAccountName: null, payee: 'Coffee', memo: null,
        transactionDirection: 'out', qboType: null, transactionPeriod: '2026-08',
        jurisdiction: null, taxStatus: 'ready',
      },
    })).rejects.toThrow('Check the classification request');
  });
  it('binds internal-agent search to the job company and current-company scope', async () => {
    const search = vi.fn(async () => ({
      query: 'Coffee', companyId: 'company-a', scope: 'current_company',
      mode: 'lexical', requestedMode: 'auto', degraded: true,
      degradedReason: 'semantic_unavailable', status: 'no_match', noMatch: true,
      hits: [], total: 0,
    }));
    const bound = classificationSearchForCompany('company-a', search);

    await bound({
      query: 'Coffee',
      mode: 'auto',
      limit: 12,
      transaction: {
        transactionId: 'transaction-a',
        date: '2026-08-31',
        signedAmountCents: -1_200,
        currency: 'CAD',
        sourceAccountName: null,
        payee: 'Coffee shop',
        memo: null,
        transactionDirection: 'out',
        qboType: null,
        transactionPeriod: '2026-08',
        jurisdiction: null,
        taxStatus: 'ready',
      },
    });

    expect(search).toHaveBeenCalledWith({
      query: 'Coffee',
      companyId: 'company-a',
      scope: 'current_company',
      mode: 'auto',
      limit: 12,
      accessibleCompanyIds: ['company-a'],
      excludeTransactionId: 'transaction-a',
      context: {
        transactionDirection: 'out',
        currency: 'CAD',
        transactionPeriod: '2026-08',
      },
    });
  });
});
