// Read-only purchase-tax reference endpoints. The cached QBO reference remains
// complete internally; HTTP responses deliberately expose only a bounded slice.

import { Router } from 'express';
import { isUsableTaxCodeDto, type TaxReadinessDto } from '@recat/shared';
import { asyncHandler } from '../lib/http.js';
import { requireRole, requireUser } from '../middleware/auth.js';
import { withCompany } from '../middleware/company.js';
import {
  getTaxReadiness,
  refreshTaxReference,
} from '../services/tax/reference.js';

export const TAX_CODE_RESPONSE_LIMIT = 100;

function boundedReadiness(readiness: TaxReadinessDto): TaxReadinessDto {
  return {
    ...readiness,
    taxCodes: readiness.taxCodes.filter(isUsableTaxCodeDto).slice(0, TAX_CODE_RESPONSE_LIMIT),
  };
}

export const taxRouter = Router({ mergeParams: true });
taxRouter.use(requireUser);

taxRouter.get(
  '/',
  withCompany({ allowDisconnected: true }),
  requireRole('viewer'),
  asyncHandler(async (req, res) => {
    res.json(boundedReadiness(await getTaxReadiness(req.company!.id)));
  }),
);

taxRouter.post(
  '/refresh',
  withCompany(),
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const result = await refreshTaxReference(req.company!.id, { force: true });
    res.json({ ...result, readiness: boundedReadiness(result.readiness) });
  }),
);
