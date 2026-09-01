# Phase 7 — File Transfer

**Status:** Complete. Employees can send any file into a direct or group conversation, it reaches
the other members in real time, and it downloads through an endpoint that authorizes every
request. Files are stored on the company server's own filesystem; PostgreSQL holds the metadata.

**Scope:** upload, storage, metadata, authorized download, the Shared files panel, and the
join-bounded window applied to all of it. Network restriction is Phase 8 and deployment is Phase
10; neither was touched.

**What did not change:** the schema, the Phase 2 visual design, the identity model, and the
message and membership behaviour of Phases 5 and 6.

---

## 1. Why there is no migration

`Attachment` was designed in Phase 3 for exactly this and needed nothing added:

| What Phase 7 needs | Column |
|---|---|
| The name the sender's computer had | `originalFilename varchar(255)` |
| Where the bytes are, opaquely | `storageKey varchar(255) UNIQUE` |
| How large it is | `byteSize BigInt` — 500 MB does not fit a 32-bit column |
| What it appears to be | `mimeType varchar(127)`, `extension varchar(16)` |
| Whether it is complete | `status PENDING/READY/FAILED` |
| Who sent it, where, and as what | `uploaderId`, `conversationId`, `messageId UNIQUE` |
| Integrity | `checksumSha256 char(64)` |
| When | `createdAt timestamptz(3)` |

`Message.type = FILE` and the nullable `Message.body` were already there too, so a file with a
caption is one message rather than two.

One column is used slightly differently from the original plan. `status` anticipated a two-step
upload — reserve a `PENDING` row, then fill it in. This implementation writes the bytes first and
both rows afterwards in a single transaction, so a `PENDING` row never exists and rows are written
`READY`. That removes the abandoned-upload sweep the schema comment anticipated: there is nothing
half-finished to sweep (§5).

**No `prisma migrate` command was run.**

---

## 2. Shape of the change

```text
Browser
  ├── POST /api/conversations/:id/attachments    raw body, filename in a header  → the file
  ├── GET  /api/conversations/:id/attachments    the Shared files panel
  └── GET  /api/attachments/:id/download         the only way bytes leave the server

Server
  lib/files/storage.ts      the filesystem: opaque names, containment, streaming, atomic finish
  lib/files/service.ts      filenames, content types, and who may see which file
  lib/authz/membership.ts   unchanged — still the single authorization seam
  lib/realtime/notify.ts    + messagePosted, so an HTTP upload reaches open browsers
```

Nothing above `lib/files/storage.ts` ever sees a filesystem path. Everything holds an opaque
`storageKey`, and only that module turns one into a path.

---

## 3. The upload is a raw body, not a multipart form

The single most consequential decision in this phase.

`await request.formData()` reads the entire request into memory before the handler runs. A 500 MB
video would therefore cost 500 MB of server memory per concurrent upload, and a handful at once is
the server rather than a slow request. Sending the file as the request body instead lets it be
piped straight to disk through a byte counter and a hash.

It also avoids a multipart parser, which would be a dependency doing nothing else this application
needs (`CLAUDE.md` §3). The two values a form would have carried travel as headers:

```
POST /api/conversations/:id/attachments
X-Filename:           percent-encoded original filename
X-Client-Message-Id:  uuid, the idempotency key
X-Caption:            percent-encoded optional caption
Content-Type:         application/octet-stream
<body: the file>
```

Percent-encoded because a header cannot hold arbitrary Unicode and filenames very often are. A
value that will not decode is treated as absent, not as an error — the filename is a label and
there is a sane fallback.

Measured against the production build with a 180 MB file: **1.4 seconds, byte-perfect, and the
server's resident memory went from 128 MB to 120 MB** — it did not grow.

The browser side uses `XMLHttpRequest` rather than `fetch` for one reason: `fetch` cannot report
upload progress. There is no event for it, so a `fetch` implementation would have to show nothing
or animate a bar measuring nothing. Over a LAN a 500 MB file takes long enough that a made-up bar
would be a lie the user could catch.

---

## 4. Storage

```text
UPLOAD_DIR/
  tmp/                     in-progress uploads, moved out when complete
  2026/09/<uuid>.bin       one file, named after nothing
```

- **Opaque names.** A UUID, date-sharded so a directory holding years of company files stays a
  reasonable size. The name carries no sender, no conversation and no original filename, so a
  directory listing discloses nothing. The uniform `.bin` suffix means no backup tool, indexer or
  misconfigured web server can decide a stored file is executable or servable by type.
- **The original filename never touches the filesystem.** It is a column. Two employees uploading
  `report.pdf` get two different files and neither overwrites the other — tested.
- **Containment is checked after resolution**, not before. Prefix-checking a string before
  `resolve()` is how `..` gets through; resolving first and then testing containment is what holds.
- **`UPLOAD_DIR` must not be inside `public/`**, and the application refuses to start if it is.
  Nothing maps a URL onto this directory, and the end-to-end run probes `/uploads/`,
  `/var/uploads/` and traversal attempts to confirm it.
- **No file bytes in PostgreSQL.** Metadata only.

`var/` is git-ignored, so nothing uploaded can reach version control.

---

## 5. The upload flow, and what happens when it fails

```text
authorize  →  stream to tmp/, counting and hashing  →  atomic rename into place
           →  message + attachment rows in ONE transaction  →  notify
```

The order is what keeps storage and the database consistent, and each failure has one honest
outcome:

| Failure | Result |
|---|---|
| Not a member | Refused **before a byte is read** — a stranger cannot make the server spend disk on them |
| Over the limit | The transfer is aborted mid-flight; the temporary file is deleted; no row |
| Connection drops | Same: temporary file deleted, database never reached |
| Disk write fails | Same |
| Database refuses after the bytes landed | The stored file is deleted, then the error is returned |
| A retry of an upload that already succeeded | The stored message is returned; the second copy of the bytes is deleted |

The rename is inside one filesystem — which is why `tmp/` lives under the storage root rather than
in the system temp directory — so a reader sees either no file or the complete file, never a
half-written one.

There is no state in which a row points at a file that is not there, or a file exists that no row
will ever name. Both are asserted by counting files on disk before and after a deliberately failing
upload.

Authorization is checked twice: once in the route before reading the body, and again inside
`createAttachmentMessage` immediately before the write. The second is the one that guards the row.

---

## 6. Download authorization

`GET /api/attachments/:id/download`. The browser has an id; everything else is re-derived on every
request. **Two checks, and the second is the one that is easy to leave out:**

1. The caller is an active member of the conversation the file's **message** belongs to.
2. That message was sent at or after the caller's `joinedAt`.

Without (2), a colleague added to a group today could read every file ever shared in it by asking
for the file rather than the message — D-03 reopened through a different door. That is **R-14**, and
`loadAttachmentForDownload` is where it is closed. The conversation is read from the message rather
than from the attachment's own column, so the membership check and the window comparison are made
against one row and cannot drift apart.

Every refusal is `404` with the same body. "No such file", "not your conversation" and "before you
joined" are one answer, because distinguishing them would confirm an id exists and roughly when.

Response headers, on every download:

```
Content-Type: application/octet-stream        never the detected type
Content-Disposition: attachment; filename="…"; filename*=UTF-8''…
X-Content-Type-Options: nosniff
Cache-Control: private, no-store
Content-Security-Policy: default-src 'none'; sandbox
```

`Content-Length` comes from the file on disk rather than the stored number: if they ever disagree,
the bytes being sent are the truth.

---

## 7. Any file type, and why that is not a weakening

The company transfers arbitrary business files — documents, spreadsheets, video, archives,
database dumps, source, screenshots, CAD, and formats nobody here has heard of. **There is no
extension allowlist and no MIME allowlist.** `ALLOWED_FILE_EXTENSIONS` was documented in
`.env.example` for this phase and is deliberately not implemented; the entry now says why.

This is not a relaxation, because an allowlist was never the control:

- An extension is a string the sender chose. Renaming `payload.exe` to `notes.txt` defeats it.
- A `Content-Type` header is a string the sender's browser chose.
- Neither is evidence, and a system whose safety depends on either is *also* unsafe for the files
  it does accept.

Safety comes from what the server refuses to do with the bytes: never execute them, never import
them, never pass them to a shell, never derive a path from anything a client sent, never serve them
inline or with a type a browser might act on, and never let anyone read one without re-checking the
conversation. An `.exe` and a `.txt` are treated identically, because to this application they are
identical — a sequence of bytes with a row in a database.

Content type is **sniffed from the leading bytes** for common formats, for a label and an icon.
It never gates an upload and never becomes a download's `Content-Type`. Anything unrecognised is
`application/octet-stream`, which is the honest answer and also the majority.

---

## 8. Size

`MAX_FILE_SIZE`, 500 MB by default (D-05), read once in `lib/config/env.ts` and never hard-coded
anywhere else. A mistyped value is a startup failure rather than a disk filled by one upload.

Enforced **while the bytes are arriving**, not after. The counter aborts the transfer the moment
the limit is passed, which tears down the pipeline and stops the client sending the rest — an
oversized upload never reaches permanent storage and never has to be written to be measured. The
limit is inclusive: a file of exactly the limit is accepted.

The composer refuses an oversized file before sending it, using the limit the server reports in
`GET /api/session` rather than a copy compiled into the bundle. That is a courtesy — it saves
minutes of pointless uploading — and never the control.

---

## 9. Direct and group behaviour

**Direct.** Only the two members see the metadata or can download. An outsider with the attachment
id gets 404, and none of the file comes back with the refusal.

**Group.** Everything obeys D-03. From the requirement:

```text
10:00  group created
10:05  Alice sends report.pdf
10:20  John joins        →  John cannot see it, list it, or download it
10:25  Alice sends agenda.pdf   →  John can
```

Applied in every path a file can be reached through:

| Path | How |
|---|---|
| Message history | the message query's existing window; the attachment rides on the message |
| Reconnect backfill | the same query |
| Sidebar preview | computed inside the caller's window; a file preview names the file |
| Shared files list | joined onto the message, filtered on its `createdAt` |
| Download | `loadAttachmentForDownload`, §6 |

**Nothing is deleted** to achieve it. The older file stays on disk and in the database, and the
members who were there keep downloading it — asserted directly.

A member who leaves loses access to the group's files at the same moment they lose access to its
messages, including files sent afterwards. The check is `leftAt IS NULL`, not the row's existence.

---

## 10. Shared files

`GET /api/conversations/:id/attachments`, bounded identically. It lists filename, size, sender and
time, and each row links to the authorized download endpoint. There is no `storageKey` in the
response and no path anywhere in the interface — asserted by searching every response body and the
rendered panel for the storage root, `storageKey`, and `.bin`.

For a group, the panel says the list starts where the member's history does.

---

## 11. Real time

A file uploaded over HTTP reaches other members through the existing `message:new` event, emitted
after the transaction commits by `notifyMessagePosted`. **The event carries metadata — id, name,
size, type — and never the bytes.** Pushing a 500 MB video down a socket would send it to every
member whether they wanted it or not; the bytes are fetched over HTTP by whoever chooses to
download, through an endpoint that authorizes them again. The end-to-end run asserts the socket
frame stays under 2 KB for a 9 KB file and contains no `storageKey`.

---

## 12. Security properties, and what is not done

| Property | How |
|---|---|
| No execution of uploaded content | Nothing reads, interprets, imports or shells out with a stored file |
| No public path | Storage is outside `public/`, refused at startup if not; no static route exists |
| No path traversal | Names are generated; containment checked after resolution; separators stripped from filenames anyway |
| No header injection | Control characters removed; `Content-Disposition` quotes and backslashes stripped, RFC 5987 for the real name |
| No stored XSS via a file | Always `application/octet-stream`, always `attachment`, always `nosniff`, never rendered inline (D-10, R-07) |
| Size validated server-side | Counted as the bytes arrive; the client's number is never trusted |
| Access re-checked per request | Membership **and** `joinedAt`, from the database, every time |
| Retention | An attachment outlives sessions, device reassignment and a member leaving. It belongs to the `User` and the conversation, never to a device (D-14) |

**Not done, deliberately:**

- **Malware scanning.** Out of v1 scope and flagged as Q-07. The hook belongs between the upload
  completing and the row being written `READY`, so an infected file never becomes downloadable.
  Recommended for production hardening; endpoint antivirus on the workstation remains the
  company's control either way (R-06, R-08).
- **Inline preview, thumbnails, video playback, document rendering.** D-10: download-only. Adding
  any of them needs per-type decisions and an isolated origin, and is what would reopen R-07.
- **Resumable uploads.** Q-18: a failed 500 MB upload restarts. Acceptable on a LAN; chunked
  upload is the fix if it proves disruptive, and is a materially larger piece of work.
- **Deleting an attachment.** No deletion feature exists anywhere in this application (Q-10).
- **Rate limiting on uploads.** Phase 9, with the rest of it. A member can currently upload
  repeatedly; the size limit bounds each one but not the total.
- **Storage quotas and disk monitoring.** Phase 10, with the deployment work (R-15).

---

## 13. Production storage setup (for Phase 10)

```bash
# A directory outside the application, owned by the account the service runs as.
sudo mkdir -p /var/lib/company-chat/uploads
sudo chown company-chat:company-chat /var/lib/company-chat/uploads
sudo chmod 700 /var/lib/company-chat/uploads
```

Then `UPLOAD_DIR=/var/lib/company-chat/uploads` in the production `.env`. Requirements:

- Outside the repository, outside `public/`, and containing no application code.
- On a filesystem with room for the expected volume — at 500 MB a file this grows quickly, and
  capacity planning belongs with the deployment.
- `tmp/` is created automatically inside it and holds only in-progress uploads.
- Included in the backup strategy **alongside** the database: a database backup without the files
  restores rows pointing at nothing, and files without the database are unreachable bytes. The
  download endpoint handles the mismatch cleanly (404 plus a server-side error), but the pair
  must be backed up together.
- Never served by the reverse proxy. There is no location block for it, and there should not be.

---

## 14. Tests

`tests/chat/files.test.ts` — 40 tests against the real database, real route handlers and a real
storage directory under the system temp folder. `tests/setup-env.ts` points `UPLOAD_DIR` at a fresh
temp directory before any module reads configuration, so the suite can never write into or delete
out of the storage a developer's own server is using, and sets a 1 MB limit so the boundary can be
tested without moving 500 MB.

**Filenames** — traversal, separators and drive letters stripped; control characters removed and a
header proven uninjectable; Unicode preserved and encoded; always something usable.
**Types** — signatures recognised; unknown falls back to octet-stream; downloads always served as
octet-stream.
**Storage keys** — 500 generated with no collision, opaque shape, and traversal refused.
**Streaming** — exact bytes and checksum; oversized aborted with nothing left behind; the boundary
accepted; zero bytes accepted; a source that dies mid-transfer leaves no permanent or temporary
file.
**Upload and download** — text, binary (MP4 header plus 256 KB), an unknown extension, zero-byte,
duplicate names kept apart, Unicode and traversal-shaped names, a file with a caption, the headers,
the size limit both ways, unauthorized upload, upload with no identity, a repeated upload treated
as one, download refused to an outsider, and a row whose file has vanished.
**The group window** — the pre-join file hidden from history, refused on download, absent from
Shared files; the post-join file visible; the earlier members keeping both and the bytes still on
disk; a member who has left cut off from future files too; an outsider refused the list; an
attachment with no message unreachable by anyone.
**Real time and paths** — the socket payload is small metadata; no response anywhere contains a
`storageKey` or the storage root.
**Rollback** — no row when storage fails; no orphaned file when the database refuses.

### Verification runs

| | |
|---|---|
| `npm test` | 268 passed, 14 files |
| `npm run typecheck` | pass (app and server) |
| `npm run lint` | pass, no warnings |
| `npm run build` | pass; both new routes present |
| Production end-to-end, files | 31/31 |
| Production end-to-end, large file (180 MB) | 15/15, byte-perfect, memory flat |
| Production end-to-end, groups (regression) | 46/46 |
| Production end-to-end, admin identity (regression) | 61/61 |
| Browser regression, files | 25/25 |
| Browser regression, groups (regression) | 47/47 |
| Browser regression, admin identity (regression) | 60/60 |
| `npm run db:audit` | clean |

The large-file run generates its file in the system temp directory and deletes it afterwards.
Nothing large is written inside the repository and nothing is committed.
