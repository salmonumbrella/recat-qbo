-- AlterTable
ALTER TABLE "Company"
    ADD COLUMN IF NOT EXISTS "taxReferenceRefreshedAt" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "taxUsingSalesTax" BOOLEAN,
    ADD COLUMN IF NOT EXISTS "taxSupportStatus" TEXT NOT NULL DEFAULT 'needs_setup',
    ADD COLUMN IF NOT EXISTS "taxSupportReason" TEXT;

-- CreateTable
CREATE TABLE IF NOT EXISTS "QboTaxRate" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "qboId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "rateValue" DECIMAL(9,6) NOT NULL,
    "sourceUpdatedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QboTaxRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "QboTaxCode" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "qboId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "taxable" BOOLEAN,
    "purchaseTaxRateList" JSONB NOT NULL,
    "combinedPurchaseRate" DECIMAL(9,6),
    "sourceUpdatedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QboTaxCode_pkey" PRIMARY KEY ("id")
);

-- Upgrade cache tables created by pre-migration development builds. Their
-- legacy-only columns and nullability remain intact so the currently running
-- image can coexist until it is replaced; the new service writes only the
-- normalized, non-null purchase-reference subset.
ALTER TABLE "QboTaxRate"
    ADD COLUMN IF NOT EXISTS "sourceUpdatedAt" TIMESTAMP(3);

ALTER TABLE "QboTaxCode"
    ADD COLUMN IF NOT EXISTS "combinedPurchaseRate" DECIMAL(9,6),
    ADD COLUMN IF NOT EXISTS "sourceUpdatedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "QboTaxRate_companyId_qboId_key" ON "QboTaxRate"("companyId", "qboId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "QboTaxCode_companyId_qboId_key" ON "QboTaxCode"("companyId", "qboId");

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'QboTaxRate_companyId_fkey'
          AND conrelid = '"QboTaxRate"'::regclass
    ) THEN
        ALTER TABLE "QboTaxRate"
            ADD CONSTRAINT "QboTaxRate_companyId_fkey"
            FOREIGN KEY ("companyId") REFERENCES "Company"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END
$$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'QboTaxCode_companyId_fkey'
          AND conrelid = '"QboTaxCode"'::regclass
    ) THEN
        ALTER TABLE "QboTaxCode"
            ADD CONSTRAINT "QboTaxCode_companyId_fkey"
            FOREIGN KEY ("companyId") REFERENCES "Company"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END
$$;
