ALTER TABLE "McpOperation"
    DROP CONSTRAINT "McpOperation_kind_check";

ALTER TABLE "McpOperation"
    ADD CONSTRAINT "McpOperation_kind_check"
    CHECK ("kind" IN ('categorization', 'transfer', 'undo', 'tax_refund'));

CREATE UNIQUE INDEX "McpOperation_tax_refund_source_key"
    ON "McpOperation" ("companyId", "transactionId")
    WHERE "kind" = 'tax_refund' AND "cancelledAt" IS NULL;
