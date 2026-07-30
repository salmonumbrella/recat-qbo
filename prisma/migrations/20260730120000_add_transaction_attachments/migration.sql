CREATE TYPE "AttachmentSourceKind" AS ENUM (
  'LOCAL_UPLOAD',
  'HTTPS_IMPORT',
  'QBO_EXTERNAL'
);

CREATE TYPE "AttachmentStatus" AS ENUM (
  'STAGED',
  'UPLOADING',
  'ATTACHED',
  'FAILED',
  'UNCERTAIN',
  'RECONCILING',
  'DELETING',
  'DELETED',
  'QBO_MISSING'
);

CREATE TYPE "AttachmentOperationStatus" AS ENUM (
  'PREPARED',
  'COMMITTING',
  'PARTIAL',
  'VERIFIED',
  'FAILED',
  'UNCERTAIN',
  'DELETING',
  'DELETED'
);

CREATE TYPE "AttachmentBlobState" AS ENUM ('STAGING', 'READY');

ALTER TABLE "Company"
  ADD COLUMN "retainAttachmentFiles" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "AttachmentBlob" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "state" "AttachmentBlobState" NOT NULL DEFAULT 'STAGING',
  "sha256" CHAR(64),
  "sizeBytes" BIGINT NOT NULL DEFAULT 0,
  "contentType" VARCHAR(120),
  "chunkCount" INTEGER NOT NULL DEFAULT 0,
  "expiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AttachmentBlob_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AttachmentBlobChunk" (
  "blobId" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "content" BYTEA NOT NULL,
  CONSTRAINT "AttachmentBlobChunk_pkey" PRIMARY KEY ("blobId", "ordinal")
);

CREATE TABLE "StagedAttachment" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "actorKey" VARCHAR(160) NOT NULL,
  "blobId" TEXT NOT NULL,
  "originalFilename" VARCHAR(255) NOT NULL,
  "contentType" VARCHAR(120) NOT NULL,
  "sizeBytes" BIGINT NOT NULL,
  "sourceKind" "AttachmentSourceKind" NOT NULL,
  "retainLocally" BOOLEAN NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StagedAttachment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TransactionAttachment" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "transactionId" TEXT NOT NULL,
  "blobId" TEXT,
  "originalFilename" VARCHAR(255) NOT NULL,
  "contentType" VARCHAR(120) NOT NULL,
  "sizeBytes" BIGINT NOT NULL,
  "sha256" CHAR(64) NOT NULL,
  "sourceKind" "AttachmentSourceKind" NOT NULL,
  "retainLocally" BOOLEAN NOT NULL,
  "status" "AttachmentStatus" NOT NULL DEFAULT 'STAGED',
  "qboAttachableId" VARCHAR(128),
  "qboSyncToken" VARCHAR(64),
  "recatMarker" UUID NOT NULL,
  "errorCode" VARCHAR(64),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TransactionAttachment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AttachmentOperation" (
  "id" TEXT NOT NULL,
  "actorKey" VARCHAR(160) NOT NULL,
  "companyId" TEXT NOT NULL,
  "transactionId" TEXT NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "inputHash" CHAR(64) NOT NULL,
  "status" "AttachmentOperationStatus" NOT NULL DEFAULT 'PREPARED',
  "fileCount" INTEGER NOT NULL,
  "totalBytes" BIGINT NOT NULL,
  "errorCode" VARCHAR(64),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AttachmentOperation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AttachmentOperationFile" (
  "operationId" TEXT NOT NULL,
  "attachmentId" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "status" "AttachmentStatus" NOT NULL,
  "errorCode" VARCHAR(64),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AttachmentOperationFile_pkey"
    PRIMARY KEY ("operationId", "attachmentId")
);

CREATE TABLE "AttachmentUploadGrant" (
  "id" TEXT NOT NULL,
  "tokenHash" CHAR(64) NOT NULL,
  "actorKey" VARCHAR(160) NOT NULL,
  "companyId" TEXT NOT NULL,
  "maxFileCount" INTEGER NOT NULL,
  "maxBytes" BIGINT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AttachmentUploadGrant_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AttachmentBlob_state_expiresAt_idx"
  ON "AttachmentBlob"("state", "expiresAt");
CREATE UNIQUE INDEX "AttachmentBlob_companyId_sha256_key"
  ON "AttachmentBlob"("companyId", "sha256");
CREATE INDEX "StagedAttachment_companyId_actorKey_expiresAt_idx"
  ON "StagedAttachment"("companyId", "actorKey", "expiresAt");
CREATE UNIQUE INDEX "TransactionAttachment_recatMarker_key"
  ON "TransactionAttachment"("recatMarker");
CREATE INDEX "TransactionAttachment_companyId_transactionId_status_idx"
  ON "TransactionAttachment"("companyId", "transactionId", "status");
CREATE UNIQUE INDEX "TransactionAttachment_companyId_qboAttachableId_key"
  ON "TransactionAttachment"("companyId", "qboAttachableId");
CREATE INDEX "AttachmentOperation_companyId_transactionId_status_idx"
  ON "AttachmentOperation"("companyId", "transactionId", "status");
CREATE UNIQUE INDEX
  "AttachmentOperation_actorKey_companyId_transactionId_idempo_key"
  ON "AttachmentOperation"(
    "actorKey",
    "companyId",
    "transactionId",
    "idempotencyKey"
  );
CREATE INDEX "AttachmentOperationFile_attachmentId_status_idx"
  ON "AttachmentOperationFile"("attachmentId", "status");
CREATE UNIQUE INDEX "AttachmentOperationFile_operationId_ordinal_key"
  ON "AttachmentOperationFile"("operationId", "ordinal");
CREATE UNIQUE INDEX "AttachmentUploadGrant_tokenHash_key"
  ON "AttachmentUploadGrant"("tokenHash");
CREATE INDEX "AttachmentUploadGrant_companyId_actorKey_expiresAt_idx"
  ON "AttachmentUploadGrant"("companyId", "actorKey", "expiresAt");

ALTER TABLE "AttachmentBlob"
  ADD CONSTRAINT "AttachmentBlob_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AttachmentBlobChunk"
  ADD CONSTRAINT "AttachmentBlobChunk_blobId_fkey"
  FOREIGN KEY ("blobId") REFERENCES "AttachmentBlob"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StagedAttachment"
  ADD CONSTRAINT "StagedAttachment_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StagedAttachment"
  ADD CONSTRAINT "StagedAttachment_blobId_fkey"
  FOREIGN KEY ("blobId") REFERENCES "AttachmentBlob"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TransactionAttachment"
  ADD CONSTRAINT "TransactionAttachment_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TransactionAttachment"
  ADD CONSTRAINT "TransactionAttachment_transactionId_fkey"
  FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TransactionAttachment"
  ADD CONSTRAINT "TransactionAttachment_blobId_fkey"
  FOREIGN KEY ("blobId") REFERENCES "AttachmentBlob"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AttachmentOperation"
  ADD CONSTRAINT "AttachmentOperation_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AttachmentOperation"
  ADD CONSTRAINT "AttachmentOperation_transactionId_fkey"
  FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AttachmentOperationFile"
  ADD CONSTRAINT "AttachmentOperationFile_operationId_fkey"
  FOREIGN KEY ("operationId") REFERENCES "AttachmentOperation"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AttachmentOperationFile"
  ADD CONSTRAINT "AttachmentOperationFile_attachmentId_fkey"
  FOREIGN KEY ("attachmentId") REFERENCES "TransactionAttachment"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AttachmentUploadGrant"
  ADD CONSTRAINT "AttachmentUploadGrant_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

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
    )
  );
ALTER TABLE "AttachmentBlobChunk"
  ADD CONSTRAINT "AttachmentBlobChunk_bounded"
  CHECK (
    "ordinal" >= 0
    AND octet_length("content") BETWEEN 1 AND 1048576
  );
ALTER TABLE "AttachmentOperation"
  ADD CONSTRAINT "AttachmentOperation_positive_batch"
  CHECK ("fileCount" BETWEEN 1 AND 20 AND "totalBytes" >= 0);
ALTER TABLE "AttachmentUploadGrant"
  ADD CONSTRAINT "AttachmentUploadGrant_bounds"
  CHECK (
    "maxFileCount" BETWEEN 1 AND 20
    AND "maxBytes" BETWEEN 1 AND 100000000
  );
