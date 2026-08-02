import { AttachmentError } from './types.js';

const MIB = 1024n * 1024n;
const GIB = 1024n * MIB;
const TIB = 1024n * GIB;
const DAY_MS = 24 * 60 * 60 * 1000;

export const ATTACHMENT_POLICY_BOUNDS = Object.freeze({
  companyQuotaMinBytes: MIB,
  companyQuotaMaxBytes: TIB,
  instanceQuotaMinBytes: MIB,
  instanceQuotaMaxBytes: 10n * TIB,
  retentionMinDays: 1,
  retentionMaxDays: 3650,
});

export interface AttachmentStoragePolicyDefaults {
  readonly companyQuotaBytes: bigint;
  readonly instanceQuotaBytes: bigint;
  readonly retentionDays: number;
}

export interface AttachmentStoragePolicyOverrides {
  readonly attachmentQuotaBytes: bigint | null;
  readonly attachmentRetentionDays: number | null;
}

export interface AttachmentStoragePolicy {
  readonly companyQuotaBytes: bigint;
  readonly instanceQuotaBytes: bigint;
  readonly retentionDays: number;
}

export const DEFAULT_ATTACHMENT_STORAGE_POLICY: AttachmentStoragePolicyDefaults =
  Object.freeze({
    companyQuotaBytes: GIB,
    instanceQuotaBytes: 10n * GIB,
    retentionDays: 365,
  });

function invalidPolicy(): never {
  throw new AttachmentError(
    'ATTACHMENT_POLICY_INVALID',
    'Attachment storage policy is invalid.',
  );
}

function boundedBytes(value: bigint, minimum: bigint, maximum: bigint): bigint {
  if (typeof value !== 'bigint' || value < minimum || value > maximum) {
    invalidPolicy();
  }
  return value;
}

function boundedDays(value: number): number {
  if (
    !Number.isSafeInteger(value)
    || value < ATTACHMENT_POLICY_BOUNDS.retentionMinDays
    || value > ATTACHMENT_POLICY_BOUNDS.retentionMaxDays
  ) {
    invalidPolicy();
  }
  return value;
}

export function resolveAttachmentStoragePolicy(
  company: AttachmentStoragePolicyOverrides,
  defaults: AttachmentStoragePolicyDefaults = DEFAULT_ATTACHMENT_STORAGE_POLICY,
): AttachmentStoragePolicy {
  const defaultCompanyQuota = boundedBytes(
    defaults.companyQuotaBytes,
    ATTACHMENT_POLICY_BOUNDS.companyQuotaMinBytes,
    ATTACHMENT_POLICY_BOUNDS.companyQuotaMaxBytes,
  );
  const instanceQuotaBytes = boundedBytes(
    defaults.instanceQuotaBytes,
    ATTACHMENT_POLICY_BOUNDS.instanceQuotaMinBytes,
    ATTACHMENT_POLICY_BOUNDS.instanceQuotaMaxBytes,
  );
  const companyQuotaBytes = company.attachmentQuotaBytes === null
    ? defaultCompanyQuota
    : boundedBytes(
        company.attachmentQuotaBytes,
        ATTACHMENT_POLICY_BOUNDS.companyQuotaMinBytes,
        ATTACHMENT_POLICY_BOUNDS.companyQuotaMaxBytes,
      );
  const retentionDays = boundedDays(
    company.attachmentRetentionDays ?? defaults.retentionDays,
  );
  if (instanceQuotaBytes < companyQuotaBytes) invalidPolicy();
  return { companyQuotaBytes, instanceQuotaBytes, retentionDays };
}

export function attachmentRetentionDeadline(now: Date, retentionDays: number): Date {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) invalidPolicy();
  const days = boundedDays(retentionDays);
  const deadline = new Date(now.getTime() + days * DAY_MS);
  if (!Number.isFinite(deadline.getTime())) invalidPolicy();
  return deadline;
}
