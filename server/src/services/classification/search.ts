import type {
  ClassificationAction,
  ClassificationActionSummary,
  ClassificationEffectiveSearchMode,
  ClassificationMatchReason,
  ClassificationSearchHit,
  ClassificationSearchMode,
  ClassificationSearchResult,
  ClassificationSearchScope,
} from '@recat/shared';
import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import {
  CLASSIFICATION_CONTRACT_LIMITS,
  parseClassificationSearchHit,
  parseClassificationSearchResult,
} from './contracts.js';
import type { VoyageEmbeddingClient } from './embedding/client.js';
import type {
  ClassificationEmbeddingGeneration,
  ClassificationSearchDocument,
} from './embedding/recipe.js';
import { createClassificationSearchDocument } from './embedding/recipe.js';
import type {
  PgClassificationVectorStore,
  VectorGenerationHealth,
  VectorSearchHit,
} from './embedding/vectorStore.js';
import {
  reciprocalRankFuse,
  rollupSemanticChunks,
  type RankedDocumentList,
} from './rrf.js';
import { normalizeVendorLookupKey } from './vendorIdentity.js';

const MAX_ACCESSIBLE_COMPANIES = 100;
const SEARCH_FETCH_MULTIPLIER = 5;
const MAX_FETCH = 500;
const COSINE_FLOOR = 0.72;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

export interface ClassificationSearchRecord {
  hit: ClassificationSearchHit;
  revisedAt: string;
  lexicalScore: number;
  exactReasons: ClassificationMatchReason[];
  document?: ClassificationSearchDocument;
  /** Deterministic exact-key source; never returned to callers. */
  lookupValue?: string;
}

export interface ClassificationSearchRepository {
  search(
    companyIds: readonly string[],
    query: string,
    limit: number,
  ): Promise<ClassificationSearchRecord[]>;
  rehydrate(
    companyIds: readonly string[],
    documentIds: readonly string[],
  ): Promise<ClassificationSearchRecord[]>;
  documents(companyId: string): Promise<ClassificationSearchDocument[]>;
}

export interface ClassificationSemanticSearch {
  generation: ClassificationEmbeddingGeneration;
  client: VoyageEmbeddingClient;
  store: Pick<
    PgClassificationVectorStore,
    'ensureAvailable' | 'health' | 'search'
  >;
}

export interface ClassificationSearchDependencies {
  repository?: ClassificationSearchRepository;
  semantic: ClassificationSemanticSearch | null;
}

export interface ClassificationSearchInput {
  query: string;
  companyId: string;
  scope: ClassificationSearchScope;
  mode: ClassificationSearchMode;
  limit?: number;
  accessibleCompanyIds: readonly string[];
}

type DegradedReason = Exclude<ClassificationSearchResult['degradedReason'], null>;

export class ClassificationSearchError extends Error {
  constructor(
    public readonly code:
      | 'INVALID_INPUT'
      | 'FORBIDDEN'
      | 'COMPANY_UNAVAILABLE'
      | 'SEMANTIC_UNAVAILABLE',
    public readonly reason: DegradedReason | null = null,
  ) {
    super(
      code === 'FORBIDDEN'
        ? 'Classification company access is forbidden.'
        : code === 'COMPANY_UNAVAILABLE'
          ? 'Classification data is temporarily unavailable.'
        : code === 'SEMANTIC_UNAVAILABLE'
          ? 'Semantic classification search is unavailable.'
          : 'Classification search input is invalid.',
    );
    this.name = 'ClassificationSearchError';
  }
}

async function boundedRepositoryRead<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ClassificationSearchError) throw error;
    throw new ClassificationSearchError('COMPANY_UNAVAILABLE');
  }
}

function checkedText(value: string, maximum: number): string {
  if (typeof value !== 'string' || CONTROL_CHARACTER.test(value)) {
    throw new ClassificationSearchError('INVALID_INPUT');
  }
  const normalized = value.normalize('NFC').trim();
  if (Array.from(normalized).length < 1 || Array.from(normalized).length > maximum) {
    throw new ClassificationSearchError('INVALID_INPUT');
  }
  return normalized;
}

function selectedCompanyIds(input: ClassificationSearchInput): string[] {
  const current = checkedText(input.companyId, CLASSIFICATION_CONTRACT_LIMITS.identifier);
  if (!Array.isArray(input.accessibleCompanyIds)) {
    throw new ClassificationSearchError('INVALID_INPUT');
  }
  const accessible = [...new Set(input.accessibleCompanyIds.map((value) => (
    checkedText(value, CLASSIFICATION_CONTRACT_LIMITS.identifier)
  )))];
  if (accessible.length > MAX_ACCESSIBLE_COMPANIES || !accessible.includes(current)) {
    throw new ClassificationSearchError('FORBIDDEN');
  }
  return input.scope === 'current_company' ? [current] : accessible;
}

function kindReason(
  kind: ClassificationSearchHit['kind'],
): ClassificationMatchReason {
  switch (kind) {
    case 'vendor_alias': return 'alias';
    case 'rule': return 'rule';
    case 'rule_candidate': return 'candidate';
    case 'classification_case': return 'case';
    case 'vendor_identity': return 'alias';
  }
}

function sourceReason(hit: ClassificationSearchHit): ClassificationMatchReason {
  return kindReason(hit.kind);
}

function relationSafeHit(
  raw: ClassificationSearchHit,
  currentCompanyId: string,
): ClassificationSearchHit {
  const foreign = raw.companyId !== currentCompanyId;
  const source = sourceReason(raw);
  const matchedIn = [...new Set([
    source,
    ...raw.matchedIn,
  ])];
  return parseClassificationSearchHit({
    ...raw,
    companyRelation: foreign ? 'foreign' : 'current',
    executable: foreign ? false : raw.executable,
    advisory: foreign ? true : raw.advisory,
    action: foreign ? null : raw.action,
    conflicts: foreign
      ? raw.conflicts.map((conflict) => ({ ...conflict, action: null }))
      : raw.conflicts,
    matchedIn,
  });
}

function lexicalLists(records: readonly ClassificationSearchRecord[]): RankedDocumentList[] {
  const ordered = [...records].sort((left, right) => (
    right.lexicalScore - left.lexicalScore
    || Date.parse(right.revisedAt) - Date.parse(left.revisedAt)
    || left.hit.id.localeCompare(right.hit.id)
  ));
  const lists: RankedDocumentList[] = [{
    matchedIn: 'lexical',
    hits: ordered.map((record) => ({ id: record.hit.id, revisedAt: record.revisedAt })),
  }];
  for (const reason of ['alias', 'rule'] as const) {
    const exact = records.filter((record) => record.exactReasons.includes(reason));
    if (exact.length > 0) {
      lists.push({
        matchedIn: reason,
        hits: exact.map((record) => ({ id: record.hit.id, revisedAt: record.revisedAt })),
      });
    }
  }
  return lists;
}

function exactLists(records: readonly ClassificationSearchRecord[]): RankedDocumentList[] {
  return (['alias', 'rule'] as const).flatMap((reason) => {
    const hits = records
      .filter((record) => record.exactReasons.includes(reason))
      .map((record) => ({ id: record.hit.id, revisedAt: record.revisedAt }));
    return hits.length === 0 ? [] : [{ matchedIn: reason, hits }];
  });
}

async function semanticLeg(
  companyIds: readonly string[],
  query: string,
  fetchLimit: number,
  semantic: ClassificationSemanticSearch,
): Promise<VectorSearchHit[]> {
  let capability;
  try {
    capability = await semantic.store.ensureAvailable();
  } catch {
    throw new ClassificationSearchError('SEMANTIC_UNAVAILABLE', 'semantic_error');
  }
  if (!capability.available) {
    throw new ClassificationSearchError(
      'SEMANTIC_UNAVAILABLE',
      'vector_capability_unavailable',
    );
  }
  let health: VectorGenerationHealth[];
  try {
    health = await Promise.all(companyIds.map((companyId) => semantic.store.health(companyId)));
  } catch {
    throw new ClassificationSearchError('SEMANTIC_UNAVAILABLE', 'semantic_error');
  }
  if (health.some((state) => state.activeGeneration !== semantic.generation.fingerprint)) {
    throw new ClassificationSearchError('SEMANTIC_UNAVAILABLE', 'semantic_unavailable');
  }
  try {
    const embedding = await semantic.client.embedQuery(query);
    return await semantic.store.search({
      companyIds,
      fingerprint: semantic.generation.fingerprint,
      embedding,
      cosineFloor: COSINE_FLOOR,
      limit: fetchLimit,
    });
  } catch (error) {
    if (error instanceof ClassificationSearchError) throw error;
    throw new ClassificationSearchError('SEMANTIC_UNAVAILABLE', 'semantic_error');
  }
}

function finalResult(input: {
  query: string;
  companyId: string;
  scope: ClassificationSearchScope;
  requestedMode: ClassificationSearchMode;
  mode: ClassificationEffectiveSearchMode;
  degradedReason: DegradedReason | null;
  records: readonly ClassificationSearchRecord[];
  lists: readonly RankedDocumentList[];
  limit: number;
}): ClassificationSearchResult {
  const byId = new Map(input.records.map((record) => [record.hit.id, record]));
  const fused = reciprocalRankFuse(input.lists, { limit: MAX_FETCH });
  const hits = fused.flatMap((ranked) => {
    const record = byId.get(ranked.id);
    if (record === undefined) return [];
    const hit = relationSafeHit({
      ...record.hit,
      score: ranked.score,
      matchedIn: [...new Set([...record.hit.matchedIn, ...ranked.matchedIn])],
    }, input.companyId);
    return [hit];
  });
  const page = hits.slice(0, input.limit);
  return parseClassificationSearchResult({
    query: input.query,
    companyId: input.companyId,
    scope: input.scope,
    mode: input.mode,
    requestedMode: input.requestedMode,
    degraded: input.degradedReason !== null,
    degradedReason: input.degradedReason,
    status: page.length === 0 ? 'no_match' : 'matched',
    noMatch: page.length === 0,
    hits: page,
    total: hits.length,
  });
}

export async function searchClassificationMemory(
  rawInput: ClassificationSearchInput,
  dependencies: ClassificationSearchDependencies,
): Promise<ClassificationSearchResult> {
  const query = checkedText(rawInput.query, CLASSIFICATION_CONTRACT_LIMITS.query);
  const companyId = checkedText(rawInput.companyId, CLASSIFICATION_CONTRACT_LIMITS.identifier);
  const companyIds = selectedCompanyIds(rawInput);
  const limit = Math.max(1, Math.min(
    CLASSIFICATION_CONTRACT_LIMITS.hits,
    Math.trunc(rawInput.limit ?? 20),
  ));
  if (!Number.isFinite(limit)) throw new ClassificationSearchError('INVALID_INPUT');
  const fetchLimit = Math.min(MAX_FETCH, limit * SEARCH_FETCH_MULTIPLIER);
  const repository = dependencies.repository ?? new PrismaClassificationSearchRepository();

  if (rawInput.mode === 'exact') {
    const records = await boundedRepositoryRead(() => (
      repository.search(companyIds, query, fetchLimit)
    ));
    return finalResult({
      query, companyId, scope: rawInput.scope, requestedMode: 'exact', mode: 'exact',
      degradedReason: null, records, lists: exactLists(records), limit,
    });
  }

  if (rawInput.mode === 'lexical') {
    const records = await boundedRepositoryRead(() => (
      repository.search(companyIds, query, fetchLimit)
    ));
    return finalResult({
      query, companyId, scope: rawInput.scope, requestedMode: 'lexical', mode: 'lexical',
      degradedReason: null, records, lists: lexicalLists(records), limit,
    });
  }

  if (dependencies.semantic === null) {
    if (rawInput.mode !== 'auto') {
      throw new ClassificationSearchError('SEMANTIC_UNAVAILABLE', 'embedding_not_configured');
    }
    const records = await boundedRepositoryRead(() => (
      repository.search(companyIds, query, fetchLimit)
    ));
    return finalResult({
      query, companyId, scope: rawInput.scope, requestedMode: 'auto', mode: 'lexical',
      degradedReason: 'embedding_not_configured', records, lists: lexicalLists(records), limit,
    });
  }

  if (rawInput.mode === 'semantic') {
    const semanticHits = await semanticLeg(
      companyIds, query, fetchLimit, dependencies.semantic,
    );
    const rolled = rollupSemanticChunks(semanticHits.map((hit) => ({
      documentId: hit.documentId,
      similarity: hit.similarity,
      revisedAt: hit.revisedAt,
    })), { cosineFloor: COSINE_FLOOR, limit: fetchLimit });
    const records = await boundedRepositoryRead(() => (
      repository.rehydrate(companyIds, rolled.map((hit) => hit.id))
    ));
    return finalResult({
      query, companyId, scope: rawInput.scope, requestedMode: 'semantic', mode: 'semantic',
      degradedReason: null, records,
      lists: [{ matchedIn: 'semantic', hits: rolled }], limit,
    });
  }

  const lexicalPromise = boundedRepositoryRead(() => (
    repository.search(companyIds, query, fetchLimit)
  ));
  const semanticPromise = semanticLeg(
    companyIds, query, fetchLimit, dependencies.semantic,
  );
  let lexical: ClassificationSearchRecord[];
  let semanticHits: VectorSearchHit[];
  try {
    [lexical, semanticHits] = await Promise.all([lexicalPromise, semanticPromise]);
  } catch (error) {
    if (rawInput.mode !== 'auto') throw error;
    if (error instanceof ClassificationSearchError && error.code !== 'SEMANTIC_UNAVAILABLE') {
      throw error;
    }
    lexical = await lexicalPromise;
    const reason = error instanceof ClassificationSearchError && error.reason !== null
      ? error.reason
      : 'semantic_error';
    return finalResult({
      query, companyId, scope: rawInput.scope, requestedMode: 'auto', mode: 'lexical',
      degradedReason: reason, records: lexical, lists: lexicalLists(lexical), limit,
    });
  }
  const rolled = rollupSemanticChunks(semanticHits.map((hit) => ({
    documentId: hit.documentId,
    similarity: hit.similarity,
    revisedAt: hit.revisedAt,
  })), { cosineFloor: COSINE_FLOOR, limit: fetchLimit });
  const rehydrated = await boundedRepositoryRead(() => (
    repository.rehydrate(companyIds, rolled.map((hit) => hit.id))
  ));
  const records = [...new Map(
    [...lexical, ...rehydrated].map((record) => [record.hit.id, record]),
  ).values()];
  return finalResult({
    query,
    companyId,
    scope: rawInput.scope,
    requestedMode: rawInput.mode,
    mode: 'hybrid',
    degradedReason: null,
    records,
    lists: [
      ...lexicalLists(lexical),
      { matchedIn: 'semantic', hits: rolled },
    ],
    limit,
  });
}

/** PostgreSQL-backed repository is implemented below; lexical reads never
 * depend on the optional vector tables. */
export class PrismaClassificationSearchRepository implements ClassificationSearchRepository {
  constructor(private readonly db: PrismaClient = prisma) {}

  async search(
    companyIds: readonly string[],
    query: string,
    limit: number,
  ): Promise<ClassificationSearchRecord[]> {
    const checkedCompanyIds = checkedCompanyList(companyIds);
    const checkedQuery = checkedText(query, CLASSIFICATION_CONTRACT_LIMITS.query);
    return this.load(checkedCompanyIds, checkedQuery, null, boundedFetchLimit(limit));
  }

  async rehydrate(
    companyIds: readonly string[],
    documentIds: readonly string[],
  ): Promise<ClassificationSearchRecord[]> {
    const checkedCompanyIds = checkedCompanyList(companyIds);
    if (!Array.isArray(documentIds) || documentIds.length > MAX_FETCH) {
      throw new ClassificationSearchError('INVALID_INPUT');
    }
    const checkedIds = [...new Set(documentIds.map((id) => checkedText(id, 260)))];
    if (checkedIds.length === 0) return [];
    return this.load(checkedCompanyIds, null, checkedIds, checkedIds.length);
  }

  async documents(companyId: string): Promise<ClassificationSearchDocument[]> {
    const records = await this.load(
      [checkedText(companyId, CLASSIFICATION_CONTRACT_LIMITS.identifier)],
      null,
      null,
      10_000,
    );
    return records.flatMap((record) => record.document === undefined ? [] : [record.document]);
  }

  private async load(
    companyIds: readonly string[],
    query: string | null,
    documentIds: readonly string[] | null,
    limit: number,
  ): Promise<ClassificationSearchRecord[]> {
    const idsByKind = splitDocumentIds(documentIds);
    const [identities, aliases, cases, rules, candidates] = await Promise.all([
      this.identityRows(companyIds, query, idsByKind.vendor_identity, limit),
      this.aliasRows(companyIds, query, idsByKind.vendor_alias, limit),
      this.caseRows(companyIds, query, idsByKind.classification_case, limit),
      this.ruleRows(companyIds, query, idsByKind.rule, limit),
      this.candidateRows(companyIds, query, idsByKind.rule_candidate, limit),
    ]);
    const records = [
      ...identities.map(identityRecord),
      ...aliases.map(aliasRecord),
      ...cases.map(caseRecord),
      ...rules.map(ruleRecord),
      ...candidates.map(candidateRecord),
    ].flatMap((record) => {
      try {
        const mapped = record();
        if (query !== null && mapped.lookupValue !== undefined) {
          const exact = normalizeVendorLookupKey(mapped.lookupValue)
            === normalizeVendorLookupKey(query);
          if (exact) {
            mapped.exactReasons = mapped.hit.kind === 'rule' ? ['rule'] : ['alias'];
          }
        }
        return [mapped];
      } catch {
        // Legacy rows can predate bounded classification contracts. One bad
        // row must not take exact/lexical search down for the whole company.
        return [];
      }
    });
    return records
      .sort((left, right) => (
        right.lexicalScore - left.lexicalScore
        || Date.parse(right.revisedAt) - Date.parse(left.revisedAt)
        || left.hit.id.localeCompare(right.hit.id)
      ))
      .slice(0, limit);
  }

  private identityRows(
    companyIds: readonly string[],
    query: string | null,
    ids: readonly string[] | null,
    limit: number,
  ) {
    if (ids !== null && ids.length === 0) return Promise.resolve([] as VendorIdentitySearchRow[]);
    const idFilter = ids === null ? Prisma.empty : Prisma.sql`AND identity."id" IN (${Prisma.join(ids)})`;
    const exactKey = query === null ? null : normalizeVendorLookupKey(query);
    const queryFilter = query === null ? Prisma.empty : Prisma.sql`
      AND (
        identity."normalizedName" = ${exactKey}
        OR to_tsvector('simple', concat_ws(' ', identity."displayName", aliases."values"))
           @@ plainto_tsquery('simple', ${query})
      )
    `;
    const score = query === null ? Prisma.sql`0::double precision` : Prisma.sql`
      ts_rank_cd(
        to_tsvector('simple', concat_ws(' ', identity."displayName", aliases."values")),
        plainto_tsquery('simple', ${query})
      )::double precision
    `;
    return this.db.$queryRaw<VendorIdentitySearchRow[]>(Prisma.sql`
      SELECT identity."id", identity."companyId", company."nickname" AS "companyName",
             identity."displayName", identity."normalizedName", identity."updatedAt" AS "revisedAt",
             COALESCE(aliases."values", '') AS "aliases", ${score} AS "lexicalScore"
      FROM "VendorIdentity" identity
      JOIN "Company" company ON company."id" = identity."companyId"
      LEFT JOIN "VendorIdentityMerge" merge ON merge."companyId" = identity."companyId"
        AND merge."sourceVendorIdentityId" = identity."id"
      LEFT JOIN LATERAL (
        SELECT string_agg(alias."value", ' ') AS "values"
        FROM "VendorAlias" alias
        WHERE alias."companyId" = identity."companyId"
          AND alias."vendorIdentityId" = identity."id"
      ) aliases ON true
      WHERE identity."companyId" IN (${Prisma.join(companyIds)})
        AND merge."id" IS NULL
        ${idFilter} ${queryFilter}
      ORDER BY "lexicalScore" DESC, identity."updatedAt" DESC, identity."id" ASC
      LIMIT ${limit}
    `);
  }

  private aliasRows(
    companyIds: readonly string[],
    query: string | null,
    ids: readonly string[] | null,
    limit: number,
  ) {
    if (ids !== null && ids.length === 0) return Promise.resolve([] as VendorAliasSearchRow[]);
    const idFilter = ids === null ? Prisma.empty : Prisma.sql`AND alias."id" IN (${Prisma.join(ids)})`;
    const exactKey = query === null ? null : normalizeVendorLookupKey(query);
    const queryFilter = query === null ? Prisma.empty : Prisma.sql`
      AND (
        alias."normalizedValue" = ${exactKey}
        OR to_tsvector('simple', concat_ws(' ', alias."value", identity."displayName"))
           @@ plainto_tsquery('simple', ${query})
      )
    `;
    const score = query === null ? Prisma.sql`0::double precision` : Prisma.sql`
      ts_rank_cd(
        to_tsvector('simple', concat_ws(' ', alias."value", identity."displayName")),
        plainto_tsquery('simple', ${query})
      )::double precision
    `;
    return this.db.$queryRaw<VendorAliasSearchRow[]>(Prisma.sql`
      SELECT alias."id", alias."companyId", company."nickname" AS "companyName",
             alias."vendorIdentityId", alias."value", alias."normalizedValue", alias."source",
             alias."createdAt" AS "revisedAt", identity."displayName" AS "vendorName",
             ${score} AS "lexicalScore"
      FROM "VendorAlias" alias
      JOIN "Company" company ON company."id" = alias."companyId"
      JOIN "VendorIdentity" identity ON identity."companyId" = alias."companyId"
        AND identity."id" = alias."vendorIdentityId"
      LEFT JOIN "VendorIdentityMerge" merge ON merge."companyId" = identity."companyId"
        AND merge."sourceVendorIdentityId" = identity."id"
      WHERE alias."companyId" IN (${Prisma.join(companyIds)})
        AND merge."id" IS NULL
        ${idFilter} ${queryFilter}
      ORDER BY "lexicalScore" DESC, alias."createdAt" DESC, alias."id" ASC
      LIMIT ${limit}
    `);
  }

  private caseRows(
    companyIds: readonly string[],
    query: string | null,
    ids: readonly string[] | null,
    limit: number,
  ) {
    if (ids !== null && ids.length === 0) return Promise.resolve([] as ClassificationCaseSearchRow[]);
    const idFilter = ids === null ? Prisma.empty : Prisma.sql`AND memory."id" IN (${Prisma.join(ids)})`;
    const text = Prisma.sql`concat_ws(' ', transaction."payee", transaction."memo", identity."displayName",
      account."fullName", tax."name", memory."rationale", memory."requiredEvidence"::text,
      memory."examples"::text, memory."counterexamples"::text, memory."citations"::text,
      memory."context"::text)`;
    const queryFilter = query === null ? Prisma.empty : Prisma.sql`
      AND to_tsvector('simple', ${text}) @@ plainto_tsquery('simple', ${query})
    `;
    const score = query === null ? Prisma.sql`0::double precision` : Prisma.sql`
      ts_rank_cd(to_tsvector('simple', ${text}), plainto_tsquery('simple', ${query}))::double precision
    `;
    return this.db.$queryRaw<ClassificationCaseSearchRow[]>(Prisma.sql`
      SELECT memory."id", memory."companyId", company."nickname" AS "companyName",
             memory."vendorIdentityId", identity."displayName" AS "vendorName", memory."action",
             memory."originIntent", memory."rationale", memory."requiredEvidence", memory."examples",
             memory."counterexamples", memory."reviewer", memory."jurisdiction", memory."currency",
             memory."provenance", memory."verifiedAt", memory."verifiedAt" AS "revisedAt",
             transaction."payee", transaction."memo", account."name" AS "categoryName",
             tax."name" AS "taxCodeName", ${text} AS "searchText", ${score} AS "lexicalScore"
      FROM "ClassificationCase" memory
      JOIN "Company" company ON company."id" = memory."companyId"
      JOIN "Transaction" transaction ON transaction."companyId" = memory."companyId"
        AND transaction."id" = memory."transactionId"
      LEFT JOIN "VendorIdentity" identity ON identity."companyId" = memory."companyId"
        AND identity."id" = memory."vendorIdentityId"
      LEFT JOIN "QboAccount" account ON account."companyId" = memory."companyId"
        AND account."qboId" = memory."action"->>'categoryQboId'
      LEFT JOIN "QboTaxCode" tax ON tax."companyId" = memory."companyId"
        AND tax."qboId" = memory."action"->>'taxCodeQboId'
      LEFT JOIN "ClassificationCaseInvalidation" invalidation
        ON invalidation."companyId" = memory."companyId"
       AND invalidation."classificationCaseId" = memory."id"
      WHERE memory."companyId" IN (${Prisma.join(companyIds)})
        AND invalidation."id" IS NULL
        ${idFilter} ${queryFilter}
      ORDER BY "lexicalScore" DESC, memory."verifiedAt" DESC, memory."id" ASC
      LIMIT ${limit}
    `);
  }

  private ruleRows(
    companyIds: readonly string[],
    query: string | null,
    ids: readonly string[] | null,
    limit: number,
  ) {
    if (ids !== null && ids.length === 0) return Promise.resolve([] as RuleSearchRow[]);
    const idFilter = ids === null ? Prisma.empty : Prisma.sql`AND rule."id" IN (${Prisma.join(ids)})`;
    const text = Prisma.sql`concat_ws(' ', rule."matchText", rule."category", account."fullName",
      rule."taxCode", tax."name", tags."names", rule."reviewReason")`;
    const exactKey = query === null ? null : normalizeVendorLookupKey(query);
    const queryFilter = query === null ? Prisma.empty : Prisma.sql`
      AND (
        lower(regexp_replace(trim(rule."matchText"), '\\s+', ' ', 'g')) = ${exactKey}
        OR to_tsvector('simple', ${text}) @@ plainto_tsquery('simple', ${query})
      )
    `;
    const score = query === null ? Prisma.sql`0::double precision` : Prisma.sql`
      ts_rank_cd(to_tsvector('simple', ${text}), plainto_tsquery('simple', ${query}))::double precision
    `;
    return this.db.$queryRaw<RuleSearchRow[]>(Prisma.sql`
      SELECT rule."id", rule."companyId", company."nickname" AS "companyName",
             rule."matchText", rule."categoryQboId", rule."taxCalculation", rule."taxCodeQboId",
             rule."originIntent", rule."revision", rule."updatedById", rule."updatedAt" AS "revisedAt",
             rule."reviewRequiredAt", rule."reviewReason", account."name" AS "categoryName",
             tax."name" AS "taxCodeName", COALESCE(tags."ids", '[]'::jsonb) AS "tagIds",
             COALESCE(tags."namesArray", '[]'::jsonb) AS "tagNames",
             ${text} AS "searchText", ${score} AS "lexicalScore"
      FROM "Rule" rule
      JOIN "Company" company ON company."id" = rule."companyId"
      LEFT JOIN "QboAccount" account ON account."companyId" = rule."companyId"
        AND account."qboId" = rule."categoryQboId"
      LEFT JOIN "QboTaxCode" tax ON tax."companyId" = rule."companyId"
        AND tax."qboId" = rule."taxCodeQboId"
      LEFT JOIN LATERAL (
        SELECT string_agg(tag."name", ' ') AS "names",
               jsonb_agg(tag."id" ORDER BY tag."id") AS "ids",
               jsonb_agg(tag."name" ORDER BY tag."id") AS "namesArray"
        FROM "RuleTag" relation
        JOIN "Tag" tag ON tag."id" = relation."tagId"
        WHERE relation."ruleId" = rule."id"
      ) tags ON true
      WHERE rule."companyId" IN (${Prisma.join(companyIds)})
        AND rule."enabled" = true AND rule."retiredAt" IS NULL
        ${idFilter} ${queryFilter}
      ORDER BY "lexicalScore" DESC, rule."updatedAt" DESC, rule."id" ASC
      LIMIT ${limit}
    `);
  }

  private candidateRows(
    companyIds: readonly string[],
    query: string | null,
    ids: readonly string[] | null,
    limit: number,
  ) {
    if (ids !== null && ids.length === 0) return Promise.resolve([] as CandidateSearchRow[]);
    const idFilter = ids === null ? Prisma.empty : Prisma.sql`AND candidate."id" IN (${Prisma.join(ids)})`;
    const text = Prisma.sql`concat_ws(' ', candidate."matchText", account."fullName", tax."name",
      evidence."patterns", evidence."transactions")`;
    const queryFilter = query === null ? Prisma.empty : Prisma.sql`
      AND to_tsvector('simple', ${text}) @@ plainto_tsquery('simple', ${query})
    `;
    const score = query === null ? Prisma.sql`0::double precision` : Prisma.sql`
      ts_rank_cd(to_tsvector('simple', ${text}), plainto_tsquery('simple', ${query}))::double precision
    `;
    return this.db.$queryRaw<CandidateSearchRow[]>(Prisma.sql`
      SELECT candidate."id", candidate."companyId", company."nickname" AS "companyName",
             candidate."matchText", candidate."state", candidate."categoryQboId",
             candidate."taxCalculation", candidate."taxCodeQboId", candidate."tagIds",
             candidate."evidenceCount", candidate."conflictingEvidenceCount",
             candidate."updatedAt" AS "revisedAt", account."name" AS "categoryName",
             tax."name" AS "taxCodeName", COALESCE(evidence."patterns", '') AS "patterns",
             COALESCE(evidence."transactions", '') AS "transactions",
             ${text} AS "searchText", ${score} AS "lexicalScore"
      FROM "AutopilotRuleCandidate" candidate
      JOIN "Company" company ON company."id" = candidate."companyId"
      LEFT JOIN "QboAccount" account ON account."companyId" = candidate."companyId"
        AND account."qboId" = candidate."categoryQboId"
      LEFT JOIN "QboTaxCode" tax ON tax."companyId" = candidate."companyId"
        AND tax."qboId" = candidate."taxCodeQboId"
      LEFT JOIN LATERAL (
        SELECT string_agg(candidateEvidence."pattern"::text, ' ') AS "patterns",
               string_agg(concat_ws(' ', transaction."payee", transaction."memo"), ' ') AS "transactions"
        FROM "AutopilotRuleCandidateEvidence" candidateEvidence
        JOIN "Transaction" transaction ON transaction."companyId" = candidateEvidence."companyId"
          AND transaction."id" = candidateEvidence."transactionId"
        WHERE candidateEvidence."companyId" = candidate."companyId"
          AND candidateEvidence."candidateId" = candidate."id"
          AND candidateEvidence."active" = true
      ) evidence ON true
      WHERE candidate."companyId" IN (${Prisma.join(companyIds)})
        AND candidate."state" IN ('ready', 'conflict')
        ${idFilter} ${queryFilter}
      ORDER BY "lexicalScore" DESC, candidate."updatedAt" DESC, candidate."id" ASC
      LIMIT ${limit}
    `);
  }
}

type BaseSearchRow = {
  id: string;
  companyId: string;
  companyName: string;
  revisedAt: Date;
  lexicalScore: number;
};

type VendorIdentitySearchRow = BaseSearchRow & {
  displayName: string;
  normalizedName: string;
  aliases: string;
};

type VendorAliasSearchRow = BaseSearchRow & {
  vendorIdentityId: string;
  value: string;
  normalizedValue: string;
  source: string;
  vendorName: string;
};

type ClassificationCaseSearchRow = BaseSearchRow & {
  vendorIdentityId: string | null;
  vendorName: string | null;
  action: Prisma.JsonValue;
  originIntent: string;
  rationale: string;
  requiredEvidence: Prisma.JsonValue;
  examples: Prisma.JsonValue;
  counterexamples: Prisma.JsonValue;
  reviewer: Prisma.JsonValue;
  jurisdiction: string;
  currency: string;
  provenance: Prisma.JsonValue;
  verifiedAt: Date;
  payee: string;
  memo: string | null;
  categoryName: string | null;
  taxCodeName: string | null;
  searchText: string;
};

type RuleSearchRow = BaseSearchRow & {
  matchText: string;
  categoryQboId: string | null;
  taxCalculation: string | null;
  taxCodeQboId: string | null;
  originIntent: string | null;
  revision: number;
  updatedById: string | null;
  reviewRequiredAt: Date | null;
  reviewReason: string | null;
  categoryName: string | null;
  taxCodeName: string | null;
  tagIds: Prisma.JsonValue;
  tagNames: Prisma.JsonValue;
  searchText: string;
};

type CandidateSearchRow = BaseSearchRow & {
  matchText: string;
  state: string;
  categoryQboId: string | null;
  taxCalculation: string | null;
  taxCodeQboId: string | null;
  tagIds: Prisma.JsonValue;
  evidenceCount: number;
  conflictingEvidenceCount: number;
  categoryName: string | null;
  taxCodeName: string | null;
  patterns: string;
  transactions: string;
  searchText: string;
};

function boundedFetchLimit(limit: number): number {
  if (!Number.isFinite(limit)) throw new ClassificationSearchError('INVALID_INPUT');
  return Math.max(1, Math.min(MAX_FETCH, Math.trunc(limit)));
}

function checkedCompanyList(companyIds: readonly string[]): string[] {
  if (!Array.isArray(companyIds) || companyIds.length < 1 || companyIds.length > MAX_ACCESSIBLE_COMPANIES) {
    throw new ClassificationSearchError('INVALID_INPUT');
  }
  return [...new Set(companyIds.map((id) => (
    checkedText(id, CLASSIFICATION_CONTRACT_LIMITS.identifier)
  )))];
}

function splitDocumentIds(documentIds: readonly string[] | null): Record<
  'vendor_identity' | 'vendor_alias' | 'classification_case' | 'rule' | 'rule_candidate',
  string[] | null
> {
  const result: Record<
    'vendor_identity' | 'vendor_alias' | 'classification_case' | 'rule' | 'rule_candidate',
    string[] | null
  > = {
    vendor_identity: documentIds === null ? null : [],
    vendor_alias: documentIds === null ? null : [],
    classification_case: documentIds === null ? null : [],
    rule: documentIds === null ? null : [],
    rule_candidate: documentIds === null ? null : [],
  } satisfies Record<string, string[] | null>;
  if (documentIds === null) return result;
  for (const documentId of documentIds) {
    const separator = documentId.indexOf(':');
    if (separator < 1) continue;
    const kind = documentId.slice(0, separator) as keyof typeof result;
    const sourceId = documentId.slice(separator + 1);
    if (kind in result && sourceId !== '') {
      const bucket = result[kind];
      if (bucket !== null) bucket.push(sourceId);
    }
  }
  return result;
}

function jsonStrings(value: Prisma.JsonValue): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').slice(0, 20)
    : [];
}

function taxCalculation(value: string | null): ClassificationAction['taxCalculation'] | null {
  return value === 'TaxInclusive' || value === 'TaxExcluded' || value === 'NotApplicable'
    ? value
    : null;
}

function actionFromColumns(input: {
  categoryQboId: string | null;
  taxCalculation: string | null;
  taxCodeQboId: string | null;
  tagIds: Prisma.JsonValue;
}): ClassificationAction | null {
  const calculation = taxCalculation(input.taxCalculation);
  if (input.categoryQboId === null || calculation === null) return null;
  if ((calculation === 'NotApplicable') !== (input.taxCodeQboId === null)) return null;
  return {
    categoryQboId: input.categoryQboId,
    taxCalculation: calculation,
    taxCodeQboId: input.taxCodeQboId,
    tagIds: jsonStrings(input.tagIds),
  };
}

function actionFromJson(value: Prisma.JsonValue): ClassificationAction | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, Prisma.JsonValue>;
  return actionFromColumns({
    categoryQboId: typeof row.categoryQboId === 'string' ? row.categoryQboId : null,
    taxCalculation: typeof row.taxCalculation === 'string' ? row.taxCalculation : null,
    taxCodeQboId: typeof row.taxCodeQboId === 'string' ? row.taxCodeQboId : null,
    tagIds: row.tagIds ?? [],
  });
}

function actionSummary(
  action: ClassificationAction | null,
  categoryName: string | null,
  taxCodeName: string | null,
  tagNames: string[] = [],
): ClassificationActionSummary | null {
  if (action === null || categoryName === null) return null;
  if ((action.taxCalculation === 'NotApplicable') !== (taxCodeName === null)) return null;
  return { categoryName, taxCalculation: action.taxCalculation, taxCodeName, tagNames };
}

function documentFor(
  hit: ClassificationSearchHit,
  revisedAt: string,
  searchText: string,
): ClassificationSearchDocument {
  return createClassificationSearchDocument({
    companyId: hit.companyId,
    kind: hit.kind,
    sourceId: hit.sourceId,
    revisedAt,
    fields: [['classification context', searchText]],
  });
}

function baseHit(input: {
  row: BaseSearchRow;
  kind: ClassificationSearchHit['kind'];
  vendorIdentityId: string | null;
  vendorName: string | null;
  action: ClassificationAction | null;
  summary: ClassificationActionSummary | null;
  executable: boolean;
  advisory: boolean;
  originIntent: ClassificationSearchHit['originIntent'];
  evidenceCount: number;
  conflictingEvidenceCount: number;
  conflicts?: ClassificationSearchHit['conflicts'];
  provenance: ClassificationSearchHit['provenance'];
  rationale?: string | null;
  examples?: string[];
  counterexamples?: string[];
  jurisdiction?: string | null;
  currency?: string | null;
  verifiedAt?: string | null;
  ruleRevision?: number | null;
}): ClassificationSearchHit {
  return parseClassificationSearchHit({
    id: `${input.kind}:${input.row.id}`,
    sourceId: input.row.id,
    kind: input.kind,
    companyId: input.row.companyId,
    companyName: input.row.companyName,
    companyRelation: 'current',
    executable: input.executable,
    advisory: input.advisory,
    matchedIn: [kindReason(input.kind)],
    score: 0,
    vendorIdentityId: input.vendorIdentityId,
    vendorName: input.vendorName,
    action: input.action,
    actionSummary: input.summary,
    originIntent: input.originIntent,
    evidenceCount: input.evidenceCount,
    conflictingEvidenceCount: input.conflictingEvidenceCount,
    conflicts: input.conflicts ?? [],
    provenance: input.provenance,
    rationale: input.rationale ?? null,
    examples: input.examples ?? [],
    counterexamples: input.counterexamples ?? [],
    jurisdiction: input.jurisdiction ?? null,
    currency: input.currency ?? null,
    verifiedAt: input.verifiedAt ?? null,
    ruleRevision: input.ruleRevision ?? null,
  });
}

function identityRecord(row: VendorIdentitySearchRow): () => ClassificationSearchRecord {
  return () => {
    const revisedAt = row.revisedAt.toISOString();
    const hit = baseHit({
      row, kind: 'vendor_identity', vendorIdentityId: row.id, vendorName: row.displayName,
      action: null, summary: null, executable: false, advisory: true, originIntent: null,
      evidenceCount: 0, conflictingEvidenceCount: 0,
      provenance: { source: 'user', sourceId: row.id, actorId: null, recordedAt: revisedAt },
    });
    const searchText = `${row.displayName} ${row.aliases}`.trim();
    return {
      hit, revisedAt, lexicalScore: Number(row.lexicalScore),
      exactReasons: [], document: documentFor(hit, revisedAt, searchText), lookupValue: row.displayName,
    };
  };
}

function aliasRecord(row: VendorAliasSearchRow): () => ClassificationSearchRecord {
  return () => {
    const revisedAt = row.revisedAt.toISOString();
    const hit = baseHit({
      row, kind: 'vendor_alias', vendorIdentityId: row.vendorIdentityId, vendorName: row.vendorName,
      action: null, summary: null, executable: false, advisory: true, originIntent: null,
      evidenceCount: 0, conflictingEvidenceCount: 0,
      provenance: {
        source: row.source === 'qbo' ? 'qbo_verified' : 'user',
        sourceId: row.id, actorId: null, recordedAt: revisedAt,
      },
    });
    const searchText = `${row.value} ${row.vendorName}`;
    return {
      hit, revisedAt, lexicalScore: Number(row.lexicalScore),
      exactReasons: [], document: documentFor(hit, revisedAt, searchText), lookupValue: row.value,
    };
  };
}

function caseRecord(row: ClassificationCaseSearchRow): () => ClassificationSearchRecord {
  return () => {
    const revisedAt = row.revisedAt.toISOString();
    const action = actionFromJson(row.action);
    const summary = actionSummary(action, row.categoryName, row.taxCodeName);
    const provenance = row.provenance as unknown as ClassificationSearchHit['provenance'];
    const hit = baseHit({
      row, kind: 'classification_case', vendorIdentityId: row.vendorIdentityId, vendorName: row.vendorName,
      action, summary, executable: action !== null && summary !== null && row.jurisdiction !== 'unknown',
      advisory: action === null || summary === null || row.jurisdiction === 'unknown',
      originIntent: row.originIntent as ClassificationSearchHit['originIntent'],
      evidenceCount: 1, conflictingEvidenceCount: 0, provenance,
      rationale: row.rationale, examples: jsonStrings(row.examples),
      counterexamples: jsonStrings(row.counterexamples), jurisdiction: row.jurisdiction,
      currency: row.currency, verifiedAt: row.verifiedAt.toISOString(),
    });
    return {
      hit, revisedAt, lexicalScore: Number(row.lexicalScore), exactReasons: [],
      document: documentFor(hit, revisedAt, row.searchText),
    };
  };
}

function ruleRecord(row: RuleSearchRow): () => ClassificationSearchRecord {
  return () => {
    const revisedAt = row.revisedAt.toISOString();
    const action = actionFromColumns(row);
    const summary = actionSummary(action, row.categoryName, row.taxCodeName, jsonStrings(row.tagNames));
    const taxed = action !== null && action.taxCalculation !== 'NotApplicable';
    const conflicted = row.reviewRequiredAt !== null;
    const conflict = conflicted ? [{
      id: `rule-review:${row.id}`,
      companyId: row.companyId,
      sourceId: row.id,
      kind: 'rule' as const,
      reason: row.reviewReason ?? 'This rule requires review after contradictory verified evidence.',
      action,
      actionSummary: summary,
      evidenceCount: 1,
    }] : [];
    const hit = baseHit({
      row, kind: 'rule', vendorIdentityId: null, vendorName: row.matchText,
      action, summary, executable: action !== null && summary !== null && !taxed && !conflicted,
      advisory: action === null || summary === null || taxed || conflicted,
      originIntent: row.originIntent as ClassificationSearchHit['originIntent'],
      evidenceCount: 0, conflictingEvidenceCount: conflict.length, conflicts: conflict,
      provenance: { source: 'rule', sourceId: row.id, actorId: row.updatedById, recordedAt: revisedAt },
      rationale: row.reviewReason, jurisdiction: taxed ? 'unknown' : null, ruleRevision: row.revision,
    });
    return {
      hit, revisedAt, lexicalScore: Number(row.lexicalScore), exactReasons: [],
      document: documentFor(hit, revisedAt, row.searchText), lookupValue: row.matchText,
    };
  };
}

function candidateRecord(row: CandidateSearchRow): () => ClassificationSearchRecord {
  return () => {
    const revisedAt = row.revisedAt.toISOString();
    const action = actionFromColumns(row);
    const summary = actionSummary(action, row.categoryName, row.taxCodeName);
    const conflict = row.state === 'conflict' ? [{
      id: `candidate-conflict:${row.id}`,
      companyId: row.companyId,
      sourceId: row.id,
      kind: 'candidate' as const,
      reason: 'Verified outcomes disagree for this rule candidate.',
      action,
      actionSummary: summary,
      evidenceCount: row.conflictingEvidenceCount,
    }] : [];
    const hit = baseHit({
      row, kind: 'rule_candidate', vendorIdentityId: null, vendorName: row.matchText,
      action, summary, executable: false, advisory: true, originIntent: 'auto_candidate',
      evidenceCount: row.evidenceCount, conflictingEvidenceCount: row.conflictingEvidenceCount,
      conflicts: conflict,
      provenance: { source: 'candidate', sourceId: row.id, actorId: null, recordedAt: revisedAt },
      rationale: row.state === 'conflict' ? 'Verified outcomes disagree for this candidate.' : null,
      jurisdiction: action !== null && action.taxCalculation !== 'NotApplicable' ? 'unknown' : null,
    });
    return {
      hit, revisedAt, lexicalScore: Number(row.lexicalScore), exactReasons: [],
      document: documentFor(hit, revisedAt, row.searchText),
    };
  };
}
