import type { DashboardDataDto } from './index.js';

type Assert<T extends true> = T;

type DashboardDataIncludesProvenance = Assert<
  DashboardDataDto extends {
    source: 'demo' | 'quickbooks' | 'local_fallback';
    retrievedAt: string;
  }
    ? true
    : false
>;
