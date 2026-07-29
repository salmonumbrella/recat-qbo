ALTER TABLE "McpOperation"
    DROP CONSTRAINT "McpOperation_kind_check";

ALTER TABLE "McpOperation"
    ADD CONSTRAINT "McpOperation_kind_check"
    CHECK ("kind" IN ('categorization', 'transfer', 'undo'));
