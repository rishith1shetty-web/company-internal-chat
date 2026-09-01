/**
 * GET /api/attachments/:id/download — the only way a file leaves this server.
 *
 * There is no static route to the storage directory, no signed URL, and no path parameter. The
 * browser has an attachment id; everything else — which conversation it belongs to, where the
 * bytes are, whether this person may have them — is re-derived here, on every request. Knowing an
 * id is not access (`CLAUDE.md` §9, §20).
 *
 * Two authorization checks, not one, and the second is the one that is easy to leave out:
 *
 *   1. The caller is an active member of the conversation the file's MESSAGE belongs to.
 *   2. That message was sent at or after the caller's `joinedAt` (D-03).
 *
 * Without (2) a colleague added to a group today could read every file ever shared in it by
 * asking for the file rather than the message — the same leak D-03 closes for history, reopened
 * through a different door. That is risk R-14, and `loadAttachmentForDownload` is where it is
 * closed.
 *
 * Every refusal is 404 and says the same thing. Distinguishing "no such file" from "not yours"
 * from "before you joined" would confirm that an id exists and roughly when it was sent, which is
 * most of what somebody guessing ids wants to know.
 *
 * The response is always a download. Never inline, never with a type the browser might act on —
 * see `downloadContentType`.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { getDb } from '@/lib/db/prisma';
import {
  AttachmentError,
  contentDispositionFor,
  downloadContentType,
  loadAttachmentForDownload,
} from '@/lib/files/service';
import { openStoredFile, statStoredFile } from '@/lib/files/storage';
import {
  apiError,
  routeLogger as logger,
  storageConfig,
  withIdentity,
} from '@/lib/http/route-helpers';

export const dynamic = 'force-dynamic';

const uuid = z.uuid({ version: 'v4' });

/** One answer for every refusal. See the note above. */
function unavailable(): NextResponse {
  return apiError(404, 'NOT_FOUND', 'That file is not available.');
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return withIdentity(request, async (current) => {
    const { id } = await context.params;
    if (!uuid.safeParse(id).success) return unavailable();

    let authorized;
    try {
      authorized = await loadAttachmentForDownload(getDb(), current.userId, id);
    } catch (error) {
      if (error instanceof AttachmentError) return unavailable();
      throw error;
    }

    const { attachment } = authorized;
    const config = storageConfig;

    /*
     * The row exists and the caller may have the file — but the bytes may not be there: a restore
     * that missed the storage directory, a disk replaced, a file removed by hand. Checked before
     * streaming so the answer is a clean 404 rather than a half-sent response that fails partway
     * through and looks to the browser like a corrupt file.
     */
    const stats = await statStoredFile(config, attachment.storageKey);
    if (!stats) {
      // Logged as an error because it means storage and the database disagree, which an operator
      // needs to know about. The employee is told the file is unavailable and nothing else.
      logger.error('Attachment row has no file behind it', { attachmentId: attachment.id });
      return unavailable();
    }

    const stream = openStoredFile(config, attachment.storageKey);

    return new NextResponse(stream as unknown as ReadableStream, {
      status: 200,
      headers: {
        // Always a download, whatever the file is. Phase 7 is download-only (D-10): nothing
        // uploaded is ever rendered inside this application.
        'Content-Type': downloadContentType(),
        'Content-Disposition': contentDispositionFor(attachment.originalFilename),
        // From the file on disk rather than the stored number: if they ever disagree, the bytes
        // being sent are the truth, and a wrong length would truncate or hang the download.
        'Content-Length': String(stats.byteSize),
        // Belt and braces with the octet-stream type: no sniffing, whatever the content looks
        // like. Between them a file cannot be talked into executing in a colleague's browser.
        'X-Content-Type-Options': 'nosniff',
        // Company data. Not in a shared cache, and not left on disk by an intermediary.
        'Cache-Control': 'private, no-store',
        // Nothing to embed, and nothing that should try.
        'Content-Security-Policy': "default-src 'none'; sandbox",
      },
    });
  });
}
