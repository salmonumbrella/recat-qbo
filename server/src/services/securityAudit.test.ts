import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { writeSecurityAudit, type SecurityAuditWriter } from './securityAudit.js';

describe('writeSecurityAudit', () => {
  it('appends only bounded allowlisted token metadata', async () => {
    const create = vi.fn(async () => ({ id: 'event-id' }));
    const db: SecurityAuditWriter = { securityAuditEvent: { create } };

    await writeSecurityAudit(db, {
      actorUserId: '10000000-0000-4000-8000-000000000001',
      action: 'mcp_token.created',
      subjectId: '20000000-0000-4000-8000-000000000001',
      subjectPrefix: 'rct_example',
    });

    expect(create).toHaveBeenCalledWith({
      data: {
        actorUserId: '10000000-0000-4000-8000-000000000001',
        action: 'mcp_token.created',
        subjectId: '20000000-0000-4000-8000-000000000001',
        subjectPrefix: 'rct_example',
      },
    });
    expect(JSON.stringify(create.mock.calls)).not.toMatch(/plaintext|digest|bearer|metadata/i);
  });

  it('rejects an unsafe prefix before writing', async () => {
    const create = vi.fn();
    const db: SecurityAuditWriter = { securityAuditEvent: { create } };

    await expect(
      writeSecurityAudit(db, {
        actorUserId: '10000000-0000-4000-8000-000000000001',
        action: 'mcp_token.revoked',
        subjectId: '20000000-0000-4000-8000-000000000001',
        subjectPrefix: 'unsafe prefix with spaces',
      }),
    ).rejects.toThrow('safe token prefix');
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects non-canonical actor and subject UUIDs before writing', async () => {
    const create = vi.fn();
    const db: SecurityAuditWriter = { securityAuditEvent: { create } };
    const invalidIds = [
      'rct_not-an-actor',
      'a'.repeat(64),
      'abcdefab-cdef-4abc-8abc-abcdefabcdef'.toUpperCase(),
      '10000000-0000-0000-0000-000000000001',
    ];

    for (const invalidId of invalidIds) {
      await expect(
        writeSecurityAudit(db, {
          actorUserId: invalidId,
          action: 'mcp_token.created',
          subjectId: '20000000-0000-4000-8000-000000000001',
          subjectPrefix: 'rct_example',
        }),
      ).rejects.toThrow('canonical UUID');
      await expect(
        writeSecurityAudit(db, {
          actorUserId: '10000000-0000-4000-8000-000000000001',
          action: 'mcp_token.created',
          subjectId: invalidId,
          subjectPrefix: 'rct_example',
        }),
      ).rejects.toThrow('canonical UUID');
    }
    expect(create).not.toHaveBeenCalled();
  });

  it('defines immutable attribution, bounded checks, and an append-only database trigger', () => {
    const migration = readFileSync(
      new URL(
        '../../../prisma/migrations/20260728210000_add_mcp_tokens/migration.sql',
        import.meta.url,
      ),
      'utf8',
    );

    expect(migration).toMatch(/"actorUserId" TEXT NOT NULL/);
    expect(migration).not.toMatch(/SecurityAuditEvent_actorUserId_fkey|ON DELETE SET NULL/);
    expect(migration).toMatch(/SecurityAuditEvent_actorUserId_uuid_check/);
    expect(migration).toMatch(/SecurityAuditEvent_subjectId_uuid_check/);
    expect(migration).toMatch(/SecurityAuditEvent_action_check/);
    expect(migration).toMatch(/SecurityAuditEvent_subjectPrefix_check/);
    expect(migration).toMatch(/CREATE FUNCTION "prevent_security_audit_event_mutation"/);
    expect(migration).toMatch(/BEFORE UPDATE OR DELETE ON "SecurityAuditEvent"/);
  });
});
