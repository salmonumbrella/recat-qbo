-- Inherited authority is valid only after the parent attempt is durably
-- VERIFIED. Replacement legs are inserted after their child coordinator and
-- therefore cannot be checked here.
CREATE OR REPLACE FUNCTION "enforce_qbo_transfer_retry_inheritance"()
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
       )
       OR (
           NEW."firstAttemptRequestId" = parent."firstAttemptRequestId"
           AND NOT EXISTS (
               SELECT 1
                 FROM "QboMutationAttempt"
                WHERE "requestId" = parent."firstAttemptRequestId"
                  AND "status" = 'VERIFIED'
           )
       )
       OR (
           NEW."secondAttemptRequestId" = parent."secondAttemptRequestId"
           AND NOT EXISTS (
               SELECT 1
                 FROM "QboMutationAttempt"
                WHERE "requestId" = parent."secondAttemptRequestId"
                  AND "status" = 'VERIFIED'
           )
       ) THEN
        RAISE EXCEPTION 'Invalid transfer retry inheritance';
    END IF;

    RETURN NEW;
END;
$$;
