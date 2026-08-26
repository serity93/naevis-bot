-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountLinkCode" (
    "code" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountLinkCode_pkey" PRIMARY KEY ("code")
);

-- CreateIndex
CREATE INDEX "AccountLinkCode_accountId_idx" ON "AccountLinkCode"("accountId");

-- CreateIndex
CREATE INDEX "AccountLinkCode_expiresAt_idx" ON "AccountLinkCode"("expiresAt");

-- AlterTable: add the column nullable so existing rows can be backfilled.
ALTER TABLE "User" ADD COLUMN "accountId" TEXT;

-- Backfill: every pre-existing identity becomes its own unlinked account.
-- gen_random_uuid() is volatile, so this assigns a distinct id per row.
UPDATE "User" SET "accountId" = gen_random_uuid()::text;

INSERT INTO "Account" ("id", "createdAt")
SELECT "accountId", CURRENT_TIMESTAMP FROM "User";

ALTER TABLE "User" ALTER COLUMN "accountId" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "User_accountId_platform_key" ON "User"("accountId", "platform");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountLinkCode" ADD CONSTRAINT "AccountLinkCode_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
