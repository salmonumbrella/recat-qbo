-- Durable, read-only shadow agent state. Provider credentials remain in
-- encrypted instance AppConfig rows; these tables store only a provider name
-- and model aliases used to reproduce a run.
CREATE TABLE "AgentCompanyConfig" (
    "companyId" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'off',
    "provider" TEXT NOT NULL,
    "decisionModel" TEXT NOT NULL,
    "verifierModel" TEXT NOT NULL,
    "scheduleMinutes" INTEGER NOT NULL DEFAULT 10,
    "companyConcurrency" INTEGER NOT NULL DEFAULT 1,
    "evidenceThreshold" INTEGER NOT NULL DEFAULT 50,
    "limits" JSONB NOT NULL,
    "configVersion" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentCompanyConfig_pkey" PRIMARY KEY ("companyId")
);

CREATE TABLE "AgentJob" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "configVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "lockOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastErrorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentJob_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "configVersion" TEXT NOT NULL,
    "attemptCount" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "decision" JSONB,
    "verification" JSONB,
    "decisionModel" TEXT NOT NULL,
    "verifierModel" TEXT NOT NULL,
    "verifierKind" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "durationMs" INTEGER,
    "usage" JSONB,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AgentJob_companyId_transactionId_revision_configVersion_key"
    ON "AgentJob"("companyId", "transactionId", "revision", "configVersion");
CREATE INDEX "AgentJob_status_dueAt_idx" ON "AgentJob"("status", "dueAt");
CREATE INDEX "AgentRun_companyId_createdAt_idx" ON "AgentRun"("companyId", "createdAt");
CREATE INDEX "AgentRun_transactionId_revision_idx" ON "AgentRun"("transactionId", "revision");
CREATE UNIQUE INDEX "AgentRun_jobId_attemptCount_key"
    ON "AgentRun"("jobId", "attemptCount");

ALTER TABLE "AgentCompanyConfig" ADD CONSTRAINT "AgentCompanyConfig_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentJob" ADD CONSTRAINT "AgentJob_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_jobId_fkey"
    FOREIGN KEY ("jobId") REFERENCES "AgentJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
