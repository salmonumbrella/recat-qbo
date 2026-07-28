-- Versioned, normalized local staging state. IF NOT EXISTS keeps this migration
-- additive when a pre-release image already introduced the nullable tax fields.
ALTER TABLE "Transaction"
    ADD COLUMN IF NOT EXISTS "revision" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "taxCalculation" TEXT,
    ADD COLUMN IF NOT EXISTS "taxCode" TEXT,
    ADD COLUMN IF NOT EXISTS "taxCodeQboId" TEXT;

ALTER TABLE "SplitLine"
    ADD COLUMN IF NOT EXISTS "taxCode" TEXT,
    ADD COLUMN IF NOT EXISTS "taxCodeQboId" TEXT;

ALTER TABLE "Rule"
    ADD COLUMN IF NOT EXISTS "taxCalculation" TEXT,
    ADD COLUMN IF NOT EXISTS "taxCode" TEXT,
    ADD COLUMN IF NOT EXISTS "taxCodeQboId" TEXT;

CREATE TABLE IF NOT EXISTS "QboEntityLease" (
    "companyId" TEXT NOT NULL,
    "qboType" TEXT NOT NULL,
    "qboId" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "leaseExpiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QboEntityLease_pkey" PRIMARY KEY ("companyId", "qboType", "qboId")
);

CREATE INDEX IF NOT EXISTS "QboEntityLease_leaseExpiresAt_idx"
    ON "QboEntityLease"("leaseExpiresAt");

-- Fresh PR1 databases receive the strict planned model. The ALTER statements
-- below converge the verified legacy table without dropping its extra columns
-- or tightening legacy constraints.
CREATE TABLE IF NOT EXISTS "QboMutationAttempt" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "expectedRevision" INTEGER NOT NULL,
    "expectedSyncToken" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "requestPayload" JSONB NOT NULL,
    "beforeSnapshot" JSONB NOT NULL,
    "responseSnapshot" JSONB,
    "verification" JSONB,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QboMutationAttempt_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "QboMutationAttempt"
    ADD COLUMN IF NOT EXISTS "expectedRevision" INTEGER,
    ADD COLUMN IF NOT EXISTS "expectedSyncToken" TEXT,
    ADD COLUMN IF NOT EXISTS "requestHash" TEXT,
    ADD COLUMN IF NOT EXISTS "requestPayload" JSONB,
    ADD COLUMN IF NOT EXISTS "beforeSnapshot" JSONB,
    ADD COLUMN IF NOT EXISTS "responseSnapshot" JSONB,
    ADD COLUMN IF NOT EXISTS "errorCode" TEXT,
    ADD COLUMN IF NOT EXISTS "errorMessage" TEXT;

-- decisionHash is a verified legacy-only required column. The strict Prisma
-- model does not write it, so legacy deployments must permit it to be absent.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'QboMutationAttempt'
          AND column_name = 'decisionHash'
          AND is_nullable = 'NO'
    ) THEN
        ALTER TABLE "QboMutationAttempt"
            ALTER COLUMN "decisionHash" DROP NOT NULL;
    END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS "QboMutationAttempt_requestId_key"
    ON "QboMutationAttempt"("requestId");

CREATE INDEX IF NOT EXISTS "QboMutationAttempt_transactionId_status_idx"
    ON "QboMutationAttempt"("transactionId", "status");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint constraint_row
        JOIN pg_attribute column_row
          ON column_row.attrelid = constraint_row.conrelid
         AND column_row.attnum = ANY(constraint_row.conkey)
        WHERE constraint_row.contype = 'f'
          AND constraint_row.conrelid = '"QboMutationAttempt"'::regclass
          AND constraint_row.confrelid = '"Transaction"'::regclass
          AND column_row.attname = 'transactionId'
    ) THEN
        ALTER TABLE "QboMutationAttempt"
            ADD CONSTRAINT "QboMutationAttempt_transactionId_fkey"
            FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END
$$;
