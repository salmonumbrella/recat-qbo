ALTER TABLE "AttachmentOperation"
ADD COLUMN "receiptDocumentId" TEXT;

CREATE INDEX "AttachmentOperation_receiptDocumentId_status_idx"
ON "AttachmentOperation"("receiptDocumentId", "status");

ALTER TABLE "AttachmentOperation"
ADD CONSTRAINT "AttachmentOperation_receiptDocumentId_fkey"
FOREIGN KEY ("receiptDocumentId")
REFERENCES "ReceiptDocument"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;
