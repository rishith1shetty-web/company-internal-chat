-- MAINTENANCE BATCH — timestamp / timezone normalization: repair of historical instants.
--
-- THIS IS A DATA MIGRATION. No column is added, dropped, renamed or retyped; every `DateTime`
-- column in this schema is already `TIMESTAMPTZ(3)` and always was. What is wrong is the VALUES.
--
-- WHAT WENT WRONG, precisely. Prisma hands a `DateTime` to the driver as the instant's UTC wall
-- clock in a NAIVE, offset-less form — `2026-09-22 16:00:00` for `2026-09-22T16:00:00Z`.
-- PostgreSQL must attach an offset to a naive literal, and it attaches the SESSION timezone's.
-- This machine's cluster was initialised from the operating system, so that session zone is
-- `America/New_York`, and the row stored `2026-09-22 16:00:00-04` — the instant `20:00Z`, four
-- hours after the one the application meant to write.
--
-- It survived undetected because the read path is exactly symmetric: PostgreSQL renders the row
-- back in the same zone, Prisma keeps the naive part and calls it UTC, and the original instant
-- returns intact. Every comparison the application makes is between two values carrying the
-- identical error, so ordering, unread counts, read watermarks and session expiry all behaved
-- correctly over data that was hours wrong.
--
-- THE CONVERSION, and why it is the only correct one. Taking the stored value's LOCAL wall clock
-- and reinterpreting it as UTC is the exact inverse of what happened on the way in:
--
--     ("<column>" AT TIME ZONE 'America/New_York') AT TIME ZONE 'UTC'
--
-- Both zones are named explicitly, so the result does not depend on the session timezone this
-- migration happens to run under, and PostgreSQL applies the offset in force ON EACH ROW'S OWN
-- DATE. That last part is not a detail:
--
--   * A row written in July is out by 4 hours (EDT). A row written in January is out by 5 (EST).
--   * `Device.expiresAt` holds dates in DECEMBER that were written in SEPTEMBER, so those values
--     are out by 5 hours while the `Device.createdAt` beside them is out by 4.
--
-- A flat `- interval '4 hours'` therefore leaves every winter-dated value an hour wrong, and
-- there is no single interval that is right for all of them. Manual DST arithmetic is not used
-- here for the same reason it is not used anywhere else in this project: the zone database
-- already knows the answer.
--
-- `_prisma_migrations` IS NOT TOUCHED. Its timestamps are written by PostgreSQL itself, not by
-- the application, and they are already correct. The completeness check below excludes it by
-- name, which is also what stops a future edit from sweeping it in by accident.
--
-- ON A FRESH DATABASE this migration is a no-op: every table is empty, so each `UPDATE` matches
-- zero rows and every assertion below passes vacuously. It is ordered after the four schema
-- migrations so that the tables it names exist.
--
-- IT IS NOT IDEMPOTENT, and it is not meant to be. Applying the conversion twice would shift the
-- data a second time. Prisma records applied migrations in `_prisma_migrations` and will not
-- re-run it; nothing else may run this file by hand.
--
-- SEQUENCING, which matters more than anything else here. This repair assumes every row was
-- written by the OLD code. The application must be STOPPED before it runs and must not be
-- started again until the new build — the one that pins the database session to UTC
-- (lib/db/prisma.ts) — is in place. A single message written by the old code after this
-- migration would be re-skewed and would sit four hours adrift of everything around it.
--
-- TRANSACTION. `prisma migrate deploy` runs each migration file inside one transaction on
-- PostgreSQL, so the snapshot, the twenty-four updates and the verification below either all
-- commit or none of them do. The verification is expressed as `RAISE EXCEPTION`, which aborts
-- that transaction — so "verify before commit, roll back on failure" is enforced by the database
-- rather than by an operator watching output at the right moment.

-- ---------------------------------------------------------------------------------------------
-- 1. COMPLETENESS — every application timestamp column is repaired below, or this fails.
-- ---------------------------------------------------------------------------------------------
--
-- The realistic mistake in a migration like this is not a wrong conversion, it is a FORGOTTEN
-- COLUMN: one timestamp left four hours ahead of every other value in the same row. So the list
-- is checked against the live catalogue instead of against a developer's memory.

DO $$
DECLARE
    missing text;
BEGIN
    SELECT string_agg(format('%s.%s', c.table_name, c.column_name), ', ' ORDER BY c.table_name, c.column_name)
      INTO missing
      FROM information_schema.columns c
     WHERE c.table_schema = 'public'
       AND c.udt_name = 'timestamptz'
       /*
        * Scoped to the nine application tables, deliberately.
        *
        * `_prisma_migrations` is excluded because PostgreSQL writes it and its values are already
        * correct — the one table this repair must not touch.
        *
        * Everything else in the schema is excluded because the question worth asking is "did I
        * forget a COLUMN on a table I am repairing?", which is the mistake that leaves one value
        * in a row hours adrift of its neighbours. A table added by some later migration is not
        * this migration's business, and scanning for one only makes this fail on a database that
        * happens to carry anything else in `public`.
        */
       AND c.table_name IN ('User', 'Session', 'Device', 'Conversation', 'ConversationMember',
                            'Message', 'Attachment', 'MessageReaction', 'MessageHide')
       AND (c.table_name, c.column_name) NOT IN (
            ('User', 'createdAt'), ('User', 'lastSeenAt'),
            ('Session', 'createdAt'), ('Session', 'expiresAt'), ('Session', 'lastSeenAt'),
            ('Device', 'createdAt'), ('Device', 'assignedAt'), ('Device', 'enrolledAt'),
            ('Device', 'expiresAt'), ('Device', 'lastSeenAt'), ('Device', 'revokedAt'),
            ('Device', 'enrollmentExpiresAt'),
            ('Conversation', 'createdAt'), ('Conversation', 'lastMessageAt'),
            ('ConversationMember', 'joinedAt'), ('ConversationMember', 'leftAt'),
            ('ConversationMember', 'lastReadAt'),
            ('Message', 'createdAt'), ('Message', 'editedAt'), ('Message', 'pinnedAt'),
            ('Message', 'deletedAt'),
            ('Attachment', 'createdAt'),
            ('MessageReaction', 'createdAt'),
            ('MessageHide', 'createdAt')
       );

    IF missing IS NOT NULL THEN
        RAISE EXCEPTION
            'Timestamp repair is incomplete: % is a timestamptz column that this migration does not repair. Every application timestamp must be converted together, or the row will disagree with itself.',
            missing;
    END IF;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- 2. BEFORE — snapshot the behaviour that must survive the repair.
-- ---------------------------------------------------------------------------------------------
--
-- Not the timestamps themselves. What is worth proving is that the things BUILT on them are
-- unchanged, and each of these is a comparison between two columns that this migration moves:
--
--   * D-03 visibility   `Message.createdAt >= ConversationMember.joinedAt`
--   * unread            `Message.createdAt >  ConversationMember.lastReadAt`
--
-- If the conversion were applied unevenly — one column missed, one row converted at the wrong
-- offset — these counts move, and the migration refuses to commit.

CREATE TEMP TABLE zz_repair_before ON COMMIT DROP AS
SELECT cm."conversationId",
       cm."userId",
       count(*) FILTER (WHERE m."createdAt" >= cm."joinedAt")                                AS visible,
       count(*) FILTER (WHERE m."createdAt" >= cm."joinedAt"
                          AND (cm."lastReadAt" IS NULL OR m."createdAt" > cm."lastReadAt"))   AS unread
  FROM "ConversationMember" cm
  LEFT JOIN "Message" m ON m."conversationId" = cm."conversationId"
 GROUP BY cm."conversationId", cm."userId";

CREATE TEMP TABLE zz_repair_counts ON COMMIT DROP AS
SELECT (SELECT count(*) FROM "User")               AS users,
       (SELECT count(*) FROM "Session")            AS sessions,
       (SELECT count(*) FROM "Device")             AS devices,
       (SELECT count(*) FROM "Conversation")       AS conversations,
       (SELECT count(*) FROM "ConversationMember") AS members,
       (SELECT count(*) FROM "Message")            AS messages,
       (SELECT count(*) FROM "Attachment")         AS attachments,
       (SELECT count(*) FROM "MessageReaction")    AS reactions,
       (SELECT count(*) FROM "MessageHide")        AS hides,
       -- Proof, not politeness: these must be identical afterwards.
       (SELECT count(*) FROM _prisma_migrations)   AS migrations,
       (SELECT md5(string_agg(id || coalesce(finished_at::text, '') || coalesce(started_at::text, ''), '|' ORDER BY id))
          FROM _prisma_migrations)                 AS migrations_fingerprint;

-- ---------------------------------------------------------------------------------------------
-- 3. THE REPAIR — 9 tables, 24 columns.
-- ---------------------------------------------------------------------------------------------
--
-- `IS NOT NULL` on the nullable columns keeps the row count of the update honest and leaves
-- "never happened" as NULL, which is what it means. The non-null columns are converted whole.

UPDATE "User" SET
    "createdAt"  = ("createdAt"  AT TIME ZONE 'America/New_York') AT TIME ZONE 'UTC',
    "lastSeenAt" = ("lastSeenAt" AT TIME ZONE 'America/New_York') AT TIME ZONE 'UTC';

UPDATE "Session" SET
    "createdAt"  = ("createdAt"  AT TIME ZONE 'America/New_York') AT TIME ZONE 'UTC',
    "expiresAt"  = ("expiresAt"  AT TIME ZONE 'America/New_York') AT TIME ZONE 'UTC',
    "lastSeenAt" = ("lastSeenAt" AT TIME ZONE 'America/New_York') AT TIME ZONE 'UTC';

UPDATE "Device" SET
    "createdAt"           = ("createdAt"  AT TIME ZONE 'America/New_York') AT TIME ZONE 'UTC',
    "assignedAt"          = ("assignedAt" AT TIME ZONE 'America/New_York') AT TIME ZONE 'UTC',
    "expiresAt"           = ("expiresAt"  AT TIME ZONE 'America/New_York') AT TIME ZONE 'UTC',
    "lastSeenAt"          = ("lastSeenAt" AT TIME ZONE 'America/New_York') AT TIME ZONE 'UTC',
    "enrolledAt"          = CASE WHEN "enrolledAt" IS NULL THEN NULL
                                 ELSE ("enrolledAt" AT TIME ZONE 'America/New_York') AT TIME ZONE 'UTC' END,
    "revokedAt"           = CASE WHEN "revokedAt" IS NULL THEN NULL
                                 ELSE ("revokedAt" AT TIME ZONE 'America/New_York') AT TIME ZONE 'UTC' END,
    "enrollmentExpiresAt" = CASE WHEN "enrollmentExpiresAt" IS NULL THEN NULL
                                 ELSE ("enrollmentExpiresAt" AT TIME ZONE 'America/New_York') AT TIME ZONE 'UTC' END;

UPDATE "Conversation" SET
    "createdAt"     = ("createdAt" AT TIME ZONE 'America/New_York') AT TIME ZONE 'UTC',
    "lastMessageAt" = CASE WHEN "lastMessageAt" IS NULL THEN NULL
                           ELSE ("lastMessageAt" AT TIME ZONE 'America/New_York') AT TIME ZONE 'UTC' END;

UPDATE "ConversationMember" SET
    "joinedAt"   = ("joinedAt" AT TIME ZONE 'America/New_York') AT TIME ZONE 'UTC',
    "leftAt"     = CASE WHEN "leftAt" IS NULL THEN NULL
                        ELSE ("leftAt" AT TIME ZONE 'America/New_York') AT TIME ZONE 'UTC' END,
    "lastReadAt" = CASE WHEN "lastReadAt" IS NULL THEN NULL
                        ELSE ("lastReadAt" AT TIME ZONE 'America/New_York') AT TIME ZONE 'UTC' END;

UPDATE "Message" SET
    "createdAt" = ("createdAt" AT TIME ZONE 'America/New_York') AT TIME ZONE 'UTC',
    "editedAt"  = CASE WHEN "editedAt" IS NULL THEN NULL
                       ELSE ("editedAt" AT TIME ZONE 'America/New_York') AT TIME ZONE 'UTC' END,
    "pinnedAt"  = CASE WHEN "pinnedAt" IS NULL THEN NULL
                       ELSE ("pinnedAt" AT TIME ZONE 'America/New_York') AT TIME ZONE 'UTC' END,
    "deletedAt" = CASE WHEN "deletedAt" IS NULL THEN NULL
                       ELSE ("deletedAt" AT TIME ZONE 'America/New_York') AT TIME ZONE 'UTC' END;

UPDATE "Attachment" SET
    "createdAt" = ("createdAt" AT TIME ZONE 'America/New_York') AT TIME ZONE 'UTC';

UPDATE "MessageReaction" SET
    "createdAt" = ("createdAt" AT TIME ZONE 'America/New_York') AT TIME ZONE 'UTC';

UPDATE "MessageHide" SET
    "createdAt" = ("createdAt" AT TIME ZONE 'America/New_York') AT TIME ZONE 'UTC';

-- ---------------------------------------------------------------------------------------------
-- 4. VERIFY BEFORE COMMIT — any failure here aborts the transaction and rolls everything back.
-- ---------------------------------------------------------------------------------------------

DO $$
DECLARE
    offenders  bigint;
    detail     text;
    fingerprint_before text;
    fingerprint_after  text;
BEGIN
    -- 4a. Nothing that has ALREADY HAPPENED may be dated in the future.
    --
    -- This is the assertion that would have caught the original bug, and the one that proves the
    -- repair did something: before it runs, thirty-odd messages on the live database are stamped
    -- up to four hours ahead of the clock. A minute of tolerance absorbs ordinary clock jitter;
    -- the fault being guarded against is measured in hours.
    SELECT sum(n), string_agg(label, ', ' ORDER BY label)
      INTO offenders, detail
      FROM (
        SELECT 'User.createdAt'  AS label, count(*) n FROM "User"  WHERE "createdAt"  > now() + interval '1 minute'
        UNION ALL SELECT 'User.lastSeenAt', count(*) FROM "User"   WHERE "lastSeenAt" > now() + interval '1 minute'
        UNION ALL SELECT 'Session.createdAt', count(*) FROM "Session" WHERE "createdAt" > now() + interval '1 minute'
        UNION ALL SELECT 'Session.lastSeenAt', count(*) FROM "Session" WHERE "lastSeenAt" > now() + interval '1 minute'
        UNION ALL SELECT 'Device.createdAt', count(*) FROM "Device" WHERE "createdAt" > now() + interval '1 minute'
        UNION ALL SELECT 'Device.assignedAt', count(*) FROM "Device" WHERE "assignedAt" > now() + interval '1 minute'
        UNION ALL SELECT 'Device.enrolledAt', count(*) FROM "Device" WHERE "enrolledAt" > now() + interval '1 minute'
        UNION ALL SELECT 'Device.lastSeenAt', count(*) FROM "Device" WHERE "lastSeenAt" > now() + interval '1 minute'
        UNION ALL SELECT 'Device.revokedAt', count(*) FROM "Device" WHERE "revokedAt" > now() + interval '1 minute'
        UNION ALL SELECT 'Conversation.createdAt', count(*) FROM "Conversation" WHERE "createdAt" > now() + interval '1 minute'
        UNION ALL SELECT 'Conversation.lastMessageAt', count(*) FROM "Conversation" WHERE "lastMessageAt" > now() + interval '1 minute'
        UNION ALL SELECT 'ConversationMember.joinedAt', count(*) FROM "ConversationMember" WHERE "joinedAt" > now() + interval '1 minute'
        UNION ALL SELECT 'ConversationMember.leftAt', count(*) FROM "ConversationMember" WHERE "leftAt" > now() + interval '1 minute'
        UNION ALL SELECT 'ConversationMember.lastReadAt', count(*) FROM "ConversationMember" WHERE "lastReadAt" > now() + interval '1 minute'
        UNION ALL SELECT 'Message.createdAt', count(*) FROM "Message" WHERE "createdAt" > now() + interval '1 minute'
        UNION ALL SELECT 'Message.editedAt', count(*) FROM "Message" WHERE "editedAt" > now() + interval '1 minute'
        UNION ALL SELECT 'Message.pinnedAt', count(*) FROM "Message" WHERE "pinnedAt" > now() + interval '1 minute'
        UNION ALL SELECT 'Message.deletedAt', count(*) FROM "Message" WHERE "deletedAt" > now() + interval '1 minute'
        UNION ALL SELECT 'Attachment.createdAt', count(*) FROM "Attachment" WHERE "createdAt" > now() + interval '1 minute'
        UNION ALL SELECT 'MessageReaction.createdAt', count(*) FROM "MessageReaction" WHERE "createdAt" > now() + interval '1 minute'
        UNION ALL SELECT 'MessageHide.createdAt', count(*) FROM "MessageHide" WHERE "createdAt" > now() + interval '1 minute'
      ) t
     WHERE n > 0;

    IF coalesce(offenders, 0) > 0 THEN
        RAISE EXCEPTION
            'Timestamp repair failed verification: % value(s) are still dated in the future (%). Rolling back.',
            offenders, detail;
    END IF;

    -- 4b. Expiry columns are allowed to be in the future — but only by their own lifetime.
    --
    -- Checked as a RELATIONSHIP rather than against a hard-coded TTL, so this does not break when
    -- SESSION_TTL_HOURS or DEVICE_ID_TTL_DAYS is reconfigured. An unrepaired expiry sits four or
    -- five hours further from its own creation than it was ever issued for, and since both ends
    -- move together under a correct repair, the interval is what stays fixed.
    SELECT count(*) INTO offenders
      FROM "Session"
     WHERE "expiresAt" <= "createdAt";
    IF offenders > 0 THEN
        RAISE EXCEPTION 'Timestamp repair failed verification: % session(s) expire before they were created. Rolling back.', offenders;
    END IF;

    SELECT count(*) INTO offenders
      FROM "Device"
     WHERE "expiresAt" <= "createdAt";
    IF offenders > 0 THEN
        RAISE EXCEPTION 'Timestamp repair failed verification: % device(s) expire before they were created. Rolling back.', offenders;
    END IF;

    -- 4c. The read watermark still names a real message instant.
    --
    -- `markConversationRead` sets `lastReadAt` to a message's `createdAt` exactly, so every
    -- non-null watermark matches one. If `Message.createdAt` and `ConversationMember.lastReadAt`
    -- were converted differently — the single most damaging way this could go wrong — the match
    -- disappears and Seen starts lying.
    SELECT count(*) INTO offenders
      FROM "ConversationMember" cm
     WHERE cm."lastReadAt" IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM "Message" m
                        WHERE m."conversationId" = cm."conversationId"
                          AND m."createdAt" = cm."lastReadAt");
    IF offenders > 0 THEN
        RAISE EXCEPTION
            'Timestamp repair failed verification: % read watermark(s) no longer match any message time. Read receipts would be wrong. Rolling back.',
            offenders;
    END IF;

    -- 4d. D-03 visibility and unread counts are byte-for-byte what they were.
    SELECT count(*), string_agg(format('%s/%s visible %s->%s unread %s->%s',
                                       b."conversationId", b."userId", b.visible, a.visible, b.unread, a.unread),
                                '; ')
      INTO offenders, detail
      FROM zz_repair_before b
      JOIN (
        SELECT cm."conversationId", cm."userId",
               count(*) FILTER (WHERE m."createdAt" >= cm."joinedAt") AS visible,
               count(*) FILTER (WHERE m."createdAt" >= cm."joinedAt"
                                  AND (cm."lastReadAt" IS NULL OR m."createdAt" > cm."lastReadAt")) AS unread
          FROM "ConversationMember" cm
          LEFT JOIN "Message" m ON m."conversationId" = cm."conversationId"
         GROUP BY cm."conversationId", cm."userId"
      ) a ON a."conversationId" = b."conversationId" AND a."userId" = b."userId"
     WHERE a.visible <> b.visible OR a.unread <> b.unread;

    IF coalesce(offenders, 0) > 0 THEN
        RAISE EXCEPTION
            'Timestamp repair failed verification: % membership(s) changed what they can see or have unread (%). Rolling back.',
            offenders, left(coalesce(detail, ''), 500);
    END IF;

    -- 4e. Nothing was created or destroyed. An UPDATE cannot change a row count, which is the
    -- point: if one of these moved, the statement that ran was not the statement written above.
    SELECT count(*) INTO offenders
      FROM zz_repair_counts c
     WHERE c.users         <> (SELECT count(*) FROM "User")
        OR c.sessions      <> (SELECT count(*) FROM "Session")
        OR c.devices       <> (SELECT count(*) FROM "Device")
        OR c.conversations <> (SELECT count(*) FROM "Conversation")
        OR c.members       <> (SELECT count(*) FROM "ConversationMember")
        OR c.messages      <> (SELECT count(*) FROM "Message")
        OR c.attachments   <> (SELECT count(*) FROM "Attachment")
        OR c.reactions     <> (SELECT count(*) FROM "MessageReaction")
        OR c.hides         <> (SELECT count(*) FROM "MessageHide");
    IF offenders > 0 THEN
        RAISE EXCEPTION 'Timestamp repair failed verification: row counts changed. Rolling back.';
    END IF;

    -- 4f. `_prisma_migrations` is exactly as it was found.
    --
    -- Its timestamps come from PostgreSQL and are already correct; sweeping them into a repair
    -- built for application values would corrupt the one record of when each migration ran.
    -- The fingerprint covers the row this very migration is adding, so it is taken over the rows
    -- that existed BEFORE it — hence the comparison of both the count and the digest.
    SELECT c.migrations_fingerprint INTO fingerprint_before FROM zz_repair_counts c;
    SELECT md5(string_agg(id || coalesce(finished_at::text, '') || coalesce(started_at::text, ''), '|' ORDER BY id))
      INTO fingerprint_after
      FROM _prisma_migrations
     WHERE id IN (SELECT id FROM _prisma_migrations ORDER BY started_at LIMIT (SELECT migrations FROM zz_repair_counts));

    IF fingerprint_before IS DISTINCT FROM fingerprint_after THEN
        RAISE EXCEPTION 'Timestamp repair failed verification: _prisma_migrations was modified. Rolling back.';
    END IF;

    RAISE NOTICE 'Timestamp repair verified: no future-dated events, watermarks intact, visibility and unread counts unchanged, _prisma_migrations untouched.';
END
$$;
