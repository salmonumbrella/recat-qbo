// Read-only purchase-tax reference endpoints. The cached QBO reference remains
// complete internally; HTTP responses deliberately expose only a bounded slice.

import { Router } from 'express';
import { asyncHandler } from '../lib/http.js';
import { requireRole, requireUser } from '../middleware/auth.js';
import { withCompany } from '../middleware/company.js';
import {
  getTaxReadiness,
  refreshTaxReference,
} from '../services/tax/reference.js';
import { boundedTaxReadiness } from '../services/companyReads.js';

export const TAX_CODE_RESPONSE_LIMIT = 100;

export const taxRouter = Router({ mergeParams: true });
taxRouter.use(requireUser);

taxRouter.get(
  '/',
  withCompany({ allowDisconnected: true }),
  requireRole('viewer'),
  asyncHandler(async (req, res) => {
    res.json(boundedTaxReadiness(await getTaxReadiness(req.company!.id), TAX_CODE_RESPONSE_LIMIT));
  }),
);

taxRouter.post(
  '/refresh',
  withCompany(),
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const result = await refreshTaxReference(req.company!.id, { force: true });
    res.json({
      ...result,
      readiness: boundedTaxReadiness(result.readiness, TAX_CODE_RESPONSE_LIMIT),
    });
  }),
);
