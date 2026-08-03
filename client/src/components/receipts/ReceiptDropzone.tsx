import { useRef, useState } from 'react';
import type { CSSProperties } from 'react';

const ACCEPTED = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/tiff',
]);

export interface ReceiptDropzoneProps {
  disabled?: boolean;
  disabledLabel?: string;
  onFiles(files: File[]): void;
}

export default function ReceiptDropzone({
  disabled = false,
  disabledLabel = 'Uploading receipts…',
  onFiles,
}: ReceiptDropzoneProps) {
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const accept = (files: FileList | File[]) => {
    const values = [...files];
    if (values.length < 1 || values.length > 20) {
      setError('Choose between 1 and 20 files.');
      return;
    }
    if (values.some((file) => !ACCEPTED.has(file.type))) {
      setError('Use PDF, JPEG, PNG, GIF, or TIFF files.');
      return;
    }
    setError(null);
    onFiles(values);
  };

  const style: CSSProperties = {
    display: 'block',
    border: `2px dashed ${dragging ? 'var(--acc)' : 'var(--bd2)'}`,
    borderRadius: 12,
    padding: '22px 18px',
    textAlign: 'center',
    background: dragging ? 'var(--hl)' : 'var(--card)',
    color: disabled ? 'var(--fnt)' : 'var(--ink)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.65 : 1,
  };

  return (
    <div>
      <label
        className="receipt-dropzone"
        aria-label="Drop receipt files"
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
        onKeyDown={(event) => {
          if (!disabled && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (!disabled) accept(event.dataTransfer.files);
        }}
        style={style}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".pdf,.jpg,.jpeg,.png,.gif,.tif,.tiff"
          disabled={disabled}
          onChange={(event) => {
            if (event.target.files) accept(event.target.files);
            event.target.value = '';
          }}
          style={{
            position: 'absolute',
            width: 1,
            height: 1,
            overflow: 'hidden',
            clip: 'rect(0 0 0 0)',
          }}
        />
        {disabled ? disabledLabel : 'Choose receipt files or drop them here'}
      </label>
      {error && (
        <div role="alert" style={{ color: 'var(--red)', fontSize: 13, marginTop: 6 }}>
          {error}
        </div>
      )}
    </div>
  );
}
