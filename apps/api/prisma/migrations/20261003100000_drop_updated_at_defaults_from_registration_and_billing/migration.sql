-- These columns are managed by Prisma's @updatedAt behavior, not database defaults.
-- Keep migration history aligned with the Prisma schema for fresh and existing databases.
ALTER TABLE "pending_registrations"
  ALTER COLUMN "updated_at" DROP DEFAULT;

ALTER TABLE "plan_prices"
  ALTER COLUMN "updated_at" DROP DEFAULT;

ALTER TABLE "token_purchases"
  ALTER COLUMN "updated_at" DROP DEFAULT;
