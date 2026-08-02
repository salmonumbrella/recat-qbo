-- CreateEnum
CREATE TYPE "ReceiptDocumentStatus" AS ENUM ('RECEIVED', 'QUEUED', 'PROCESSING', 'NEEDS_REVIEW', 'READY', 'MATCHED', 'ATTACHING', 'ATTACHED', 'FAILED');

-- CreateEnum
CREATE TYPE "ReceiptSourceKind" AS ENUM ('WEB_UPLOAD', 'API_UPLOAD', 'MCP_UPLOAD');

-- CreateTable
CREATE TABLE "ReceiptDocument" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "blobId" TEXT,
    "originalFilename" VARCHAR(255) NOT NULL,
    "contentType" VARCHAR(120) NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "sourceKind" "ReceiptSourceKind" NOT NULL,
    "sourceExternalId" VARCHAR(200),
    "status" "ReceiptDocumentStatus" NOT NULL DEFAULT 'RECEIVED',
    "generation" INTEGER NOT NULL DEFAULT 1,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "pageCount" INTEGER,
    "retainLocally" BOOLEAN NOT NULL DEFAULT true,
    "userNotes" TEXT,
    "manuallyEdited" BOOLEAN NOT NULL DEFAULT false,
    "lastExportedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "matchedTransactionId" TEXT,
    "matchedTransactionRevision" INTEGER,
    "transactionAttachmentId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvedByUserId" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReceiptDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceiptProcessingJob" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "configVersion" CHAR(64) NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "lockOwner" VARCHAR(200),
    "leaseExpiresAt" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastErrorCode" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReceiptProcessingJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceiptIntakeOperation" (
    "id" TEXT NOT NULL,
    "actorKey" VARCHAR(160) NOT NULL,
    "companyId" TEXT NOT NULL,
    "idempotencyKey" VARCHAR(128) NOT NULL,
    "requestHash" CHAR(64) NOT NULL,
    "receiptIds" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReceiptIntakeOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceiptExtractionAttempt" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "attemptCount" INTEGER NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "result" JSONB,
    "receiptDate" DATE,
    "documentTitle" VARCHAR(500),
    "vendorName" VARCHAR(500),
    "vendorTaxId" VARCHAR(200),
    "vendorReceiptId" VARCHAR(200),
    "clientName" VARCHAR(500),
    "clientTaxId" VARCHAR(200),
    "description" TEXT,
    "lineItems" JSONB,
    "subtotal" DECIMAL(18,4),
    "taxAmount" DECIMAL(18,4),
    "totalAmount" DECIMAL(18,4),
    "currency" VARCHAR(3),
    "convertedAmount" DECIMAL(18,4),
    "conversionRate" DECIMAL(18,8),
    "paymentMethod" VARCHAR(80),
    "paymentIdentifier" VARCHAR(200),
    "language" VARCHAR(16),
    "additionalFields" JSONB,
    "rawExtractedText" TEXT,
    "documentType" VARCHAR(80),
    "category" VARCHAR(500),
    "extractionConfidence" DECIMAL(5,4),
    "taxComponents" JSONB,
    "parseSalvaged" BOOLEAN NOT NULL DEFAULT false,
    "warnings" JSONB,
    "model" VARCHAR(200) NOT NULL,
    "promptVersion" VARCHAR(120) NOT NULL,
    "schemaVersion" VARCHAR(120) NOT NULL,
    "tokensIn" INTEGER NOT NULL DEFAULT 0,
    "tokensOut" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DECIMAL(14,8),
    "durationMs" INTEGER,
    "errorCode" VARCHAR(64),
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "search_vector" tsvector GENERATED ALWAYS AS (
        to_tsvector(
            'simple',
            coalesce("documentTitle", '') || ' ' ||
            coalesce("vendorName", '') || ' ' ||
            coalesce("vendorTaxId", '') || ' ' ||
            coalesce("vendorReceiptId", '') || ' ' ||
            coalesce("description", '') || ' ' ||
            coalesce("rawExtractedText", '') || ' ' ||
            coalesce("currency", '')
        )
    ) STORED,

    CONSTRAINT "ReceiptExtractionAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceiptMatchCandidate" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "extractionAttemptId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "transactionRevision" INTEGER NOT NULL,
    "score" INTEGER NOT NULL,
    "evidence" JSONB NOT NULL,
    "rank" INTEGER NOT NULL,
    "state" VARCHAR(16) NOT NULL DEFAULT 'proposed',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReceiptMatchCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceiptCompanyConfig" (
    "companyId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "provider" VARCHAR(32) NOT NULL DEFAULT 'openrouter',
    "model" VARCHAR(200) NOT NULL DEFAULT 'openai/gpt-4o-mini',
    "confidenceThreshold" DECIMAL(5,4) NOT NULL DEFAULT 0.8,
    "autoMatchThreshold" INTEGER NOT NULL DEFAULT 85,
    "autoMatchMargin" INTEGER NOT NULL DEFAULT 15,
    "maxPages" INTEGER NOT NULL DEFAULT 20,
    "configVersion" CHAR(64) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReceiptCompanyConfig_pkey" PRIMARY KEY ("companyId")
);

-- CreateTable
CREATE TABLE "ReceiptEvent" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "action" VARCHAR(64) NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReceiptEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReceiptDocument_transactionAttachmentId_key" ON "ReceiptDocument"("transactionAttachmentId");

-- CreateIndex
CREATE INDEX "ReceiptDocument_companyId_status_createdAt_idx" ON "ReceiptDocument"("companyId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ReceiptDocument_companyId_deletedAt_createdAt_idx" ON "ReceiptDocument"("companyId", "deletedAt", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReceiptDocument_companyId_blobId_key" ON "ReceiptDocument"("companyId", "blobId");

-- CreateIndex
CREATE UNIQUE INDEX "ReceiptDocument_companyId_sha256_key" ON "ReceiptDocument"("companyId", "sha256");

-- CreateIndex
CREATE UNIQUE INDEX "ReceiptDocument_companyId_sourceKind_sourceExternalId_key" ON "ReceiptDocument"("companyId", "sourceKind", "sourceExternalId");

-- CreateIndex
CREATE INDEX "ReceiptProcessingJob_status_dueAt_idx" ON "ReceiptProcessingJob"("status", "dueAt");

-- CreateIndex
CREATE INDEX "ReceiptProcessingJob_companyId_status_idx" ON "ReceiptProcessingJob"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ReceiptProcessingJob_documentId_generation_key" ON "ReceiptProcessingJob"("documentId", "generation");

-- CreateIndex
CREATE INDEX "ReceiptIntakeOperation_companyId_createdAt_idx" ON "ReceiptIntakeOperation"("companyId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReceiptIntakeOperation_actorKey_companyId_idempotencyKey_key" ON "ReceiptIntakeOperation"("actorKey", "companyId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "ReceiptExtractionAttempt_documentId_generation_idx" ON "ReceiptExtractionAttempt"("documentId", "generation");

-- CreateIndex
CREATE INDEX "ReceiptExtractionAttempt_documentId_completedAt_idx" ON "ReceiptExtractionAttempt"("documentId", "completedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReceiptExtractionAttempt_jobId_attemptCount_key" ON "ReceiptExtractionAttempt"("jobId", "attemptCount");

-- CreateIndex
CREATE INDEX "ReceiptExtractionAttempt_search_vector_idx" ON "ReceiptExtractionAttempt" USING GIN ("search_vector");

-- CreateIndex
CREATE INDEX "ReceiptMatchCandidate_documentId_rank_idx" ON "ReceiptMatchCandidate"("documentId", "rank");

-- CreateIndex
CREATE INDEX "ReceiptMatchCandidate_transactionId_state_idx" ON "ReceiptMatchCandidate"("transactionId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "ReceiptMatchCandidate_extractionAttemptId_transactionId_key" ON "ReceiptMatchCandidate"("extractionAttemptId", "transactionId");

-- CreateIndex
CREATE INDEX "ReceiptEvent_documentId_createdAt_idx" ON "ReceiptEvent"("documentId", "createdAt");

-- CreateIndex
CREATE INDEX "ReceiptEvent_companyId_createdAt_idx" ON "ReceiptEvent"("companyId", "createdAt");

-- AddForeignKey
ALTER TABLE "ReceiptDocument" ADD CONSTRAINT "ReceiptDocument_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptDocument" ADD CONSTRAINT "ReceiptDocument_blobId_fkey" FOREIGN KEY ("blobId") REFERENCES "AttachmentBlob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptDocument" ADD CONSTRAINT "ReceiptDocument_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptDocument" ADD CONSTRAINT "ReceiptDocument_matchedTransactionId_fkey" FOREIGN KEY ("matchedTransactionId") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptDocument" ADD CONSTRAINT "ReceiptDocument_transactionAttachmentId_fkey" FOREIGN KEY ("transactionAttachmentId") REFERENCES "TransactionAttachment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptDocument" ADD CONSTRAINT "ReceiptDocument_approvedByUserId_fkey" FOREIGN KEY ("approvedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptProcessingJob" ADD CONSTRAINT "ReceiptProcessingJob_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "ReceiptDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptProcessingJob" ADD CONSTRAINT "ReceiptProcessingJob_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptIntakeOperation" ADD CONSTRAINT "ReceiptIntakeOperation_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptExtractionAttempt" ADD CONSTRAINT "ReceiptExtractionAttempt_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ReceiptProcessingJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptExtractionAttempt" ADD CONSTRAINT "ReceiptExtractionAttempt_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "ReceiptDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptMatchCandidate" ADD CONSTRAINT "ReceiptMatchCandidate_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "ReceiptDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptMatchCandidate" ADD CONSTRAINT "ReceiptMatchCandidate_extractionAttemptId_fkey" FOREIGN KEY ("extractionAttemptId") REFERENCES "ReceiptExtractionAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptMatchCandidate" ADD CONSTRAINT "ReceiptMatchCandidate_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptCompanyConfig" ADD CONSTRAINT "ReceiptCompanyConfig_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptEvent" ADD CONSTRAINT "ReceiptEvent_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptEvent" ADD CONSTRAINT "ReceiptEvent_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "ReceiptDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptEvent" ADD CONSTRAINT "ReceiptEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddCheckConstraint
ALTER TABLE "ReceiptProcessingJob"
    ADD CONSTRAINT "ReceiptProcessingJob_status_check"
    CHECK ("status" IN ('queued', 'running', 'retry', 'completed', 'terminal', 'cancelled'));

-- AddCheckConstraint
ALTER TABLE "ReceiptExtractionAttempt"
    ADD CONSTRAINT "ReceiptExtractionAttempt_status_check"
    CHECK ("status" IN ('running', 'succeeded', 'failed'));

-- AddCheckConstraint
ALTER TABLE "ReceiptMatchCandidate"
    ADD CONSTRAINT "ReceiptMatchCandidate_state_check"
    CHECK ("state" IN ('proposed', 'rejected', 'confirmed', 'stale'));
