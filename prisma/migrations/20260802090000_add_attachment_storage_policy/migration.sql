ALTER TABLE "Company"
  ADD COLUMN "attachmentQuotaBytes" BIGINT,
  ADD COLUMN "attachmentRetentionDays" INTEGER;

ALTER TABLE "Company"
  ADD CONSTRAINT "Company_attachmentQuotaBytes_bounds"
  CHECK (
    "attachmentQuotaBytes" IS NULL
    OR "attachmentQuotaBytes" BETWEEN 1048576 AND 1099511627776
  ),
  ADD CONSTRAINT "Company_attachmentRetentionDays_bounds"
  CHECK (
    "attachmentRetentionDays" IS NULL
    OR "attachmentRetentionDays" BETWEEN 1 AND 3650
  );

UPDATE "AttachmentBlob"
   SET "expiresAt" = "createdAt" + INTERVAL '365 days'
 WHERE "state" = 'READY'
   AND "expiresAt" IS NULL;

ALTER TABLE "AttachmentBlob"
  DROP CONSTRAINT "AttachmentBlob_ready_metadata";

ALTER TABLE "AttachmentBlob"
  ADD CONSTRAINT "AttachmentBlob_ready_metadata"
  CHECK (
    ("state" = 'STAGING' AND "sha256" IS NULL)
    OR (
      "state" = 'READY'
      AND "sha256" IS NOT NULL
      AND "sha256" ~ '^[0-9a-f]{64}$'
      AND "contentType" IS NOT NULL
      AND "sizeBytes" >= 0
      AND "chunkCount" >= 1
      AND "expiresAt" IS NOT NULL
    )
  );

CREATE INDEX "AttachmentBlob_companyId_state_idx"
  ON "AttachmentBlob"("companyId", "state");
