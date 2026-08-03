import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_POLICY_BOUNDS,
  DEFAULT_ATTACHMENT_STORAGE_POLICY,
  attachmentRetentionDeadline,
  resolveAttachmentStoragePolicy,
} from './policy.js';
import { getAttachmentStoragePolicyDefaults } from './policyStore.js';

describe('attachment storage policy', () => {
  it('uses finite conservative defaults', () => {
    expect(DEFAULT_ATTACHMENT_STORAGE_POLICY).toEqual({
      companyQuotaBytes: 1_073_741_824n,
      instanceQuotaBytes: 10_737_418_240n,
      retentionDays: 365,
    });
  });

  it('applies nullable company overrides', () => {
    expect(resolveAttachmentStoragePolicy({
      attachmentQuotaBytes: 2_147_483_648n,
      attachmentRetentionDays: 90,
    })).toEqual({
      companyQuotaBytes: 2_147_483_648n,
      instanceQuotaBytes: 10_737_418_240n,
      retentionDays: 90,
    });
    expect(resolveAttachmentStoragePolicy({
      attachmentQuotaBytes: null,
      attachmentRetentionDays: null,
    })).toEqual(DEFAULT_ATTACHMENT_STORAGE_POLICY);
  });

  it('accepts exact bounds and rejects values one step outside them', () => {
    const bounds = ATTACHMENT_POLICY_BOUNDS;
    expect(() => resolveAttachmentStoragePolicy({
      attachmentQuotaBytes: bounds.companyQuotaMinBytes,
      attachmentRetentionDays: bounds.retentionMinDays,
    }, {
      companyQuotaBytes: bounds.companyQuotaMinBytes,
      instanceQuotaBytes: bounds.instanceQuotaMinBytes,
      retentionDays: bounds.retentionMaxDays,
    })).not.toThrow();
    expect(() => resolveAttachmentStoragePolicy({
      attachmentQuotaBytes: bounds.companyQuotaMinBytes - 1n,
      attachmentRetentionDays: bounds.retentionMinDays,
    })).toThrowError(expect.objectContaining({ code: 'ATTACHMENT_POLICY_INVALID' }));
    expect(() => resolveAttachmentStoragePolicy({
      attachmentQuotaBytes: bounds.companyQuotaMaxBytes + 1n,
      attachmentRetentionDays: bounds.retentionMaxDays,
    })).toThrowError(expect.objectContaining({ code: 'ATTACHMENT_POLICY_INVALID' }));
    expect(() => resolveAttachmentStoragePolicy({
      attachmentQuotaBytes: null,
      attachmentRetentionDays: bounds.retentionMaxDays + 1,
    })).toThrowError(expect.objectContaining({ code: 'ATTACHMENT_POLICY_INVALID' }));
  });

  it('rejects an instance limit below the effective company limit', () => {
    expect(() => resolveAttachmentStoragePolicy({
      attachmentQuotaBytes: 2_000_000n,
      attachmentRetentionDays: 30,
    }, {
      companyQuotaBytes: 2_000_000n,
      instanceQuotaBytes: 1_999_999n,
      retentionDays: 30,
    })).toThrowError(expect.objectContaining({ code: 'ATTACHMENT_POLICY_INVALID' }));
  });

  it('computes an exact UTC retention deadline without mutating the input', () => {
    const now = new Date('2026-08-02T12:34:56.789Z');
    expect(attachmentRetentionDeadline(now, 30).toISOString())
      .toBe('2026-09-01T12:34:56.789Z');
    expect(now.toISOString()).toBe('2026-08-02T12:34:56.789Z');
  });

  it('uses validated AppConfig defaults when environment overrides are absent', async () => {
    const defaults = await getAttachmentStoragePolicyDefaults({
      appConfig: {
        findMany: async () => [
          { key: 'attachmentCompanyQuotaBytes', value: '2097152' },
          { key: 'attachmentInstanceQuotaBytes', value: '4194304' },
          { key: 'attachmentRetentionDays', value: '30' },
        ],
      },
    });

    expect(defaults).toEqual({
      companyQuotaBytes: 2_097_152n,
      instanceQuotaBytes: 4_194_304n,
      retentionDays: 30,
    });
  });

  it('fails closed on malformed persisted configuration', async () => {
    await expect(getAttachmentStoragePolicyDefaults({
      appConfig: {
        findMany: async () => [
          { key: 'attachmentCompanyQuotaBytes', value: '1e9' },
        ],
      },
    })).rejects.toMatchObject({ code: 'ATTACHMENT_POLICY_INVALID' });
  });
});
