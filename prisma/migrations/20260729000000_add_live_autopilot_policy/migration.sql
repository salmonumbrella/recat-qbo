-- Persist company-scoped live-mode intent, policy acceptance, and safe pause state.
ALTER TABLE "AgentCompanyConfig"
    ADD COLUMN "liveRequested" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "liveAcceptedPolicyVersion" TEXT,
    ADD COLUMN "liveAcceptedConfigVersion" TEXT,
    ADD COLUMN "liveEnabledAt" TIMESTAMP(3),
    ADD COLUMN "liveEnabledByUserId" TEXT,
    ADD COLUMN "livePausedAt" TIMESTAMP(3),
    ADD COLUMN "livePauseCode" TEXT,
    ADD COLUMN "livePauseMessage" TEXT;
