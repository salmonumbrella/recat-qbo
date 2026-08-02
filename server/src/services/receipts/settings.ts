import { createHash } from 'node:crypto';
import type { ReceiptCompanySettingsDto, SuggestionProvider } from '@recat/shared';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { runSerializableTransaction } from '../../lib/serializableTransaction.js';
import {
  getInstanceSettings,
  type InstanceSettingsDb,
} from '../instanceSettings.js';

const MODEL_MAX_LENGTH = 200;

export const receiptSettingsPatchSchema = z.object({
  enabled: z.boolean().optional(),
  provider: z.enum(['custom', 'openrouter']).optional(),
  model: z.string().trim().min(1).max(MODEL_MAX_LENGTH).optional(),
  confidenceThreshold: z.number().min(0).max(1).optional(),
  autoMatchThreshold: z.number().int().min(0).max(100).optional(),
  autoMatchMargin: z.number().int().min(0).max(100).optional(),
  maxPages: z.number().int().min(1).max(50).optional(),
}).strict();

export type ReceiptSettingsPatch = z.input<typeof receiptSettingsPatchSchema>;

type ReceiptSettingsWithoutVersion = Omit<
  ReceiptCompanySettingsDto,
  'configVersion'
>;

export const DEFAULT_RECEIPT_SETTINGS: Readonly<ReceiptSettingsWithoutVersion> = {
  enabled: false,
  provider: 'openrouter',
  model: 'openai/gpt-4o-mini',
  confidenceThreshold: 0.8,
  autoMatchThreshold: 85,
  autoMatchMargin: 15,
  maxPages: 20,
};

export function receiptSettingsVersion(
  settings: ReceiptSettingsWithoutVersion,
): string {
  const canonical = JSON.stringify({
    version: 1,
    enabled: settings.enabled,
    provider: settings.provider,
    model: settings.model,
    confidenceThreshold: settings.confidenceThreshold,
    autoMatchThreshold: settings.autoMatchThreshold,
    autoMatchMargin: settings.autoMatchMargin,
    maxPages: settings.maxPages,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export const DEFAULT_RECEIPT_CONFIG_VERSION = receiptSettingsVersion(
  DEFAULT_RECEIPT_SETTINGS,
);

export interface ReceiptCompanyConfigRow {
  companyId: string;
  enabled: boolean;
  provider: string;
  model: string;
  confidenceThreshold: unknown;
  autoMatchThreshold: number;
  autoMatchMargin: number;
  maxPages: number;
  configVersion: string;
}

type ReceiptCompanyConfigData = Omit<
  ReceiptCompanyConfigRow,
  'confidenceThreshold'
> & { confidenceThreshold: number };

export interface ReceiptSettingsDb {
  receiptCompanyConfig: {
    findUnique(args: {
      where: { companyId: string };
    }): Promise<ReceiptCompanyConfigRow | null>;
    upsert(args: {
      where: { companyId: string };
      create: ReceiptCompanyConfigData;
      update: Omit<ReceiptCompanyConfigData, 'companyId'>;
    }): Promise<ReceiptCompanyConfigRow>;
  };
}

export interface ReceiptProviderInstanceSettings {
  aiEndpoint: string;
  aiApiKey: string;
  openrouterApiKey: string;
  openrouterReferer: string;
  openrouterTitle: string;
}

export interface ReceiptSettingsReadDeps {
  db: ReceiptSettingsDb;
  getInstanceSettings(
    db?: InstanceSettingsDb,
  ): Promise<ReceiptProviderInstanceSettings>;
}

export interface ReceiptSettingsDeps extends ReceiptSettingsReadDeps {
  withSerializableTransaction<T>(
    callback: (db: ReceiptSettingsDb) => Promise<T>,
  ): Promise<T>;
}

export interface ResolvedReceiptProvider {
  settings: ReceiptCompanySettingsDto;
  apiBase: string;
  apiKey: string;
  headers: Record<string, string>;
}

const defaultDeps: ReceiptSettingsDeps = {
  db: prisma as unknown as ReceiptSettingsDb,
  getInstanceSettings,
  withSerializableTransaction: (callback) => runSerializableTransaction(
    prisma,
    (transaction) => callback(
      transaction as unknown as ReceiptSettingsDb,
    ),
  ),
};

export class ReceiptSettingError extends Error {
  readonly code = 'RECEIPT_SETTING_INVALID';

  constructor(message = 'Invalid receipt processing settings.') {
    super(message);
    this.name = 'ReceiptSettingError';
  }
}

export async function getReceiptSettings(
  companyId: string,
  deps: ReceiptSettingsReadDeps = defaultDeps,
): Promise<ReceiptCompanySettingsDto> {
  assertCompanyId(companyId);
  const row = await deps.db.receiptCompanyConfig.findUnique({
    where: { companyId },
  });
  if (row !== null) return toDto(row);
  return {
    ...DEFAULT_RECEIPT_SETTINGS,
    configVersion: DEFAULT_RECEIPT_CONFIG_VERSION,
  };
}

export async function updateReceiptSettings(
  companyId: string,
  patch: ReceiptSettingsPatch,
  deps: ReceiptSettingsDeps = defaultDeps,
): Promise<ReceiptCompanySettingsDto> {
  assertCompanyId(companyId);
  const parsed = receiptSettingsPatchSchema.safeParse(patch);
  if (!parsed.success) throw invalid();

  return deps.withSerializableTransaction(async (db) => {
    const [row, instance] = await Promise.all([
      db.receiptCompanyConfig.findUnique({ where: { companyId } }),
      deps.getInstanceSettings(db as unknown as InstanceSettingsDb),
    ]);
    const current = row === null
      ? { ...DEFAULT_RECEIPT_SETTINGS }
      : withoutVersion(toDto(row));
    const next: ReceiptSettingsWithoutVersion = {
      ...current,
      ...parsed.data,
    };
    validateSettings(next);
    if (next.enabled) validateProvider(next.provider, instance);

    const configVersion = receiptSettingsVersion(next);
    const data: ReceiptCompanyConfigData = {
      companyId,
      ...next,
      configVersion,
    };
    const stored = await db.receiptCompanyConfig.upsert({
      where: { companyId },
      create: data,
      update: withoutCompanyId(data),
    });
    return toDto(stored);
  });
}

export async function resolveReceiptProvider(
  companyId: string,
  deps: ReceiptSettingsReadDeps = defaultDeps,
): Promise<ResolvedReceiptProvider> {
  const [settings, instance] = await Promise.all([
    getReceiptSettings(companyId, deps),
    deps.getInstanceSettings(),
  ]);
  if (!settings.enabled) {
    return {
      settings,
      apiBase: '',
      apiKey: '',
      headers: {},
    };
  }
  validateProvider(settings.provider, instance);

  if (settings.provider === 'openrouter') {
    return {
      settings,
      apiBase: 'https://openrouter.ai/api/v1',
      apiKey: instance.openrouterApiKey,
      headers: {
        ...(instance.openrouterReferer === ''
          ? {}
          : { 'HTTP-Referer': instance.openrouterReferer }),
        ...(instance.openrouterTitle === ''
          ? {}
          : { 'X-Title': instance.openrouterTitle }),
      },
    };
  }
  return {
    settings,
    apiBase: instance.aiEndpoint,
    apiKey: instance.aiApiKey,
    headers: {},
  };
}

function toDto(row: ReceiptCompanyConfigRow): ReceiptCompanySettingsDto {
  const parsed = receiptSettingsPatchSchema.safeParse({
    enabled: row.enabled,
    provider: row.provider,
    model: row.model,
    confidenceThreshold: decimalNumber(row.confidenceThreshold),
    autoMatchThreshold: row.autoMatchThreshold,
    autoMatchMargin: row.autoMatchMargin,
    maxPages: row.maxPages,
  });
  if (!parsed.success) throw invalid('Stored receipt settings are invalid.');
  return {
    enabled: parsed.data.enabled!,
    provider: parsed.data.provider!,
    model: parsed.data.model!,
    confidenceThreshold: parsed.data.confidenceThreshold!,
    autoMatchThreshold: parsed.data.autoMatchThreshold!,
    autoMatchMargin: parsed.data.autoMatchMargin!,
    maxPages: parsed.data.maxPages!,
    configVersion: row.configVersion,
  };
}

function validateSettings(settings: ReceiptSettingsWithoutVersion): void {
  const parsed = receiptSettingsPatchSchema.safeParse(settings);
  if (!parsed.success) throw invalid();
}

function validateProvider(
  provider: SuggestionProvider,
  instance: ReceiptProviderInstanceSettings,
): void {
  const configured = provider === 'openrouter'
    ? instance.openrouterApiKey !== ''
    : validHttpUrl(instance.aiEndpoint) && instance.aiApiKey !== '';
  if (!configured) {
    throw invalid('The selected receipt provider is not configured.');
  }
}

function validHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function decimalNumber(value: unknown): number {
  if (
    typeof value === 'object'
    && value !== null
    && 'toNumber' in value
    && typeof value.toNumber === 'function'
  ) {
    return value.toNumber();
  }
  return Number(value);
}

function assertCompanyId(companyId: string): void {
  if (
    typeof companyId !== 'string'
    || companyId.trim() === ''
    || companyId.length > 200
  ) {
    throw invalid();
  }
}

function withoutVersion(
  settings: ReceiptCompanySettingsDto,
): ReceiptSettingsWithoutVersion {
  const { configVersion: _configVersion, ...rest } = settings;
  return rest;
}

function withoutCompanyId(
  data: ReceiptCompanyConfigData,
): Omit<ReceiptCompanyConfigData, 'companyId'> {
  const { companyId: _companyId, ...rest } = data;
  return rest;
}

function invalid(message?: string): ReceiptSettingError {
  return new ReceiptSettingError(message);
}
