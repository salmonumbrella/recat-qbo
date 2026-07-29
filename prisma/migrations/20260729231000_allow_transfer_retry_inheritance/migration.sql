-- A one-child transfer retry may inherit a VERIFIED parent attempt for a leg
-- that is already durable. Replacement legs still use the child coordinator's
-- deterministic request id.
ALTER TABLE "QboTransferOperation"
    DROP CONSTRAINT "QboTransferOperation_firstAttemptRequestId_check",
    DROP CONSTRAINT "QboTransferOperation_secondAttemptRequestId_check";

ALTER TABLE "QboTransferOperation"
    ADD CONSTRAINT "QboTransferOperation_firstAttemptRequestId_check"
        CHECK (char_length("firstAttemptRequestId") BETWEEN 1 AND 128),
    ADD CONSTRAINT "QboTransferOperation_secondAttemptRequestId_check"
        CHECK (char_length("secondAttemptRequestId") BETWEEN 1 AND 128);

CREATE FUNCTION "enforce_qbo_transfer_retry_inheritance"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    parent "QboTransferOperation"%ROWTYPE;
BEGIN
    IF NEW."retryOfId" IS NULL THEN
        IF NEW."firstAttemptRequestId" <> NEW."id" || ':transfer:0'
           OR NEW."secondAttemptRequestId" <> NEW."id" || ':transfer:1' THEN
            RAISE EXCEPTION 'Original transfer attempt ids must belong to the coordinator';
        END IF;
        RETURN NEW;
    END IF;

    SELECT *
      INTO parent
      FROM "QboTransferOperation"
     WHERE "id" = NEW."retryOfId";

    IF NOT FOUND
       OR parent."retryOfId" IS NOT NULL
       OR NEW."actorId" <> parent."actorId"
       OR NEW."companyId" <> parent."companyId"
       OR NEW."firstTransactionId" <> parent."firstTransactionId"
       OR NEW."secondTransactionId" <> parent."secondTransactionId"
       OR NEW."firstAttemptRequestId" NOT IN (
           parent."firstAttemptRequestId",
           NEW."id" || ':transfer:0'
       )
       OR NEW."secondAttemptRequestId" NOT IN (
           parent."secondAttemptRequestId",
           NEW."id" || ':transfer:1'
       )
       OR (
           NEW."firstAttemptRequestId" = parent."firstAttemptRequestId"
           AND NEW."secondAttemptRequestId" = parent."secondAttemptRequestId"
       ) THEN
        RAISE EXCEPTION 'Invalid transfer retry inheritance';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "QboTransferOperation_retry_inheritance"
    BEFORE INSERT ON "QboTransferOperation"
    FOR EACH ROW
    EXECUTE FUNCTION "enforce_qbo_transfer_retry_inheritance"();
