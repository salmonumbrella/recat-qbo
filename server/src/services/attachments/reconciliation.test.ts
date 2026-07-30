import { describe, expect, it } from 'vitest';
import { findExactMarkerMatches } from './reconciliation.js';

describe('attachment marker reconciliation', () => {
  const ref = { qboType: 'Purchase' as const, qboId: 'P1' };

  it('matches only the exact opaque Recat marker note', () => {
    const rows = [
      {
        id: 'A1',
        syncToken: '0',
        filename: 'one.pdf',
        contentType: 'application/pdf',
        sizeBytes: 10,
        note: 'Recat reference: exact-marker',
        refs: [ref],
      },
      {
        id: 'A2',
        syncToken: '0',
        filename: 'two.pdf',
        contentType: 'application/pdf',
        sizeBytes: 10,
        note: 'prefix Recat reference: exact-marker suffix',
        refs: [ref],
      },
      {
        id: 'A3',
        syncToken: '0',
        filename: 'three.pdf',
        contentType: 'application/pdf',
        sizeBytes: 10,
        note: 'Recat reference: other-marker',
        refs: [ref],
      },
    ];

    expect(findExactMarkerMatches(rows, 'exact-marker').map((row) => row.id))
      .toEqual(['A1']);
  });

  it('preserves multiple exact matches for fail-closed ambiguity handling', () => {
    const duplicate = {
      id: 'A1',
      syncToken: '0',
      filename: 'one.pdf',
      contentType: 'application/pdf',
      sizeBytes: 10,
      note: 'Recat reference: duplicate-marker',
      refs: [ref],
    };

    expect(findExactMarkerMatches(
      [duplicate, { ...duplicate, id: 'A2' }],
      'duplicate-marker',
    )).toHaveLength(2);
  });
});
