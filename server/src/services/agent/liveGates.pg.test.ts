import { PrismaClient, type Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runSerializableTransaction } from '../../lib/serializableTransaction.js';
import {
  enableLiveMode,
  runLiveAuthorityTransaction,
  type LiveGateDeps,
} from './liveGates.js';
import {
  updateShadowSettings,
  type AgentSettingsDb,
  type AgentSettingsDeps,
} from './settings.js';
import {
  disconnectCompanyWithLiveAuthority,
  updateCompanySettingsWithLiveAuthority,
  type CompanyLiveAuthorityDeps,
} from '../companyLiveAuthority.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;
const NOW = new Date('2026-07-29T12:00:00.000Z');

type GateDb = Pick<
  Prisma.TransactionClient,
  'agentCompanyConfig' | 'company' | 'qboMutationAttempt'
>;

interface Fixture {
  companyId: string;
  transactionId: string;
}

interface GateBarrier {
  afterBlockerRead?(): Promise<void>;
}

describePostgres('live gate PostgreSQL authority races', () => {
  let firstClient: PrismaClient;
  let secondClient: PrismaClient;

  beforeAll(() => {
    firstClient = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL! } } });
    secondClient = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL! } } });
  });

  afterAll(async () => {
    await Promise.all([firstClient?.$disconnect(), secondClient?.$disconnect()]);
  });

  async function seed(): Promise<Fixture> {
    const suffix = randomUUID();
    const company = await firstClient.company.create({
      data: {
        realmId: `live-gate-${suffix}`,
        legalName: 'Live gate PostgreSQL fixture',
        nickname: `live-${suffix.slice(0, 8)}`,
        dryRun: false,
        accessToken: 'encrypted-access-placeholder',
        refreshToken: 'encrypted-refresh-placeholder',
        taxReferenceRefreshedAt: NOW,
        taxUsingSalesTax: true,
        taxSupportStatus: 'ready',
      },
    });
    await firstClient.agentCompanyConfig.create({
      data: {
        companyId: company.id,
        mode: 'shadow',
        provider: 'custom',
        decisionModel: 'decision-model',
        verifierModel: 'verifier-model',
        scheduleMinutes: 10,
        companyConcurrency: 1,
        evidenceThreshold: 25,
        limits: {},
        configVersion: `config-${suffix}`,
      },
    });
    const transaction = await firstClient.transaction.create({
      data: {
        companyId: company.id,
        qboId: `live-gate-${suffix}`,
        qboType: 'Purchase',
        qboSyncToken: '0',
        date: NOW,
        payee: 'PostgreSQL fixture',
        amount: '-1.00',
        bankAccount: 'Fixture bank',
      },
    });
    return { companyId: company.id, transactionId: transaction.id };
  }

  async function cleanup(fixture: Fixture): Promise<void> {
    await firstClient.company.deleteMany({ where: { id: fixture.companyId } });
  }

  function gateDeps(
    root: PrismaClient,
    barrier: GateBarrier = {},
  ): LiveGateDeps {
    const build = (db: GateDb, transactional: boolean): LiveGateDeps => ({
      now: () => NOW,
      getConfig: async (companyId) =>
        db.agentCompanyConfig.findUnique({ where: { companyId } }),
      getCompany: async (companyId) => {
        const company = await db.company.findUnique({
          where: { id: companyId },
          select: { legalName: true, disconnectedAt: true, dryRun: true },
        });
        return company === null
          ? null
          : {
              ...company,
              qboClientCredentialsReady: true,
              qboTokensReady: true,
            };
      },
      getEvidence: async () => ({
        eligibleRuns: 25,
        agreements: 25,
        disagreements: 0,
        threshold: 25,
        thresholdMet: true,
      }),
      getShadowMetrics: async () => ({ abstentions: 0, errors: 0 }),
      getTaxReadiness: async () => ({ status: 'ready', refreshedAt: NOW.toISOString() }),
      getWriteBlockers: async (companyId) => {
        const unresolvedMutations = await db.qboMutationAttempt.count({
          where: {
            transaction: { companyId },
            status: { in: ['PREPARED', 'COMMITTING', 'UNCERTAIN'] },
          },
        });
        if (transactional) await barrier.afterBlockerRead?.();
        return { unresolvedMutations };
      },
      getProviderBinding: async (companyId) => {
        const config = await db.agentCompanyConfig.findUnique({ where: { companyId } });
        return config === null ? 'missing' : `binding:${config.configVersion}`;
      },
      getProviderHealth: async (companyId) => {
        const config = await db.agentCompanyConfig.findUnique({ where: { companyId } });
        return {
          binding: config === null ? 'missing' : `binding:${config.configVersion}`,
          decisionModel: true,
          verifierModel: true,
          decisionIdentity: 'custom:resolved/decision',
          verifierIdentity: 'custom:resolved/verifier',
        };
      },
      getWorkerHealth: async () => ({ healthy: true }),
      updateConfig: async (companyId, update) =>
        db.agentCompanyConfig.update({ where: { companyId }, data: update }),
      withTransaction: transactional
        ? async (callback) => callback(build(db, true))
        : async (callback) => runLiveAuthorityTransaction(
            root,
            (transaction) => callback(build(transaction, true)),
          ),
    });
    return build(root, false);
  }

  function companyAuthorityDeps(root: PrismaClient): CompanyLiveAuthorityDeps {
    return {
      now: () => NOW,
      withSerializableTransaction: (callback) =>
        runSerializableTransaction(root, callback),
    };
  }

  async function waitForBlockedQuery(fragment: string): Promise<void> {
    await vi.waitFor(async () => {
      const rows = await firstClient.$queryRawUnsafe<{ count: number }[]>(
        `SELECT COUNT(*)::integer AS "count"
         FROM pg_stat_activity
         WHERE datname = current_database()
           AND pid <> pg_backend_pid()
           AND "wait_event_type" = 'Lock'
           AND query LIKE $1`,
        `%${fragment}%`,
      );
      expect(rows[0]?.count ?? 0).toBeGreaterThan(0);
    }, { timeout: 2_000, interval: 10 });
  }

  function barrier(): {
    gateRead: Promise<void>;
    release(): void;
    hook: GateBarrier;
  } {
    let markRead: (() => void) | undefined;
    let allowCommit: (() => void) | undefined;
    const gateRead = new Promise<void>((resolve) => {
      markRead = resolve;
    });
    const released = new Promise<void>((resolve) => {
      allowCommit = resolve;
    });
    return {
      gateRead,
      release: () => allowCommit?.(),
      hook: {
        afterBlockerRead: async () => {
          markRead?.();
          await released;
        },
      },
    };
  }

  it('prevents a PREPARED mutation from landing between the final gate read and enable commit', async () => {
    const fixture = await seed();
    const sync = barrier();
    try {
      const enabling = enableLiveMode(
        fixture.companyId,
        'Live gate PostgreSQL fixture',
        { userId: 'admin-1', isAdmin: true },
        gateDeps(firstClient, sync.hook),
      );
      await sync.gateRead;

      const mutation = secondClient.qboMutationAttempt.create({
        data: {
          transactionId: fixture.transactionId,
          requestId: `live-race-${randomUUID()}`,
          operation: 'recategorize',
          status: 'PREPARED',
          expectedRevision: 1,
          expectedSyncToken: '0',
          requestHash: 'hash',
          requestPayload: {},
          beforeSnapshot: {},
        },
      }).then((attempt) => attempt);
      await waitForBlockedQuery('QboMutationAttempt');
      sync.release();

      const readiness = await enabling;
      expect(readiness.gates.every((gate) => gate.ok)).toBe(true);
      await mutation;
      await expect(firstClient.agentCompanyConfig.findUniqueOrThrow({
        where: { companyId: fixture.companyId },
      })).resolves.toMatchObject({
        liveRequested: true,
        liveEnabledAt: NOW,
        livePauseCode: null,
      });
    } finally {
      sync.release();
      await cleanup(fixture);
    }
  });

  it('retries a concurrent company-settings change and leaves accepted live mode paused', async () => {
    const fixture = await seed();
    const sync = barrier();
    try {
      const enabling = enableLiveMode(
        fixture.companyId,
        'Live gate PostgreSQL fixture',
        { userId: 'admin-1', isAdmin: true },
        gateDeps(firstClient, sync.hook),
      );
      await sync.gateRead;

      const settingsDeps: AgentSettingsDeps = {
        db: secondClient as unknown as AgentSettingsDb,
        getInstanceSettings: async () => ({
          suggestionProvider: 'custom',
          agentDecisionModel: 'decision-model',
          agentVerifierModel: 'verifier-model',
          aiEndpoint: 'https://models.example/v1',
          aiApiKey: 'configured',
          openrouterApiKey: '',
        }),
        withSerializableTransaction: (callback) => runSerializableTransaction(
          secondClient,
          (transaction) => callback(transaction as unknown as AgentSettingsDb),
        ),
      };
      const changing = updateShadowSettings(
        fixture.companyId,
        { evidenceThreshold: 26 },
        settingsDeps,
      );
      await waitForBlockedQuery('AgentCompanyConfig');
      sync.release();

      await Promise.all([enabling, changing]);
      await expect(firstClient.agentCompanyConfig.findUniqueOrThrow({
        where: { companyId: fixture.companyId },
      })).resolves.toMatchObject({
        liveRequested: true,
        liveAcceptedPolicyVersion: null,
        liveAcceptedConfigVersion: null,
        liveAcceptedProviderBinding: null,
        livePauseCode: 'LIVE_POLICY_NOT_ACCEPTED',
      });
    } finally {
      sync.release();
      await cleanup(fixture);
    }
  });

  it('serializes a concurrent dry-run transition after enable and clears every accepted binding', async () => {
    const fixture = await seed();
    const sync = barrier();
    try {
      const enabling = enableLiveMode(
        fixture.companyId,
        'Live gate PostgreSQL fixture',
        { userId: 'admin-1', isAdmin: true },
        gateDeps(firstClient, sync.hook),
      );
      await sync.gateRead;

      const changing = updateCompanySettingsWithLiveAuthority(
        fixture.companyId,
        { dryRun: true },
        companyAuthorityDeps(secondClient),
      );
      await waitForBlockedQuery('Company');
      sync.release();

      await Promise.all([enabling, changing]);
      await expect(firstClient.company.findUniqueOrThrow({
        where: { id: fixture.companyId },
      })).resolves.toMatchObject({ dryRun: true });
      await expect(firstClient.agentCompanyConfig.findUniqueOrThrow({
        where: { companyId: fixture.companyId },
      })).resolves.toMatchObject({
        liveRequested: true,
        liveAcceptedPolicyVersion: null,
        liveAcceptedConfigVersion: null,
        liveAcceptedProviderBinding: null,
        livePauseCode: 'LIVE_POLICY_NOT_ACCEPTED',
      });
    } finally {
      sync.release();
      await cleanup(fixture);
    }
  });

  it('serializes a concurrent QBO disconnect after enable and clears every accepted binding', async () => {
    const fixture = await seed();
    const sync = barrier();
    try {
      const enabling = enableLiveMode(
        fixture.companyId,
        'Live gate PostgreSQL fixture',
        { userId: 'admin-1', isAdmin: true },
        gateDeps(firstClient, sync.hook),
      );
      await sync.gateRead;

      const disconnecting = disconnectCompanyWithLiveAuthority(
        fixture.companyId,
        companyAuthorityDeps(secondClient),
      );
      await waitForBlockedQuery('Company');
      sync.release();

      await Promise.all([enabling, disconnecting]);
      await expect(firstClient.company.findUniqueOrThrow({
        where: { id: fixture.companyId },
      })).resolves.toMatchObject({
        disconnectedAt: NOW,
        accessToken: null,
        refreshToken: null,
        tokenExpiresAt: null,
      });
      await expect(firstClient.agentCompanyConfig.findUniqueOrThrow({
        where: { companyId: fixture.companyId },
      })).resolves.toMatchObject({
        liveRequested: true,
        liveAcceptedPolicyVersion: null,
        liveAcceptedConfigVersion: null,
        liveAcceptedProviderBinding: null,
        livePauseCode: 'QBO_DISCONNECTED',
      });
    } finally {
      sync.release();
      await cleanup(fixture);
    }
  });
});
