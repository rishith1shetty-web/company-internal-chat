'use client';

import { Button } from '@/components/ui/Button';
import { FileIcon } from '@/components/ui/icons';
import { attachmentDownloadUrl } from '@/lib/chat/api';
import { formatFileSize, fileTypeLabel } from '@/lib/chat/format';
import type { AttachmentSummary, PendingUpload } from '@/lib/chat/types';
import { cn } from '@/lib/ui/cn';

/**
 * A file inside a message.
 *
 * Download-only, and the interface says so by having nothing else to offer: no preview, no
 * thumbnail, no player. That is D-10 rather than an omission — rendering an uploaded file inside
 * this page is how an uploaded file becomes an attack on the person reading it, and it would need
 * per-type decisions and an isolated origin to do safely (docs/04-security.md R-07).
 *
 * The filename is rendered as text through React, which escapes it. It is never markup, never a
 * URL, and never a path: the link is built from the attachment's id alone, and the server decides
 * on every request whether this person may have the bytes.
 */
export function AttachmentCard({
  attachment,
  isOwn,
}: {
  attachment: AttachmentSummary;
  isOwn: boolean;
}) {
  return (
    <a
      href={attachmentDownloadUrl(attachment.id)}
      /*
       * `download` asks the browser to save rather than navigate. The server says the same thing
       * far more authoritatively with `Content-Disposition: attachment`; this is the hint that
       * keeps the current page from being replaced while that answer is on its way.
       */
      download={attachment.filename}
      className={cn(
        'flex max-w-full items-center gap-3 rounded-xl border px-3 py-2.5 transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        isOwn
          ? 'border-white/25 bg-white/10 hover:bg-white/20'
          : 'border-line bg-surface hover:bg-surface-muted',
      )}
    >
      <span
        className={cn(
          'flex h-10 w-10 shrink-0 flex-col items-center justify-center rounded-lg',
          isOwn ? 'bg-white/15 text-white' : 'bg-canvas text-ink-muted',
        )}
        aria-hidden="true"
      >
        <FileIcon className="h-4 w-4" />
        <span className="mt-0.5 text-[8px] leading-none font-semibold tracking-wide">
          {fileTypeLabel(attachment)}
        </span>
      </span>

      <span className="min-w-0 flex-1">
        <span
          className={cn(
            'block truncate text-sm font-medium',
            isOwn ? 'text-white' : 'text-ink',
          )}
          title={attachment.filename}
        >
          {attachment.filename}
        </span>
        <span className={cn('block text-xs', isOwn ? 'text-white/75' : 'text-ink-subtle')}>
          {formatFileSize(attachment.byteSize)} · Download
        </span>
      </span>
    </a>
  );
}

/**
 * A file still going up from this browser.
 *
 * Never shown as a message, because it is not one yet: nobody else can see this file, and the
 * card says "Uploading" until the server has committed it. Progress is measured from bytes the
 * browser has actually handed to the network — if it could not be measured it is not drawn,
 * rather than animated to look busy.
 */
export function UploadCard({
  upload,
  onCancel,
  onDismiss,
}: {
  upload: PendingUpload;
  onCancel: () => void;
  onDismiss: () => void;
}) {
  const failed = upload.state === 'FAILED';
  const percent = Math.round(Math.min(Math.max(upload.progress, 0), 1) * 100);

  return (
    <div
      className={cn(
        'mt-3 ml-auto flex max-w-[min(28rem,80%)] items-center gap-3 rounded-xl border px-3 py-2.5',
        failed ? 'border-danger/50 bg-danger/5' : 'border-line bg-surface',
      )}
      role="status"
      aria-live="polite"
    >
      <span
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-canvas text-ink-muted"
        aria-hidden="true"
      >
        <FileIcon className="h-4 w-4" />
      </span>

      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-ink" title={upload.filename}>
          {upload.filename}
        </span>

        {failed ? (
          <span className="block text-xs text-danger">{upload.error ?? 'Not sent.'}</span>
        ) : (
          <>
            <span className="block text-xs text-ink-subtle">
              {formatFileSize(upload.byteSize)} · Uploading… {percent}%
            </span>
            <span
              className="mt-1.5 block h-1 w-full overflow-hidden rounded-full bg-line"
              role="progressbar"
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`Uploading ${upload.filename}`}
            >
              <span
                className="block h-full rounded-full bg-accent transition-[width] duration-200"
                style={{ width: `${percent}%` }}
              />
            </span>
          </>
        )}
      </span>

      <Button size="sm" onClick={failed ? onDismiss : onCancel} className="shrink-0">
        {failed ? 'Dismiss' : 'Cancel'}
      </Button>
    </div>
  );
}
