-- Tenant-local revision events fence semantic generations from canonical
-- writes without serializing writers on one shared state row. Events append
-- between cutovers; successful publication compacts them to its fenced event.
-- pgvector and its derived tables remain optional.
CREATE TABLE "ClassificationCorpusRevision" (
    "revision" BIGSERIAL NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClassificationCorpusRevision_pkey" PRIMARY KEY ("revision"),
    CONSTRAINT "ClassificationCorpusRevision_companyId_fkey"
      FOREIGN KEY ("companyId") REFERENCES "Company"("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "ClassificationCorpusRevision_companyId_revision_idx"
  ON "ClassificationCorpusRevision"("companyId", "revision" DESC);

INSERT INTO "ClassificationCorpusRevision" ("companyId")
SELECT "id" FROM "Company";

CREATE OR REPLACE FUNCTION classification_corpus_create_company_revision()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "ClassificationCorpusRevision" ("companyId") VALUES (NEW."id");
  RETURN NEW;
END;
$$;

CREATE TRIGGER classification_corpus_company_insert
AFTER INSERT ON "Company"
FOR EACH ROW EXECUTE FUNCTION classification_corpus_create_company_revision();

CREATE OR REPLACE FUNCTION classification_corpus_append_company_id()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_company_id TEXT;
  new_company_id TEXT;
  lock_company_id TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN old_company_id := OLD."companyId"; END IF;
  IF TG_OP <> 'DELETE' THEN new_company_id := NEW."companyId"; END IF;

  FOR lock_company_id IN
    SELECT DISTINCT candidate FROM unnest(ARRAY[old_company_id, new_company_id]) candidate
    WHERE candidate IS NOT NULL ORDER BY candidate
  LOOP
    PERFORM pg_advisory_xact_lock_shared(hashtextextended(lock_company_id, 1481988));
  END LOOP;

  IF old_company_id IS NOT NULL THEN
    INSERT INTO "ClassificationCorpusRevision" ("companyId")
    SELECT old_company_id WHERE EXISTS (
      SELECT 1 FROM "Company" WHERE "id" = old_company_id
    );
  END IF;
  IF new_company_id IS NOT NULL AND new_company_id IS DISTINCT FROM old_company_id THEN
    INSERT INTO "ClassificationCorpusRevision" ("companyId")
    SELECT new_company_id WHERE EXISTS (
      SELECT 1 FROM "Company" WHERE "id" = new_company_id
    );
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION classification_corpus_append_company_nickname()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW."id", 1481988));
  INSERT INTO "ClassificationCorpusRevision" ("companyId") VALUES (NEW."id");
  RETURN NEW;
END;
$$;

CREATE TRIGGER classification_corpus_company_nickname
AFTER UPDATE OF "nickname" ON "Company"
FOR EACH ROW WHEN (OLD."nickname" IS DISTINCT FROM NEW."nickname")
EXECUTE FUNCTION classification_corpus_append_company_nickname();

-- Direct documents plus every joined source whose value or eligibility can
-- affect the bounded corpus. Database triggers cover every writer, including
-- rolling or legacy application processes.
CREATE TRIGGER classification_corpus_vendor_identity
AFTER INSERT OR DELETE OR UPDATE OF "displayName", "normalizedName" ON "VendorIdentity"
FOR EACH ROW EXECUTE FUNCTION classification_corpus_append_company_id();
CREATE TRIGGER classification_corpus_vendor_alias
AFTER INSERT OR DELETE OR UPDATE OF "vendorIdentityId", "value", "normalizedValue", "source" ON "VendorAlias"
FOR EACH ROW EXECUTE FUNCTION classification_corpus_append_company_id();
CREATE TRIGGER classification_corpus_vendor_merge
AFTER INSERT OR DELETE OR UPDATE OF "sourceVendorIdentityId", "targetVendorIdentityId" ON "VendorIdentityMerge"
FOR EACH ROW EXECUTE FUNCTION classification_corpus_append_company_id();
CREATE TRIGGER classification_corpus_case
AFTER INSERT OR UPDATE OR DELETE ON "ClassificationCase"
FOR EACH ROW EXECUTE FUNCTION classification_corpus_append_company_id();
CREATE TRIGGER classification_corpus_case_invalidation
AFTER INSERT OR UPDATE OR DELETE ON "ClassificationCaseInvalidation"
FOR EACH ROW EXECUTE FUNCTION classification_corpus_append_company_id();
CREATE TRIGGER classification_corpus_rule
AFTER INSERT OR UPDATE OR DELETE ON "Rule"
FOR EACH ROW EXECUTE FUNCTION classification_corpus_append_company_id();
CREATE TRIGGER classification_corpus_rule_revision
AFTER INSERT OR UPDATE OR DELETE ON "RuleRevision"
FOR EACH ROW EXECUTE FUNCTION classification_corpus_append_company_id();
CREATE TRIGGER classification_corpus_candidate
AFTER INSERT OR UPDATE OR DELETE ON "AutopilotRuleCandidate"
FOR EACH ROW EXECUTE FUNCTION classification_corpus_append_company_id();
CREATE TRIGGER classification_corpus_candidate_evidence
AFTER INSERT OR UPDATE OR DELETE ON "AutopilotRuleCandidateEvidence"
FOR EACH ROW EXECUTE FUNCTION classification_corpus_append_company_id();
CREATE TRIGGER classification_corpus_tag
AFTER UPDATE OF "name" ON "Tag"
FOR EACH ROW EXECUTE FUNCTION classification_corpus_append_company_id();
CREATE TRIGGER classification_corpus_account
AFTER INSERT OR DELETE OR UPDATE OF "name", "fullName" ON "QboAccount"
FOR EACH ROW EXECUTE FUNCTION classification_corpus_append_company_id();
CREATE TRIGGER classification_corpus_tax_code
AFTER INSERT OR DELETE OR UPDATE OF "name" ON "QboTaxCode"
FOR EACH ROW EXECUTE FUNCTION classification_corpus_append_company_id();
CREATE TRIGGER classification_corpus_transaction
AFTER UPDATE OF "payee", "memo" ON "Transaction"
FOR EACH ROW EXECUTE FUNCTION classification_corpus_append_company_id();

-- RuleTag has no companyId column. Resolve the owning rule; a cascade after
-- rule deletion needs no second event because the Rule trigger already wrote
-- the durable revision.
CREATE OR REPLACE FUNCTION classification_corpus_append_rule_tag()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_owner_company_id TEXT;
  new_owner_company_id TEXT;
  lock_company_id TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    SELECT "companyId" INTO old_owner_company_id FROM "Rule" WHERE "id" = OLD."ruleId";
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT "companyId" INTO new_owner_company_id FROM "Rule" WHERE "id" = NEW."ruleId";
  END IF;
  FOR lock_company_id IN
    SELECT DISTINCT candidate
    FROM unnest(ARRAY[old_owner_company_id, new_owner_company_id]) candidate
    WHERE candidate IS NOT NULL ORDER BY candidate
  LOOP
    PERFORM pg_advisory_xact_lock_shared(hashtextextended(lock_company_id, 1481988));
    INSERT INTO "ClassificationCorpusRevision" ("companyId") VALUES (lock_company_id);
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER classification_corpus_rule_tag
AFTER INSERT OR UPDATE OR DELETE ON "RuleTag"
FOR EACH ROW EXECUTE FUNCTION classification_corpus_append_rule_tag();
