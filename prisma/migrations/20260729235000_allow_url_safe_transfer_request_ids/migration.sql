-- Intuit limits requestid to 50 URL characters. The original ":transfer:N"
-- suffix expands when percent-encoded, so new coordinators use the compact
-- URL-safe "-tN" form. Retain the legacy form for already-prepared evidence.
CREATE OR REPLACE FUNCTION "enforce_qbo_transfer_retry_inheritance"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    parent "QboTransferOperation"%ROWTYPE;
BEGIN
    IF NEW."retryOfId" IS NULL THEN
        IF NOT (
            (
                NEW."firstAttemptRequestId" = NEW."id" || '-t0'
                AND NEW."secondAttemptRequestId" = NEW."id" || '-t1'
            )
            OR (
                NEW."firstAttemptRequestId" = NEW."id" || ':transfer:0'
                AND NEW."secondAttemptRequestId" = NEW."id" || ':transfer:1'
            )
        ) THEN
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
           NEW."id" || '-t0',
           NEW."id" || ':transfer:0'
       )
       OR NEW."secondAttemptRequestId" NOT IN (
           parent."secondAttemptRequestId",
           NEW."id" || '-t1',
           NEW."id" || ':transfer:1'
       )
       OR (
           NEW."firstAttemptRequestId" = parent."firstAttemptRequestId"
           AND NEW."secondAttemptRequestId" = parent."secondAttemptRequestId"
       )
       OR (
           NEW."firstAttemptRequestId" = parent."firstAttemptRequestId"
           AND (
               NEW."firstExpectedRevision" <> parent."firstExpectedRevision"
               OR NEW."firstQboType" <> parent."firstQboType"
               OR NEW."firstQboId" <> parent."firstQboId"
               OR NEW."firstQboSyncToken" <> parent."firstQboSyncToken"
               OR NEW."firstTargetAccountQboId"
                    <> parent."firstTargetAccountQboId"
           )
       )
       OR (
           NEW."secondAttemptRequestId" = parent."secondAttemptRequestId"
           AND (
               NEW."secondExpectedRevision" <> parent."secondExpectedRevision"
               OR NEW."secondQboType" <> parent."secondQboType"
               OR NEW."secondQboId" <> parent."secondQboId"
               OR NEW."secondQboSyncToken" <> parent."secondQboSyncToken"
               OR NEW."secondTargetAccountQboId"
                    <> parent."secondTargetAccountQboId"
           )
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
