-- =============================================================================================
-- Migration #6 — group mentions (Batch 1.7)
-- =============================================================================================
--
-- PURELY ADDITIVE. One enum, one new table, one unique index and two foreign keys. No existing
-- table is altered, no column is dropped or retyped, no row is rewritten and nothing is
-- backfilled: every message that exists today simply has no mention rows, which is exactly what
-- "this message mentions nobody" means. Historical messages therefore need no migration of their
-- own and render exactly as they do now.
--
-- SAFE TO APPLY WHILE THE APPLICATION IS RUNNING. `CREATE TABLE`, `CREATE TYPE` and
-- `CREATE UNIQUE INDEX` on a table that does not yet exist take no lock on `Message` or `User`.
-- The two `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY` statements take a brief
-- SHARE ROW EXCLUSIVE lock on the referenced tables to validate the (empty) new table — which
-- blocks writes to `Message` and `User` for the instant it takes and nothing longer, because
-- there are no rows to validate.
--
-- ROLLBACK, if it were ever needed, is `DROP TABLE "MessageMention"; DROP TYPE "MentionKind";`
-- and costs no message data — the mentions are metadata ABOUT messages, never the messages.

-- CreateEnum
CREATE TYPE "MentionKind" AS ENUM ('USER', 'EVERYONE');

-- CreateTable
CREATE TABLE "MessageMention" (
    "id" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "kind" "MentionKind" NOT NULL,
    "mentionedUserId" UUID,
    "startOffset" INTEGER NOT NULL,
    "endOffset" INTEGER NOT NULL,

    CONSTRAINT "MessageMention_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Both the duplicate-metadata constraint and the only lookup path (leading column `messageId`).
CREATE UNIQUE INDEX "MessageMention_messageId_startOffset_key" ON "MessageMention"("messageId", "startOffset");

-- AddForeignKey
ALTER TABLE "MessageMention" ADD CONSTRAINT "MessageMention_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageMention" ADD CONSTRAINT "MessageMention_mentionedUserId_fkey" FOREIGN KEY ("mentionedUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
