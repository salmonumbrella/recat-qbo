import { Router } from 'express';
import type { ReceiptCompanySettingsDto } from '@recat/shared';
import { asyncHandler, HttpError, validate } from '../lib/http.js';
import { requireRole, requireUser } from '../middleware/auth.js';
import { withCompany } from '../middleware/company.js';
import {
  getReceiptSettings,
  receiptSettingsPatchSchema,
  ReceiptSettingError,
  updateReceiptSettings,
} from '../services/receipts/settings.js';

export const receiptSettingsRouter = Router({ mergeParams: true });
receiptSettingsRouter.use(requireUser, withCompany());

receiptSettingsRouter.get(
  '/',
  requireRole('viewer'),
  asyncHandler(async (req, res) => {
    res.json(
      (
        await getReceiptSettings(req.company!.id)
      ) satisfies ReceiptCompanySettingsDto,
    );
  }),
);

receiptSettingsRouter.patch(
  '/',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const patch = validate(receiptSettingsPatchSchema)(req.body);
    try {
      res.json(
        (
          await updateReceiptSettings(req.company!.id, patch)
        ) satisfies ReceiptCompanySettingsDto,
      );
    } catch (error) {
      if (error instanceof ReceiptSettingError) {
        throw new HttpError(
          400,
          'Invalid receipt processing settings.',
          error.code,
        );
      }
      throw error;
    }
  }),
);
