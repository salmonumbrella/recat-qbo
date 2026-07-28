import { describe, expect, it } from 'vitest';
import {
  PurchaseTaxError,
  calculatePurchaseLine,
  calculatePurchaseTransaction as calculatePurchaseTransactionRaw,
} from './purchaseTax.js';

const reference = {
  codes: [
    {
      qboId: 'GST5',
      name: 'GST 5%',
      description: null,
      active: true,
      taxable: true,
      purchaseRates: [{ taxRateQboId: 'RATE5', taxTypeApplicable: 'TaxOnAmount' }],
    },
    {
      qboId: 'OOS',
      name: 'Out of scope',
      description: null,
      active: true,
      taxable: false,
      purchaseRates: [],
    },
    {
      qboId: 'OLD',
      name: 'Old GST',
      description: null,
      active: false,
      taxable: true,
      purchaseRates: [{ taxRateQboId: 'RATE5', taxTypeApplicable: 'TaxOnAmount' }],
    },
    {
      qboId: 'COMPOUND',
      name: 'GST and PST',
      description: null,
      active: true,
      taxable: true,
      purchaseRates: [
        { taxRateQboId: 'RATE5', taxTypeApplicable: 'TaxOnAmount' },
        { taxRateQboId: 'RATE7', taxTypeApplicable: 'TaxOnAmount' },
      ],
    },
    {
      qboId: 'SALES_ONLY',
      name: 'Sales only',
      description: null,
      active: true,
      taxable: true,
      purchaseRates: [],
    },
    {
      qboId: 'FULL',
      name: 'Full rate',
      description: null,
      active: true,
      taxable: true,
      purchaseRates: [{ taxRateQboId: 'RATE100', taxTypeApplicable: 'TaxOnAmount' }],
    },
    {
      qboId: 'FRACTIONAL',
      name: 'Fractional rate',
      description: null,
      active: true,
      taxable: true,
      purchaseRates: [{ taxRateQboId: 'RATE5_123456', taxTypeApplicable: 'TaxOnAmount' }],
    },
    {
      qboId: 'HIGH',
      name: 'High rate',
      description: null,
      active: true,
      taxable: true,
      purchaseRates: [{ taxRateQboId: 'RATE200', taxTypeApplicable: 'TaxOnAmount' }],
    },
    {
      qboId: 'PST7',
      name: 'PST 7%',
      description: null,
      active: true,
      taxable: true,
      purchaseRates: [{ taxRateQboId: 'RATE7', taxTypeApplicable: 'TaxOnAmount' }],
    },
    {
      qboId: 'VAT20',
      name: 'VAT 20%',
      description: null,
      active: true,
      taxable: true,
      purchaseRates: [{ taxRateQboId: 'RATE20', taxTypeApplicable: 'TaxOnAmount' }],
    },
    {
      qboId: 'ZERO_CODE',
      name: 'Zero rate',
      description: null,
      active: true,
      taxable: true,
      purchaseRates: [{ taxRateQboId: 'ZERO', taxTypeApplicable: 'TaxOnAmount' }],
    },
    {
      qboId: 'UNKNOWN_TAXABLE',
      name: 'Unknown taxable semantics',
      description: null,
      active: true,
      taxable: null,
      purchaseRates: [],
    },
    {
      qboId: 'CONTRADICTORY',
      name: 'Contradictory',
      description: null,
      active: true,
      taxable: false,
      purchaseRates: [{ taxRateQboId: 'RATE5', taxTypeApplicable: 'TaxOnAmount' }],
    },
    {
      qboId: 'WRONG_COMPONENT',
      name: 'Wrong component',
      description: null,
      active: true,
      taxable: true,
      purchaseRates: [{ taxRateQboId: 'RATE5', taxTypeApplicable: 'TaxOnTax' }],
    },
  ],
  rates: [
    { qboId: 'RATE5', name: 'GST 5%', description: null, active: true, rateValue: 5 },
    { qboId: 'RATE7', name: 'PST 7%', description: null, active: true, rateValue: 7 },
    { qboId: 'RATE20', name: 'VAT 20%', description: null, active: true, rateValue: 20 },
    { qboId: 'ZERO', name: 'Zero', description: null, active: true, rateValue: 0 },
    { qboId: 'RATE100', name: 'Full', description: null, active: true, rateValue: 100 },
    { qboId: 'RATE5_123456', name: 'Fractional', description: null, active: true, rateValue: 5.123456 },
    { qboId: 'RATE200', name: 'High', description: null, active: true, rateValue: 200 },
    { qboId: 'OLD_RATE', name: 'Old', description: null, active: false, rateValue: 5 },
  ],
};

describe('calculatePurchaseLine', () => {
  it.each([
    ['TaxExcluded', -10_00, -10_00, -50],
    ['TaxInclusive', -10_50, -10_00, -50],
    ['NotApplicable', -10_00, -10_00, 0],
  ] as const)('%s preserves signed gross accounting', (taxCalculation, grossCents, netCents, taxCents) => {
    expect(
      calculatePurchaseLine(
        {
          grossCents,
          taxCalculation,
          taxCodeQboId: taxCalculation === 'NotApplicable' ? 'OOS' : 'GST5',
        },
        reference,
      ),
    ).toEqual({ grossCents, netCents, taxCents });
  });

  it.each([
    [10, 1],
    [-10, -1],
  ])('rounds signed half-cent tax ties away from zero for %s cents', (grossCents, taxCents) => {
    expect(
      calculatePurchaseLine(
        { grossCents, taxCalculation: 'TaxExcluded', taxCodeQboId: 'GST5' },
        reference,
      ),
    ).toEqual({ grossCents, netCents: grossCents, taxCents });
  });

  it.each([
    [1, 1, 0],
    [-1, -1, 0],
  ])('keeps inclusive small amounts balanced for signed gross %s', (grossCents, netCents, taxCents) => {
    const result = calculatePurchaseLine(
      { grossCents, taxCalculation: 'TaxInclusive', taxCodeQboId: 'FULL' },
      reference,
    );

    expect(result).toEqual({ grossCents, netCents, taxCents });
    expect(result.netCents + result.taxCents).toBe(result.grossCents);
  });

  it('preserves six-decimal tax-rate precision', () => {
    expect(
      calculatePurchaseLine(
        { grossCents: 1_000_000, taxCalculation: 'TaxExcluded', taxCodeQboId: 'FRACTIONAL' },
        reference,
      ),
    ).toEqual({ grossCents: 1_000_000, netCents: 1_000_000, taxCents: 51_235 });
  });

  it('supports an active zero rate', () => {
    const zeroRateReference = {
      ...reference,
      codes: [{ ...reference.codes[0], qboId: 'ZERO_CODE', purchaseRates: [{ taxRateQboId: 'ZERO', taxTypeApplicable: 'TaxOnAmount' }] }],
    };

    expect(
      calculatePurchaseLine(
        { grossCents: -10_00, taxCalculation: 'TaxInclusive', taxCodeQboId: 'ZERO_CODE' },
        zeroRateReference,
      ),
    ).toEqual({ grossCents: -10_00, netCents: -10_00, taxCents: 0 });
  });

  it.each([
    ['missing code', 'MISSING', 'TaxExcluded', 'TAX_CODE_UNAVAILABLE'],
    ['inactive code', 'OLD', 'TaxExcluded', 'TAX_CODE_UNAVAILABLE'],
    ['compound rate', 'COMPOUND', 'TaxExcluded', 'TAX_RATE_UNSUPPORTED'],
    ['sales-only code', 'SALES_ONLY', 'TaxExcluded', 'TAX_RATE_UNSUPPORTED'],
    ['sales-only code marked not applicable', 'SALES_ONLY', 'NotApplicable', 'TAX_RATE_UNSUPPORTED'],
  ] as const)('fails closed for %s', (_name, taxCodeQboId, taxCalculation, code) => {
    expect(() =>
      calculatePurchaseLine({ grossCents: -10_00, taxCalculation, taxCodeQboId }, reference),
    ).toThrowError(new PurchaseTaxError(code));
  });

  it('fails closed for a missing or inactive rate', () => {
    expect(() =>
      calculatePurchaseLine(
        { grossCents: -10_00, taxCalculation: 'TaxExcluded', taxCodeQboId: 'GST5' },
        { ...reference, rates: [] },
      ),
    ).toThrowError(new PurchaseTaxError('TAX_RATE_UNAVAILABLE'));

    expect(() =>
      calculatePurchaseLine(
        { grossCents: -10_00, taxCalculation: 'TaxExcluded', taxCodeQboId: 'GST5' },
        { ...reference, rates: [{ qboId: 'RATE5', name: 'Old', description: null, active: false, rateValue: 5 }] },
      ),
    ).toThrowError(new PurchaseTaxError('TAX_RATE_UNAVAILABLE'));
  });

  it('rejects calculated cents outside the safe integer range', () => {
    expect(() =>
      calculatePurchaseLine(
        { grossCents: Number.MAX_SAFE_INTEGER, taxCalculation: 'TaxExcluded', taxCodeQboId: 'HIGH' },
        reference,
      ),
    ).toThrowError(new PurchaseTaxError('TAX_AMOUNT_INVALID'));
  });
});

describe('calculatePurchaseTransaction', () => {
  const companyId = 'company-1';
  const calculatePurchaseTransaction = (
    input: Omit<Parameters<typeof calculatePurchaseTransactionRaw>[0], 'companyId'>,
    scopedReference = reference,
  ) =>
    calculatePurchaseTransactionRaw(
      { ...input, companyId } as Parameters<typeof calculatePurchaseTransactionRaw>[0],
      { ...scopedReference, companyId } as Parameters<typeof calculatePurchaseTransactionRaw>[1],
    );

  it.each([
    ['purchase', -1, [-1, 0]],
    ['refund', 1, [1, 0]],
  ] as const)('rounds two excluded 5%% lines once for a %s', (_direction, taxCents, lineTaxes) => {
    const sign = taxCents < 0 ? -1 : 1;

    expect(
      calculatePurchaseTransaction(
        {
          taxCalculation: 'TaxExcluded',
          lines: [
            { grossCents: sign * 10, taxCodeQboId: 'GST5' },
            { grossCents: sign * 10, taxCodeQboId: 'GST5' },
          ],
        },
        reference,
      ),
    ).toMatchObject({
      eligible: true,
      grossCents: sign * 20,
      netCents: sign * 20,
      taxCents,
      lines: [
        { taxCents: lineTaxes[0], treatment: 'standard' },
        { taxCents: lineTaxes[1], treatment: 'standard' },
      ],
    });
  });

  it('aggregates excluded lines independently for each supported rate component', () => {
    expect(
      calculatePurchaseTransaction(
        {
          taxCalculation: 'TaxExcluded',
          lines: [
            { grossCents: -1_000, taxCodeQboId: 'GST5' },
            { grossCents: -2_000, taxCodeQboId: 'PST7' },
            { grossCents: -1_000, taxCodeQboId: 'GST5' },
          ],
        },
        reference,
      ),
    ).toMatchObject({
      eligible: true,
      taxCents: -240,
      lines: [{ taxCents: -50 }, { taxCents: -140 }, { taxCents: -50 }],
    });
  });

  it('back-calculates and balances inclusive tax per line', () => {
    const result = calculatePurchaseTransaction(
      {
        taxCalculation: 'TaxInclusive',
        lines: Array.from({ length: 5 }, () => ({ grossCents: -400, taxCodeQboId: 'VAT20' })),
      },
      reference,
    );

    expect(result).toMatchObject({
      eligible: true,
      grossCents: -2_000,
      netCents: -1_665,
      taxCents: -335,
      lines: Array.from({ length: 5 }, () => ({
        grossCents: -400,
        netCents: -333,
        taxCents: -67,
      })),
    });
    if (result.eligible) {
      expect(result.lines.every((line) => line.grossCents === line.netCents + line.taxCents)).toBe(true);
    }
  });

  it('distinguishes a proven zero rate from explicit exempt and out-of-scope input', () => {
    expect(
      calculatePurchaseTransaction(
        {
          taxCalculation: 'TaxExcluded',
          lines: [{ grossCents: -1_000, taxCodeQboId: 'ZERO_CODE' }],
        },
        reference,
      ),
    ).toMatchObject({
      eligible: true,
      taxCents: 0,
      lines: [{ treatment: 'zero_rated' }],
    });

    for (const nonTaxTreatment of ['exempt', 'out_of_scope'] as const) {
      expect(
        calculatePurchaseTransaction(
          {
            taxCalculation: 'NotApplicable',
            lines: [{ grossCents: -1_000, taxCodeQboId: 'OOS', nonTaxTreatment }],
          },
          reference,
        ),
      ).toMatchObject({
        eligible: true,
        taxCents: 0,
        lines: [{ treatment: nonTaxTreatment }],
      });
    }
  });

  it('supports explicitly exempt lines alongside taxable lines in an excluded transaction', () => {
    expect(
      calculatePurchaseTransaction(
        {
          taxCalculation: 'TaxExcluded',
          lines: [
            { grossCents: -1_000, taxCodeQboId: 'GST5' },
            { grossCents: -2_000, taxCodeQboId: 'OOS', nonTaxTreatment: 'exempt' },
          ],
        },
        reference,
      ),
    ).toMatchObject({
      eligible: true,
      taxCents: -50,
      lines: [
        { treatment: 'standard', taxCents: -50 },
        { treatment: 'exempt', taxCents: 0 },
      ],
    });
  });

  it.each([
    ['ambiguous non-tax treatment', 'OOS', 'NotApplicable', undefined, 'TAX_TREATMENT_AMBIGUOUS'],
    ['unknown code', 'MISSING', 'TaxExcluded', undefined, 'TAX_CODE_UNAVAILABLE'],
    ['inactive code', 'OLD', 'TaxExcluded', undefined, 'TAX_CODE_INACTIVE'],
    ['sales-only code', 'SALES_ONLY', 'TaxExcluded', undefined, 'TAX_CODE_SALES_ONLY'],
    ['compound code', 'COMPOUND', 'TaxExcluded', undefined, 'TAX_RATE_UNSUPPORTED'],
    ['unknown taxable semantics', 'UNKNOWN_TAXABLE', 'TaxExcluded', undefined, 'TAX_CODE_MALFORMED'],
    ['contradictory semantics', 'CONTRADICTORY', 'TaxExcluded', undefined, 'TAX_CODE_MALFORMED'],
    ['unsupported component', 'WRONG_COMPONENT', 'TaxExcluded', undefined, 'TAX_RATE_UNSUPPORTED'],
  ] as const)(
    'returns structured ineligibility for %s',
    (_case, taxCodeQboId, taxCalculation, nonTaxTreatment, reason) => {
      expect(
        calculatePurchaseTransaction(
          {
            taxCalculation,
            lines: [{ grossCents: -1_000, taxCodeQboId, nonTaxTreatment }],
          },
          reference,
        ),
      ).toEqual({ eligible: false, reason, lineIndex: 0 });
    },
  );

  it('returns structured ineligibility for malformed and incompatible rates', () => {
    expect(
      calculatePurchaseTransaction(
        {
          taxCalculation: 'TaxExcluded',
          lines: [{ grossCents: -1_000, taxCodeQboId: 'GST5' }],
        },
        { ...reference, rates: [{ ...reference.rates[0], rateValue: Number.NaN }] },
      ),
    ).toEqual({ eligible: false, reason: 'TAX_RATE_MALFORMED', lineIndex: 0 });

    expect(
      calculatePurchaseTransaction(
        {
          taxCalculation: 'TaxExcluded',
          lines: [{ grossCents: -1_000, taxCodeQboId: 'GST5' }],
        },
        { ...reference, rates: [{ ...reference.rates[0], active: false }] },
      ),
    ).toEqual({ eligible: false, reason: 'TAX_RATE_INACTIVE', lineIndex: 0 });

    expect(
      calculatePurchaseTransaction(
        {
          taxCalculation: 'TaxExcluded',
          lines: [{ grossCents: -1_000, taxCodeQboId: 'GST5' }],
        },
        { ...reference, rates: [{ ...reference.rates[0], rateValue: 1_000 }] },
      ),
    ).toEqual({ eligible: false, reason: 'TAX_RATE_MALFORMED', lineIndex: 0 });
  });

  it('does not throw when a normalized reference object is malformed at runtime', () => {
    expect(
      calculatePurchaseTransaction(
        {
          taxCalculation: 'TaxExcluded',
          lines: [{ grossCents: -1_000, taxCodeQboId: 'BROKEN' }],
        },
        {
          codes: [
            {
              qboId: 'BROKEN',
              name: 'Broken',
              description: null,
              active: true,
              taxable: true,
            } as never,
          ],
          rates: reference.rates,
        },
      ),
    ).toEqual({ eligible: false, reason: 'TAX_CODE_MALFORMED', lineIndex: 0 });
  });

  it('rejects empty runtime component and rate identities instead of skipping their tax', () => {
    expect(
      calculatePurchaseTransaction(
        {
          taxCalculation: 'TaxExcluded',
          lines: [{ grossCents: -1_000, taxCodeQboId: 'GST5' }],
        },
        {
          codes: [{
            ...reference.codes[0],
            purchaseRates: [{ taxRateQboId: '', taxTypeApplicable: 'TaxOnAmount' }],
          }],
          rates: [{ ...reference.rates[0], qboId: '' }],
        },
      ),
    ).toEqual({ eligible: false, reason: 'TAX_RATE_MALFORMED', lineIndex: 0 });

    expect(
      calculatePurchaseTransaction(
        {
          taxCalculation: 'TaxExcluded',
          lines: [{ grossCents: -1_000, taxCodeQboId: 'GST5' }],
        },
        {
          codes: [reference.codes[0]],
          rates: [{ ...reference.rates[0], qboId: '' }],
        },
      ),
    ).toEqual({ eligible: false, reason: 'TAX_RATE_MALFORMED', lineIndex: 0 });
  });

  it.each([
    ['foreign reference', 'company-1', 'company-2'],
    ['empty request company', '', 'company-1'],
    ['empty reference company', 'company-1', ' '],
  ])('rejects %s before using tax metadata', (_case, requestCompanyId, referenceCompanyId) => {
    expect(
      calculatePurchaseTransactionRaw(
        {
          companyId: requestCompanyId,
          taxCalculation: 'TaxExcluded',
          lines: [{ grossCents: -1_000, taxCodeQboId: 'GST5' }],
        } as never,
        { ...reference, companyId: referenceCompanyId } as never,
      ),
    ).toEqual({ eligible: false, reason: 'TAX_COMPANY_MISMATCH' });
  });
});
