-- Inert rule-candidate state and append-preserving verified outcome evidence.
ALTER TABLE "Rule"
    ADD COLUMN "reviewRequiredAt" TIMESTAMP(3),
    ADD COLUMN "reviewReason" TEXT;
ALTER TABLE "QboMutationAttempt"
    ADD COLUMN "ruleCandidateFoldedAt" TIMESTAMP(3);

CREATE TABLE "AutopilotRuleCandidate" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "conditionFingerprint" TEXT NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "configVersion" TEXT NOT NULL,
    "matchField" TEXT NOT NULL DEFAULT 'payee',
    "matchText" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'gathering',
    "winningActionFingerprint" TEXT,
    "categoryQboId" TEXT,
    "taxCalculation" TEXT,
    "taxCodeQboId" TEXT,
    "tagIds" JSONB NOT NULL DEFAULT '[]',
    "evidenceCount" INTEGER NOT NULL DEFAULT 0,
    "conflictingEvidenceCount" INTEGER NOT NULL DEFAULT 0,
    "dismissedAt" TIMESTAMP(3),
    "dismissedByUserId" TEXT,
    "activatedAt" TIMESTAMP(3),
    "activatedByUserId" TEXT,
    "activationEvidenceCount" INTEGER,
    "activationActionFingerprint" TEXT,
    "activatedRuleId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AutopilotRuleCandidate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AutopilotRuleCandidateEvidence" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "inputRevision" INTEGER NOT NULL,
    "requestId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "actionFingerprint" TEXT NOT NULL,
    "pattern" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "invalidatedAt" TIMESTAMP(3),
    "invalidationReason" TEXT,
    CONSTRAINT "AutopilotRuleCandidateEvidence_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AutopilotRuleCandidateFold" (
    "requestId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AutopilotRuleCandidateFold_pkey" PRIMARY KEY ("requestId")
);

CREATE UNIQUE INDEX "AutopilotRuleCandidate_companyId_conditionFingerprint_schemaVersion_configVersion_key"
    ON "AutopilotRuleCandidate"("companyId", "conditionFingerprint", "schemaVersion", "configVersion");
CREATE INDEX "AutopilotRuleCandidate_companyId_state_updatedAt_idx"
    ON "AutopilotRuleCandidate"("companyId", "state", "updatedAt");
CREATE UNIQUE INDEX "AutopilotRuleCandidate_activatedRuleId_key"
    ON "AutopilotRuleCandidate"("activatedRuleId");
CREATE UNIQUE INDEX "AutopilotRuleCandidateEvidence_requestId_key"
    ON "AutopilotRuleCandidateEvidence"("requestId");
CREATE INDEX "AutopilotRuleCandidateEvidence_candidateId_active_idx"
    ON "AutopilotRuleCandidateEvidence"("candidateId", "active");
CREATE INDEX "AutopilotRuleCandidateEvidence_transactionId_active_idx"
    ON "AutopilotRuleCandidateEvidence"("transactionId", "active");
CREATE INDEX "AutopilotRuleCandidateFold_companyId_processedAt_idx"
    ON "AutopilotRuleCandidateFold"("companyId", "processedAt");
CREATE INDEX "AutopilotRuleCandidateFold_transactionId_idx"
    ON "AutopilotRuleCandidateFold"("transactionId");
CREATE INDEX "QboMutationAttempt_pending_rule_candidate_fold_idx"
    ON "QboMutationAttempt"("transactionId", "createdAt" DESC, "id" DESC)
    WHERE "status" = 'VERIFIED'
      AND "operation" IN ('recategorize', 'restore')
      AND "ruleCandidateFoldedAt" IS NULL
      AND "requestPayload"->'ruleCandidateFold'->>'version' = '1';

ALTER TABLE "AutopilotRuleCandidate"
    ADD CONSTRAINT "AutopilotRuleCandidate_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AutopilotRuleCandidate"
    ADD CONSTRAINT "AutopilotRuleCandidate_activatedRuleId_fkey"
    FOREIGN KEY ("activatedRuleId") REFERENCES "Rule"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AutopilotRuleCandidateEvidence"
    ADD CONSTRAINT "AutopilotRuleCandidateEvidence_candidateId_fkey"
    FOREIGN KEY ("candidateId") REFERENCES "AutopilotRuleCandidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AutopilotRuleCandidateEvidence"
    ADD CONSTRAINT "AutopilotRuleCandidateEvidence_transactionId_fkey"
    FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AutopilotRuleCandidateFold"
    ADD CONSTRAINT "AutopilotRuleCandidateFold_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AutopilotRuleCandidateFold"
    ADD CONSTRAINT "AutopilotRuleCandidateFold_transactionId_fkey"
    FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
