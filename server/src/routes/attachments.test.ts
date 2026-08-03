import { describe, expect, it } from 'vitest';
import {
  attachmentActorForUser,
  attachmentContentDisposition,
  parseAttachmentGrantBearer,
} from './attachments.js';

describe('attachment route safety helpers', () => {
  it('builds a stable session actor without email or display-name data', () => {
    const actor = attachmentActorForUser({
      id: 'user-1',
      isInstanceAdmin: false,
      memberships: [{ companyId: 'company-1', role: 'categorizer' }],
    });

    expect(actor).toEqual({
      kind: 'session',
      actorKey: 'session:user-1',
      userId: 'user-1',
      isInstanceAdmin: false,
      memberships: [{ companyId: 'company-1', role: 'categorizer' }],
    });
  });

  it('creates an injection-safe RFC 5987 attachment disposition', () => {
    const header = attachmentContentDisposition(
      'invoice"\r\nX-Evil: yes café.pdf',
    );

    expect(header).toContain('attachment;');
    expect(header).not.toContain('\r');
    expect(header).not.toContain('\n');
    expect(header).not.toContain('X-Evil: yes');
    expect(header).toContain("filename*=UTF-8''");
  });

  it('accepts exactly one bounded Bearer token and rejects other schemes', () => {
    expect(parseAttachmentGrantBearer('Bearer opaque_token-123')).toBe(
      'opaque_token-123',
    );
    expect(parseAttachmentGrantBearer('Basic abc')).toBeNull();
    expect(parseAttachmentGrantBearer('Bearer one two')).toBeNull();
    expect(parseAttachmentGrantBearer(undefined)).toBeNull();
  });
});
