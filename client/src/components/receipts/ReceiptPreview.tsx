import type { ReceiptDto } from '@recat/shared';
import { receipts } from '../../lib/api';

interface ReceiptPreviewProps {
  companyId: string;
  receipt: ReceiptDto;
}

export default function ReceiptPreview({
  companyId,
  receipt,
}: ReceiptPreviewProps) {
  const url = receipts.previewUrl(companyId, receipt.id);
  if (receipt.contentType === 'application/pdf') {
    return (
      <iframe
        title="Receipt preview"
        src={url}
        sandbox=""
        referrerPolicy="no-referrer"
        style={{ width: '100%', minHeight: 640, border: 0 }}
      />
    );
  }
  if (receipt.contentType.startsWith('image/')) {
    return (
      <img
        title="Receipt preview"
        src={url}
        alt={`Preview of ${receipt.filename}`}
        referrerPolicy="no-referrer"
        style={{ maxWidth: '100%', maxHeight: '75vh', objectFit: 'contain' }}
      />
    );
  }
  return (
    <div style={{ padding: 24, color: 'var(--mut)' }}>
      Preview is unavailable for this file type.{' '}
      <a href={receipts.fileUrl(companyId, receipt.id)}>Download original</a>
    </div>
  );
}
