CREATE TYPE "AttachmentOperationKind" AS ENUM (
  'ATTACH',
  'DELETE_LOCAL',
  'DELETE_EVERYWHERE'
);

ALTER TABLE "AttachmentOperation"
ADD COLUMN "kind" "AttachmentOperationKind" NOT NULL DEFAULT 'ATTACH',
ADD COLUMN "requestHash" CHAR(64) NOT NULL;
