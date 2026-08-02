// Create-only security audit writer. Its narrow input is the allowlist:
// there is deliberately no arbitrary metadata field where secrets can leak.

const SAFE_PREFIX = /^[A-Za-z0-9_-]{4,16}$/;
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type SecurityAuditAction = 'mcp_token.created' | 'mcp_token.revoked';

export interface SecurityAuditInput {
  actorUserId: string;
  action: SecurityAuditAction;
  subjectId: string;
  subjectPrefix: string;
}

export interface SecurityAuditWriter {
  securityAuditEvent: {
    create(args: {
      data: {
        actorUserId: string;
        action: SecurityAuditAction;
        subjectId: string;
        subjectPrefix: string;
      };
    }): Promise<unknown>;
  };
}

export async function writeSecurityAudit(
  db: SecurityAuditWriter,
  input: SecurityAuditInput,
): Promise<void> {
  if (!CANONICAL_UUID.test(input.actorUserId) || !CANONICAL_UUID.test(input.subjectId)) {
    throw new Error('Security audit actor and subject require canonical UUIDs');
  }
  if (!SAFE_PREFIX.test(input.subjectPrefix)) {
    throw new Error('Security audit requires a safe token prefix');
  }
  await db.securityAuditEvent.create({
    data: {
      actorUserId: input.actorUserId,
      action: input.action,
      subjectId: input.subjectId,
      subjectPrefix: input.subjectPrefix,
    },
  });
}
