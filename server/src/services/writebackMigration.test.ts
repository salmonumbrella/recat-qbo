import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('legacy durable restore migration', () => {
  it('requeues transactions stranded in REVERTED and clears terminal metadata', () => {
    const migration = readFileSync(
      new URL(
        '../../../prisma/migrations/20260902130000_requeue_legacy_reverted_transactions/migration.sql',
        import.meta.url,
      ),
      'utf8',
    );

    expect(migration).toContain('UPDATE "Transaction"');
    expect(migration).toContain('SET "status" = \'PENDING\'');
    expect(migration).toContain('"postedAt" = NULL');
    expect(migration).toContain('"postedByUserId" = NULL');
    expect(migration).toContain('"errorCode" = NULL');
    expect(migration).toContain('"errorMessage" = NULL');
    expect(migration).toContain('"updatedAt" = CURRENT_TIMESTAMP');
    expect(migration).toContain('WHERE "status" = \'REVERTED\'');
  });
});
