-- CreateEnum
CREATE TYPE "tenant_lifecycle_state" AS ENUM ('Provisioning', 'PendingActivation', 'Active', 'Suspended', 'ReadOnly', 'Closed');

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "lifecycle_state" "tenant_lifecycle_state" NOT NULL DEFAULT 'Provisioning';

-- CreateIndex
CREATE INDEX "tenants_lifecycle_state_idx" ON "tenants"("lifecycle_state");

-- Backfill: companies that existed before this column were provisioned and functioning, so
-- 'Active' is the truthful state for them. New companies correctly start at 'Provisioning'
-- via the column default.
--
-- Expand/migrate/contract note: adding a NOT NULL column WITH a default is safe in one step on
-- PostgreSQL 11+ (no table rewrite), and no pre-existing writer can produce a NULL, so the
-- three phases legitimately collapse here. A column added WITHOUT a default would have needed
-- the full nullable -> backfill -> NOT NULL sequence across separate deploys.
UPDATE "tenants" SET "lifecycle_state" = 'Active' WHERE "created_at" < NOW();
