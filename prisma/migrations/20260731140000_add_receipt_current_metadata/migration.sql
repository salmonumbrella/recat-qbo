ALTER TABLE "ReceiptDocument"
ADD COLUMN "currentMetadata" JSONB NOT NULL DEFAULT '{}'::jsonb;
