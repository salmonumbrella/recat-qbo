ALTER TABLE "AgentCompanyConfig"
ADD COLUMN "dailyLiveWriteLimit" INTEGER NOT NULL DEFAULT 25;

CREATE TABLE "LiveWritePermit" (
  "requestId" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "utcDay" DATE NOT NULL,
  "limitAtIssue" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "LiveWritePermit_pkey" PRIMARY KEY ("requestId")
);

CREATE INDEX "LiveWritePermit_companyId_utcDay_idx"
ON "LiveWritePermit"("companyId", "utcDay");

ALTER TABLE "LiveWritePermit"
ADD CONSTRAINT "LiveWritePermit_companyId_fkey"
FOREIGN KEY ("companyId") REFERENCES "Company"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
