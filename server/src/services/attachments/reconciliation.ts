import type { QboAttachable } from '../../lib/qbo/types.js';

export function findExactMarkerMatches(
  attachments: readonly QboAttachable[],
  marker: string,
): QboAttachable[] {
  const expected = `Recat reference: ${marker}`;
  return attachments.filter((attachment) => attachment.note === expected);
}
