-- =============================================================================================
-- Admin-controlled device identity
-- =============================================================================================
--
-- Identity stops being something an employee creates for themselves and becomes something an
-- administrator assigns to a company computer (docs/12-admin-device-identity.md).
--
-- WHY EACH CHANGE IS NECESSARY:
--
--   Device.label                A computer must be identifiable to an administrator BEFORE any
--                               browser on it holds a cookie. Without a label there is nothing
--                               to select in an admin list — only opaque uuids.
--
--   Device.tokenHash nullable   An assignment exists before the computer is enrolled. Requiring
--                               the cookie hash up front would force the server to invent a
--                               token nobody has, which is worse than modelling the real state.
--
--   Device.enrollmentTokenHash  Only the SHA-256 hash of the one-time enrollment code is stored,
--   Device.enrollmentExpiresAt  for the same reason session and device tokens are hashed: a
--                               database backup must not yield usable credentials. The code
--                               expires and is cleared on redemption.
--
--   Device.assignedAt           When the current employee was assigned, and when the assignment
--   Device.enrolledAt           was redeemed on the machine. Both are operational facts an
--                               administrator needs and cannot otherwise recover.
--
--   Session.deviceId            Identity is now anchored to a device, so a session must be
--                               traceable back to the computer that produced it. Without this
--                               column, reassigning a computer to a new employee cannot revoke
--                               the previous employee's still-valid session cookie, and the old
--                               identity would keep resolving. That is the whole point of the
--                               change, so the column is not optional.
--
-- SAFETY (docs/02-database.md §0). This migration is FORWARD-ONLY and ADDITIVE:
--   - no table is dropped, renamed, truncated or recreated;
--   - no existing column is dropped or narrowed (the only alteration RELAXES a NOT NULL);
--   - no row is deleted, and no User, Conversation, Message or membership is touched;
--   - `label` is added nullable, backfilled, and only then made NOT NULL, so the migration is
--     correct whether the table is empty or already holds rows.
-- Applied with `prisma migrate deploy` against company_chat_db as company_chat_app. No shadow
-- database is created and no reset command is used.

-- ---------------------------------------------------------------------------------------------
-- Device: the assigned company computer
-- ---------------------------------------------------------------------------------------------

-- Added nullable first so the statement succeeds on a table that already has rows.
ALTER TABLE "Device" ADD COLUMN "label" VARCHAR(64);

-- Backfill: any pre-existing device gets a placeholder label derived from its own id, which is
-- unique by construction. An administrator can rename it afterwards.
UPDATE "Device"
SET "label" = 'Unlabelled device ' || substring("id"::text from 1 for 8)
WHERE "label" IS NULL;

ALTER TABLE "Device" ALTER COLUMN "label" SET NOT NULL;

ALTER TABLE "Device" ADD COLUMN "enrollmentTokenHash" CHAR(64);
ALTER TABLE "Device" ADD COLUMN "enrollmentExpiresAt" TIMESTAMPTZ(3);
ALTER TABLE "Device" ADD COLUMN "assignedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Device" ADD COLUMN "enrolledAt" TIMESTAMPTZ(3);

-- A device is assigned before it is enrolled, so the cookie hash starts out absent.
ALTER TABLE "Device" ALTER COLUMN "tokenHash" DROP NOT NULL;

CREATE UNIQUE INDEX "Device_label_key" ON "Device"("label");
CREATE UNIQUE INDEX "Device_enrollmentTokenHash_key" ON "Device"("enrollmentTokenHash");

-- ---------------------------------------------------------------------------------------------
-- Session: which computer this session was issued for
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "Session" ADD COLUMN "deviceId" UUID;

CREATE INDEX "Session_deviceId_idx" ON "Session"("deviceId");

-- SET NULL, never CASCADE: deleting a device row must not silently delete session history, and
-- sessions are cleaned up explicitly by the reassignment path.
ALTER TABLE "Session" ADD CONSTRAINT "Session_deviceId_fkey"
  FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;
