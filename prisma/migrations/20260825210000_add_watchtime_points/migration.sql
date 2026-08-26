-- AlterEnum
-- As with ACCOUNT_LINK: Postgres 12+ allows ADD VALUE inside a transaction
-- (which is how Prisma runs migrations) so long as the new value isn't *used*
-- in that same transaction. The ADD COLUMN below doesn't touch it.
ALTER TYPE "PointsReason" ADD VALUE 'WATCHTIME';

-- AlterTable
ALTER TABLE "User" ADD COLUMN "watchtimeSeconds" INTEGER NOT NULL DEFAULT 0;
