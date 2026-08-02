-- Immutable MCP preparation envelope. QboMutationAttempt remains the sole
-- authority for QBO write status and recovery.
CREATE TABLE "McpOperation" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "tokenPrefix" VARCHAR(12) NOT NULL,
    "userId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "toolName" VARCHAR(64) NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "idempotencyKey" VARCHAR(128),
    "inputHash" CHAR(64) NOT NULL,
    "payload" JSONB NOT NULL,
    "payloadHash" CHAR(64) NOT NULL,
    "sourceRevision" INTEGER NOT NULL,
    "preparedRevision" INTEGER NOT NULL,
    "qboType" VARCHAR(32) NOT NULL,
    "qboId" VARCHAR(128) NOT NULL,
    "qboSyncToken" VARCHAR(128) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "retryOfId" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "McpOperation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "McpOperation_kind_check"
        CHECK ("kind" IN ('categorization', 'undo')),
    CONSTRAINT "McpOperation_sourceRevision_check"
        CHECK ("sourceRevision" >= 0),
    CONSTRAINT "McpOperation_preparedRevision_check"
        CHECK ("preparedRevision" >= 0),
    CONSTRAINT "McpOperation_inputHash_check"
        CHECK ("inputHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "McpOperation_payloadHash_check"
        CHECK ("payloadHash" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "McpOperation_retryOfId_key"
    ON "McpOperation"("retryOfId");
CREATE INDEX "McpOperation_tokenId_createdAt_idx"
    ON "McpOperation"("tokenId", "createdAt");
CREATE INDEX "McpOperation_userId_createdAt_idx"
    ON "McpOperation"("userId", "createdAt");
CREATE INDEX "McpOperation_companyId_transactionId_idx"
    ON "McpOperation"("companyId", "transactionId");
CREATE UNIQUE INDEX "McpOperation_tokenId_toolName_transactionId_idempotencyKey_key"
    ON "McpOperation"("tokenId", "toolName", "transactionId", "idempotencyKey");

-- Attribution and target fields intentionally have no foreign keys. Existing
-- token/user deletion cascades must not be blocked and must not erase history.

-- The envelope is immutable below the application layer. The only permitted
-- update is the first cancellation timestamp (plus Prisma's updatedAt value).
CREATE FUNCTION "enforce_mcp_operation_immutability"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'UPDATE'
       AND OLD."cancelledAt" IS NULL
       AND NEW."cancelledAt" IS NOT NULL
       AND ROW(
           NEW."id",
           NEW."tokenId",
           NEW."tokenPrefix",
           NEW."userId",
           NEW."companyId",
           NEW."transactionId",
           NEW."toolName",
           NEW."kind",
           NEW."idempotencyKey",
           NEW."inputHash",
           NEW."payload",
           NEW."payloadHash",
           NEW."sourceRevision",
           NEW."preparedRevision",
           NEW."qboType",
           NEW."qboId",
           NEW."qboSyncToken",
           NEW."expiresAt",
           NEW."retryOfId",
           NEW."createdAt"
       ) IS NOT DISTINCT FROM ROW(
           OLD."id",
           OLD."tokenId",
           OLD."tokenPrefix",
           OLD."userId",
           OLD."companyId",
           OLD."transactionId",
           OLD."toolName",
           OLD."kind",
           OLD."idempotencyKey",
           OLD."inputHash",
           OLD."payload",
           OLD."payloadHash",
           OLD."sourceRevision",
           OLD."preparedRevision",
           OLD."qboType",
           OLD."qboId",
           OLD."qboSyncToken",
           OLD."expiresAt",
           OLD."retryOfId",
           OLD."createdAt"
       )
    THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'McpOperation immutable fields cannot be changed';
    RETURN NULL;
END;
$$;

CREATE TRIGGER "McpOperation_immutable"
    BEFORE UPDATE OR DELETE ON "McpOperation"
    FOR EACH ROW
    EXECUTE FUNCTION "enforce_mcp_operation_immutability"();
