-- Immutable transfer coordinator. QboMutationAttempt remains the mutable
-- authority for each leg's write and recovery state.
CREATE UNIQUE INDEX "QboMutationAttempt_active_transaction_key"
    ON "QboMutationAttempt"("transactionId")
    WHERE "status" IN ('PREPARED', 'COMMITTING', 'UNCERTAIN');

CREATE TABLE "QboTransferOperation" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "firstTransactionId" TEXT NOT NULL,
    "secondTransactionId" TEXT NOT NULL,
    "firstExpectedRevision" INTEGER NOT NULL,
    "secondExpectedRevision" INTEGER NOT NULL,
    "firstQboType" VARCHAR(32) NOT NULL,
    "firstQboId" VARCHAR(128) NOT NULL,
    "firstQboSyncToken" VARCHAR(128) NOT NULL,
    "firstTargetAccountQboId" VARCHAR(128) NOT NULL,
    "firstAttemptRequestId" VARCHAR(128) NOT NULL,
    "secondQboType" VARCHAR(32) NOT NULL,
    "secondQboId" VARCHAR(128) NOT NULL,
    "secondQboSyncToken" VARCHAR(128) NOT NULL,
    "secondTargetAccountQboId" VARCHAR(128) NOT NULL,
    "secondAttemptRequestId" VARCHAR(128) NOT NULL,
    "idempotencyHash" CHAR(64) NOT NULL,
    "inputHash" CHAR(64) NOT NULL,
    "preparedHash" CHAR(64) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "retryOfId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QboTransferOperation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "QboTransferOperation_distinct_transactions_check"
        CHECK ("firstTransactionId" <> "secondTransactionId"),
    CONSTRAINT "QboTransferOperation_distinct_qbo_entities_check"
        CHECK (ROW("firstQboType", "firstQboId") <> ROW("secondQboType", "secondQboId")),
    CONSTRAINT "QboTransferOperation_distinct_target_accounts_check"
        CHECK ("firstTargetAccountQboId" <> "secondTargetAccountQboId"),
    CONSTRAINT "QboTransferOperation_firstExpectedRevision_check"
        CHECK ("firstExpectedRevision" >= 0),
    CONSTRAINT "QboTransferOperation_secondExpectedRevision_check"
        CHECK ("secondExpectedRevision" >= 0),
    CONSTRAINT "QboTransferOperation_future_expiry_check"
        CHECK ("expiresAt" > "createdAt"),
    CONSTRAINT "QboTransferOperation_idempotencyHash_check"
        CHECK ("idempotencyHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "QboTransferOperation_inputHash_check"
        CHECK ("inputHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "QboTransferOperation_preparedHash_check"
        CHECK ("preparedHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "QboTransferOperation_firstAttemptRequestId_check"
        CHECK (
            char_length("firstAttemptRequestId") BETWEEN 1 AND 128
            AND "firstAttemptRequestId" = "id" || ':transfer:0'
        ),
    CONSTRAINT "QboTransferOperation_secondAttemptRequestId_check"
        CHECK (
            char_length("secondAttemptRequestId") BETWEEN 1 AND 128
            AND "secondAttemptRequestId" = "id" || ':transfer:1'
        ),
    CONSTRAINT "QboTransferOperation_retry_not_self_check"
        CHECK ("retryOfId" IS NULL OR "retryOfId" <> "id")
);

CREATE UNIQUE INDEX "QboTransferOperation_retryOfId_key"
    ON "QboTransferOperation"("retryOfId");
CREATE INDEX "QboTransferOperation_companyId_firstTransactionId_secondTransactionId_idx"
    ON "QboTransferOperation"("companyId", "firstTransactionId", "secondTransactionId");
CREATE UNIQUE INDEX "QboTransferOperation_actorId_companyId_firstTransactionId_secondTransactionId_idempotencyHash_key"
    ON "QboTransferOperation"(
        "actorId",
        "companyId",
        "firstTransactionId",
        "secondTransactionId",
        "idempotencyHash"
    );

-- No cascading foreign keys: the coordinator retains actor, target, and QBO
-- recovery identities even if the corresponding application records vanish.
CREATE FUNCTION "enforce_qbo_transfer_operation_future_expiry"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW."expiresAt" <= clock_timestamp() THEN
        RAISE EXCEPTION 'QboTransferOperation expiry must be in the future at insert';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "QboTransferOperation_future_expiry"
    BEFORE INSERT ON "QboTransferOperation"
    FOR EACH ROW
    EXECUTE FUNCTION "enforce_qbo_transfer_operation_future_expiry"();

CREATE FUNCTION "enforce_qbo_transfer_operation_immutability"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'QboTransferOperation is immutable';
    RETURN NULL;
END;
$$;

CREATE TRIGGER "QboTransferOperation_immutable"
    BEFORE UPDATE OR DELETE ON "QboTransferOperation"
    FOR EACH ROW
    EXECUTE FUNCTION "enforce_qbo_transfer_operation_immutability"();
