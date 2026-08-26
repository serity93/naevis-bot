-- AlterEnum
-- Postgres 12+ allows ADD VALUE inside a transaction (which is how Prisma runs
-- migrations) so long as the new value isn't *used* in that same transaction.
-- Nothing here writes a row with it, so this is safe on its own.
ALTER TYPE "PointsReason" ADD VALUE 'ACCOUNT_LINK';
