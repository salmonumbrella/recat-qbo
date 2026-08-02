-- Opaque MCP bearer tokens: only a SHA-256 digest and a short display prefix
-- are persisted. Every token has a required expiry.
CREATE TABLE "McpToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "digest" CHAR(64) NOT NULL,
    "prefix" VARCHAR(12) NOT NULL,
    "label" VARCHAR(80) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "McpToken_pkey" PRIMARY KEY ("id")
);

-- Append-only security events intentionally have no arbitrary metadata column,
-- so bearer plaintext and digests cannot be recorded here.
CREATE TABLE "SecurityAuditEvent" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "action" VARCHAR(64) NOT NULL,
    "subjectId" VARCHAR(64) NOT NULL,
    "subjectPrefix" VARCHAR(16) NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecurityAuditEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SecurityAuditEvent_actorUserId_uuid_check"
        CHECK ("actorUserId" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
    CONSTRAINT "SecurityAuditEvent_subjectId_uuid_check"
        CHECK ("subjectId" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
    CONSTRAINT "SecurityAuditEvent_action_check"
        CHECK ("action" IN ('mcp_token.created', 'mcp_token.revoked')),
    CONSTRAINT "SecurityAuditEvent_subjectPrefix_check"
        CHECK ("subjectPrefix" ~ '^[A-Za-z0-9_-]{4,16}$')
);

CREATE UNIQUE INDEX "McpToken_digest_key" ON "McpToken"("digest");
CREATE INDEX "McpToken_userId_createdAt_idx" ON "McpToken"("userId", "createdAt");
CREATE INDEX "SecurityAuditEvent_actorUserId_at_idx"
    ON "SecurityAuditEvent"("actorUserId", "at");

ALTER TABLE "McpToken"
    ADD CONSTRAINT "McpToken_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Enforce append-only semantics below the application layer. Attribution and
-- event details cannot be rewritten or removed through Prisma or direct SQL.
CREATE FUNCTION "prevent_security_audit_event_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'SecurityAuditEvent is append-only';
    RETURN NULL;
END;
$$;

CREATE TRIGGER "SecurityAuditEvent_append_only"
    BEFORE UPDATE OR DELETE ON "SecurityAuditEvent"
    FOR EACH ROW
    EXECUTE FUNCTION "prevent_security_audit_event_mutation"();
