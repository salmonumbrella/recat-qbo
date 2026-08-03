import type {
  AttachmentInstanceStoragePolicyDto,
  AttachmentStoragePolicyDto,
} from '@recat/shared';
import { attachmentPolicyEnvManaged, env } from '../../env.js';
import { prisma } from '../../lib/prisma.js';
import {
  resolveAttachmentStoragePolicy,
  type AttachmentStoragePolicyDefaults,
} from './policy.js';
import { AttachmentError } from './types.js';

export const ATTACHMENT_POLICY_CONFIG_KEYS = Object.freeze({
  companyQuotaBytes: 'attachmentCompanyQuotaBytes',
  instanceQuotaBytes: 'attachmentInstanceQuotaBytes',
  retentionDays: 'attachmentRetentionDays',
});

export const ATTACHMENT_STORAGE_INSTANCE_LOCK = 7_314_646_946_693_590_089n;

export interface AttachmentPolicyConfigDb {
  appConfig: {
    findMany(args: {
      where: { key: { in: string[] } };
    }): Promise<Array<{ key: string; value: string }>>;
  };
}

interface AttachmentPolicyDb extends AttachmentPolicyConfigDb {
  company: {
    findUnique(args: {
      where: { id: string };
      select: { attachmentQuotaBytes: true; attachmentRetentionDays: true };
    }): Promise<{
      attachmentQuotaBytes: bigint | null;
      attachmentRetentionDays: number | null;
    } | null>;
  };
  attachmentBlob: {
    aggregate(args: {
      where: { state: 'READY'; companyId?: string };
      _sum: { sizeBytes: true };
    }): Promise<{ _sum: { sizeBytes: bigint | null } }>;
  };
}

function invalidPolicy(): never {
  throw new AttachmentError(
    'ATTACHMENT_POLICY_INVALID',
    'Attachment storage policy is invalid.',
  );
}

function storedBigInt(value: string | undefined, fallback: bigint): bigint {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) invalidPolicy();
  try {
    return BigInt(value);
  } catch {
    return invalidPolicy();
  }
}

function storedDays(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) invalidPolicy();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) invalidPolicy();
  return parsed;
}

function environmentDefaults(): AttachmentStoragePolicyDefaults {
  return {
    companyQuotaBytes: env.ATTACHMENT_COMPANY_QUOTA_BYTES,
    instanceQuotaBytes: env.ATTACHMENT_INSTANCE_QUOTA_BYTES,
    retentionDays: env.ATTACHMENT_RETENTION_DAYS,
  };
}

export async function getAttachmentStoragePolicyDefaults(
  db: AttachmentPolicyConfigDb = prisma as unknown as AttachmentPolicyConfigDb,
): Promise<AttachmentStoragePolicyDefaults> {
  const rows = await db.appConfig.findMany({
    where: { key: { in: Object.values(ATTACHMENT_POLICY_CONFIG_KEYS) } },
  });
  const stored = new Map(rows.map((row) => [row.key, row.value]));
  const fallback = environmentDefaults();
  const defaults = {
    companyQuotaBytes: attachmentPolicyEnvManaged.companyQuotaBytes
      ? fallback.companyQuotaBytes
      : storedBigInt(
          stored.get(ATTACHMENT_POLICY_CONFIG_KEYS.companyQuotaBytes),
          fallback.companyQuotaBytes,
        ),
    instanceQuotaBytes: attachmentPolicyEnvManaged.instanceQuotaBytes
      ? fallback.instanceQuotaBytes
      : storedBigInt(
          stored.get(ATTACHMENT_POLICY_CONFIG_KEYS.instanceQuotaBytes),
          fallback.instanceQuotaBytes,
        ),
    retentionDays: attachmentPolicyEnvManaged.retentionDays
      ? fallback.retentionDays
      : storedDays(
          stored.get(ATTACHMENT_POLICY_CONFIG_KEYS.retentionDays),
          fallback.retentionDays,
        ),
  };
  return resolveAttachmentStoragePolicy({
    attachmentQuotaBytes: null,
    attachmentRetentionDays: null,
  }, defaults);
}

export async function getAttachmentStoragePolicyDto(
  companyId: string,
  db: AttachmentPolicyDb = prisma as unknown as AttachmentPolicyDb,
): Promise<AttachmentStoragePolicyDto | null> {
  const [company, defaults, companyUsage, instanceUsage] = await Promise.all([
    db.company.findUnique({
      where: { id: companyId },
      select: { attachmentQuotaBytes: true, attachmentRetentionDays: true },
    }),
    getAttachmentStoragePolicyDefaults(db),
    db.attachmentBlob.aggregate({
      where: { state: 'READY', companyId },
      _sum: { sizeBytes: true },
    }),
    db.attachmentBlob.aggregate({
      where: { state: 'READY' },
      _sum: { sizeBytes: true },
    }),
  ]);
  if (company === null) return null;
  const effective = resolveAttachmentStoragePolicy(company, defaults);
  return {
    companyQuotaBytes: effective.companyQuotaBytes.toString(),
    instanceQuotaBytes: effective.instanceQuotaBytes.toString(),
    companyUsageBytes: (companyUsage._sum.sizeBytes ?? 0n).toString(),
    instanceUsageBytes: (instanceUsage._sum.sizeBytes ?? 0n).toString(),
    retentionDays: effective.retentionDays,
    companyQuotaOverrideBytes: company.attachmentQuotaBytes?.toString() ?? null,
    companyRetentionOverrideDays: company.attachmentRetentionDays,
  };
}

export async function getAttachmentInstanceStoragePolicyDto(
  db: AttachmentPolicyDb = prisma as unknown as AttachmentPolicyDb,
): Promise<AttachmentInstanceStoragePolicyDto> {
  const [defaults, usage] = await Promise.all([
    getAttachmentStoragePolicyDefaults(db),
    db.attachmentBlob.aggregate({
      where: { state: 'READY' },
      _sum: { sizeBytes: true },
    }),
  ]);
  return {
    companyQuotaBytes: defaults.companyQuotaBytes.toString(),
    instanceQuotaBytes: defaults.instanceQuotaBytes.toString(),
    instanceUsageBytes: (usage._sum.sizeBytes ?? 0n).toString(),
    retentionDays: defaults.retentionDays,
    companyQuotaFromEnv: attachmentPolicyEnvManaged.companyQuotaBytes,
    instanceQuotaFromEnv: attachmentPolicyEnvManaged.instanceQuotaBytes,
    retentionFromEnv: attachmentPolicyEnvManaged.retentionDays,
  };
}
