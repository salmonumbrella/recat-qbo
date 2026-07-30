CREATE TABLE "AttachmentDownloadGrant" (
  "id" TEXT NOT NULL,
  "tokenHash" CHAR(64) NOT NULL,
  "actorKey" VARCHAR(160) NOT NULL,
  "companyId" TEXT NOT NULL,
  "attachmentId" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AttachmentDownloadGrant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AttachmentDownloadGrant_tokenHash_key"
ON "AttachmentDownloadGrant"("tokenHash");

CREATE INDEX "AttachmentDownloadGrant_companyId_actorKey_expiresAt_idx"
ON "AttachmentDownloadGrant"("companyId", "actorKey", "expiresAt");

ALTER TABLE "AttachmentDownloadGrant"
ADD CONSTRAINT "AttachmentDownloadGrant_companyId_fkey"
FOREIGN KEY ("companyId") REFERENCES "Company"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AttachmentDownloadGrant"
ADD CONSTRAINT "AttachmentDownloadGrant_attachmentId_fkey"
FOREIGN KEY ("attachmentId") REFERENCES "TransactionAttachment"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
