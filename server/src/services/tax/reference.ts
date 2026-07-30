import { isUsableTaxCodeDto, type TaxReadinessDto, type TaxSupportStatus } from '@recat/shared';
import type { QboClient, QboTaxCodeInfo, QboTaxProfile, QboTaxRateInfo } from '../../lib/qbo/types.js';
import { isSupportedTaxRateValue } from '../../lib/qbo/purchaseTax.js';
import { lockCompanyMutationScope } from '../companyMutationScope.js';

export const TAX_REFERENCE_TTL_MS = 24 * 60 * 60 * 1000;

const REFRESH_FAILURE_REASON = 'Tax reference refresh failed.';

type TaxReferenceCompany = {
  id: string;
  taxReferenceRefreshedAt: Date | null;
  taxUsingSalesTax: boolean | null;
  taxSupportStatus: string;
  taxSupportReason: string | null;
};

type TaxRateRow = {
  qboId: string;
  name: string;
  description: string | null;
  active: boolean;
  rateValue: number | string | { toString(): string };
  sourceUpdatedAt: Date | null;
};

type TaxCodeRow = {
  qboId: string;
  name: string;
  description: string | null;
  active: boolean;
  taxable: boolean | null;
  purchaseTaxRateList: unknown;
  combinedPurchaseRate: number | string | { toString(): string } | null;
  sourceUpdatedAt: Date | null;
};

export interface TaxReadinessQueryDb {
  company: {
    findUniqueOrThrow(args: { where: { id: string } }): Promise<TaxReferenceCompany>;
  };
  qboTaxCode: {
    findMany(args: {
      where: { companyId: string };
      orderBy: { qboId: 'asc' };
    }): Promise<TaxCodeRow[]>;
  };
}

type TaxCacheModel = {
  findMany(args: { where: { companyId: string }; orderBy?: { qboId: 'asc' } }): Promise<TaxRateRow[] | TaxCodeRow[]>;
  upsert(args: {
    where: { companyId_qboId: { companyId: string; qboId: string } };
    create: Record<string, unknown>;
    update: Record<string, unknown>;
  }): Promise<unknown>;
  updateMany(args: {
    where: { companyId: string; qboId?: { notIn: string[] } };
    data: { active: boolean };
  }): Promise<unknown>;
};

export interface TaxReferenceDb {
  company: {
    findUniqueOrThrow(args: { where: { id: string } }): Promise<TaxReferenceCompany>;
    update(args: {
      where: { id: string };
      data: {
        taxReferenceRefreshedAt?: Date;
        taxUsingSalesTax?: boolean | null;
        taxSupportStatus: string;
        taxSupportReason: string | null;
      };
    }): Promise<unknown>;
  };
  qboTaxRate: TaxCacheModel;
  qboTaxCode: TaxCacheModel;
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $transaction<T>(
    callback: (tx: TaxReferenceDb) => Promise<T>,
    options?: { isolationLevel: 'RepeatableRead' },
  ): Promise<T>;
}

export interface TaxReferenceDeps {
  db: TaxReferenceDb;
  getClient(companyId: string): Promise<Pick<QboClient, 'getTaxProfile' | 'listTaxCodes' | 'listTaxRates'>>;
  now(): Date;
}

export interface RefreshedTaxReference {
  readiness: TaxReadinessDto;
  refreshed: boolean;
}

type PurchaseCodeSupport = { supported: boolean; combinedPurchaseRate: number | null };

const inFlightRefreshes = new Map<string, Promise<RefreshedTaxReference>>();

function purchaseCodeSupport(code: QboTaxCodeInfo, ratesById: Map<string, QboTaxRateInfo>): PurchaseCodeSupport {
  if (!code.active || !Array.isArray(code.purchaseRates)) {
    return { supported: false, combinedPurchaseRate: null };
  }
  if (code.taxable === false && code.purchaseRates.length === 0) {
    return { supported: true, combinedPurchaseRate: null };
  }
  if (code.taxable !== true) return { supported: false, combinedPurchaseRate: null };
  if (code.purchaseRates.length !== 1) return { supported: false, combinedPurchaseRate: null };

  const [component] = code.purchaseRates;
  if (!component) return { supported: false, combinedPurchaseRate: null };
  const rate = ratesById.get(component.taxRateQboId);
  if (!rate || !rate.active || component.taxTypeApplicable !== 'TaxOnAmount' || !isSupportedTaxRateValue(rate.rateValue)) {
    return { supported: false, combinedPurchaseRate: null };
  }
  return { supported: true, combinedPurchaseRate: rate.rateValue };
}

function readinessStatus(
  profile: QboTaxProfile,
  codes: QboTaxCodeInfo[],
  ratesById: Map<string, QboTaxRateInfo>,
): { status: TaxSupportStatus; reason: string | null } {
  if (profile.usingSalesTax === null) {
    return { status: 'needs_setup', reason: 'QuickBooks tax preferences are malformed.' };
  }
  if (profile.usingSalesTax === false) {
    return { status: 'unsupported', reason: 'Sales tax is disabled in QuickBooks.' };
  }
  if (!codes.some((code) => purchaseCodeSupport(code, ratesById).supported)) {
    return { status: 'needs_setup', reason: 'No supported active purchase tax codes were found in QuickBooks.' };
  }
  return { status: 'ready', reason: null };
}

function validatedReferencedRates(codes: QboTaxCodeInfo[], rates: QboTaxRateInfo[]): Map<string, QboTaxRateInfo> {
  const allRatesById = new Map(rates.map((rate) => [rate.qboId, rate]));
  const referencedRates = new Map<string, QboTaxRateInfo>();
  for (const code of codes) {
    for (const component of code.purchaseRates) {
      const rate = allRatesById.get(component.taxRateQboId);
      if (!rate) {
        throw new Error(`Tax code ${code.qboId} references an unknown tax rate.`);
      }
      if (!isSupportedTaxRateValue(rate.rateValue)) {
        throw new Error(`Unsupported tax rate metadata for ${rate.qboId}.`);
      }
      referencedRates.set(rate.qboId, rate);
    }
  }
  return referencedRates;
}

async function replaceTaxCache(
  db: TaxReferenceDb,
  companyId: string,
  profile: QboTaxProfile,
  codes: QboTaxCodeInfo[],
  rates: QboTaxRateInfo[],
  refreshedAt: Date,
): Promise<void> {
  const ratesById = validatedReferencedRates(codes, rates);
  const readiness = readinessStatus(profile, codes, ratesById);

  await db.$transaction(async (tx) => {
    await lockCompanyMutationScope(tx, companyId);
    await tx.$queryRawUnsafe(
      `SELECT "id"
         FROM "Company"
        WHERE "id" = $1
        FOR UPDATE`,
      companyId,
    );
    for (const rate of ratesById.values()) {
      const data = {
        name: rate.name,
        description: rate.description,
        active: rate.active,
        rateValue: rate.rateValue,
        sourceUpdatedAt: rate.sourceUpdatedAt === null ? null : new Date(rate.sourceUpdatedAt),
      };
      await tx.qboTaxRate.upsert({
        where: { companyId_qboId: { companyId, qboId: rate.qboId } },
        create: { companyId, qboId: rate.qboId, ...data },
        update: data,
      });
    }
    const rateIds = [...ratesById.keys()];
    await tx.qboTaxRate.updateMany({
      where: rateIds.length > 0 ? { companyId, qboId: { notIn: rateIds } } : { companyId },
      data: { active: false },
    });

    for (const code of codes) {
      const support = purchaseCodeSupport(code, ratesById);
      const data = {
        name: code.name,
        description: code.description,
        active: code.active,
        taxable: code.taxable,
        purchaseTaxRateList: code.purchaseRates,
        combinedPurchaseRate: support.combinedPurchaseRate,
        sourceUpdatedAt: code.sourceUpdatedAt === null ? null : new Date(code.sourceUpdatedAt),
      };
      await tx.qboTaxCode.upsert({
        where: { companyId_qboId: { companyId, qboId: code.qboId } },
        create: { companyId, qboId: code.qboId, ...data },
        update: data,
      });
    }
    const codeIds = codes.map((code) => code.qboId);
    await tx.qboTaxCode.updateMany({
      where: codeIds.length > 0 ? { companyId, qboId: { notIn: codeIds } } : { companyId },
      data: { active: false },
    });
    await tx.company.update({
      where: { id: companyId },
      data: {
        taxReferenceRefreshedAt: refreshedAt,
        taxUsingSalesTax: profile.usingSalesTax,
        taxSupportStatus: readiness.status,
        taxSupportReason: readiness.reason,
      },
    });
  });
}

function taxCodesForReadiness(rows: TaxCodeRow[]): TaxReadinessDto['taxCodes'] {
  return rows.filter((row) => {
    if (!row.active || !Array.isArray(row.purchaseTaxRateList)) return false;
    if (row.taxable === false) {
      return row.purchaseTaxRateList.length === 0 && row.combinedPurchaseRate === null;
    }
    return (
      row.taxable === true &&
      row.purchaseTaxRateList.length === 1 &&
      row.combinedPurchaseRate !== null &&
      isSupportedTaxRateValue(Number(row.combinedPurchaseRate))
    );
  }).map((row) => ({
    qboId: row.qboId,
    name: row.name,
    active: row.active,
    taxable: row.taxable,
    combinedPurchaseRate: row.combinedPurchaseRate === null ? null : Number(row.combinedPurchaseRate),
  })).filter(isUsableTaxCodeDto);
}

async function getCachedReference(companyId: string, db: TaxReferenceDb): Promise<TaxReadinessDto> {
  return db.$transaction(
    (tx) => getTaxReadinessInTransaction(companyId, tx as unknown as TaxReadinessQueryDb),
    { isolationLevel: 'RepeatableRead' },
  );
}

/** Reads cached tax readiness inside an already-open transaction without nesting one. */
export async function getTaxReadinessInTransaction(
  companyId: string,
  db: TaxReadinessQueryDb,
): Promise<TaxReadinessDto> {
  const [company, codeRows] = await Promise.all([
    db.company.findUniqueOrThrow({ where: { id: companyId } }),
    db.qboTaxCode.findMany({ where: { companyId }, orderBy: { qboId: 'asc' } }),
  ]);
  return {
    status: company.taxSupportStatus as TaxSupportStatus,
    reason: company.taxSupportReason,
    usingSalesTax: company.taxUsingSalesTax,
    refreshedAt: company.taxReferenceRefreshedAt?.toISOString() ?? null,
    taxCodes: taxCodesForReadiness(codeRows),
  };
}

async function recordRefreshFailure(db: TaxReferenceDb, companyId: string): Promise<void> {
  await db.company.update({
    where: { id: companyId },
    data: { taxSupportStatus: 'needs_setup', taxSupportReason: REFRESH_FAILURE_REASON },
  });
}

async function defaultTaxReferenceDeps(): Promise<TaxReferenceDeps> {
  const [{ prisma }, { qboFactory }] = await Promise.all([
    import('../../lib/prisma.js'),
    import('../../lib/qbo/factory.js'),
  ]);
  return {
    db: prisma as unknown as TaxReferenceDb,
    getClient: (companyId) => qboFactory.forCompany(companyId),
    now: () => new Date(),
  };
}

async function runTaxReferenceRefresh(
  companyId: string,
  options: { force?: boolean } = {},
  deps?: TaxReferenceDeps,
): Promise<RefreshedTaxReference> {
  const resolvedDeps = deps ?? (await defaultTaxReferenceDeps());
  const company = await resolvedDeps.db.company.findUniqueOrThrow({ where: { id: companyId } });
  const now = resolvedDeps.now();
  if (
    !options.force &&
    company.taxReferenceRefreshedAt !== null &&
    now.getTime() - company.taxReferenceRefreshedAt.getTime() < TAX_REFERENCE_TTL_MS
  ) {
    return { readiness: await getCachedReference(companyId, resolvedDeps.db), refreshed: false };
  }

  try {
    const client = await resolvedDeps.getClient(companyId);
    const [profile, codes, rates] = await Promise.all([
      client.getTaxProfile(),
      client.listTaxCodes(),
      client.listTaxRates(),
    ]);
    await replaceTaxCache(resolvedDeps.db, companyId, profile, codes, rates, now);
    return { readiness: await getCachedReference(companyId, resolvedDeps.db), refreshed: true };
  } catch (error) {
    await recordRefreshFailure(resolvedDeps.db, companyId).catch(() => undefined);
    throw error;
  }
}

export function refreshTaxReference(
  companyId: string,
  options: { force?: boolean } = {},
  deps?: TaxReferenceDeps,
): Promise<RefreshedTaxReference> {
  const previous = inFlightRefreshes.get(companyId) ?? Promise.resolve();
  const run = previous.then(
    () => runTaxReferenceRefresh(companyId, options, deps),
    () => runTaxReferenceRefresh(companyId, options, deps),
  );
  inFlightRefreshes.set(companyId, run);
  run
    .catch(() => undefined)
    .finally(() => {
      if (inFlightRefreshes.get(companyId) === run) inFlightRefreshes.delete(companyId);
    });
  return run;
}

export async function getTaxReadiness(
  companyId: string,
  deps?: TaxReferenceDeps,
): Promise<TaxReadinessDto> {
  return getCachedReference(companyId, (deps ?? (await defaultTaxReferenceDeps())).db);
}
